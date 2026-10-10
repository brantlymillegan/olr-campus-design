import * as THREE from 'three';

const FT = 0.3048;
const LAWN_TILE_METERS = 2.51;
const clamp = THREE.MathUtils.clamp;
const mix = THREE.MathUtils.lerp;
const smooth = (a, b, x) => THREE.MathUtils.smoothstep(x, a, b);

const COLOR_SATURATION = 1.24;
function installCampusColorLook() {
  // A modest saturation lift within the existing AgX shader keeps highlights
  // gentle without a full-screen postprocessing pass. Neutral surfaces stay
  // neutral. Install before the first visible draw, once per viewer window.
  const chunk = THREE.ShaderChunk.tonemapping_pars_fragment;
  if (chunk.includes('// Campus color look')) return;
  const ending = '\treturn color;\n}\nvec3 NeutralToneMapping';
  if (!chunk.includes(ending)) throw new Error('The campus color look needs the expected AgX shader.');
  THREE.ShaderChunk.tonemapping_pars_fragment = chunk.replace(ending,
    `\t// Campus color look\n\tfloat luminance = dot( color, vec3( 0.2126, 0.7152, 0.0722 ) );\n\treturn clamp( mix( vec3( luminance ), color, ${COLOR_SATURATION.toFixed(2)} ), 0.0, 1.0 );\n}\nvec3 NeutralToneMapping`);
}

// The same continuous field as build-campus.py, with glTF's Y-up/-Z north.
export function sampleCampusGround(x, z) {
  const east = x / FT, north = -z / FT;
  const west = smooth(0, 1, (-east - 115) / 155);
  const south = smooth(0, 1, (125 - north) / 60);
  const lowerEast = smooth(0, 1, (east - 260) / 95);
  return (-14 * west - 11 * Math.max(south * .75 * clamp((east - 155) / 110, 0, 1), lowerEast * .9) - .1) * FT;
}

