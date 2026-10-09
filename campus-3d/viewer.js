import { loadCampusBoundary } from './campus-boundary.js?v=cff9d31e0ce590de';
import { createCampusLighting, lightingAtTime, normalizeMinutes } from './campus-lighting.js?v=0e3eb9b504964545';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const EMBEDDED = window.parent !== window;
const FEET = 0.3048;
const CAMPUS_BEARING = 9.067253590763931;
const DEFAULT_TILT = 25;
const MIN_TILT = 0, MAX_TILT = 85;
const themeMedia = matchMedia('(prefers-color-scheme: dark)');
let themePreference = 'system', resolvedTheme = 'light', active = false;
let hemi, sun, oldOutlines, oldOutlinePolygons = [], oldOutlineVisible = true;
let embeddedCamera = { center: { x: 15, y: 85 }, scale: 1, bearing: CAMPUS_BEARING, tilt: DEFAULT_TILT, zoom: 1, width: innerWidth, height: innerHeight };
let savedEmbeddedCamera = null, dragMode = 'rotate';
let campusLighting = null, timeOfDay = 840, lightingDirty = true;
const ASSET_REVISION = '7c74ca3158f3123c';
const wrap = document.getElementById('canvas-wrap');
const status = document.getElementById('status');
const loading = document.getElementById('loading');
const errorPanel = document.getElementById('error');
let renderer, camera, scene, extent = 200;
let model, frame = null;
let target = new THREE.Vector3();

document.getElementById('retry').addEventListener('click', () => location.reload());
// Messages belong only to this same-origin parent, never another frame.
function post(message) {
  if (!EMBEDDED) return;
  try { if (window.parent.location.origin !== location.origin) return; } catch { return; }
  window.parent.postMessage(message, location.origin);
}

function fail(error) {
  console.error('Campus model:', error);
  loading.hidden = true;
  errorPanel.hidden = false;
  post({ type: 'olr-3d-error', message: 'The interactive campus model could not load.' });
}

function draw() {
  frame = null;
  if (!active || document.hidden) return;
  if (lightingDirty && campusLighting) {
    campusLighting.setTime(timeOfDay);
    lightingDirty = false;
    updateOutlineColor();
  }
  renderer.render(scene, camera);
  renderedFrames++;
}
function requestDraw() { if (active && !document.hidden && renderer && camera && frame === null) frame = requestAnimationFrame(draw); }
function setDragMode(mode, announce = true) {
  if (!['rotate', 'pan'].includes(mode)) return;
  dragMode = mode;
  if (!renderer) return;
  renderer.domElement.dataset.dragMode = mode;
  renderer.domElement.setAttribute('aria-label', `Interactive new campus exterior model. Drag with a mouse or one finger to ${mode === 'pan' ? 'pan' : 'rotate and tilt'}. Use the main campus toolbar to switch modes. Right-drag, Shift-drag, or drag with two fingers to pan. Two-finger trackpad scrolling pans; pinch or Control-scroll zooms. Twist with two fingers to rotate. Keyboard: arrow keys pan; Shift and arrow keys rotate or tilt; plus and minus zoom; zero resets.`);
  if (announce) {
    status.textContent = mode === 'pan' ? 'Pan mode. Drag to move left, right, up or down.' : 'Rotate mode. Drag to turn and tilt the campus.';
    publishCamera();
  }
}

