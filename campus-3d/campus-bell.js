import * as THREE from 'three';

// An analytic damped oscillator keeps the bell's motion continuous at any frame
// rate. A pull adds energy at its current phase; it never resets the swing.
export const BELL_MOTION = Object.freeze({ frequency: 1.8, damping: .125, maxAmplitude: .55, pullAmplitude: .47, stopAmplitude: .018, strikeAmplitude: .115, clapperContact: .3849, pullCooldown: .65 });
export function advanceBell(state, seconds) {
  const t = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const { frequency: w, damping: d } = BELL_MOTION;
  const a = state.angle, b = (state.velocity + d * a) / w;
  const decay = Math.exp(-d * t), sin = Math.sin(w * t), cos = Math.cos(w * t);
  const angle = decay * (a * cos + b * sin);
  const velocity = decay * (w * (-a * sin + b * cos) - d * (a * cos + b * sin));
  const amplitude = Math.hypot(angle, (velocity + d * angle) / w);
  return amplitude < BELL_MOTION.stopAmplitude ? { angle: 0, velocity: 0, amplitude: 0 } : { angle, velocity, amplitude };
}
export function energizeBell(state) {
  const { frequency: w, damping: d, maxAmplitude, pullAmplitude } = BELL_MOTION;
  const q = (state.velocity + d * state.angle) / w;
  const amplitude = Math.min(maxAmplitude, Math.hypot(state.angle, q, pullAmplitude));
  const direction = Math.abs(q) > .01 ? Math.sign(q) : state.angle > 0 ? -1 : 1;
  return { angle: state.angle, velocity: direction * Math.sqrt(Math.max(0, amplitude ** 2 - state.angle ** 2)) * w - d * state.angle, amplitude };
}