// Match the actual exported grass at the finite landform's perimeter. This
// annulus belongs to the scene, not the model: it changes neither camera fitting
// nor the walkthrough's terrain/collision index. The fullscreen backdrop still
// supplies the infinite horizon beyond the camera's far clipping plane.
function createSurroundingTerrain(model) {
  if (!model) return null;
  let terrain = null, lawnMaterial = null;
  model.updateMatrixWorld(true);
  model.traverse(object => {
    if (!object.isMesh || !/Landform.*upper.campus/i.test(object.name)) return;
    const candidate = (Array.isArray(object.material) ? object.material : [object.material])
      .find(material => /Campus.lawn/i.test(material?.name || ''));
    if (candidate) { terrain = object; lawnMaterial = candidate; }
  });
  if (!terrain || !lawnMaterial) return null;
  const source = terrain.geometry;
  const sourcePositions = source.getAttribute('position');
  const sourceNormals = source.getAttribute('normal');
  const sourceUVs = source.getAttribute('uv');
  if (!sourcePositions || !sourceNormals || !sourceUVs) return null;

  const xMin = -500 * FT, xMax = 530 * FT, zMin = -450 * FT, zMax = 290 * FT;
  const xSteps = 103, zSteps = 74;
  const boundary = new Map();
  const position = new THREE.Vector3(), normal = new THREE.Vector3();
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(terrain.matrixWorld);
  for (let i = 0; i < sourcePositions.count; i++) {
    position.fromBufferAttribute(sourcePositions, i).applyMatrix4(terrain.matrixWorld);
    const gridX = Math.round((position.x - xMin) / (10 * FT));
    const gridZ = Math.round((position.z - zMin) / (10 * FT));
    if (gridX !== 0 && gridX !== xSteps && gridZ !== 0 && gridZ !== zSteps) continue;
    if (gridX < 0 || gridX > xSteps || gridZ < 0 || gridZ > zSteps) continue;
    normal.fromBufferAttribute(sourceNormals, i).applyNormalMatrix(normalMatrix);
    boundary.set(`${gridX},${gridZ}`, {
      position: position.toArray(), normal: normal.toArray(),
      uv: [sourceUVs.getX(i), sourceUVs.getY(i)]
    });
  }
  const perimeter = [];
  for (let x = 0; x < xSteps; x++) perimeter.push([x, 0]);
  for (let z = 0; z < zSteps; z++) perimeter.push([xSteps, z]);
  for (let x = xSteps; x > 0; x--) perimeter.push([x, zSteps]);
  for (let z = zSteps; z > 0; z--) perimeter.push([0, z]);
  // Never substitute an approximate near edge if a future native export changes
  // the terrain contract. An unmatched edge should be reported, not overlapped.
  if (perimeter.some(([x, z]) => !boundary.has(`${x},${z}`))) return null;

  const rings = [0, 3.048, 6.096, 12.192, 24.384, 48.768, 97.536,
    195.072, 390.144, 780.288, 1560.576, 3121.152, 6242.304, 12500, 30000];
  const positions = [], normals = [], uvs = [], indices = [];
  const epsilon = .05;
  for (const offset of rings) {
    for (const [gridX, gridZ] of perimeter) {
      if (offset === 0) {
        const vertex = boundary.get(`${gridX},${gridZ}`);
        positions.push(...vertex.position); normals.push(...vertex.normal); uvs.push(...vertex.uv);
        continue;
      }
      const x = THREE.MathUtils.lerp(xMin - offset, xMax + offset, gridX / xSteps);
      const z = THREE.MathUtils.lerp(zMin - offset, zMax + offset, gridZ / zSteps);
      positions.push(x, sampleCampusGround(x, z), z);
      normal.set(
        -(sampleCampusGround(x + epsilon, z) - sampleCampusGround(x - epsilon, z)) / (2 * epsilon),
        1,
        -(sampleCampusGround(x, z + epsilon) - sampleCampusGround(x, z - epsilon)) / (2 * epsilon)
      ).normalize();
      normals.push(...normal.toArray());
      // Verified against TEXCOORD_0 in the native glTF: Blender's V becomes
      // 1 + world Z / tile size after the Y-up conversion, not its negative.
      uvs.push(x / LAWN_TILE_METERS, 1 + z / LAWN_TILE_METERS);
    }
  }
  const count = perimeter.length;
  for (let ring = 0; ring < rings.length - 1; ring++) {
    for (let i = 0; i < count; i++) {
      const next = (i + 1) % count;
      const a = ring * count + i, b = ring * count + next;
      const c = (ring + 1) * count + next, d = (ring + 1) * count + i;
      indices.push(a, b, c, a, c, d);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  const material = lawnMaterial.clone();
  material.name = 'Atmosphere • native lawn continuation';
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'Atmosphere • surrounding terrain';
  mesh.castShadow = false; mesh.receiveShadow = true;
  mesh.raycast = () => {};
  return { mesh, geometry, material, diagnostics: Object.freeze({
    sourceMesh: terrain.name, sourceMaterial: lawnMaterial.name,
    nativeBoundaryVertices: count, vertexCount: positions.length / 3,
    triangleCount: indices.length / 3, outerOffsetMeters: rings.at(-1),
    nativeBoundaryCopied: true, textureTileFeet: LAWN_TILE_METERS / FT,
    materialMapsShared: material.map === lawnMaterial.map && material.normalMap === lawnMaterial.normalMap
      && material.roughnessMap === lawnMaterial.roughnessMap,
    castsShadows: false, receivesShadows: true, raycastEnabled: false
  }) };
}

// WebGLRenderer's standard material fog runs after tone mapping and output
// encoding. Store a tone-mapped LINEAR color here; refreshFogUniforms performs
// the final output-space conversion. The sky/environment retain raw radiance.
// These matrices and polynomial are the exact vendored Three.js r186 AgX fit.
function agxFogColor(color, exposure, target) {
  const multiply = (v, rows) => rows.map(row => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
  let value = color.toArray().map(channel => channel * exposure);
  value = multiply(value, [
    [.6274, .3293, .0433], [.0691, .9195, .0113], [.0164, .0880, .8956]
  ]);
  value = multiply(value, [
    [.856627153315983, .0951212405381588, .0482516061458583],
    [.137318972929847, .761241990602591, .101439036467562],
    [.11189821299995, .0767994186031903, .811302368396859]
  ]);
  value = value.map(channel => {
    const x = clamp((Math.log2(Math.max(channel, 1e-10)) + 12.47393) / (4.026069 + 12.47393), 0, 1);
    const x2 = x * x, x4 = x2 * x2;
    return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4
      - 6.868 * x2 * x + .4298 * x2 + .1191 * x - .00232;
  });
  value = multiply(value, [
    [1.1271005818144368, -.11060664309660323, -.016493938717834573],
    [-.1413297634984383, 1.157823702216272, -.016493938717834257],
    [-.14132976349843826, -.11060664309660294, 1.2519364065950405]
  ]).map(channel => Math.pow(Math.max(channel, 0), 2.2));
  value = multiply(value, [
    [1.6605, -.5876, -.0728], [-.1246, 1.1329, -.0083], [-.0182, -.1006, 1.1187]
  ]).map(channel => clamp(channel, 0, 1));
  // Fog is applied after material tone mapping: use the exact same look as
  // the AgX shader so distant terrain and the sky still meet seamlessly.
  const luminance = value[0] * .2126 + value[1] * .7152 + value[2] * .0722;
  value = value.map(channel => clamp(luminance + (channel - luminance) * COLOR_SATURATION, 0, 1));
  return target.setRGB(...value);
}

const noiseShader = /* glsl */`
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 345.45));
  p += dot(p, p + 34.345);
  return fract(p.x * p.y);
}
float noise2(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1,0)), f.x),
             mix(hash21(i + vec2(0,1)), hash21(i + vec2(1,1)), f.x), f.y);
}
float cloudNoise(vec2 p) {
  float value = 0.0, weight = .53;
  mat2 turn = mat2(.8, -.6, .6, .8);
  for (int i = 0; i < 5; i++) {
    value += weight * noise2(p);
    p = turn * p * 2.07 + vec2(11.3, 7.1); weight *= .49;
  }
  return value;
}
`;

const skyShader = /* glsl */`
uniform float uDaylight;
uniform float uNight;
uniform float uTwilight;
uniform float uStorm;
uniform vec3 uSun;
uniform vec3 uGroundColor;
uniform vec3 uHorizon;
uniform vec3 uZenith;
${noiseShader}
vec3 skyRadiance(vec3 direction) {
  vec3 d = normalize(direction);
  float elevation = max(0.0, d.y);
  vec3 sky = mix(uHorizon, uZenith, pow(elevation, .40));
  float sunAngle = clamp(dot(d, uSun), -1.0, 1.0);
  float sunVisible = smoothstep(-.075, .035, uSun.y);
  // A broad warm aureole and a small bright disk, all in scene-linear radiance.
  vec3 warmth = mix(vec3(1.0, .39, .12), vec3(1.0, .83, .58), smoothstep(.0, .5, uSun.y));
  sky += warmth * exp((sunAngle - 1.0) * 12.0) * uTwilight * .25;
  sky += warmth * (exp((sunAngle - 1.0) * 120.0) * .19 + exp((sunAngle - 1.0) * 27000.0) * 5.0) * sunVisible * (1.0 - uStorm);
  float moonAngle = dot(d, -uSun);
  sky += vec3(.27, .36, .53) * (exp((moonAngle - 1.0) * 1700.0) * .10
    + exp((moonAngle - 1.0) * 27000.0) * .60) * uNight * (1.0 - uStorm * .9);

  // Broken cumulus banks: broad rounded volumes, finer eroded edges, cool
  // shaded bases and warm sun-facing shoulders. This field is baked only on
  // a time change, never evaluated for every moving-camera screen pixel.
  vec2 cloudPoint = d.xz / max(.09, d.y + .035) * 1.05 + vec2(3.8, -1.3);
  float broad = cloudNoise(cloudPoint);
  float detail = cloudNoise(cloudPoint * 3.6 + 13.0);
  float body = broad * .82 + detail * .18;
  float coverage = smoothstep(mix(.525, .20, uStorm), mix(.59, .43, uStorm), body);
  coverage *= smoothstep(.02, .12, d.y);
  float lightEdge = cloudNoise(cloudPoint + uSun.xz * .28);
  float relief = clamp(.35 + (broad - lightEdge) * 6.0 + .24 * d.y, 0.0, 1.0);
  vec3 cloudDay = mix(vec3(.32, .40, .51), vec3(1.70, 1.70, 1.66), relief);
  float silver = pow(max(0.0, sunAngle), 18.0) * (1.0 - coverage) * .22;
  cloudDay += vec3(1.0, .91, .78) * silver;
  cloudDay = mix(cloudDay, vec3(1.22, .65, .35), uTwilight * .56 * pow(max(0.0, sunAngle), 3.0));
  // Dense layered storm banks retain relief rather than becoming a flat gray
  // background. They are baked only when weather or time changes.
  cloudDay = mix(cloudDay, mix(vec3(.042, .056, .077), vec3(.31, .35, .40), relief), uStorm);
  vec3 cloudNight = mix(vec3(.006, .009, .018), vec3(.026, .035, .055), relief);
  cloudNight *= mix(1.0, .62, uStorm);
  sky = mix(sky, mix(cloudNight, cloudDay, uDaylight), coverage * .91);
  return max(sky, vec3(0.0));
}
vec3 distantGroundRadiance() {
  // A sky-lit environment hemisphere supplies a restrained green bounce.
  return uGroundColor * mix(.10, .93, uDaylight) * mix(1.0, .52, uStorm);
}
`;

const cachedSkyShader = /* glsl */`
uniform sampler2D uSkyRadiance;
vec3 cachedSkyRadiance(vec3 direction) {
  vec3 d = normalize(direction);
  vec2 uv = vec2(atan(d.z, d.x) / 6.28318530718 + .5,
                 asin(clamp(d.y, -1.0, 1.0)) / 3.14159265359 + .5);
  return texture2D(uSkyRadiance, uv).rgb;
}
`;

const skyBakeFragment = /* glsl */`
varying vec2 vNdc;
${skyShader}
void main() {
  float longitude = vNdc.x * 3.14159265359;
  float latitude = vNdc.y * 1.57079632679;
  vec3 direction = vec3(cos(latitude) * cos(longitude), sin(latitude), cos(latitude) * sin(longitude));
  // Scene-linear HDR: no display tone mapping is baked into the lookup.
  gl_FragColor = vec4(skyRadiance(direction), 1.0);
}
`;

const backdropVertex = /* glsl */`
varying vec2 vNdc;
void main() {
  vNdc = position.xy;
  // A depth-disabled background; campus geometry keeps its native depth.
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;

const backdropFragment = /* glsl */`
uniform mat4 uProjectionInverse;
uniform mat4 uCameraWorld;
uniform vec3 uCameraPosition;
uniform float uFogDensity;
uniform float uLightning;
varying vec2 vNdc;
${skyShader}
${cachedSkyShader}
float groundHeight(vec2 world) {
  float east = world.x / .3048, north = -world.y / .3048;
  float west = smoothstep(0.0, 1.0, (-east - 115.0) / 155.0);
  float south = smoothstep(0.0, 1.0, (125.0 - north) / 60.0);
  float lowerEast = smoothstep(0.0, 1.0, (east - 260.0) / 95.0);
  return (-14.0 * west - 11.0 * max(south * .75 * clamp((east - 155.0) / 110.0, 0.0, 1.0), lowerEast * .9) - .1) * .3048;
}
float clearance(vec3 origin, vec3 direction, float t) {
  vec3 p = origin + direction * t;
  return p.y - groundHeight(p.xz);
}
float groundDistance(vec3 origin, vec3 direction) {
  if (direction.y >= -.00001) return -1.0;
  // All native terrain falls within this vertical slab. Bracketing avoids
  // unstable fixed-point iteration when a walk camera looks along a slope.
  float low = max(0.0, (-.03048 - origin.y) / direction.y);
  float high = max(low, (-8.0 - origin.y) / direction.y);
  float lowValue = clearance(origin, direction, low);
  // At plateau grade, the slab and height-field expressions differ by a few
  // floating-point ULPs. Treat that contact as a hit, never random sky pixels.
  if (lowValue < -.001) return -1.0;
  if (lowValue <= .00001) return low;
  for (int i = 0; i < 7; i++) {
    float middle = (low + high) * .5;
    if (clearance(origin, direction, middle) > 0.0) low = middle;
    else high = middle;
  }
  // Secant interpolation makes a flat continuation exact rather than stepped.
  lowValue = clearance(origin, direction, low);
  float highValue = clearance(origin, direction, high);
  return mix(low, high, clamp(lowValue / max(.000001, lowValue - highValue), 0.0, 1.0));
}
void main() {
  vec4 view = uProjectionInverse * vec4(vNdc, 1.0, 1.0);
  vec3 direction = normalize(mat3(uCameraWorld) * (view.xyz / view.w));
  float distanceToGround = groundDistance(uCameraPosition, direction);
  vec3 color;
  if (distanceToGround > 0.0) {
    vec3 point = uCameraPosition + direction * distanceToGround;
    float coarse = noise2(point.xz * .014) - .5;
    float medium = noise2(point.xz * .11 + 17.0) - .5;
    float fine = noise2(point.xz * .64 + 41.0) - .5;
    float detail = 1.0 - smoothstep(180.0, 850.0, distanceToGround);
    float variation = coarse * .085 + medium * .07 * detail + fine * .025 * detail;
    float sunHeight = max(0.0, uSun.y);
    color = uGroundColor * (1.0 + variation) * mix(.10, .83 + .32 * sunHeight, uDaylight) * mix(1.0, .52, uStorm);
    float haze = 1.0 - exp(-pow(distanceToGround * uFogDensity, 2.0));
    color = mix(color, uHorizon, haze);
  } else {
    color = cachedSkyRadiance(direction);
    // The sub-pixel mathematical horizon has no finite green-plane edge.
    if (direction.y < 0.0) color = uHorizon;
    // A restrained cloud glow, only in the sky and never a full-screen flash.
    color += vec3(.18, .21, .27) * uLightning * smoothstep(.025, .30, direction.y);
  }
  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const environmentVertex = /* glsl */`
varying vec3 vDirection;
void main() {
  vDirection = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const environmentFragment = /* glsl */`
varying vec3 vDirection;
${skyShader}
${cachedSkyShader}
void main() {
  vec3 d = normalize(vDirection);
  vec3 color = mix(distantGroundRadiance(), cachedSkyRadiance(d), smoothstep(-.025, .025, d.y));
  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Atmosphere objects live on scene, never inside the campus model/collider tree.
 * Colors passed as THREE.Color or [r,g,b] use scene-linear RGB, matching glTF.
 * Call setTime AFTER lighting.setTime, and updateCamera before the visible draw.
 */
export function createCampusAtmosphere({ scene, renderer, model = null, groundColor = null, fogDensity = .00050, environmentSize = 128 } = {}) {
  if (!scene?.isScene || !renderer?.isWebGLRenderer) throw new TypeError('Atmosphere needs a Three.js scene and WebGL renderer.');
  installCampusColorLook();
  const originalEnvironment = scene.environment, originalFog = scene.fog;
  const lawn = new THREE.Color().setRGB(.10, .16, .047);
  if (model) model.traverse(object => {
    if (!object.isMesh) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      // A textured material's white base factor is not its grass albedo. Use
      // the calibrated linear texture mean unless the caller supplies one.
      if (/Campus.lawn/i.test(material?.name || '') && material.color && !material.map) lawn.copy(material.color);
    }
  });
  if (groundColor?.isColor) lawn.copy(groundColor);
  else if (Array.isArray(groundColor) && groundColor.length === 3 && groundColor.every(Number.isFinite)) lawn.setRGB(...groundColor);
  const density = Number.isFinite(fogDensity) ? clamp(fogDensity, .0001, .003) : .0005;
  const size = [64, 128, 256].includes(environmentSize) ? environmentSize : 128;
  const dayZenith = new THREE.Color('#2877c8'), dayHorizon = new THREE.Color('#c5d9e6');
  const nightZenith = new THREE.Color('#091226'), nightHorizon = new THREE.Color('#1b2940');
  const duskHorizon = new THREE.Color('#d4a19b');
  const stormHorizon = new THREE.Color('#768895'), stormZenith = new THREE.Color('#394a60');
  const shared = {
    uDaylight: { value: 1 }, uNight: { value: 0 }, uTwilight: { value: 0 },
    uStorm: { value: 0 },
    uSun: { value: new THREE.Vector3(-.3, .8, .5).normalize() },
    uGroundColor: { value: lawn }, uHorizon: { value: dayHorizon.clone() }, uZenith: { value: dayZenith.clone() }
  };
  // A 2048px full-sphere lookup keeps the small solar disk and cloud edges
  // crisp. One texture fetch replaces ten FBM octaves per Walk/Fly pixel.
  // It is deterministic, static between time changes and wraps across north.
  const skyWidth = Math.min(2048, renderer.capabilities.maxTextureSize);
  const skyHeight = skyWidth / 2;
  const skyTarget = new THREE.WebGLRenderTarget(skyWidth, skyHeight, {
    type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    depthBuffer: false, stencilBuffer: false, generateMipmaps: false
  });
  skyTarget.texture.name = 'Campus cached scene-linear cloud sky';
  skyTarget.texture.wrapS = THREE.RepeatWrapping;
  shared.uSkyRadiance = { value: skyTarget.texture };
  const skyBakeScene = new THREE.Scene();
  const skyBakeGeometry = new THREE.PlaneGeometry(2, 2);
  const skyBakeMaterial = new THREE.ShaderMaterial({ uniforms: shared,
    vertexShader: backdropVertex, fragmentShader: skyBakeFragment,
    depthTest: false, depthWrite: false, toneMapped: false, fog: false });
  skyBakeScene.add(new THREE.Mesh(skyBakeGeometry, skyBakeMaterial));
  const skyBakeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  function bakeSky() {
    const previousTarget = renderer.getRenderTarget();
    const cubeFace = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
    try {
      // setRenderTarget applies this target's pixel viewport/scissor directly;
      // setViewport would multiply by the display DPR and crop the cached sky.
      renderer.setRenderTarget(skyTarget);
      renderer.clear(true, false, false);
      renderer.render(skyBakeScene, skyBakeCamera);
    } finally {
      renderer.setRenderTarget(previousTarget, cubeFace, mip);
    }
  }
  const uniforms = { ...shared,
    uProjectionInverse: { value: new THREE.Matrix4() }, uCameraWorld: { value: new THREE.Matrix4() },
    uCameraPosition: { value: new THREE.Vector3() }, uFogDensity: { value: density },
    uLightning: { value: 0 }
  };
  const geometry = new THREE.PlaneGeometry(2, 2);
  const material = new THREE.ShaderMaterial({ uniforms, vertexShader: backdropVertex, fragmentShader: backdropFragment,
    depthTest: false, depthWrite: false, toneMapped: true, fog: false });
  const backdrop = new THREE.Mesh(geometry, material);
  backdrop.name = 'Atmosphere • endless landscape and cloud sky';
  backdrop.frustumCulled = false; backdrop.renderOrder = -10000;
  backdrop.raycast = () => {};
  scene.add(backdrop);
  const surrounding = createSurroundingTerrain(model);
  if (surrounding) scene.add(surrounding.mesh);
  const fog = new THREE.FogExp2(shared.uHorizon.value, density);
  scene.fog = fog;
  let fogColorKey = null;
  function syncFogColor() {
    const key = [...shared.uHorizon.value.toArray(), renderer.toneMapping, renderer.toneMappingExposure].join(',');
    if (key === fogColorKey) return;
    if (renderer.toneMapping === THREE.AgXToneMapping) {
      agxFogColor(shared.uHorizon.value, renderer.toneMappingExposure, fog.color);
    } else {
      // The explorer uses AgX. This also keeps NoToneMapping test/capture scenes
      // in their unmodified linear working space.
      fog.color.copy(shared.uHorizon.value);
    }
    fogColorKey = key;
  }
  syncFogColor();

  // PMREM captures only the outdoor radiance, with no campus geometry, lights,
  // or room walls. It never renders on camera motion or cloud animation.
  const environmentScene = new THREE.Scene();
  const environmentGeometry = new THREE.SphereGeometry(25, 32, 16);
  const environmentMaterial = new THREE.ShaderMaterial({ uniforms: shared,
    vertexShader: environmentVertex, fragmentShader: environmentFragment,
    side: THREE.BackSide, depthTest: false, depthWrite: false, toneMapped: true, fog: false });
  environmentScene.add(new THREE.Mesh(environmentGeometry, environmentMaterial));
  const pmrem = new THREE.PMREMGenerator(renderer);
  let environmentTarget = null, revision = 0, timeKey = null, latest = null, disposed = false;
  let raining = false, lastTimeState = null;

  function setTime(state) {
    if (disposed) return false;
    if (!state || !Number.isFinite(state.daylight) || !Array.isArray(state.sunDirection) || state.sunDirection.length !== 3 || !state.sunDirection.every(Number.isFinite)) return false;
    lastTimeState = structuredClone(state);
    const key = JSON.stringify([state.minutes, state.daylight, state.nightStrength, state.sunDirection, raining]);
    if (key === timeKey) return false;
    const daylight = clamp(state.daylight, 0, 1);
    const altitude = Number.isFinite(state.altitude) ? state.altitude : THREE.MathUtils.radToDeg(Math.asin(clamp(state.sunDirection[1], -1, 1)));
    const twilight = smooth(-11, -1, altitude) * (1 - smooth(0, 15, altitude));
    shared.uDaylight.value = daylight;
    shared.uNight.value = Number.isFinite(state.nightStrength) ? clamp(state.nightStrength, 0, 1) : 1 - daylight;
    shared.uTwilight.value = twilight;
    shared.uSun.value.fromArray(state.sunDirection).normalize();
    shared.uHorizon.value.copy(nightHorizon).lerp(dayHorizon, daylight).lerp(duskHorizon, twilight * .56);
    shared.uZenith.value.copy(nightZenith).lerp(dayZenith, daylight);
    shared.uStorm.value = raining ? 1 : 0;
    if (raining) {
      shared.uHorizon.value.lerp(stormHorizon, daylight * .92);
      shared.uZenith.value.lerp(stormZenith, daylight * .94);
      if (daylight < 1) {
        shared.uHorizon.value.multiplyScalar(mix(0.72, 1, daylight));
        shared.uZenith.value.multiplyScalar(mix(0.72, 1, daylight));
      }
    }
    syncFogColor();
    bakeSky();
    // PMREM's fromScene temporarily sets NoToneMapping, so these linear colors
    // are captured once without AgX/display encoding baked into reflections.
    const next = pmrem.fromScene(environmentScene, .025, .1, 50, { size });
    next.texture.name = 'Campus outdoor sky and green horizon';
    scene.environment = next.texture;
    const previous = environmentTarget; environmentTarget = next; previous?.dispose();
    timeKey = key; revision++;
    latest = { minutes: state.minutes, phase: state.phase, daylight, nightStrength: shared.uNight.value, altitude };
    return true;
  }

  function updateCamera(camera) {
    if (disposed || !camera?.isCamera) return;
    camera.updateMatrixWorld();
    uniforms.uProjectionInverse.value.copy(camera.projectionMatrixInverse);
    uniforms.uCameraWorld.value.copy(camera.matrixWorld);
    uniforms.uCameraPosition.value.setFromMatrixPosition(camera.matrixWorld);
    syncFogColor();
    // The walk camera has a shorter far plane than the aerial camera. Both
    // physical terrain and the analytic continuation must already be >99.9%
    // horizon haze there, so a clipped ring can never reveal a color boundary.
    const effectiveDensity = Number.isFinite(camera.far) && camera.far > 0
      ? Math.max(density * (raining ? 2.2 : 1), 2.7 / camera.far) : density * (raining ? 2.2 : 1);
    fog.density = effectiveDensity;
    uniforms.uFogDensity.value = effectiveDensity;
  }

  function setWeather(enabled) {
    if (disposed) return false;
    const next = Boolean(enabled);
    if (next === raining) return false;
    raining = next;
    if (!raining) uniforms.uLightning.value = 0;
    if (lastTimeState) setTime(lastTimeState);
    return true;
  }

  function setLightning(value) {
    uniforms.uLightning.value = !disposed && raining && Number.isFinite(value) ? clamp(value, 0, .65) : 0;
  }

  function dispose() {
    if (disposed) return;
    disposed = true; backdrop.removeFromParent();
    if (surrounding) {
      surrounding.mesh.removeFromParent();
      surrounding.geometry.dispose(); surrounding.material.dispose();
      // The native lawn owns its shared textures; never dispose them here.
    }
    if (scene.environment === environmentTarget?.texture) scene.environment = originalEnvironment;
    if (scene.fog === fog) scene.fog = originalFog;
    environmentTarget?.dispose(); environmentTarget = null;
    pmrem.dispose(); environmentMaterial.dispose(); environmentGeometry.dispose(); material.dispose(); geometry.dispose();
    skyTarget.dispose(); skyBakeMaterial.dispose(); skyBakeGeometry.dispose();
  }

  return Object.freeze({ setTime, setWeather, setLightning, updateCamera, sampleGround: sampleCampusGround, dispose,
    get state() { return Object.freeze({ ...latest, environmentRevision: revision, environmentSize: size,
      groundColorLinear: lawn.toArray(), horizonColorLinear: shared.uHorizon.value.toArray(),
      zenithColorLinear: shared.uZenith.value.toArray(), fogDensity: fog.density, baseFogDensity: density,
      raining, lightningIntensity: uniforms.uLightning.value,
      cameraPosition: uniforms.uCameraPosition.value.toArray(), cloudAnimation: false,
      skyCache: Object.freeze({ width: skyWidth, height: skyHeight, format: 'RGBA16F',
        updates: revision, updatesOnCameraMovement: false, colorSpace: 'scene-linear', seamlessLongitude: true }),
      infiniteGround: true, groundUnits: 'world meters; X east, Y elevation, -Z north',
      surroundingTerrain: surrounding?.diagnostics || null,
      modelGeometryChanged: false, colorSaturation: COLOR_SATURATION, disposed }); }
  });
}