// Enter with the same ground-plane scale and compass bearing as the map, then
// allow a full orbit while retaining the center and scale for the return to 2D.
function publishCamera() {
  if (!model) return;
  post({ type: 'olr-3d-state', camera: structuredClone(embeddedCamera), dragMode });
}
function applyEmbeddedCamera(announce = false) {
  if (!camera) return;
  const rect = wrap.getBoundingClientRect();
  const width = Math.max(1, rect.width), height = Math.max(1, rect.height);
  embeddedCamera.width = width; embeddedCamera.height = height;
  const unitsPerPixel = FEET / embeddedCamera.scale;
  Object.assign(camera, { left: -width * unitsPerPixel / 2, right: width * unitsPerPixel / 2, top: height * unitsPerPixel / 2, bottom: -height * unitsPerPixel / 2, zoom: 1 });
  const theta = THREE.MathUtils.degToRad(embeddedCamera.bearing - CAMPUS_BEARING);
  const focus = new THREE.Vector3(embeddedCamera.center.x * FEET, 0, -embeddedCamera.center.y * FEET);
  const tilt = THREE.MathUtils.degToRad(embeddedCamera.tilt);
  const direction = new THREE.Vector3(Math.sin(theta) * Math.sin(tilt), Math.cos(tilt), Math.cos(theta) * Math.sin(tilt));
  camera.position.copy(focus).addScaledVector(direction, 1200);
  // Retain the compass bearing even directly overhead, where world-up would
  // be parallel to the viewing direction and lookAt cannot resolve yaw.
  camera.up.set(-Math.sin(theta), 0, -Math.cos(theta));
  camera.lookAt(focus);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  requestDraw();
  if (announce) publishCamera();
}
function groundOffset(dx, dy) {
  const theta = THREE.MathUtils.degToRad(embeddedCamera.bearing - CAMPUS_BEARING);
  const c = Math.cos(theta), s = Math.sin(theta), scale = embeddedCamera.scale;
  const foreshortening = Math.cos(THREE.MathUtils.degToRad(embeddedCamera.tilt));
  return { x: (c * dx + s * dy / foreshortening) / scale, y: (s * dx - c * dy / foreshortening) / scale };
}
function panEmbedded(dx, dy, announce = true) {
  const delta = groundOffset(dx, dy);
  embeddedCamera.center.x -= delta.x; embeddedCamera.center.y -= delta.y;
  applyEmbeddedCamera(announce);
}
function zoomEmbedded(factor, point, announce = true) {
  const nextZoom = THREE.MathUtils.clamp(embeddedCamera.zoom * factor, 1, 32);
  const actual = nextZoom / embeddedCamera.zoom;
  const rect = wrap.getBoundingClientRect();
  const offset = groundOffset((point?.x ?? rect.width / 2) - rect.width / 2, (point?.y ?? rect.height / 2) - rect.height / 2);
  embeddedCamera.center.x += offset.x * (1 - 1 / actual);
  embeddedCamera.center.y += offset.y * (1 - 1 / actual);
  embeddedCamera.scale *= actual;
  embeddedCamera.zoom = nextZoom;
  applyEmbeddedCamera(announce);
}
function orbitEmbedded(yaw, tilt = 0, announce = true) {
  embeddedCamera.bearing = ((embeddedCamera.bearing + yaw) % 360 + 540) % 360 - 180;
  embeddedCamera.tilt = THREE.MathUtils.clamp(embeddedCamera.tilt + tilt, MIN_TILT, MAX_TILT);
  applyEmbeddedCamera(announce);
}
function rotateEmbedded(delta, announce = true) { orbitEmbedded(delta, 0, announce); }
function setupTheme() {
  try { themePreference = localStorage.getItem('olr-campus-theme') || 'system'; } catch {}
  if (!['system', 'light', 'dark'].includes(themePreference)) themePreference = 'system';
  themeMedia.addEventListener('change', () => { if (themePreference === 'system') applyTheme(); });
  window.addEventListener('storage', event => {
    if (event.key === 'olr-campus-theme') {
      themePreference = ['system', 'light', 'dark'].includes(event.newValue) ? event.newValue : 'system';
      applyTheme();
    }
  });
  applyTheme();
}
function applyTheme(explicitResolved) {
  resolvedTheme = explicitResolved || (themePreference === 'system' ? (themeMedia.matches ? 'dark' : 'light') : themePreference);
  document.documentElement.dataset.theme = resolvedTheme;
  document.querySelector('meta[name="theme-color"]').content = resolvedTheme === 'dark' ? '#181818' : '#ffffff';
  updateOutlineColor();
  requestDraw();
}
function updateOutlineColor() {
  const darkScene = (campusLighting?.state?.daylight ?? lightingAtTime(timeOfDay).daylight) < .3;
  oldOutlines?.traverse(object => { if (object.isLine) object.material.color.set(darkScene ? 0xffffff : 0x303030); });
}
function publishLighting() {
  const { minutes, phase } = lightingAtTime(timeOfDay);
  post({ type: 'olr-3d-lighting', minutes, phase });
}
function setTimeOfDay(value, persist = true) {
  const next = normalizeMinutes(value);
  const changed = next !== timeOfDay;
  timeOfDay = next;
  if (persist) { try { localStorage.setItem('olr-campus-time-of-day', String(timeOfDay)); } catch {} }
  if (changed) {
    lightingDirty = true;
    requestDraw();
  }
  publishLighting();
}
function setupTimeOfDay() {
  try { const saved = localStorage.getItem('olr-campus-time-of-day'); if (saved !== null) timeOfDay = normalizeMinutes(saved); } catch {}
  window.addEventListener('storage', event => {
    if (event.key === 'olr-campus-time-of-day') setTimeOfDay(event.newValue === null ? 840 : event.newValue, false);
  });
}

