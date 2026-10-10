import * as THREE from 'three';

const ROOF_CELL = .65;
const RAIN_DROPS = 2800;
const VOLUME_WIDTH = 72;
const VOLUME_HEIGHT = 38;
const NO_ROOF = -10000;
const clamp = THREE.MathUtils.clamp;

function randomSequence(seed = 712703) {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

// A small static height texture stops each drop at the first overhead roof.
// It is built once from the actual roof/vault/ceiling triangles. Courtyard gaps
// and spaces between disconnected buildings remain open; no per-frame raycast
// or whole-building bounding box is used during walking or flying.
function createRoofMap(model) {
  const surfaces = [];
  const bounds = new THREE.Box3();
  const point = new THREE.Vector3();
  model?.updateMatrixWorld(true);
  model?.traverse(object => {
    if (!object.isMesh || !object.geometry?.getAttribute('position')) return;
    const name = object.name.replace(/_/g, ' ');
    if (!/roof|ceiling.*acoustic|^School canopy|Classical school entrance.*vault|Skybridge.*continuous-vault/i.test(name)) return;
    // Natural leaves and the shrine's jasmine canopy are intentionally porous.
    if (/tree|jasmine/i.test(name)) return;
    surfaces.push(object);
    const positions = object.geometry.getAttribute('position');
    for (let i = 0; i < positions.count; i++) {
      point.fromBufferAttribute(positions, i).applyMatrix4(object.matrixWorld);
      bounds.expandByPoint(point);
    }
  });
  if (bounds.isEmpty()) bounds.set(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
  bounds.min.x -= ROOF_CELL; bounds.min.z -= ROOF_CELL;
  bounds.max.x += ROOF_CELL; bounds.max.z += ROOF_CELL;
  const width = Math.max(1, Math.min(1024, Math.ceil((bounds.max.x - bounds.min.x) / ROOF_CELL)));
  const height = Math.max(1, Math.min(1024, Math.ceil((bounds.max.z - bounds.min.z) / ROOF_CELL)));
  const dx = (bounds.max.x - bounds.min.x) / width, dz = (bounds.max.z - bounds.min.z) / height;
  const data = new Float32Array(width * height).fill(NO_ROOF);
  const vertices = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), normal = new THREE.Vector3();
  let triangleCount = 0;
  const pad = Math.hypot(dx, dz) / 2;
  for (const object of surfaces) {
    const positions = object.geometry.getAttribute('position'), indices = object.geometry.index;
    const count = indices ? indices.count : positions.count;
    for (let i = 0; i + 2 < count; i += 3) {
      for (let j = 0; j < 3; j++) vertices[j].fromBufferAttribute(positions, indices ? indices.getX(i + j) : i + j).applyMatrix4(object.matrixWorld);
      const [a, b, c] = vertices;
      ab.subVectors(b, a); ac.subVectors(c, a); normal.crossVectors(ab, ac);
      if (normal.lengthSq() < 1e-12 || Math.abs(normal.y) / normal.length() < .025) continue;
      const area = (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
      if (Math.abs(area) < 1e-9) continue;
      triangleCount++;
      const sign = Math.sign(area);
      const edges = [[a, b], [b, c], [c, a]].map(([p, q]) => ({
        x: p.x, z: p.z, dx: q.x - p.x, dz: q.z - p.z,
        margin: pad * Math.hypot(q.x - p.x, q.z - p.z)
      }));
      const x0 = clamp(Math.floor((Math.min(a.x, b.x, c.x) - pad - bounds.min.x) / dx), 0, width - 1);
      const x1 = clamp(Math.floor((Math.max(a.x, b.x, c.x) + pad - bounds.min.x) / dx), 0, width - 1);
      const z0 = clamp(Math.floor((Math.min(a.z, b.z, c.z) - pad - bounds.min.z) / dz), 0, height - 1);
      const z1 = clamp(Math.floor((Math.max(a.z, b.z, c.z) + pad - bounds.min.z) / dz), 0, height - 1);
      const slopePad = Math.hypot(normal.x, normal.z) / Math.abs(normal.y) * pad;
      const maximum = Math.max(a.y, b.y, c.y);
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
        const px = bounds.min.x + (x + .5) * dx, pz = bounds.min.z + (z + .5) * dz;
        if (edges.some(edge => sign * (edge.dx * (pz - edge.z) - edge.dz * (px - edge.x)) < -edge.margin)) continue;
        const y = Math.min(maximum, a.y - (normal.x * (px - a.x) + normal.z * (pz - a.z)) / normal.y + slopePad) + .08;
        const index = z * width + x;
        if (y > data[index]) data[index] = y;
      }
    }
  }
  const texture = new THREE.DataTexture(data, width, height, THREE.RedFormat, THREE.FloatType);
  texture.name = 'Weather • cached overhead roof heights';
  texture.minFilter = texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false; texture.needsUpdate = true;
  return { texture, origin: new THREE.Vector2(bounds.min.x, bounds.min.z),
    span: new THREE.Vector2(bounds.max.x - bounds.min.x, bounds.max.z - bounds.min.z),
    sample(x, z) {
      const ix = Math.floor((x - bounds.min.x) / dx), iz = Math.floor((z - bounds.min.z) / dz);
      return ix >= 0 && ix < width && iz >= 0 && iz < height ? data[iz * width + ix] : NO_ROOF;
    }, diagnostics: Object.freeze({ width, height, bytes: data.byteLength,
      cellMeters: [dx, dz], meshCount: surfaces.length, triangleCount,
      sourceNames: surfaces.map(object => object.name), perFrameModelRaycasts: 0 }) };
}

const rainVertex = /* glsl */`
attribute vec4 aSeed;
attribute float aTip;
uniform float uTime;
uniform vec3 uCenter;
uniform sampler2D uRoofHeight;
uniform vec2 uRoofOrigin;
uniform vec2 uRoofSpan;
uniform float uOpacity;
varying float vAlpha;
float groundHeight(vec2 p) {
  float east = p.x / .3048, north = -p.y / .3048;
  float west = smoothstep(0.0, 1.0, (-east - 115.0) / 155.0);
  float south = smoothstep(0.0, 1.0, (125.0 - north) / 60.0);
  float lowerEast = smoothstep(0.0, 1.0, (east - 260.0) / 95.0);
  return (-14.0 * west - 11.0 * max(south * .75 * clamp((east - 155.0) / 110.0, 0.0, 1.0), lowerEast * .9) - .1) * .3048;
}
void main() {
  // World-anchored modulo positions wrap only at the far volume edges. Drops
  // do not stick to the view or jump when the visitor crosses a camera cell.
  vec2 drift = vec2(.82, .23) * uTime;
  vec2 xz = mod(aSeed.xy * ${VOLUME_WIDTH.toFixed(1)} + drift - uCenter.xz + ${VOLUME_WIDTH / 2}.0, ${VOLUME_WIDTH.toFixed(1)}) - ${VOLUME_WIDTH / 2}.0 + uCenter.xz;
  float speed = 14.0 + aSeed.w * 7.0;
  float y = mod(aSeed.z * ${VOLUME_HEIGHT.toFixed(1)} - uTime * speed - uCenter.y + ${VOLUME_HEIGHT * .45}, ${VOLUME_HEIGHT.toFixed(1)}) - ${VOLUME_HEIGHT * .45} + uCenter.y;
  vec2 uv = (xz - uRoofOrigin) / uRoofSpan;
  float roof = -10000.0;
  if (min(uv.x, uv.y) >= 0.0 && max(uv.x, uv.y) <= 1.0) roof = texture2D(uRoofHeight, uv).r;
  float floorY = max(groundHeight(xz), roof);
  float length = .55 + aSeed.w * .85;
  vec3 world = vec3(xz.x - aTip * .028, max(y + aTip * length, floorY + .04), xz.y - aTip * .008);
  float edge = 1.0 - smoothstep(24.0, 35.0, max(abs(xz.x - uCenter.x), abs(xz.y - uCenter.z)));
  float nearFade = smoothstep(.3, 1.0, distance(world, uCenter));
  vAlpha = (y > floorY + .04 ? 1.0 : 0.0) * edge * nearFade * uOpacity;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;
const rainFragment = /* glsl */`
varying float vAlpha;
void main() {
  if (vAlpha < .004) discard;
  gl_FragColor = vec4(.68, .78, .90, vAlpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Transient rain never enters the campus model, collider, or download export.
 * update(nowSeconds, {camera, active}) pauses safely across presentation changes.
 */
export function createCampusWeather({ scene, model, lighting, atmosphere, onLightning = null, reducedMotion = null } = {}) {
  if (!scene?.isScene || !model?.isObject3D) throw new TypeError('Weather needs the campus scene and loaded model.');
  const roof = createRoofMap(model);
  const random = randomSequence();
  const positions = new Float32Array(RAIN_DROPS * 2 * 3);
  const seeds = new Float32Array(RAIN_DROPS * 2 * 4), tips = new Float32Array(RAIN_DROPS * 2);
  for (let i = 0; i < RAIN_DROPS; i++) {
    const seed = [random(), random(), random(), random()];
    seeds.set(seed, i * 8); seeds.set(seed, i * 8 + 4); tips[i * 2 + 1] = 1;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
  geometry.setAttribute('aTip', new THREE.BufferAttribute(tips, 1));
  const uniforms = { uTime: { value: 0 }, uCenter: { value: new THREE.Vector3() },
    uRoofHeight: { value: roof.texture }, uRoofOrigin: { value: roof.origin }, uRoofSpan: { value: roof.span }, uOpacity: { value: .44 } };
  const material = new THREE.ShaderMaterial({ uniforms, vertexShader: rainVertex, fragmentShader: rainFragment,
    transparent: true, depthTest: true, depthWrite: false, toneMapped: true, fog: false });
  const rain = new THREE.LineSegments(geometry, material);
  rain.name = 'Weather • falling rain'; rain.frustumCulled = false;
  rain.raycast = () => {}; rain.visible = false;
  scene.add(rain);

  // One short, distant fork. Depth testing keeps it behind buildings. A single
  // smooth pulse every ~20–38s avoids repeated flashes and flicker/strobing.
  const boltPoints = [];
  let previous = [0, 24, 0];
  for (let i = 1; i <= 12; i++) {
    const next = [(random() - .5) * 5.5, 24 - i * 2, 0];
    boltPoints.push(...previous, ...next);
    if (i === 5 || i === 8) boltPoints.push(...next, next[0] + (i === 5 ? -7 : 6), next[1] - 3.5, 0);
    previous = next;
  }
  const boltGeometry = new THREE.BufferGeometry();
  boltGeometry.setAttribute('position', new THREE.Float32BufferAttribute(boltPoints, 3));
  const boltMaterial = new THREE.LineBasicMaterial({ color: 0xd7e4ff, transparent: true, opacity: 0,
    depthTest: true, depthWrite: false, toneMapped: false });
  const bolt = new THREE.LineSegments(boltGeometry, boltMaterial);
  bolt.name = 'Weather • distant sky lightning'; bolt.visible = false; bolt.frustumCulled = false; bolt.raycast = () => {};
  scene.add(bolt);
  const media = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
  let prefersReducedMotion = reducedMotion == null ? Boolean(media?.matches) : Boolean(reducedMotion);
  let enabled = false, active = false, disposed = false, elapsed = 0, lastNow = null;
  let lightningCount = 0, thunderCount = 0, flashStarted = -Infinity, nextLightning = 9 + random() * 4, flashIntensity = 0;
  let lastCamera = null;
  const direction = new THREE.Vector3(), boltTarget = new THREE.Vector3();

  function clearFlash() {
    flashStarted = -Infinity; flashIntensity = 0;
    bolt.visible = false; boltMaterial.opacity = 0;
    atmosphere?.setLightning?.(0);
  }
  const onMotionChange = event => {
    if (reducedMotion != null) return;
    prefersReducedMotion = event.matches;
    if (prefersReducedMotion) clearFlash();
  };
  media?.addEventListener?.('change', onMotionChange);

  function setEnabled(value) {
    if (disposed) return false;
    const next = Boolean(value);
    if (next === enabled) return false;
    enabled = next; lastNow = null;
    clearFlash();
    lighting?.setWeather?.(enabled);
    atmosphere?.setWeather?.(enabled);
    rain.visible = enabled && active && Boolean(lastCamera);
    if (enabled) nextLightning = elapsed + 9 + random() * 4;
    return true;
  }
  function setActive(value) {
    if (disposed) return false;
    const next = Boolean(value);
    if (next === active) return false;
    active = next; lastNow = null;
    rain.visible = enabled && active && Boolean(lastCamera);
    if (!active) clearFlash();
    return true;
  }
  function update(now, { camera = lastCamera, active: visibility = active } = {}) {
    if (disposed) return false;
    setActive(Boolean(visibility) && !globalThis.document?.hidden);
    if (camera?.isCamera) lastCamera = camera;
    if (!enabled || !active || !lastCamera || !Number.isFinite(now)) { lastNow = null; rain.visible = false; return false; }
    const dt = lastNow == null ? 0 : clamp(now - lastNow, 0, .08);
    lastNow = now; elapsed += dt;
    lastCamera.getWorldPosition(uniforms.uCenter.value);
    uniforms.uTime.value = elapsed;
    uniforms.uOpacity.value = THREE.MathUtils.lerp(.24, .46, lighting?.state?.daylight ?? 1);
    rain.visible = true;
    if (elapsed >= nextLightning) {
      nextLightning = elapsed + 20 + random() * 18;
      lastCamera.getWorldDirection(direction); direction.y = 0;
      if (direction.lengthSq() < .001) direction.set(0, 0, -1); else direction.normalize();
      direction.applyAxisAngle(THREE.Object3D.DEFAULT_UP, (random() - .5) * 1.1);
      if (!prefersReducedMotion) {
        flashStarted = elapsed; lightningCount++;
        bolt.position.copy(uniforms.uCenter.value).addScaledVector(direction, 175);
        bolt.position.y = Math.max(18, uniforms.uCenter.value.y + 10);
        boltTarget.copy(uniforms.uCenter.value); boltTarget.y = bolt.position.y;
        bolt.lookAt(boltTarget);
      }
      // Reduced motion suppresses the visual flash, while quiet distant
      // thunder still follows the visitor's existing sound/mute preference.
      thunderCount++;
      onLightning?.({ strength: .48, delaySeconds: .65 + random() * .8, pan: clamp(direction.x * .45, -.6, .6) });
    }
    const phase = (elapsed - flashStarted) / .48;
    flashIntensity = !prefersReducedMotion && phase >= 0 && phase < 1 ? Math.sin(phase * Math.PI) * .42 : 0;
    bolt.visible = flashIntensity > .001;
    boltMaterial.opacity = flashIntensity * 1.7;
    atmosphere?.setLightning?.(flashIntensity);
    return true;
  }
  function dispose() {
    if (disposed) return;
    setEnabled(false); clearFlash(); disposed = true;
    media?.removeEventListener?.('change', onMotionChange);
    rain.removeFromParent(); bolt.removeFromParent();
    geometry.dispose(); material.dispose(); boltGeometry.dispose(); boltMaterial.dispose(); roof.texture.dispose();
  }
  return Object.freeze({ setEnabled, setActive, update, dispose,
    shelterHeightAt: (x, z) => roof.sample(x, z),
    get state() { return Object.freeze({ enabled, active, visible: rain.visible, flashIntensity, lightningCount, thunderCount,
      rainDropCount: RAIN_DROPS, roofMapReady: true, roofMap: roof.diagnostics,
      elapsedSeconds: elapsed, nextLightningInSeconds: Math.max(0, nextLightning - elapsed),
      cameraPosition: uniforms.uCenter.value.toArray(),
      cameraUnderRoof: roof.sample(uniforms.uCenter.value.x, uniforms.uCenter.value.z) > uniforms.uCenter.value.y,
      reducedMotion: prefersReducedMotion, disposed, modelGeometryChanged: false,
      perFrameModelRaycasts: 0, rainDrawCalls: 1, lightningDrawCalls: bolt.visible ? 1 : 0 }); }
  });
}
