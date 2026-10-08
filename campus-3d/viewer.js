import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const wrap = document.getElementById('canvas-wrap');
const status = document.getElementById('status');
const loading = document.getElementById('loading');
const errorPanel = document.getElementById('error');
const viewButtons = [...document.querySelectorAll('[data-view]')];
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
let renderer, camera, controls, scene, extent = 200, fitDistance = 280;
let model, sceneBounds, presets = {}, activeView = 'overview', transition = null, frame = null;
let target = new THREE.Vector3();

document.getElementById('retry').addEventListener('click', () => location.reload());
document.addEventListener('click', event => {
  for (const details of document.querySelectorAll('details[open]')) {
    if (!details.contains(event.target)) details.open = false;
  }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') document.querySelectorAll('details[open]').forEach(d => d.open = false);
});

function fail(error) {
  console.error('Campus model:', error);
  loading.hidden = true;
  errorPanel.hidden = false;
}

function draw(now = performance.now()) {
  frame = null;
  if (transition) {
    const t = Math.min(1, (now - transition.started) / 850);
    const smooth = t * t * (3 - 2 * t);
    camera.position.lerpVectors(transition.fromPosition, transition.toPosition, smooth);
    controls.target.lerpVectors(transition.fromTarget, transition.toTarget, smooth);
    if (t === 1) transition = null;
  }
  const changed = controls.update();
  renderer.render(scene, camera);
  if (transition || changed) requestDraw();
}
function requestDraw() { if (frame === null) frame = requestAnimationFrame(draw); }
function fitOverview(position, focus) {
  if (!sceneBounds) return position;
  const direction = position.clone().sub(focus).normalize();
  const right = new THREE.Vector3().crossVectors(camera.up, direction).normalize();
  const up = new THREE.Vector3().crossVectors(direction, right).normalize();
  const vertical = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const horizontal = vertical * camera.aspect;
  let distance = 0;
  for (const x of [sceneBounds.min.x, sceneBounds.max.x]) {
    for (const y of [sceneBounds.min.y, sceneBounds.max.y]) {
      for (const z of [sceneBounds.min.z, sceneBounds.max.z]) {
        const corner = new THREE.Vector3(x, y, z).sub(focus);
        distance = Math.max(distance,
          Math.abs(corner.dot(right)) / (horizontal * 0.87) + corner.dot(direction),
          Math.abs(corner.dot(up)) / (vertical * 0.74) + corner.dot(direction));
      }
    }
  }
  return focus.clone().addScaledVector(direction, distance);
}
function selectView(name, animate = true) {
  if (!model) return;
  activeView = name;
  const preset = presets[name] || presets.overview;
  let position = new THREE.Vector3(...preset.position);
  const focus = new THREE.Vector3(...preset.target);
  if (name === 'overview') position = fitOverview(position, focus);
  else if (camera.aspect < 1) position = focus.clone().add(position.sub(focus).multiplyScalar(1 / camera.aspect));
  if (animate && !reducedMotion) {
    transition = { started: performance.now(), fromPosition: camera.position.clone(), fromTarget: controls.target.clone(), toPosition: position, toTarget: focus };
  } else {
    transition = null;
    camera.position.copy(position);
    controls.target.copy(focus);
    controls.update();
  }
  viewButtons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.view === name)));
  const nameLabel = viewButtons.find(button => button.dataset.view === name)?.textContent.replace(/^\s*0\d\s*/, '').trim();
  status.textContent = `${nameLabel || 'Campus'} view`;
  requestDraw();
}
function zoom(factor) {
  if (!model) return;
  transition = null;
  const direction = camera.position.clone().sub(controls.target);
  const distance = THREE.MathUtils.clamp(direction.length() * factor, controls.minDistance, controls.maxDistance);
  camera.position.copy(controls.target).add(direction.setLength(distance));
  controls.update();
  requestDraw();
}

