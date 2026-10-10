import * as THREE from 'three';

const FT = 0.3048;
const TAU = Math.PI * 2;
const NO_RAYCAST = () => {};
// Coordinates here are site feet: east, north, elevation. The route stays
// west of the bell tower and above the school roofs and playground trees.
export const CAMPUS_BIRD_ROUTE = Object.freeze({
  centerFeet: Object.freeze([112, 210]),
  radiusFeet: Object.freeze([62, 62]),
  altitudeFeet: Object.freeze([64, 74]),
  lapSeconds: 25,
  daylightMinutes: Object.freeze([390, 1140]),
});

// Two birds share each corridor. Their opposite phases and small height offsets
// keep them apart, while different lap lengths spread movement across campus.
export const CAMPUS_BIRD_ROUTES = Object.freeze([
  CAMPUS_BIRD_ROUTE,
  Object.freeze({ centerFeet: Object.freeze([85, 35]), radiusFeet: Object.freeze([60, 48]), altitudeFeet: Object.freeze([52, 62]), lapSeconds: 31 }),
  Object.freeze({ centerFeet: Object.freeze([201, 158]), radiusFeet: Object.freeze([22, 34]), altitudeFeet: Object.freeze([58, 68]), lapSeconds: 22 }),
  Object.freeze({ centerFeet: Object.freeze([-210, 50]), radiusFeet: Object.freeze([60, 50]), altitudeFeet: Object.freeze([64, 74]), lapSeconds: 36 }),
]);

// Five shared geometries and one material serve the entire flock. Each bird
// has its own wing joints, so flapping and gliding are not synchronized.
function makeBird() {
  const geometries = [];
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .82, metalness: 0 });
  material.name = 'Campus bird • warm gray plumage';
  const colors = {
    back: new THREE.Color('#8c8172'), breast: new THREE.Color('#d2c8b4'),
    head: new THREE.Color('#96938b'), dark: new THREE.Color('#444852'),
    wing: new THREE.Color('#797b80'), edge: new THREE.Color('#b6b4ab'),
    tail: new THREE.Color('#8d6750'), beak: new THREE.Color('#333333'),
    eye: new THREE.Color('#111518'),
  };
  function batch() {
    const position = [], normal = [], color = [], index = [];
    const matrix = new THREE.Matrix4(), rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3(), center = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0), direction = new THREE.Vector3();
    const normalMatrix = new THREE.Matrix3(), p = new THREE.Vector3(), n = new THREE.Vector3();
    function add(geometry, tint, at, size, quaternion = null) {
      center.set(at[0], at[1], at[2]); scale.set(size[0], size[1], size[2]);
      matrix.compose(center, quaternion || rotation.identity(), scale);
      normalMatrix.getNormalMatrix(matrix);
      const a = geometry.attributes.position, b = geometry.attributes.normal, offset = position.length / 3;
      for (let i = 0; i < a.count; i++) {
        p.fromBufferAttribute(a, i).applyMatrix4(matrix);
        n.fromBufferAttribute(b, i).applyMatrix3(normalMatrix).normalize();
        position.push(p.x, p.y, p.z); normal.push(n.x, n.y, n.z); color.push(tint.r, tint.g, tint.b);
      }
      if (geometry.index) for (let i = 0; i < geometry.index.count; i++) index.push(offset + geometry.index.getX(i));
      else for (let i = 0; i < a.count; i++) index.push(offset + i);
      geometry.dispose();
    }
    function oval(tint, at, size, width = 10, height = 6) {
      add(new THREE.SphereGeometry(1, width, height), tint, at, size);
    }
    function feather(tint, a, b, width, thickness) {
      direction.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      const length = direction.length();
      rotation.setFromUnitVectors(up, direction.multiplyScalar(1 / length));
      add(new THREE.SphereGeometry(1, 6, 4), tint,
        [(a[0] + b[0]) * .5, (a[1] + b[1]) * .5, (a[2] + b[2]) * .5],
        [width, length * .5, thickness], rotation);
    }
    function mesh(name) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
      geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(color, 3));
      geometry.setIndex(index); geometry.computeBoundingSphere(); geometries.push(geometry);
      const mesh = new THREE.Mesh(geometry, material); mesh.name = name;
      mesh.castShadow = false; mesh.receiveShadow = false; mesh.raycast = NO_RAYCAST;
      return mesh;
    }
    return { add, oval, feather, mesh };
  }
  const root = new THREE.Group(); root.name = 'Campus ambience • bird';
  root.scale.setScalar(.65);
  root.userData.campusAmbient = true; root.userData.excludeFromCollision = true;
  const body = batch();
  body.oval(colors.back, [0, .01, .015], [.105, .09, .235], 12, 8);
  body.oval(colors.breast, [0, -.025, -.06], [.088, .068, .15]);
  body.oval(colors.head, [0, .055, -.195], [.071, .068, .080]);
  body.oval(colors.breast, [0, .015, -.227], [.051, .034, .045]);
  const beakRotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  body.add(new THREE.ConeGeometry(1, 2, 6), colors.beak, [0, .037, -.294], [.026, .047, .021], beakRotation);
  for (const sign of [-1, 1]) {
    body.oval(colors.eye, [sign * .061, .073, -.220], [.008, .009, .008], 6, 4);
    body.feather(colors.dark, [sign * .039, -.064, .10], [sign * .031, -.079, .18], .007, .007);
  }
  // Individually tapered tail feathers produce a small, recognizable fan.
  for (let i = 0; i < 5; i++) {
    const spread = (i - 2) * .026;
    body.feather(i === 0 || i === 4 ? colors.dark : colors.tail,
      [spread * .35, -.004, .16], [spread, -.022, .38 - Math.abs(i - 2) * .022], .024, .008);
  }
  root.add(body.mesh('Campus bird • body head and tail'));
  const wings = [];
  for (const sign of [-1, 1]) {
    const shoulder = new THREE.Group(); shoulder.name = sign < 0 ? 'Bird wing left' : 'Bird wing right';
    shoulder.position.set(sign * .075, .020, -.025); root.add(shoulder);
    const inner = batch();
    // Overlapping feather forms give rounded leading edges and layered trailing edges.
    inner.oval(colors.wing, [sign * .14, 0, .01], [.19, .021, .125]);
    for (let i = 0; i < 5; i++) {
      const x = .025 + i * .059;
      inner.feather(i < 2 ? colors.edge : colors.wing,
        [sign * x, .004, -.069 + i * .012], [sign * (x + .025), -.004, .12 + i * .019], .030, .010);
    }
    shoulder.add(inner.mesh('Campus bird • inner wing ' + sign));
    const wrist = new THREE.Group(); wrist.name = sign < 0 ? 'Bird wrist left' : 'Bird wrist right';
    wrist.position.set(sign * .30, 0, .042); shoulder.add(wrist);
    const outer = batch();
    for (let i = 0; i < 6; i++) {
      const x = .20 - i * .013, back = -.010 + i * .047;
      outer.feather(i === 0 ? colors.wing : colors.dark,
        [sign * .002, 0, -.055 + i * .021], [sign * x, -.010, back], .022, .007);
    }
    wrist.add(outer.mesh('Campus bird • primary feathers ' + sign));
    wings.push({ sign, shoulder, wrist });
  }
  return { root, wings, geometries, material };
}

