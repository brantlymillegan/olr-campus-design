import * as THREE from 'three';

const FT = 0.3048;
const EYE = 6 * FT, HEIGHT = 6.25 * FT, RADIUS = .85 * FT;
const WALK_SPEED = 11 * FT, RUN_SPEED = 22 * FT;
const STEP = 1.05 * FT, GRAVITY = 9.81, JUMP_HEIGHT = 8 * FT;
const JUMP_SPEED = Math.sqrt(2 * GRAVITY * JUMP_HEIGHT);
const CELL = 3, SLOPE_COS = Math.cos(50 * Math.PI / 180);
const CAMPUS_BEARING = 9.067253590763931;
const EPS = .008;
const MAX_FLIGHT_ELEVATION = 500 * FT;

// Material groups contain disconnected buildings. Index their actual triangles,
// rather than treating a consolidated mesh's bounding box as one solid building.
function makeSurfaceIndex(model) {
  const ground = new Map(), terrain = new Map(), solids = new Map();
  const rayMeshes = [], groundMeshes = new Set();
  const terrainBounds = new THREE.Box3();
  let triangleCount = 0, solidCount = 0, groundCount = 0;
  const key = (x, z) => `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
  function add(index, triangle) {
    for (let x = Math.floor(triangle.minX / CELL); x <= Math.floor(triangle.maxX / CELL); x++) {
      for (let z = Math.floor(triangle.minZ / CELL); z <= Math.floor(triangle.maxZ / CELL); z++) {
        const k = `${x},${z}`;
        if (!index.has(k)) index.set(k, []);
        index.get(k).push(triangle);
      }
    }
  }
  model.updateMatrixWorld(true);
  model.traverse(object => {
    if (!object.isMesh || !object.visible || !object.geometry?.attributes.position) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    const names = materials.map(m => m?.name || '').join(' ');
    const name = object.name;
    if (/Campus.boundary|Terrain.cut.edge/i.test(names + ' ' + name)) return;
    // Leaves and flowers do not create invisible walls around their canopy boxes.
    const vegetation = /Tree.canopy|Planting.*\d/i.test(names);
    const isTerrain = /Landform.*upper.campus/i.test(name);
    const isGround = isTerrain || /Campus.lawn|Warm.gray.asphalt|Parking.paint|Limestone.pedestrian.paving|Garden.walk.*aggregate|Playground.*safety.surface|Shrines.*circular.stone.paving|Gaga.Ball.*level.green.turf|Planted.beds/i.test(names);
    if (isGround) groundMeshes.add(object);
    // Canopies still obstruct placement, even though leaves are not colliders.
    rayMeshes.push(object);
    if (vegetation) return;
    const positions = object.geometry.attributes.position;
    const indices = object.geometry.index;
    const count = indices ? indices.count : positions.count;
    for (let i = 0; i + 2 < count; i += 3) {
      const vertices = [0, 1, 2].map(k => new THREE.Vector3().fromBufferAttribute(positions, indices ? indices.getX(i + k) : i + k).applyMatrix4(object.matrixWorld));
      const triangle = new THREE.Triangle(...vertices);
      if (triangle.getArea() < 1e-10) continue;
      const normal = triangle.getNormal(new THREE.Vector3());
      const record = {
        triangle, normal, name,
        canSupport: !/fascia|glazing|window.frames|Fountain.water/i.test(names),
        minX: Math.min(...vertices.map(v => v.x)), maxX: Math.max(...vertices.map(v => v.x)),
        minY: Math.min(...vertices.map(v => v.y)), maxY: Math.max(...vertices.map(v => v.y)),
        minZ: Math.min(...vertices.map(v => v.z)), maxZ: Math.max(...vertices.map(v => v.z))
      };
      triangleCount++;
      if (isTerrain) { add(terrain, record); vertices.forEach(v => terrainBounds.expandByPoint(v)); }
      if (isGround && normal.y >= SLOPE_COS) { add(ground, record); groundCount++; }
      else if (!isGround) { add(solids, record); solidCount++; }
    }
  });
  const point = new THREE.Vector3(), supportPoint = new THREE.Vector3();
  function height(index, x, z) {
    let highest = null;
    for (const record of index.get(key(x, z)) || []) {
      if (x < record.minX - 1e-6 || x > record.maxX + 1e-6 || z < record.minZ - 1e-6 || z > record.maxZ + 1e-6 || Math.abs(record.normal.y) < 1e-5) continue;
      const y = record.triangle.a.y - (record.normal.x * (x - record.triangle.a.x) + record.normal.z * (z - record.triangle.a.z)) / record.normal.y;
      point.set(x, y, z);
      if (record.triangle.containsPoint(point) && (!highest || y > highest.y)) highest = { y, normal: record.normal, name: record.name };
    }
    return highest;
  }
  // Read-only aerial clearance in world meters. Sample a two-foot buffer in
  // both horizontal axes, including roofs and other elevated surfaces.
  function clearanceHeight(x, z) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return 0;
    let highest = null;
    for (const dx of [-2 * FT, 0, 2 * FT]) {
      for (const dz of [-2 * FT, 0, 2 * FT]) {
        for (const index of [ground, solids]) {
          const surface = height(index, x + dx, z + dz);
          if (surface && (highest === null || surface.y > highest)) highest = surface.y;
        }
      }
    }
    return highest ?? 0;
  }
  function groundAt(x, z, clearance = true) {
    // Every standable point must have real landform underneath it. The model's
    // decorative cut edge and bottom slab can never become a walking surface.
    const inset = clearance ? RADIUS + .025 : 0;
    if (x < terrainBounds.min.x + inset || x > terrainBounds.max.x - inset || z < terrainBounds.min.z + inset || z > terrainBounds.max.z - inset) return null;
    if (!height(terrain, x, z)) return null;
    if (clearance) for (const [dx, dz] of [[inset, 0], [-inset, 0], [0, inset], [0, -inset]]) if (!height(terrain, x + dx, z + dz)) return null;
    return height(ground, x, z);
  }
  function nearSolids(x, z) {
    const found = new Set();
    for (let ix = Math.floor((x - RADIUS) / CELL); ix <= Math.floor((x + RADIUS) / CELL); ix++) {
      for (let iz = Math.floor((z - RADIUS) / CELL); iz <= Math.floor((z + RADIUS) / CELL); iz++) {
        for (const record of solids.get(`${ix},${iz}`) || []) found.add(record);
      }
    }
    return found;
  }
  function solidSupportAt(x, z, lowest, highest, strict = false) {
    let support = null;
    for (const record of nearSolids(x, z)) {
      if (!record.canSupport || record.normal.y < SLOPE_COS) continue;
      const planeY = record.triangle.a.y - (record.normal.x * (x - record.triangle.a.x) + record.normal.z * (z - record.triangle.a.z)) / record.normal.y;
      point.set(x, planeY, z);
      record.triangle.closestPointToPoint(point, supportPoint);
      if (Math.hypot(supportPoint.x - x, supportPoint.z - z) > (strict ? .001 : RADIUS - EPS)) continue;
      const y = supportPoint.y;
      // The caller limits support to the feet while airborne, and permits a
      // small step up while grounded so pitched roofs can be walked on.
      if (y < lowest || y > highest || (support && y <= support.y)) continue;
      // Retain support until the capsule footprint clears the edge, allowing a
      // clean walk-off instead of snapping the body down into the log's side.
      support = { y, normal: record.normal, name: record.name };
    }
    return support;
  }
  return { groundAt, clearanceHeight, solidSupportAt, nearSolids, rayMeshes, groundMeshes, terrainBounds, diagnostics: Object.freeze({ triangleCount, solidCount, groundCount }) };
}

// Closest points between two finite line segments (including degenerate ends).
function closestSegments(p, q, a, b, resultP, resultQ) {
  const d1 = new THREE.Vector3().subVectors(q, p), d2 = new THREE.Vector3().subVectors(b, a), r = new THREE.Vector3().subVectors(p, a);
  const aa = d1.lengthSq(), ee = d2.lengthSq(), f = d2.dot(r);
  let s = 0, t = 0;
  if (aa <= 1e-12 && ee <= 1e-12) { resultP.copy(p); resultQ.copy(a); return; }
  if (aa <= 1e-12) t = THREE.MathUtils.clamp(f / ee, 0, 1);
  else {
    const c = d1.dot(r);
    if (ee <= 1e-12) s = THREE.MathUtils.clamp(-c / aa, 0, 1);
    else {
      const bb = d1.dot(d2), denominator = aa * ee - bb * bb;
      s = denominator !== 0 ? THREE.MathUtils.clamp((bb * f - c * ee) / denominator, 0, 1) : 0;
      t = (bb * s + f) / ee;
      if (t < 0) { t = 0; s = THREE.MathUtils.clamp(-c / aa, 0, 1); }
      else if (t > 1) { t = 1; s = THREE.MathUtils.clamp((bb - c) / aa, 0, 1); }
    }
  }
  resultP.copy(d1).multiplyScalar(s).add(p); resultQ.copy(d2).multiplyScalar(t).add(a);
}

export function createCampusWalk({ model, canvas, getAerialCamera, getAerialPose, requestDraw, onChange = () => {}, onPose = () => {}, canFocus = () => true }) {
  const surfaces = makeSurfaceIndex(model);
  const camera = new THREE.PerspectiveCamera(65, 1, .08, 2000);
  camera.rotation.order = 'YXZ';
  let mode = 'aerial', navigationMode = 'walking', runningToggle = false, grounded = true, suspended = false;
  let yaw = Math.PI / 2, pitch = 0, velocityY = 0, groundY = 0, groundSurface = '';
  let feedback = '', collisionCount = 0, movedSpeed = 0, lastAnnouncement = '';
  let pendingPlacement = null, placementDown = null, lookPointer = null;
  let wantsMouseLook = false, mouseLookPending = false, hadMouseLock = false;
  let lastPose = null;
  const feet = new THREE.Vector3(), velocity = new THREE.Vector3();
  const keys = new Set(), padDirections = new Set();
  const captured = new Set();
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const capsuleA = new THREE.Vector3(), capsuleB = new THREE.Vector3(), closestA = new THREE.Vector3(), closestB = new THREE.Vector3();
  const testPoint = new THREE.Vector3(), edgeA = new THREE.Vector3(), edgeB = new THREE.Vector3();
  const collisionNormal = new THREE.Vector3();
  const host = canvas.parentElement;
  const hud = document.createElement('div');
  hud.id = 'campus-walk-hud'; hud.className = 'campus-walk-hud'; hud.hidden = true;
  hud.innerHTML = `<div class="campus-walk-reticle" aria-hidden="true"></div>
    <div class="campus-walk-banner"><strong id="campus-walk-title">Walk the campus</strong><p id="campus-walk-status" role="status" aria-live="polite"></p><p class="campus-walk-help"><span class="campus-walk-keyboard-help">WASD or arrows move · click the scene, then move the mouse to look · Space jumps · Shift runs · Esc releases the mouse</span><span class="campus-walk-touch-help">Hold the arrows to move · drag the scene to look · tap Jump or Run · End finishes the walk</span></p></div>
    <div class="campus-walk-pad" role="group" aria-label="Walking directions">
      <button type="button" data-walk-move="forward" aria-label="Walk forward">↑</button>
      <button type="button" data-walk-move="left" aria-label="Walk left">←</button>
      <button type="button" data-walk-move="backward" aria-label="Walk backward">↓</button>
      <button type="button" data-walk-move="right" aria-label="Walk right">→</button>
    </div>
    <div class="campus-walk-actions"><button type="button" id="campus-walk-jump">Jump</button><button type="button" data-walk-move="up" class="campus-fly-vertical" aria-label="Fly up">Up</button><button type="button" data-walk-move="down" class="campus-fly-vertical" aria-label="Fly down">Down</button><button type="button" id="campus-walk-run" aria-pressed="false">Run</button><button type="button" id="campus-walk-exit">End</button></div>`;
  host.appendChild(hud);
  const title = hud.querySelector('#campus-walk-title'), status = hud.querySelector('#campus-walk-status');
  const runButton = hud.querySelector('#campus-walk-run');
  const marker = new THREE.Mesh(new THREE.RingGeometry(RADIUS * 1.02, RADIUS * 1.4, 40), new THREE.MeshBasicMaterial({ color: 0xeeb33c, side: THREE.DoubleSide, transparent: true, opacity: .95, depthWrite: false }));
  marker.name = 'Walk placement marker'; marker.rotation.x = -Math.PI / 2; marker.visible = false;
  (model.parent || model).add(marker);
  const isRunning = () => runningToggle || keys.has('ShiftLeft') || keys.has('ShiftRight');
  const pointerLocked = () => document.pointerLockElement === canvas;
  const navigating = () => mode === 'walking' || mode === 'flying';
  function snapshot() {
    const vector = v => Object.freeze({ x: v.x, y: v.y, z: v.z });
    return Object.freeze({
      mode, navigationMode, eyeHeightFeet: 6, bodyRadiusFeet: RADIUS / FT, feet: vector(feet), position: vector(camera.position),
      siteFeet: Object.freeze({ x: feet.x / FT, y: -feet.z / FT, elevation: feet.y / FT }),
      groundY, groundElevationFeet: groundY / FT, groundSurface, grounded, jumping: mode === 'walking' && !grounded,
      altitudeFeet: (camera.position.y - groundY) / FT,
      maxFlightElevationFeet: MAX_FLIGHT_ELEVATION / FT,
      running: isRunning(), speedFeetPerSecond: movedSpeed / FT, velocity: vector(velocity),
      pointerLocked: pointerLocked(), normalSpeedFeetPerSecond: WALK_SPEED / FT,
      runSpeedFeetPerSecond: RUN_SPEED / FT, jumpHeightFeet: JUMP_HEIGHT / FT,
      yawRadians: yaw, pitchRadians: pitch, collisionCount, feedback, message: feedback,
      boundsFeet: Object.freeze({ minX: surfaces.terrainBounds.min.x / FT, maxX: surfaces.terrainBounds.max.x / FT, minY: -surfaces.terrainBounds.max.z / FT, maxY: -surfaces.terrainBounds.min.z / FT }),
      collisionGeometry: surfaces.diagnostics
    });
  }
  function announce(force = false) {
    const signature = `${mode}|${navigationMode}|${isRunning()}|${pointerLocked()}|${feedback}`;
    if (!force && signature === lastAnnouncement) return;
    lastAnnouncement = signature;
    hud.hidden = mode === 'aerial'; hud.dataset.mode = mode; canvas.dataset.walkMode = mode;
    canvas.dataset.pointerLocked = String(pointerLocked());
    title.textContent = mode === 'placing' ? `Choose a ${navigationMode === 'flying' ? 'launch' : 'starting'} point` : mode === 'flying' ? 'Flying around campus' : 'Walking · 6 ft eye height';
    hud.querySelector('.campus-walk-keyboard-help').textContent = mode === 'flying'
      ? 'WASD or arrows move · mouse looks · Space / E rises · Q descends · Shift flies faster · Esc releases the mouse'
      : 'WASD or arrows move · click the scene, then move the mouse to look · Space jumps · Shift runs · Esc releases the mouse';
    hud.querySelector('.campus-walk-touch-help').textContent = mode === 'flying'
      ? 'Hold arrows to move · drag to look · hold Up / Down to change height · Fast speeds up · End finishes'
      : 'Hold the arrows to move · drag the scene to look · tap Jump or Run · End finishes the walk';
    runButton.textContent = mode === 'flying' ? 'Fast' : 'Run';
    hud.querySelector('.campus-walk-pad').setAttribute('aria-label', mode === 'flying' ? 'Flying directions' : 'Walking directions');
    for (const button of hud.querySelectorAll('.campus-walk-pad button')) button.setAttribute('aria-label', `${mode === 'flying' ? 'Fly' : 'Walk'} ${button.dataset.walkMove}`);
    status.textContent = feedback;
    runButton.setAttribute('aria-pressed', String(isRunning()));
    onChange(snapshot());
  }
  function message(text) { feedback = text; announce(); }
  function syncCamera() {
    camera.position.copy(feet).y += EYE; camera.rotation.set(pitch, yaw, 0, 'YXZ'); camera.updateMatrixWorld();
    // The 2D plan follows this same walker without copying its physics state.
    // Publish only changed poses; mode and feedback still use onChange.
    if (lastPose && lastPose.x === feet.x && lastPose.y === feet.y && lastPose.z === feet.z && lastPose.yaw === yaw && lastPose.pitch === pitch) return;
    lastPose = { x: feet.x, y: feet.y, z: feet.z, yaw, pitch };
    onPose({ siteFeet: { x: feet.x / FT, y: -feet.z / FT, elevation: feet.y / FT }, yawRadians: yaw, pitchRadians: pitch, grounded, jumping: mode === 'walking' && !grounded });
  }
  function focusCanvas() { if (!document.hidden && canFocus()) canvas.focus({ preventScroll: true }); }
  function releaseMouseLook() {
    wantsMouseLook = false;
    if (pointerLocked()) document.exitPointerLock();
  }
  function mouseLookError() {
    mouseLookPending = false;
    if (!wantsMouseLook) return;
    wantsMouseLook = false;
    if (navigating()) message('Mouse capture is unavailable. Drag the scene to look around.');
  }
  function requestMouseLook() {
    if (!navigating() || !canFocus() || pointerLocked() || mouseLookPending) return;
    if (typeof canvas.requestPointerLock !== 'function') { message('Drag the scene to look around.'); return; }
    wantsMouseLook = true; mouseLookPending = true;
    try {
      // Called directly from a mouse gesture, including the placement click.
      const result = canvas.requestPointerLock();
      result?.catch(mouseLookError);
    } catch { mouseLookError(); }
  }
  function wake() { suspended = false; requestDraw(); }
  function pause() {
    releaseMouseLook();
    keys.clear(); padDirections.clear(); lookPointer = null; placementDown = null; pendingPlacement = null;
    for (const id of captured) { try { canvas.releasePointerCapture(id); } catch {} }
    captured.clear(); movedSpeed = 0; velocity.set(0, 0, 0); suspended = true;
    for (const button of hud.querySelectorAll('[data-walk-move]')) button.removeAttribute('data-held');
    announce();
  }
  function exit() {
    pause(); mode = 'aerial'; marker.visible = false; feedback = ''; velocityY = 0;
    grounded = true; runningToggle = false; announce(); requestDraw();
  }
  function collisionAt(x, z, footY) {
    capsuleA.set(x, footY + RADIUS, z); capsuleB.set(x, footY + HEIGHT - RADIUS, z);
    let deepest = null;
    for (const record of surfaces.nearSolids(x, z)) {
      if (record.maxY < footY + EPS || record.minY > footY + HEIGHT || x < record.minX - RADIUS || x > record.maxX + RADIUS || z < record.minZ - RADIUS || z > record.maxZ + RADIUS) continue;
      // A walkable slope under the feet is support, not a wall intersecting the
      // bottom of the capsule. Roof undersides and surfaces above still collide.
      if (record.canSupport && record.normal.y >= SLOPE_COS) {
        const planeY = record.triangle.a.y - (record.normal.x * (x - record.triangle.a.x) + record.normal.z * (z - record.triangle.a.z)) / record.normal.y;
        if (planeY <= footY + EPS) continue;
      }
      const tri = record.triangle;
      let best = Infinity;
      const consider = (a, b) => { const d = a.distanceToSquared(b); if (d < best) { best = d; closestA.copy(a); closestB.copy(b); } };
      tri.closestPointToPoint(capsuleA, testPoint); consider(capsuleA, testPoint);
      tri.closestPointToPoint(capsuleB, testPoint); consider(capsuleB, testPoint);
      for (const [a, b] of [[tri.a, tri.b], [tri.b, tri.c], [tri.c, tri.a]]) { closestSegments(capsuleA, capsuleB, a, b, edgeA, edgeB); consider(edgeA, edgeB); }
      const denom = record.normal.y * (capsuleB.y - capsuleA.y);
      if (Math.abs(denom) > 1e-10) {
        const t = record.normal.dot(new THREE.Vector3().subVectors(tri.a, capsuleA)) / denom;
        if (t >= 0 && t <= 1) { testPoint.lerpVectors(capsuleA, capsuleB, t); if (tri.containsPoint(testPoint)) { best = 0; closestA.copy(testPoint); closestB.copy(testPoint); } }
      }
      if (best < (RADIUS - EPS) ** 2 && (!deepest || best < deepest.distanceSq)) {
        collisionNormal.subVectors(closestA, closestB); collisionNormal.y = 0;
        if (collisionNormal.lengthSq() < 1e-10) collisionNormal.set(record.normal.x, 0, record.normal.z);
        if (collisionNormal.lengthSq() > 0) collisionNormal.normalize();
        deepest = { distanceSq: best, normal: collisionNormal.clone(), name: record.name };
      }
    }
    return deepest;
  }
  function validStanding(x, z, elevation) {
    const terrain = surfaces.groundAt(x, z);
    if (!terrain) return { valid: false, reason: 'Choose a lawn, path, or roof inside the modeled campus.' };
    const surface = surfaces.solidSupportAt(x, z, terrain.y + .001, Number.isFinite(elevation) ? elevation + .025 : Infinity, true) || terrain;
    if (Number.isFinite(elevation) && Math.abs(surface.y - elevation) > .15) return { valid: false, reason: 'Choose the top of a roof, lawn, or path.' };
    if (surface.normal.y < SLOPE_COS) return { valid: false, reason: 'Choose a gentler slope or a path.' };
    if (collisionAt(x, z, surface.y)) return { valid: false, reason: 'Choose an open spot away from walls, trees, and equipment.' };
    return { valid: true, surface };
  }
  function startAt(x, z, facing, elevation) {
    const placement = validStanding(x, z, elevation);
    if (!placement.valid) { message(placement.reason); return false; }
    pause(); mode = navigationMode; suspended = false; marker.visible = false;
    feet.set(x, placement.surface.y, z); groundY = feet.y; groundSurface = placement.surface.name;
    yaw = facing; pitch = 0; velocityY = 0; velocity.set(0, 0, 0); grounded = mode === 'walking';
    feedback = ''; syncCamera(); announce(); focusCanvas(); requestDraw();
    return true;
  }
  function placementAt(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    ndc.set((clientX - rect.left) / rect.width * 2 - 1, 1 - (clientY - rect.top) / rect.height * 2);
    raycaster.setFromCamera(ndc, getAerialCamera());
    const hit = raycaster.intersectObjects(surfaces.rayMeshes, false).find(h => h.object.visible);
    if (!hit) return { valid: false, reason: 'Choose a lawn, path, or roof inside the modeled campus.' };
    const standing = validStanding(hit.point.x, hit.point.z, hit.point.y);
    return { ...standing, point: standing.valid ? new THREE.Vector3(hit.point.x, standing.surface.y, hit.point.z) : hit.point };
  }
  function showPlacement(point) {
    const result = placementAt(point.x, point.y);
    marker.visible = Boolean(result.point);
    if (result.point) { marker.position.copy(result.point).y += .025; marker.material.color.set(result.valid ? 0xeeb33c : 0xc6533d); }
    return result;
  }
  function placementYaw() {
    const direction = getAerialCamera().getWorldDirection(new THREE.Vector3());
    return Math.hypot(direction.x, direction.z) > 1e-5 ? Math.atan2(-direction.x, -direction.z) : THREE.MathUtils.degToRad((getAerialPose?.()?.bearing ?? CAMPUS_BEARING) - CAMPUS_BEARING);
  }
  function jump() {
    if (mode !== 'walking' || !grounded) return;
    velocityY = JUMP_SPEED; grounded = false; wake();
  }
  const moveCodes = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyE', 'KeyQ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight', 'Space']);
  const moveDirections = new Set(['forward', 'backward', 'left', 'right', 'up', 'down']);
  function look(dx, dy, touch) {
    const sensitivity = touch ? .004 : .003;
    yaw -= dx * sensitivity;
    pitch = THREE.MathUtils.clamp(pitch - dy * sensitivity, -Math.PI * .46, Math.PI * .46);
    syncCamera(); wake();
  }
  function command(name, value) {
    if (name === 'walk-exit') { exit(); return true; }
    if (name === 'walk-release-pointer') { pause(); requestDraw(); return true; }
    if (name === 'walk-input') {
      if (value?.kind === 'pause') { pause(); return true; }
      if (!navigating()) return false;
      if (value?.kind === 'key' && moveCodes.has(value.code) && typeof value.down === 'boolean') {
        if (value.down) {
          if (value.code === 'Space' && !keys.has('Space')) jump();
          keys.add(value.code); announce(); wake();
        } else { keys.delete(value.code); announce(); requestDraw(); }
        return true;
      }
      if (value?.kind === 'move' && moveDirections.has(value.direction) && typeof value.down === 'boolean') {
        if (value.down) { padDirections.add(value.direction); wake(); }
        else { padDirections.delete(value.direction); requestDraw(); }
        return true;
      }
      if (value?.kind === 'look' && Number.isFinite(value.dx) && Number.isFinite(value.dy) && typeof value.touch === 'boolean') {
        look(value.dx, value.dy, value.touch); return true;
      }
      return false;
    }
    if (name === 'walk-place-at' && mode === 'placing' && Number.isFinite(value?.x) && Number.isFinite(value?.y)) {
      return startAt(value.x * FT, -value.y * FT, placementYaw());
    }
    if (name === 'walk-place' || name === 'fly-place') {
      pause(); mode = 'placing'; suspended = false; marker.visible = false;
      navigationMode = name === 'fly-place' ? 'flying' : 'walking';
      feedback = 'Click or tap a lawn, path, or roof. End cancels placement.';
      announce(); focusCanvas(); requestDraw(); return true;
    }
    if (name === 'walk-start') {
      navigationMode = 'walking';
      // The audited exterior landing is east of Building 1's entrance canopy.
      for (const [x, y] of [[39, 224], [39, 236], [39, 212], [43, 224]]) if (startAt(x * FT, -y * FT, Math.PI / 2)) return true;
      message('The entrance is blocked. Use Start to choose a lawn, path, or roof.'); return false;
    }
    if (name === 'walk-run' && navigating() && (value === undefined || typeof value === 'boolean')) {
      runningToggle = typeof value === 'boolean' ? value : !runningToggle; announce(); focusCanvas(); wake(); return true;
    }
    return false;
  }
  function horizontalStep(dx, dz) {
    const nextX = feet.x + dx, nextZ = feet.z + dz;
    const surface = walkingSurface(nextX, nextZ);
    if (!surface || surface.y > feet.y + STEP) return false;
    const candidateY = grounded && surface.y >= feet.y - STEP ? surface.y : feet.y;
    const contact = collisionAt(nextX, nextZ, candidateY);
    if (!contact) { feet.x = nextX; feet.z = nextZ; if (grounded && Math.abs(surface.y - feet.y) <= STEP) feet.y = surface.y; return true; }
    collisionCount++;
    // Slide along the actual contacted wall. Axis fallbacks handle corners and
    // short posts without accumulating penetration into the next building.
    const dot = dx * contact.normal.x + dz * contact.normal.z;
    const slideX = dx - contact.normal.x * dot, slideZ = dz - contact.normal.z * dot;
    for (const [sx, sz] of [[slideX, slideZ], [dx, 0], [0, dz]]) {
      if (Math.hypot(sx, sz) < 1e-6) continue;
      const next = walkingSurface(feet.x + sx, feet.z + sz);
      if (!next || next.y > feet.y + STEP) continue;
      const y = grounded && Math.abs(next.y - feet.y) <= STEP ? next.y : feet.y;
      if (!collisionAt(feet.x + sx, feet.z + sz, y)) { feet.x += sx; feet.z += sz; feet.y = y; return true; }
    }
    return false;
  }
  function walkingSurface(x, z) {
    const terrain = surfaces.groundAt(x, z);
    if (!terrain) return null;
    return surfaces.solidSupportAt(x, z, terrain.y + .001, feet.y + (grounded ? STEP : .002)) || terrain;
  }
  function movement() {
    const forward = Number(keys.has('KeyW') || keys.has('ArrowUp') || padDirections.has('forward')) - Number(keys.has('KeyS') || keys.has('ArrowDown') || padDirections.has('backward'));
    const side = Number(keys.has('KeyD') || keys.has('ArrowRight') || padDirections.has('right')) - Number(keys.has('KeyA') || keys.has('ArrowLeft') || padDirections.has('left'));
    const up = mode === 'flying' ? Number(keys.has('Space') || keys.has('KeyE') || padDirections.has('up')) - Number(keys.has('KeyQ') || padDirections.has('down')) : 0;
    const length = Math.hypot(forward, side, up) || 1;
    return { x: (-Math.sin(yaw) * forward + Math.cos(yaw) * side) / length, y: up / length, z: (-Math.cos(yaw) * forward - Math.sin(yaw) * side) / length };
  }
  function update(dt) {
    if (mode === 'placing') { if (pendingPlacement) { showPlacement(pendingPlacement); pendingPlacement = null; } return; }
    if (!navigating()) return;
    suspended = false;
    const elapsed = THREE.MathUtils.clamp(Number.isFinite(dt) ? dt : 0, 0, .05);
    // An input can wake the render loop with dt=0. Keep its jump impulse alive
    // until time advances rather than treating the unchanged feet as a landing.
    if (elapsed === 0) { movedSpeed = 0; velocity.set(0, velocityY, 0); syncCamera(); return; }
    const input = movement(), speed = isRunning() ? RUN_SPEED : WALK_SPEED;
    if (mode === 'flying') {
      const old = feet.clone();
      feet.addScaledVector(new THREE.Vector3(input.x, input.y, input.z), speed * elapsed);
      const terrain = surfaces.groundAt(feet.x, feet.z, false);
      groundY = terrain?.y ?? 0; groundSurface = terrain?.name ?? 'Surrounding meadow';
      feet.y = THREE.MathUtils.clamp(feet.y, groundY, MAX_FLIGHT_ELEVATION);
      velocity.copy(feet).sub(old).divideScalar(elapsed);
      movedSpeed = velocity.length(); grounded = false; velocityY = 0;
      syncCamera(); return;
    }
    const steps = Math.max(1, Math.ceil(Math.max(elapsed / .016, speed * elapsed / .08))), step = elapsed / steps;
    const old = feet.clone();
    for (let i = 0; i < steps; i++) {
      if (input.x || input.z) horizontalStep(input.x * speed * step, input.z * speed * step);
      const surface = walkingSurface(feet.x, feet.z);
      if (!surface) { feet.copy(old); velocityY = 0; grounded = true; break; }
      groundY = surface.y; groundSurface = surface.name;
      if (feet.y > groundY + .025 || velocityY > 0) grounded = false;
      if (!grounded) {
        velocityY -= GRAVITY * step;
        const nextY = feet.y + velocityY * step;
        if (velocityY > 0 && collisionAt(feet.x, feet.z, nextY)) velocityY = 0;
        else feet.y = nextY;
        if (velocityY <= 0 && feet.y <= groundY) { feet.y = groundY; velocityY = 0; grounded = true; }
      } else { feet.y = groundY; velocityY = 0; }
    }
    movedSpeed = elapsed > 0 ? Math.hypot(feet.x - old.x, feet.z - old.z) / elapsed : 0;
    velocity.set(elapsed > 0 ? (feet.x - old.x) / elapsed : 0, velocityY, elapsed > 0 ? (feet.z - old.z) / elapsed : 0);
    syncCamera();
  }
  function resize(width, height) { camera.aspect = Math.max(1, width) / Math.max(1, height); camera.updateProjectionMatrix(); }
  function stop(event) { event.preventDefault(); event.stopImmediatePropagation(); }
  canvas.addEventListener('pointerdown', event => {
    if (mode === 'aerial' || (event.pointerType === 'mouse' && event.button !== 0)) return;
    stop(event); focusCanvas();
    if (navigating() && event.pointerType === 'mouse') {
      // Retain drag fallback if the browser cannot grant pointer lock.
      lookPointer = { id: event.pointerId, x: event.clientX, y: event.clientY, touch: false };
      requestMouseLook(); wake(); return;
    }
    canvas.setPointerCapture(event.pointerId); captured.add(event.pointerId);
    if (mode === 'placing') { placementDown = { id: event.pointerId, x: event.clientX, y: event.clientY }; pendingPlacement = { x: event.clientX, y: event.clientY }; }
    else if (lookPointer === null) lookPointer = { id: event.pointerId, x: event.clientX, y: event.clientY, touch: event.pointerType !== 'mouse' };
    wake();
  }, { capture: true });
  canvas.addEventListener('pointermove', event => {
    if (mode === 'aerial') return;
    stop(event);
    if (mode === 'placing') { pendingPlacement = { x: event.clientX, y: event.clientY }; wake(); return; }
    if (pointerLocked()) return; // Locked movement is processed once, by mousemove.
    if (lookPointer?.id !== event.pointerId) return;
    // A denied capture falls back to dragging inside the canvas. Releasing
    // outside it must not leave free-look active when the mouse returns.
    if (!lookPointer.touch && !(event.buttons & 1)) { lookPointer = null; return; }
    look(event.clientX - lookPointer.x, event.clientY - lookPointer.y, lookPointer.touch);
    lookPointer.x = event.clientX; lookPointer.y = event.clientY;
  }, { capture: true });
  function release(event) {
    if (mode === 'aerial') return;
    stop(event); captured.delete(event.pointerId);
    if (mode === 'placing' && event.type === 'pointerup' && placementDown?.id === event.pointerId) {
      if (Math.hypot(event.clientX - placementDown.x, event.clientY - placementDown.y) < 12) {
        const result = showPlacement({ x: event.clientX, y: event.clientY });
        if (result.valid) {
          if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
          startAt(result.point.x, result.point.z, placementYaw(), result.point.y);
          if (event.pointerType === 'mouse') requestMouseLook();
        }
        else message(result.reason);
      }
      placementDown = null;
    }
    if (lookPointer?.id === event.pointerId) lookPointer = null;
    requestDraw();
  }
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(type, release, { capture: true });
  document.addEventListener('mousemove', event => {
    if (!navigating() || !pointerLocked() || !canFocus()) return;
    stop(event); look(event.movementX, event.movementY, false);
  }, { capture: true });
  document.addEventListener('pointerlockchange', () => {
    const locked = pointerLocked();
    mouseLookPending = false;
    if (locked && (!wantsMouseLook || !navigating() || !canFocus())) { releaseMouseLook(); return; }
    const released = hadMouseLock && !locked;
    hadMouseLock = locked; lookPointer = null;
    if (released) pause();
    if (locked) feedback = '';
    announce(); requestDraw();
  });
  document.addEventListener('pointerlockerror', mouseLookError);
  canvas.addEventListener('wheel', event => { if (mode !== 'aerial') stop(event); }, { capture: true, passive: false });
  canvas.addEventListener('contextmenu', event => { if (mode !== 'aerial') event.preventDefault(); });
  canvas.addEventListener('keydown', event => {
    if (mode === 'aerial' || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.code === 'Escape') { stop(event); if (navigating()) pause(); else exit(); return; }
    if (!navigating() || !moveCodes.has(event.code)) return;
    stop(event); if (event.code === 'Space' && !keys.has('Space')) jump();
    keys.add(event.code); announce(); wake();
  }, { capture: true });
  canvas.addEventListener('keyup', event => {
    if (!navigating() || !moveCodes.has(event.code)) return;
    stop(event); keys.delete(event.code); announce(); requestDraw();
  }, { capture: true });
  canvas.addEventListener('blur', pause);
  window.addEventListener('blur', pause);
  document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
  hud.addEventListener('keydown', event => { if (event.key === 'Escape') { stop(event); if (navigating()) pause(); else exit(); } });
  for (const button of hud.querySelectorAll('[data-walk-move]')) {
    const direction = button.dataset.walkMove;
    const down = event => { event.preventDefault(); if (!navigating()) return; padDirections.add(direction); button.dataset.held = ''; if (event.pointerId !== undefined) button.setPointerCapture(event.pointerId); wake(); };
    const up = event => { event.preventDefault(); padDirections.delete(direction); button.removeAttribute('data-held'); requestDraw(); };
    button.addEventListener('pointerdown', down); for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(type, up);
    button.addEventListener('keydown', event => { if ([' ', 'Enter'].includes(event.key)) down(event); });
    button.addEventListener('keyup', event => { if ([' ', 'Enter'].includes(event.key)) up(event); });
    button.addEventListener('blur', () => { padDirections.delete(direction); button.removeAttribute('data-held'); });
  }
  const jumpButton = hud.querySelector('#campus-walk-jump');
  function actionButton(button, action) {
    button.addEventListener('pointerdown', event => {
      // A third finger does not reliably produce a click. Activate touch here,
      // without moving focus or clearing the other held movement/look inputs.
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      event.preventDefault();
      action();
    });
    button.addEventListener('click', event => {
      if (event.detail === 0) action(); // Keyboard and assistive activation.
    });
  }
  actionButton(jumpButton, () => { jump(); focusCanvas(); });
  actionButton(runButton, () => { command('walk-run'); focusCanvas(); });
  hud.querySelector('#campus-walk-exit').addEventListener('click', exit);
  const rect = canvas.getBoundingClientRect(); resize(rect.width, rect.height);
  return Object.freeze({
    get mode() { return mode; }, get camera() { return navigating() ? camera : null; }, get state() { return snapshot(); },
    get needsAnimation() { const input = movement(); return navigating() && !suspended && (Boolean(input.x || input.y || input.z) || (mode === 'walking' && !grounded)); },
    clearanceHeight: surfaces.clearanceHeight,
    command, update, resize, pause, exit
  });
}