async function init() {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
  renderer.setClearColor(0xf3f0e8);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  wrap.appendChild(renderer.domElement);
  renderer.domElement.tabIndex = 0;
  renderer.domElement.setAttribute('role', 'img');
  renderer.domElement.setAttribute('aria-label', 'Interactive new campus exterior model. Drag to orbit, right-drag to pan, scroll to zoom. Keyboard: arrow keys to pan, plus and minus to zoom, zero to reset.');
  renderer.domElement.addEventListener('webglcontextlost', event => { event.preventDefault(); fail(new Error('WebGL context lost')); });
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf3f0e8);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  scene.environment = pmrem.fromScene(room, 0.05).texture;
  scene.environmentIntensity = 0.28;
  room.dispose();
  pmrem.dispose();
  scene.add(new THREE.HemisphereLight(0xd3e3f0, 0x6c735f, 1.6));
  const sun = new THREE.DirectionalLight(0xfff8ef, 2.5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.bias = -0.00015;
  sun.shadow.normalBias = 0.15;
  scene.add(sun, sun.target);
  camera = new THREE.PerspectiveCamera(36, 1, 0.2, 5000);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.09;
  controls.maxPolarAngle = Math.PI * 0.487;
  controls.minPolarAngle = 0.06;
  controls.screenSpacePanning = true;
  controls.zoomSpeed = 0.8;
  controls.rotateSpeed = 0.6;
  controls.listenToKeyEvents(renderer.domElement);
  controls.addEventListener('change', requestDraw);
  controls.addEventListener('start', () => {
    transition = null;
    activeView = null;
    viewButtons.forEach(button => button.setAttribute('aria-pressed', 'false'));
  });
  renderer.domElement.addEventListener('keydown', event => {
    if (['+', '=', '-', '_', '0'].includes(event.key)) {
      event.preventDefault();
      if (event.key === '0') selectView('overview');
      else zoom(event.key === '+' || event.key === '=' ? 0.8 : 1.25);
    }
  });
  function resize() {
    const { width, height } = wrap.getBoundingClientRect();
    renderer.setSize(width, height);
    camera.aspect = width / Math.max(1, height);
    camera.updateProjectionMatrix();
    if (model && activeView === 'overview') selectView('overview', false);
    requestDraw();
  }
  new ResizeObserver(resize).observe(wrap);
  resize();
  const [gltf, cameraConfig] = await Promise.all([
    new GLTFLoader().loadAsync('./OLR-New-Campus.glb', event => {
      document.getElementById('loading-text').textContent = event.total ? `Opening the campus… ${Math.min(99, Math.round(event.loaded / event.total * 100))}%` : 'Opening the campus…';
    }),
    fetch('./views.json').then(response => response.ok ? response.json() : {}).catch(() => ({}))
  ]);
  model = gltf.scene;
  model.traverse(object => {
    if (object.isMesh) {
      object.castShadow = true;
      object.receiveShadow = true;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (material.map) material.map.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      }
    }
  });
  // Viewer lighting is controlled here so the model looks consistent on all devices.
  const importedLights = [];
  model.traverse(object => { if (object.isLight) importedLights.push(object); });
  importedLights.forEach(light => light.removeFromParent());
  scene.add(model);
  const bounds = new THREE.Box3().setFromObject(model, true);
  sceneBounds = bounds;
  const size = bounds.getSize(new THREE.Vector3());
  target = bounds.getCenter(new THREE.Vector3());
  target.y = Math.max(0, bounds.min.y) + size.y * 0.12;
  extent = Math.max(size.x, size.z);
  const viewAngle = THREE.MathUtils.degToRad(camera.fov / 2);
  fitDistance = extent * 0.64 / (Math.tan(viewAngle) * Math.min(1, camera.aspect));
  const offset = new THREE.Vector3(0.9, 1.0, 1.1).normalize().multiplyScalar(fitDistance);
  presets = {
    overview: {position: target.clone().add(offset).toArray(), target: target.toArray()},
    church: {position: target.clone().add(new THREE.Vector3(0.38, 0.3, 0.48).multiplyScalar(extent)).toArray(), target: target.toArray()},
    playgrounds: {position: target.clone().add(new THREE.Vector3(-0.35, 0.3, 0.4).multiplyScalar(extent)).toArray(), target: target.toArray()},
    ...cameraConfig
  };
  controls.minDistance = Math.max(3, extent * 0.025);
  controls.maxDistance = fitDistance * 3.0;
  sun.position.copy(target).add(new THREE.Vector3(-extent * 0.4, extent * 0.75, extent * 0.6));
  sun.target.position.copy(target);
  Object.assign(sun.shadow.camera, { left: -extent * 0.7, right: extent * 0.7, top: extent * 0.7, bottom: -extent * 0.7, near: 1, far: extent * 3 });
  sun.shadow.camera.updateProjectionMatrix();
  renderer.shadowMap.needsUpdate = true;
  selectView('overview', false);
  viewButtons.forEach(button => button.disabled = false);
  ['fit', 'zoom-in', 'zoom-out'].forEach(id => document.getElementById(id).disabled = false);
  loading.hidden = true;
  document.body.classList.add('ready');
  document.getElementById('preview').alt = '';
  requestDraw();
}
viewButtons.forEach(button => button.addEventListener('click', () => selectView(button.dataset.view)));
document.getElementById('fit').addEventListener('click', () => selectView('overview'));
document.getElementById('zoom-in').addEventListener('click', () => zoom(0.8));
document.getElementById('zoom-out').addEventListener('click', () => zoom(1.25));
const fullscreen = document.getElementById('fullscreen');
const requestFullscreen = document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen;
const exitFullscreen = document.exitFullscreen || document.webkitExitFullscreen;
const isFullscreen = () => Boolean(document.fullscreenElement || document.webkitFullscreenElement);
fullscreen.hidden = !requestFullscreen || !exitFullscreen;
fullscreen.addEventListener('click', async () => {
  try {
    if (isFullscreen()) await exitFullscreen.call(document);
    else await requestFullscreen.call(document.documentElement);
  } catch { status.textContent = 'Full screen is unavailable. Use your browser’s full-screen command.'; }
});
for (const event of ['fullscreenchange', 'webkitfullscreenchange']) document.addEventListener(event, () => {
  fullscreen.setAttribute('aria-label', isFullscreen() ? 'Exit full screen' : 'Enter full screen');
  fullscreen.title = isFullscreen() ? 'Exit full screen' : 'Full screen';
});
init().catch(fail);