function setOldOutlines(value) {
  if (typeof value === 'boolean') oldOutlineVisible = value;
  else if (value && typeof value === 'object') {
    if (Array.isArray(value.polygons)) oldOutlinePolygons = value.polygons;
    if (typeof value.visible === 'boolean') oldOutlineVisible = value.visible;
  }
  if (!scene) return;
  if (oldOutlines && (typeof value === 'boolean' || !Array.isArray(value?.polygons))) {
    oldOutlines.visible = oldOutlineVisible; requestDraw(); return;
  }
  if (oldOutlines) {
    oldOutlines.traverse(object => { object.geometry?.dispose(); object.material?.dispose(); });
    oldOutlines.removeFromParent();
  }
  oldOutlines = new THREE.Group();
  oldOutlines.name = 'Former building outlines';
  oldOutlines.visible = oldOutlineVisible;
  for (const polygon of oldOutlinePolygons) {
    if (!Array.isArray(polygon) || polygon.length < 3 || !polygon.every(p => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]))) continue;
    const points = [...polygon, polygon[0]].map(([x, y]) => new THREE.Vector3(x * FEET, 0.05, -y * FEET));
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineDashedMaterial({ color: resolvedTheme === 'dark' ? 0xffffff : 0x303030, dashSize: 1.5 * FEET, gapSize: 1.0 * FEET, depthTest: false, depthWrite: false, transparent: true, opacity: 0.95 });
    const line = new THREE.Line(geometry, material);
    line.computeLineDistances(); line.renderOrder = 1000; oldOutlines.add(line);
  }
  scene.add(oldOutlines);
  updateOutlineColor();
  requestDraw();
}
function installEmbeddedNavigation() {
  const canvas = renderer.domElement;
  const pointers = new Map();
  let gesture = null, safariGesture = null;
  function snapshot() {
    const points = [...pointers.values()];
    if (!points.length) return null;
    if (points.length === 1) return { x: points[0].x, y: points[0].y, distance: 0, angle: 0 };
    const [a, b] = points;
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, distance: Math.hypot(b.x - a.x, b.y - a.y), angle: Math.atan2(b.y - a.y, b.x - a.x) };
  }
  canvas.addEventListener('contextmenu', event => event.preventDefault());
  canvas.addEventListener('pointerdown', event => {
    if (!active || (event.pointerType === 'mouse' && ![0, 2].includes(event.button))) return;
    event.preventDefault(); canvas.focus({ preventScroll: true });
    canvas.setPointerCapture(event.pointerId);
    const rect = canvas.getBoundingClientRect();
    pointers.set(event.pointerId, { x: event.clientX - rect.left, y: event.clientY - rect.top, pan: event.button === 2 });
    gesture = snapshot();
  });
  canvas.addEventListener('pointermove', event => {
    if (!pointers.has(event.pointerId) || !active || safariGesture) return;
    const rect = canvas.getBoundingClientRect();
    const pointer = pointers.get(event.pointerId);
    pointers.set(event.pointerId, { ...pointer, x: event.clientX - rect.left, y: event.clientY - rect.top });
    const next = snapshot();
    if (gesture) {
      const dx = next.x - gesture.x, dy = next.y - gesture.y;
      if (pointers.size > 1 || pointer.pan || event.shiftKey || dragMode === 'pan') panEmbedded(dx, dy, false);
      else orbitEmbedded(-dx * 0.3, -dy * 0.3, false);
      if (next.distance && gesture.distance) {
        zoomEmbedded(next.distance / gesture.distance, next, false);
        let delta = next.angle - gesture.angle;
        delta = Math.atan2(Math.sin(delta), Math.cos(delta));
        rotateEmbedded(THREE.MathUtils.radToDeg(delta), false);
      }
      publishCamera();
    }
    gesture = next;
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(type, event => {
    pointers.delete(event.pointerId); gesture = snapshot();
  });
  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    if (!active || safariGesture) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? embeddedCamera.height : 1;
    if (event.ctrlKey || event.metaKey) {
      const rect = canvas.getBoundingClientRect();
      zoomEmbedded(Math.exp(-event.deltaY * unit * 0.008), { x: event.clientX - rect.left, y: event.clientY - rect.top });
    } else panEmbedded(-event.deltaX * unit, -event.deltaY * unit);
  }, { passive: false });
  // Safari reports an actual trackpad pinch/twist separately from a two-finger
  // scroll. Wheel deltas alone must never change the compass bearing.
  canvas.addEventListener('gesturestart', event => {
    event.preventDefault(); safariGesture = { scale: event.scale || 1, rotation: event.rotation || 0 };
  }, { passive: false });
  canvas.addEventListener('gesturechange', event => {
    event.preventDefault(); if (!safariGesture) return;
    zoomEmbedded((event.scale || 1) / safariGesture.scale, undefined, false);
    rotateEmbedded((event.rotation || 0) - safariGesture.rotation, false);
    safariGesture = { scale: event.scale || 1, rotation: event.rotation || 0 };
    publishCamera();
  }, { passive: false });
  canvas.addEventListener('gestureend', event => { event.preventDefault(); safariGesture = null; }, { passive: false });
  canvas.addEventListener('keydown', event => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.target.closest?.('input, textarea, select, [contenteditable=true]')) return;
    const deltas = { ArrowLeft: [48, 0], ArrowRight: [-48, 0], ArrowUp: [0, 48], ArrowDown: [0, -48] };
    if (deltas[event.key]) {
      event.preventDefault();
      if (event.shiftKey) {
        const orbit = { ArrowLeft: [-5, 0], ArrowRight: [5, 0], ArrowUp: [0, -5], ArrowDown: [0, 5] };
        orbitEmbedded(...orbit[event.key]);
      } else panEmbedded(...deltas[event.key]);
    }
    else if (['+', '=', '-', '_'].includes(event.key)) { event.preventDefault(); zoomEmbedded(['+', '='].includes(event.key) ? 1.25 : 0.8); }
    else if (['o', '0', 't', 'f', 'b', 'n'].includes(event.key.toLowerCase())) { event.preventDefault(); post({ type: 'olr-3d-key', key: event.key.toLowerCase() }); }
  });
}
window.addEventListener('message', event => {
  if (!EMBEDDED || event.source !== window.parent || event.origin !== location.origin || event.data?.type !== 'olr-3d-command') return;
  const { command, value } = event.data;
  if (command === 'camera' && value && Number.isFinite(value.center?.x) && Number.isFinite(value.center?.y) && Number.isFinite(value.scale) && value.scale > 0) {
    const incomingZoom = Number.isFinite(value.zoom) && value.zoom > 0 ? value.zoom : 1;
    const zoom = THREE.MathUtils.clamp(incomingZoom, 1, 32);
    embeddedCamera = { ...embeddedCamera, ...value, center: { ...value.center }, scale: value.scale * zoom / incomingZoom, bearing: Number.isFinite(value.bearing) ? value.bearing : CAMPUS_BEARING, tilt: Number.isFinite(value.tilt) ? THREE.MathUtils.clamp(value.tilt, MIN_TILT, MAX_TILT) : DEFAULT_TILT, zoom };
    savedEmbeddedCamera = structuredClone(embeddedCamera);
    if (typeof value.oldBuildings === 'boolean') setOldOutlines(value.oldBuildings);
    applyEmbeddedCamera();
  } else if (command === 'active') {
    active = Boolean(value);
    if (!active && frame !== null) { cancelAnimationFrame(frame); frame = null; }
    requestDraw();
  } else if (command === 'theme') {
    if (['system', 'light', 'dark'].includes(value?.preference)) themePreference = value.preference;
    applyTheme(['light', 'dark'].includes(value?.resolved) ? value.resolved : undefined);
  } else if (command === 'time-of-day' && typeof value === 'number' && Number.isFinite(value)) {
    setTimeOfDay(value, false);
  } else if (command === 'oldBuildings') setOldOutlines(value);
  else if (command === 'outlines') setOldOutlines({ visible: value?.visible, polygons: value?.rings });
  else if (command === 'drag-mode') setDragMode(value);
  else if (command === 'zoom') zoomEmbedded(value === 'in' ? 1.25 : 0.8);
  else if (command === 'rotate' && Number.isFinite(value)) rotateEmbedded(value);
  else if (command === 'north') { embeddedCamera.bearing = 0; applyEmbeddedCamera(true); }
  else if (command === 'compass') { embeddedCamera.bearing = Math.abs(embeddedCamera.bearing) < 0.001 ? CAMPUS_BEARING : 0; applyEmbeddedCamera(true); }
  else if (command === 'fit' && savedEmbeddedCamera) { embeddedCamera = structuredClone(savedEmbeddedCamera); applyEmbeddedCamera(true); }
});
let renderedFrames = 0;
Object.defineProperty(window, 'olr3d', { value: Object.freeze({
  get ready() { return Boolean(model); }, get embedded() { return EMBEDDED; }, get active() { return active; },
  get themePreference() { return themePreference; }, get resolvedTheme() { return resolvedTheme; },
  get lighting() { return campusLighting?.state ?? lightingAtTime(timeOfDay); },
  get oldBuildings() { return { visible: oldOutlineVisible, polygonCount: oldOutlinePolygons.length }; },
  get camera() { return structuredClone(embeddedCamera); }, get dragMode() { return dragMode; }, get frames() { return renderedFrames; },
  project(x, y, elevationFeet = 0) {
    if (!camera) return null;
    const point = new THREE.Vector3(x * FEET, elevationFeet * FEET, -y * FEET).project(camera);
    const rect = wrap.getBoundingClientRect();
    return { x: (point.x + 1) * rect.width / 2, y: (1 - point.y) * rect.height / 2 };
  }
}), writable: false });