/** Scene sibling only: never add the flock to the model/collision tree.
 * Inactive/night intervals are discarded, so resuming a tab or switching back
 * from 2D does not advance any of the birds while the scene is paused.
 */
export function createCampusBird({ scene }) {
  if (!scene?.isScene) throw new TypeError('createCampusBird requires a THREE.Scene');
  const prototype = makeBird();
  const { geometries, material } = prototype;
  const flock = new THREE.Group(); flock.name = 'Campus ambience • bird flock';
  flock.userData.campusAmbient = true; flock.userData.excludeFromCollision = true;
  scene.add(flock); flock.visible = false;
  const birds = CAMPUS_BIRD_ROUTES.flatMap((route, routeIndex) => [0, 1].map(member => {
    const index = routeIndex * 2 + member;
    const root = index === 0 ? prototype.root : prototype.root.clone(true);
    root.name = 'Campus bird • ' + (index + 1);
    delete root.userData.campusAmbient;
    root.scale.setScalar(.62 + (index % 3) * .035);
    root.traverse(object => { if (object.isMesh) object.raycast = NO_RAYCAST; });
    flock.add(root);
    const wings = [-1, 1].map(sign => ({
      sign,
      shoulder: root.getObjectByName(sign < 0 ? 'Bird wing left' : 'Bird wing right'),
      wrist: root.getObjectByName(sign < 0 ? 'Bird wrist left' : 'Bird wrist right'),
    }));
    return { root, wings, route, routeIndex,
      phase: .72 + routeIndex * .87 + member * Math.PI,
      heightOffsetFeet: member ? 2 : -2,
      direction: routeIndex % 2 ? -1 : 1,
      flapPhase: index * 1.37,
      flapRate: 2.35 + (index % 4) * .14,
    };
  }));
  let enabled = true, disposed = false, lastElapsed = null, flightTime = 0;
  let previousRunning = false;
  const positionsMeters = birds.map(() => [0, 0, 0]);
  const state = {
    active: false, visible: false, daylight: false, paused: true,
    flightSeconds: 0, laps: 0, wingSpanMeters: .83,
    birdCount: birds.length, routeCount: CAMPUS_BIRD_ROUTES.length,
    triangles: geometries.reduce((n, g) => n + g.index.count / 3, 0) * birds.length,
    meshCount: geometries.length * birds.length,
    uniqueGeometries: geometries.length, materialCount: 1,
    positionMeters: positionsMeters[0], positionsMeters,
  };
  function update(elapsedSeconds, options) {
    if (disposed) return state;
    const elapsed = Number.isFinite(elapsedSeconds) ? elapsedSeconds : 0;
    const active = options?.active !== false;
    const minutes = Number.isFinite(options?.minutes) ? ((options.minutes % 1440) + 1440) % 1440 : 840;
    const daylight = minutes >= CAMPUS_BIRD_ROUTE.daylightMinutes[0] && minutes < CAMPUS_BIRD_ROUTE.daylightMinutes[1];
    const running = enabled && active && daylight;
    const dt = lastElapsed === null ? 0 : Math.max(0, Math.min(.1, elapsed - lastElapsed));
    lastElapsed = elapsed;
    if (running && previousRunning) flightTime += dt;
    previousRunning = running;
    state.active = enabled && active; state.daylight = daylight;
    state.visible = flock.visible = running; state.paused = !running;
    if (!running) return state;
    for (let index = 0; index < birds.length; index++) {
      const bird = birds[index];
      const { root, route, direction } = bird;
      const a = flightTime * TAU / route.lapSeconds * direction + bird.phase;
      const sin = Math.sin(a), cos = Math.cos(a);
      const amplitude = (route.altitudeFeet[1] - route.altitudeFeet[0]) * .5;
      const centerHeight = (route.altitudeFeet[0] + route.altitudeFeet[1]) * .5;
      const elevation = centerHeight + amplitude * Math.sin(a * 2 + .35) + bird.heightOffsetFeet;
      const [rx, ry] = route.radiusFeet;
      root.position.set((route.centerFeet[0] + rx * cos) * FT, elevation * FT,
        -(route.centerFeet[1] + ry * sin) * FT);
      // Local -Z follows the ellipse tangent; pitch follows its vertical slope.
      const tangentLength = Math.hypot(rx * sin, ry * cos);
      const pitch = Math.atan2(2 * amplitude * Math.cos(a * 2 + .35) * direction, tangentLength);
      const yaw = Math.atan2(rx * sin * direction, ry * cos * direction);
      root.rotation.set(pitch, yaw, .12 * direction, 'YXZ');
      const cycle = (flightTime + bird.flapPhase) % 8.4;
      const flapEnvelope = cycle < 3.0 ? Math.sin(Math.PI * cycle / 3.0) ** 2 : 0;
      const wingTime = (flightTime + bird.flapPhase) * TAU * bird.flapRate;
      const flap = Math.sin(wingTime) * .57 * flapEnvelope;
      const fold = Math.max(0, Math.cos(wingTime)) * .23 * flapEnvelope;
      for (const wing of bird.wings) {
        wing.shoulder.rotation.z = wing.sign * (.055 + flap);
        wing.wrist.rotation.z = wing.sign * (-.04 - flap * .34 + fold);
        wing.wrist.rotation.y = -wing.sign * (.04 + fold * .6);
      }
      const position = positionsMeters[index];
      position[0] = root.position.x; position[1] = root.position.y; position[2] = root.position.z;
    }
    state.flightSeconds = flightTime; state.laps = flightTime / CAMPUS_BIRD_ROUTE.lapSeconds;
    return state;
  }
  function setActive(value) {
    enabled = !!value;
    if (!enabled) { flock.visible = false; previousRunning = false; state.visible = false; state.paused = true; state.active = false; }
  }
  function dispose() {
    if (disposed) return;
    disposed = true; scene.remove(flock);
    // Clones share these resources; each is released exactly once.
    for (const geometry of geometries) geometry.dispose();
    material.dispose(); flock.clear(); state.active = false; state.visible = false; state.paused = true;
  }
  return { update, setActive, state, dispose };
}