export function createCampusBell({ model, config, canvas, getWalk, getDriving, getCamera, isActive, getPresentation, ambience, requestDraw }) {
  if (config.version !== 1) throw new Error('Unsupported chapel bell configuration.');
  const find = name => {
    // GLTFLoader sanitizes spaces and punctuation in node names; exporters also
    // retain original names in extras so use the explicit source identity.
    let match = model.getObjectByName(name);
    if (!match) model.traverse(node => { if (node.userData?.bellNode === name || node.userData?.name === name) match = node; });
    if (!match) throw new Error(`Missing chapel bell part: ${name}`);
    return match;
  };
  function rig(name, nodes, pivot, parent = model) {
    const group = new THREE.Group(); group.name = name; group.userData.walkThrough = true;
    model.updateMatrixWorld(true);
    group.position.copy(parent.worldToLocal(new THREE.Vector3(...pivot)));
    parent.add(group); group.updateMatrixWorld(true);
    for (const name of nodes) { const node = find(name); group.attach(node); node.userData.walkThrough = true; node.castShadow = false; }
    return group;
  }
  const bell = rig('Chapel bell swing pivot', config.bell.nodes, config.bell.pivot_world);
  const axis = new THREE.Vector3(...config.bell.axis).normalize();
  const clapper = rig('Chapel clapper pivot', config.clapper.nodes, config.clapper.pivot_world, bell);
  const rope = rig('Chapel rope pull', config.rope.pull_nodes, config.rope.grip_world);
  const grip = new THREE.Vector3(...config.rope.grip_world);
  const mouth = new THREE.Vector3(...(config.bell.acoustic_world || config.bell.pivot_world));
  const ropeRest = rope.position.y;
  const hud = document.createElement('div'); hud.className = 'campus-bell-hud'; hud.id = 'campus-bell-hud'; hud.hidden = true;
  hud.innerHTML = '<button type="button" id="campus-bell-pull" aria-label="Pull the chapel bell rope"><kbd>F</kbd><span>Pull bell rope</span></button><span class="campus-bell-hint" role="status">Ring the tower bell</span>';
  canvas.parentElement.appendChild(hud);
  const button = hud.querySelector('button'), hint = hud.querySelector('.campus-bell-hint');
  let motion = { angle: 0, velocity: 0, amplitude: 0 }, near = false, lastUpdate = null, lastPull = -Infinity, lastStrike = -Infinity;
  let pulls = 0, strikes = 0, disposed = false, previousSign = 0, hudSignature = '';
  const now = () => performance.now() / 1000;
  const active = () => !disposed && isActive() && !document.hidden && getPresentation() === '3d';
  function canPull() {
    const mode = getWalk()?.mode, eye = getCamera()?.position;
    if (!active() || getDriving()?.camera || !['walking', 'flying'].includes(mode) || !eye) return false;
    const [x0, y0, x1, y1] = config.interior_rect_site_ft;
    const x = eye.x / .3048, y = -eye.z / .3048;
    return x > x0 && x < x1 && y > y0 && y < y1 && eye.distanceTo(grip) < (config.rope.interaction_radius_m || 1.35);
  }
  function refresh() {
    near = canPull(); hud.hidden = !near;
    const signature = `${near}|${motion.amplitude > 0}|${pulls}`;
    if (signature !== hudSignature) {
      hudSignature = signature;
      hint.textContent = motion.amplitude ? 'Pull again to keep it ringing' : 'Ring the tower bell';
    }
  }
  function sample(time) {
    const elapsed = lastUpdate === null ? 0 : Math.max(0, time - lastUpdate);
    lastUpdate = time;
    if (motion.amplitude) {
      motion = advanceBell(motion, elapsed);
      const sign = Math.sign(motion.velocity);
      // Sound at clapper contact near the end of each half-swing. Never replay
      // missed strikes after returning from a hidden tab or a long stall.
      if (active() && elapsed < .35 && previousSign && sign && sign !== previousSign && motion.amplitude > BELL_MOTION.strikeAmplitude && time - lastStrike > .7) {
        lastStrike = time; strikes++;
        ambience?.strikeBell(Math.min(1, Math.pow(Math.abs(motion.angle) / BELL_MOTION.maxAmplitude, .85)), { position: mouth });
      }
      previousSign = sign;
    }
    bell.quaternion.setFromAxisAngle(axis, motion.angle);
    // The shell's actual faceted soundbow contacts the clapper at 0.385023
    // radians. Approach that rim on each half-swing without penetrating it;
    // below the audible threshold the clapper also settles to vertical.
    const phase = motion.amplitude ? motion.angle / motion.amplitude : 0;
    const contact = BELL_MOTION.clapperContact * Math.min(1, motion.amplitude / BELL_MOTION.strikeAmplitude);
    const stroke = THREE.MathUtils.clamp(phase * Math.hypot(1, BELL_MOTION.damping / BELL_MOTION.frequency), -1, 1);
    clapper.quaternion.setFromAxisAngle(axis, -contact * stroke);
    const age = time - lastPull;
    const pull = age >= 0 && age < 1.15 ? Math.sin(Math.PI * Math.min(1, age / 1.15)) ** 2 : 0;
    rope.position.y = ropeRest - (config.rope.pull_distance_m || .13716) * pull;
    bell.updateMatrixWorld(true);
    rope.updateMatrixWorld(true);
    return motion;
  }
  function pull() {
    refresh(); const time = now();
    if (!near || time - lastPull < BELL_MOTION.pullCooldown) return false;
    // Resume synchronously in the user gesture, before delayed clapper contact.
    void ambience?.unlock();
    sample(time); motion = energizeBell(motion); previousSign = Math.sign(motion.velocity);
    lastPull = time; pulls++; refresh(); requestDraw(); return true;
  }
  function keydown(event) {
    if (event.code !== 'KeyF' || event.ctrlKey || event.metaKey || event.altKey || event.target?.closest?.('input,select,textarea,[contenteditable="true"]')) return;
    if (!canPull()) return;
    // Own F while near the rope, including cooldown/repeated keydown, so it
    // cannot also trigger the shared floor shortcut.
    event.preventDefault(); event.stopImmediatePropagation();
    if (!event.repeat) pull();
  }
  function click(event) { event.stopPropagation(); pull(); canvas.focus({ preventScroll: true }); }
  document.addEventListener('keydown', keydown, { capture: true });
  button.addEventListener('click', click);
  return {
    update(time = now()) { sample(time); refresh(); },
    pull,
    get needsAnimation() { return active() && (motion.amplitude > 0 || now() - lastPull < 1.2); },
    get state() { return { ready: true, near, swinging: motion.amplitude > 0, angle: motion.angle, velocity: motion.velocity, amplitude: motion.amplitude, pulls, strikes, gripWorld: grip.toArray(), pivotWorld: config.bell.pivot_world, audio: ambience?.state.bell || null }; },
    dispose() { disposed = true; hud.remove(); document.removeEventListener('keydown', keydown, { capture: true }); button.removeEventListener('click', click); }
  };
}