async function init() {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
  renderer.setClearColor(resolvedTheme === 'dark' ? 0x181818 : 0xffffff);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  wrap.appendChild(renderer.domElement);
  renderer.domElement.tabIndex = 0;
  renderer.domElement.setAttribute('role', 'img');
  renderer.domElement.addEventListener('webglcontextlost', event => { event.preventDefault(); fail(new Error('WebGL context lost')); });
  scene = new THREE.Scene();
  setOldOutlines({ visible: oldOutlineVisible, polygons: oldOutlinePolygons });
  scene.background = new THREE.Color(resolvedTheme === 'dark' ? 0x181818 : 0xffffff);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  scene.environment = pmrem.fromScene(room, 0.05).texture;
  scene.environmentIntensity = 0.28;
  room.dispose();
  pmrem.dispose();
  hemi = new THREE.HemisphereLight(0xd3e3f0, 0x6c735f, 1.6);
  scene.add(hemi);
  sun = new THREE.DirectionalLight(0xfff8ef, 2.5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.bias = -0.00015;
  sun.shadow.normalBias = 0.15;
  scene.add(sun, sun.target);
  camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.2, 5000);
  setDragMode(dragMode, false);
  installEmbeddedNavigation();
  function resize() {
    const { width, height } = wrap.getBoundingClientRect();
    renderer.setSize(Math.max(1, width), Math.max(1, height));
    embeddedCamera.width = Math.max(1, width); embeddedCamera.height = Math.max(1, height);
    applyEmbeddedCamera(Boolean(model && active));
  }
  new ResizeObserver(resize).observe(wrap);
  resize();
  const gltf = await new GLTFLoader().loadAsync(`./OLR-New-Campus.glb?v=${ASSET_REVISION}`, event => {
    document.getElementById('loading-text').textContent = event.total ? `Opening the campus… ${Math.min(99, Math.round(event.loaded / event.total * 100))}%` : 'Opening the campus…';
  });
  model = gltf.scene;
  model.traverse(object => {
    if (object.isMesh) {
      object.castShadow = true;
      // This thin sloped apron self-shadows at the campus-wide shadow-map scale.
      object.receiveShadow = object.name !== 'Gaga_Ball_graded_lawn_apron';
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
  await loadCampusBoundary(scene, model, `./boundary-lines.json?v=${ASSET_REVISION}`).catch(error => console.warn(error));
  const bounds = new THREE.Box3().setFromObject(model, true);
  const size = bounds.getSize(new THREE.Vector3());
  target = bounds.getCenter(new THREE.Vector3());
  target.y = Math.max(0, bounds.min.y) + size.y * 0.12;
  extent = Math.max(size.x, size.z);
  campusLighting = createCampusLighting({ scene, model, keyLight: sun, hemisphere: hemi, renderer, target, extent });
  campusLighting.setTime(timeOfDay);
  lightingDirty = false;
  applyTheme();
  applyEmbeddedCamera();
  loading.hidden = true;
  document.body.classList.add('ready');
  post({ type: 'olr-3d-ready' });
  publishLighting();
  requestDraw();
}
// The main campus app is the only top-level experience. The document's early
// redirect also covers old links with ?embedded=1; this guard avoids allocating
// WebGL while a top-level redirect is in flight.
if (EMBEDDED) {
  setupTheme();
  setupTimeOfDay();
  document.addEventListener('visibilitychange', requestDraw);
  init().catch(fail);
} else {
  location.replace(new URL('../?view=3d', location.href).href);
}
