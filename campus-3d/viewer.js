import { loadCampusBoundary } from './campus-boundary.js?v=cff9d31e0ce590de';
import { createCampusLighting, lightingAtTime, normalizeMinutes, applyCampusPalette, CAMPUS_DAYLIGHT } from './campus-lighting.js?v=4821fc8f744c57ee';
import { createCampusWalk } from './campus-walk.js?v=07851a43718a2323';
import { createCampusDriving } from './campus-driving.js?v=da8d8c4e93bf53dc';
import { createCampusPlanGround } from './campus-plan-ground.js?v=0823de4c0c642c04';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createCampusAtmosphere } from './campus-atmosphere.js?v=cf320ecba907f5a5';
import { createCampusPdfCapture, loadHashedCampusModel } from './campus-pdf-capture.js?v=24cf28b4a2228ec2';

const EMBEDDED = window.parent !== window;
const FEET = 0.3048;
const CAMPUS_BEARING = 9.067253590763931;
const DEFAULT_TILT = 25;
const MIN_TILT = 0, MAX_TILT = 85;
const AERIAL_FOV = 50;
const themeMedia = matchMedia('(prefers-color-scheme: dark)');
let themePreference = 'system', resolvedTheme = 'light', active = false;
let hemi, sun, oldOutlines, oldOutlinePolygons = [], oldOutlineVisible = true;
let embeddedCamera = { center: { x: 15, y: 85 }, scale: 1, bearing: CAMPUS_BEARING, tilt: DEFAULT_TILT, zoom: 1, width: innerWidth, height: innerHeight };
let savedEmbeddedCamera = null;
const dragMode = 'rotate';
let campusLighting = null, campusAtmosphere = null, campusInteriorLighting = null, timeOfDay = 840, lightingDirty = true;
const ASSET_REVISION = 'ec2435c4ced5a795';
const wrap = document.getElementById('canvas-wrap');
const status = document.getElementById('status');
const loading = document.getElementById('loading');
const errorPanel = document.getElementById('error');
let renderer, camera, scene, extent = 200;
let modelBounds = null;
let aerialDistance = 1200;
const navigationRay = new THREE.Raycaster();
const navigationGround = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
let model, modelReady = false, frame = null, frameHost = null;
let modelSha256 = null, campusPdfCapture = null;
let preparedTextures = 0, preparationRenders = 0;
let walk = null, planGround = null, lastDrawTime = null, walkPresentation = '3d';
let driving = null, vehicleModel = null, parkedVehicle = null, vehicleConfig = null, vehicleSha256 = null;
let planOptions = { floor: 0, theme: 'light', oldBuildings: true };
let flatBounds = null;
let resetAerialInput = () => {};
let target = new THREE.Vector3();

document.getElementById('retry').addEventListener('click', () => location.reload());
// Messages belong only to this same-origin parent, never another frame.
function post(message, transfer = []) {
  if (!EMBEDDED) return;
  try { if (window.parent.location.origin !== location.origin) return; } catch { return; }
  window.parent.postMessage(message, location.origin, transfer);
}

function handlePdfCommand(command, value) {
  const requestId = value?.requestId;
  if (typeof requestId !== 'string' || !/^[\w.:-]{1,120}$/.test(requestId)) return;
  if (command === 'pdf-info') {
    post({ type: 'olr-3d-pdf-info', requestId, ready: modelReady, modelSha256, assetRevision: ASSET_REVISION, busy: campusPdfCapture?.state.busy ?? false });
    return;
  }
  if (command === 'pdf-cancel') { campusPdfCapture?.cancel(requestId); return; }
  if (!modelReady) {
    post({ type: 'olr-3d-pdf-error', requestId, code: 'NOT_READY', message: 'The campus model is still loading.' });
    return;
  }
  campusPdfCapture ||= createCampusPdfCapture({
    getModel: () => {
      // Printing uses the parked car, independent of the visitor's driving
      // position. Shared geometry is cloned by the existing capture pipeline.
      const campus = new THREE.Group();
      campus.add(model.clone(true));
      if (parkedVehicle) campus.add(parkedVehicle.clone(true));
      return campus;
    }, getSourceScene: () => scene,
    getModelSha256: () => modelSha256, getAssetRevision: () => ASSET_REVISION,
    createAtmosphere: createCampusAtmosphere, daylight: lightingAtTime(720), daylightStyle: CAMPUS_DAYLIGHT
  });
  campusPdfCapture.capture(requestId, value, progress => post({ type: 'olr-3d-pdf-progress', ...progress }))
    .then(result => post({ type: 'olr-3d-pdf-result', ...result }, result.views.map(view => view.buffer)))
    .catch(error => post({ type: 'olr-3d-pdf-error', requestId, code: error.code || 'CAPTURE_FAILED', message: error.message || 'The 3D views could not be captured.' }));
}

function fail(error) {
  modelReady = false;
  cancelDraw();
  console.error('Campus model:', error);
  loading.hidden = true;
  errorPanel.hidden = false;
  post({ type: 'olr-3d-error', message: 'The interactive campus model could not load.' });
}

function draw(timestamp) {
  frame = null; frameHost = null;
  if (!modelReady || !active || document.hidden) return;
  const dt = lastDrawTime === null ? 0 : Math.max(0, (timestamp - lastDrawTime) / 1000);
  walk?.update(dt);
  driving?.update(dt);
  const showingModel = walkPresentation === '3d';
  if (showingModel && lightingDirty && campusLighting) {
    campusLighting.setTime(timeOfDay);
    campusAtmosphere?.setTime(campusLighting.state);
    lightingDirty = false;
    updateOutlineColor();
  }
  const showingPlan = !showingModel && Boolean(walk?.camera);
  campusInteriorLighting?.update(driving?.camera || walk?.camera || camera, showingModel && Boolean(walk?.camera) && !driving?.camera);
  planGround?.setEnabled(showingPlan);
  // First person uses the exact same camera in both presentations. The flat
  // plan has its own unlit scene, so no model geometry or shadow can appear.
  if (showingPlan) {
    planGround.update(walk.camera, walk.state.flatGroundY);
    renderer.render(planGround.scene, walk.camera);
    renderedFrames++;
  } else if (showingModel) {
    const activeCamera = driving?.camera || walk?.camera || camera;
    campusAtmosphere?.updateCamera(activeCamera);
    renderer.render(scene, activeCamera);
    renderedFrames++;
  }
  lastDrawTime = walk?.needsAnimation || driving?.needsAnimation ? timestamp : null;
  if (walk?.needsAnimation || driving?.needsAnimation) requestDraw();
}
function cancelDraw() { if(frame !== null){frameHost.cancelAnimationFrame(frame);frame=null;frameHost=null;} }
function requestDraw() {
  if (modelReady && active && !document.hidden && renderer && camera && frame === null) {
    frameHost = window;
    frame = frameHost.requestAnimationFrame(draw);
  }
}
// Older parent frames may still send a mode command; dragging stays Rotate.
function setDragMode(_mode, announce = true) {
  if (!renderer) return;
  renderer.domElement.dataset.dragMode = dragMode;
  renderer.domElement.setAttribute('aria-label', 'Interactive new campus exterior model. Drag with a mouse or one finger to rotate and tilt. Right-drag, Shift-drag, or drag with two fingers to pan. Two-finger trackpad scrolling pans; pinch or Control-scroll zooms. Twist with two fingers to rotate. Keyboard: arrow keys pan; Shift and arrow keys rotate or tilt; plus and minus zoom; zero resets.');
  if (announce) {
    status.textContent = 'Drag to turn and tilt the campus.';
    publishCamera();
  }
}

// Preserve the map's scale at the view center. Perspective then makes nearer
// objects larger and farther objects smaller as the camera orbits the campus.
function publishCamera() {
  if (!model) return;
  post({ type: 'olr-3d-state', camera: structuredClone(embeddedCamera), dragMode });
}
function applyEmbeddedCamera(announce = false) {
  if (!camera) return;
  const rect = wrap.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  const width = Math.max(1, rect.width), height = Math.max(1, rect.height);
  embeddedCamera.width = width; embeddedCamera.height = height;
  const unitsPerPixel = FEET / embeddedCamera.scale;
  const requestedDistance = height * unitsPerPixel / (2 * Math.tan(THREE.MathUtils.degToRad(AERIAL_FOV / 2)));
  const theta = THREE.MathUtils.degToRad(embeddedCamera.bearing - CAMPUS_BEARING);
  const focus = new THREE.Vector3(embeddedCamera.center.x * FEET, 0, -embeddedCamera.center.y * FEET);
  const tilt = THREE.MathUtils.degToRad(embeddedCamera.tilt);
  const direction = new THREE.Vector3(Math.sin(theta) * Math.sin(tilt), Math.cos(tilt), Math.cos(theta) * Math.sin(tilt));
  aerialDistance = Math.max(requestedDistance, 6 * FEET / direction.y);
  // Dolly back before a close aerial view enters a roof or terrain. Reuse the
  // walker's spatial index, and report the adjusted scale to the 2D toolbar.
  for (let attempt = 0; attempt < 96; attempt++) {
    camera.position.copy(focus).addScaledVector(direction, aerialDistance);
    if (!walk || camera.position.y >= walk.clearanceHeight(camera.position.x, camera.position.z) + 6 * FEET) break;
    aerialDistance *= 1.08;
  }
  camera.position.copy(focus).addScaledVector(direction, aerialDistance);
  const constrained = aerialDistance > requestedDistance * (1 + 1e-10);
  if (constrained) {
    const ratio = requestedDistance / aerialDistance;
    embeddedCamera.scale *= ratio;
    embeddedCamera.zoom = Math.max(1, embeddedCamera.zoom * ratio);
  }
  Object.assign(camera, { aspect: width / height, fov: AERIAL_FOV, zoom: 1, far: Math.max(5000, aerialDistance + extent * 4) });
  // Retain the compass bearing even directly overhead, where world-up would
  // be parallel to the viewing direction and lookAt cannot resolve yaw.
  camera.up.set(-Math.sin(theta), 0, -Math.cos(theta));
  camera.lookAt(focus);
  camera.updateMatrixWorld();
  // A distant overview does not need a ten-centimeter near plane: reserving
  // depth precision for empty space makes paving and grass fight for pixels.
  // Stay well in front of the nearest model bound, including after panning.
  // First-person cameras retain their close near plane for doors and furniture.
  if (modelBounds) {
    const direction = camera.getWorldDirection(new THREE.Vector3());
    const half = modelBounds.getSize(new THREE.Vector3()).multiplyScalar(.5);
    const centerOffset = modelBounds.getCenter(new THREE.Vector3()).sub(camera.position);
    const closest = direction.dot(centerOffset) - Math.abs(direction.x) * half.x - Math.abs(direction.y) * half.y - Math.abs(direction.z) * half.z;
    camera.near = Math.max(.1, Math.min(aerialDistance / 25, closest / 4));
  }
  camera.updateProjectionMatrix();
  requestDraw();
  if (announce || constrained) publishCamera();
}
function groundAt(point) {
  const rect = wrap.getBoundingClientRect();
  navigationRay.setFromCamera(new THREE.Vector2(point.x / rect.width * 2 - 1, 1 - point.y / rect.height * 2), camera);
  // A tilted perspective view can include sky. Do not anchor navigation to a
  // backwards or near-horizon intersection thousands of feet off campus.
  if (navigationRay.ray.direction.y >= -1e-5) return null;
  const hit = navigationRay.ray.intersectPlane(navigationGround, new THREE.Vector3());
  return hit && hit.distanceTo(camera.position) <= aerialDistance * 8 ? hit : null;
}
function centerGroundOffset(dx, dy) {
  const theta = THREE.MathUtils.degToRad(embeddedCamera.bearing - CAMPUS_BEARING);
  const c = Math.cos(theta), s = Math.sin(theta), scale = embeddedCamera.scale;
  const foreshortening = Math.cos(THREE.MathUtils.degToRad(embeddedCamera.tilt));
  return { x: (c * dx + s * dy / foreshortening) / scale, y: (s * dx - c * dy / foreshortening) / scale };
}
function panEmbedded(dx, dy, announce = true, point) {
  const rect = wrap.getBoundingClientRect();
  const end = point || { x: rect.width / 2, y: rect.height / 2 };
  const from = groundAt({ x: end.x - dx, y: end.y - dy }), to = groundAt(end);
  if (from && to) {
    embeddedCamera.center.x += (from.x - to.x) / FEET;
    embeddedCamera.center.y -= (from.z - to.z) / FEET;
  } else {
    const delta = centerGroundOffset(dx, dy);
    embeddedCamera.center.x -= delta.x; embeddedCamera.center.y -= delta.y;
  }
  applyEmbeddedCamera(announce);
}
function zoomEmbedded(factor, point, announce = true) {
  const nextZoom = THREE.MathUtils.clamp(embeddedCamera.zoom * factor, 1, 32);
  const actual = nextZoom / embeddedCamera.zoom;
  const rect = wrap.getBoundingClientRect();
  const cursor = point || { x: rect.width / 2, y: rect.height / 2 };
  const before = groundAt(cursor);
  embeddedCamera.scale *= actual;
  embeddedCamera.zoom = nextZoom;
  applyEmbeddedCamera();
  const after = before && groundAt(cursor);
  if (after) {
    embeddedCamera.center.x += (before.x - after.x) / FEET;
    embeddedCamera.center.y -= (before.z - after.z) / FEET;
  }
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
  planOptions.theme = resolvedTheme;
  planGround?.setOptions(planOptions);
  updateOutlineColor();
  requestDraw();
}
function updateOutlineColor() {
  const darkScene = (campusLighting?.state?.daylight ?? lightingAtTime(timeOfDay).daylight) < .3;
  oldOutlines?.traverse(object => {
    if (!object.isLine) return;
    object.material.color.set(darkScene ? 0xffffff : 0x303030);
    // Ground annotations remain visible where real buildings do not occlude them.
    object.material.depthTest = true;
  });
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
    const material = new THREE.LineDashedMaterial({ color: resolvedTheme === 'dark' ? 0xffffff : 0x303030, dashSize: 1.5 * FEET, gapSize: 1.0 * FEET, depthTest: true, depthWrite: false, transparent: true, opacity: 0.95 });
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
  resetAerialInput = () => { pointers.clear(); gesture = null; safariGesture = null; };
  function snapshot() {
    const points = [...pointers.values()];
    if (!points.length) return null;
    if (points.length === 1) return { x: points[0].x, y: points[0].y, distance: 0, angle: 0 };
    const [a, b] = points;
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, distance: Math.hypot(b.x - a.x, b.y - a.y), angle: Math.atan2(b.y - a.y, b.x - a.x) };
  }
  canvas.addEventListener('contextmenu', event => event.preventDefault());
  canvas.addEventListener('pointerdown', event => {
    if (!active || driving?.state.driving || (walk && walk.mode !== 'aerial') || (event.pointerType === 'mouse' && ![0, 2].includes(event.button))) return;
    event.preventDefault(); canvas.focus({ preventScroll: true });
    canvas.setPointerCapture(event.pointerId);
    const rect = canvas.getBoundingClientRect();
    pointers.set(event.pointerId, { x: event.clientX - rect.left, y: event.clientY - rect.top, pan: event.button === 2 });
    gesture = snapshot();
  });
  canvas.addEventListener('pointermove', event => {
    if (!pointers.has(event.pointerId) || !active || safariGesture || driving?.state.driving || (walk && walk.mode !== 'aerial')) return;
    const rect = canvas.getBoundingClientRect();
    const pointer = pointers.get(event.pointerId);
    pointers.set(event.pointerId, { ...pointer, x: event.clientX - rect.left, y: event.clientY - rect.top });
    const next = snapshot();
    if (gesture) {
      const dx = next.x - gesture.x, dy = next.y - gesture.y;
      if (pointers.size > 1 || pointer.pan || event.shiftKey) panEmbedded(dx, dy, false, next);
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
    if (!active || safariGesture || driving?.state.driving || (walk && walk.mode !== 'aerial')) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? embeddedCamera.height : 1;
    if (event.ctrlKey || event.metaKey) {
      const rect = canvas.getBoundingClientRect();
      zoomEmbedded(Math.exp(-event.deltaY * unit * 0.008), { x: event.clientX - rect.left, y: event.clientY - rect.top });
    } else {
      const rect = canvas.getBoundingClientRect();
      panEmbedded(-event.deltaX * unit, -event.deltaY * unit, true, { x: event.clientX - rect.left, y: event.clientY - rect.top });
    }
  }, { passive: false });
  // Safari reports an actual trackpad pinch/twist separately from a two-finger
  // scroll. Wheel deltas alone must never change the compass bearing.
  canvas.addEventListener('gesturestart', event => {
    if (!active || driving?.state.driving || (walk && walk.mode !== 'aerial')) return;
    event.preventDefault(); safariGesture = { scale: event.scale || 1, rotation: event.rotation || 0 };
  }, { passive: false });
  canvas.addEventListener('gesturechange', event => {
    if (!active || driving?.state.driving || (walk && walk.mode !== 'aerial')) return;
    event.preventDefault(); if (!safariGesture) return;
    zoomEmbedded((event.scale || 1) / safariGesture.scale, undefined, false);
    rotateEmbedded((event.rotation || 0) - safariGesture.rotation, false);
    safariGesture = { scale: event.scale || 1, rotation: event.rotation || 0 };
    publishCamera();
  }, { passive: false });
  canvas.addEventListener('gestureend', event => { event.preventDefault(); safariGesture = null; }, { passive: false });
  canvas.addEventListener('keydown', event => {
    if (!active) return;
    if (event.ctrlKey || event.metaKey || event.altKey || event.target.closest?.('input, textarea, select, [contenteditable=true]')) return;
    // F belongs to the car only when the visitor is near it or seated inside.
    if (driving?.state.driving || (event.code === 'KeyF' && driving?.state.near)) return;
    if (walk && walk.mode !== 'aerial') {
      // Movement is owned by the walker; plan/layer shortcuts still belong to
      // the common toolbar when the first-person canvas has keyboard focus.
      const key = event.key.toLowerCase();
      if (!event.repeat && ['o','f','b','t'].includes(key)) {
        event.preventDefault(); post({type:'olr-3d-key',key});
      }
      return;
    }
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
  if (['pdf-info', 'pdf-capture', 'pdf-cancel'].includes(command)) { handlePdfCommand(command, value); return; }
  if (command === 'walk-presentation' && ['2d', '3d'].includes(value)) {
    if (value === '2d' && driving?.state.driving && !driving.command('drive-exit')) {
      post({type:'olr-3d-drive',...driving.state,presentationBlocked:true});
      return;
    }
    if (walkPresentation !== value) cancelDraw();
    walkPresentation = value;
    if (value === '2d') planGround?.preload();
    walk?.command('walk-presentation', value);
    if (['walking', 'flying'].includes(walk?.mode)) renderer?.domElement.focus({preventScroll:true});
    requestDraw();
    return;
  }
  if (command === 'plan-options' && value && typeof value === 'object') {
    if ([0, 1, 2].includes(value.floor)) planOptions.floor = value.floor;
    if (['light', 'dark'].includes(value.theme)) planOptions.theme = value.theme;
    if (typeof value.oldBuildings === 'boolean') planOptions.oldBuildings = value.oldBuildings;
    planGround?.setOptions(planOptions);
    requestDraw(); return;
  }
  if (['walk-place', 'fly-place', 'walk-place-at', 'walk-start', 'walk-exit', 'walk-run', 'walk-input', 'walk-release-pointer'].includes(command)) {
    if (driving?.state.driving) {
      if (['walk-place', 'fly-place', 'walk-start', 'walk-exit'].includes(command)) driving.command('drive-exit', {resumeWalking:false});
      else if (command === 'walk-release-pointer') { driving.command('drive-release-pointer'); return; }
      else return;
    }
    if (active) walk?.command(command, value);
    return;
  }
  if (['drive-toggle', 'drive-exit', 'drive-input', 'drive-release-pointer'].includes(command)) {
    if (active) driving?.command(command, value);
    return;
  }
  if ((driving?.state.driving || (walk && walk.mode !== 'aerial')) && ['camera', 'drag-mode', 'zoom', 'rotate', 'north', 'compass', 'fit'].includes(command)) return;
  if (command === 'camera' && value && Number.isFinite(value.center?.x) && Number.isFinite(value.center?.y) && Number.isFinite(value.scale) && value.scale > 0) {
    const incomingZoom = Number.isFinite(value.zoom) && value.zoom > 0 ? value.zoom : 1;
    const zoom = THREE.MathUtils.clamp(incomingZoom, 1, 32);
    embeddedCamera = { ...embeddedCamera, ...value, dragMode, center: { ...value.center }, scale: value.scale * zoom / incomingZoom, bearing: Number.isFinite(value.bearing) ? value.bearing : CAMPUS_BEARING, tilt: Number.isFinite(value.tilt) ? THREE.MathUtils.clamp(value.tilt, MIN_TILT, MAX_TILT) : DEFAULT_TILT, zoom };
    if (typeof value.oldBuildings === 'boolean') setOldOutlines(value.oldBuildings);
    applyEmbeddedCamera();
    savedEmbeddedCamera = structuredClone(embeddedCamera);
  } else if (command === 'active') {
    active = Boolean(value);
    if (!active) { driving?.pause(); walk?.pause(); resetAerialInput(); lastDrawTime = null; }
    if (!active) cancelDraw();
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
  get ready() { return modelReady; }, get embedded() { return EMBEDDED; }, get active() { return active; },
  get modelSha256() { return modelSha256; }, get assetRevision() { return ASSET_REVISION; },
  get pdfCapture() { return campusPdfCapture?.state ?? { busy: false, requestId: null, completed: 0, views: 4 }; },
  get preparation() { return { complete: modelReady, textures: preparedTextures, renders: preparationRenders }; },
  get themePreference() { return themePreference; }, get resolvedTheme() { return resolvedTheme; },
  get atmosphere() { return campusAtmosphere?.state ?? null; },
  get lighting() { return campusLighting?.state ?? lightingAtTime(timeOfDay); },
  get interiorLighting() { return campusInteriorLighting?.state ?? { ready: false, active: false, poolSize: 0 }; },
  get oldBuildings() { return { visible: oldOutlineVisible, polygonCount: oldOutlinePolygons.length }; },
  get camera() { return structuredClone(embeddedCamera); }, get dragMode() { return dragMode; }, get frames() { return renderedFrames; },
  get walk() { return walk?.state ?? { mode: 'aerial', eyeHeightFeet: 6 }; },
  get driving() { return {...(driving?.state ?? {available:false,driving:false,near:false}), modelSha256:vehicleSha256}; },
  get walkPresentation() { return walkPresentation; },
  get plan() { return planGround?.state ?? { ready: false, flat: true, ...planOptions }; },
  get renderState() { const view=driving?.camera||walk?.camera; return { presentation: walkPresentation, firstPerson: Boolean(view), scene: walkPresentation === '2d' && walk?.camera ? 'flat-plan' : 'campus-model', depthBuffer: renderer?.capabilities.reversedDepthBuffer ? 'reversed' : 'standard', logarithmicDepthBuffer: renderer?.capabilities.logarithmicDepthBuffer ?? false, drawCalls: renderer?.info.render.calls ?? 0, triangles: renderer?.info.render.triangles ?? 0, camera: view ? { position: view.position.toArray(), quaternion: view.quaternion.toArray(), fov: view.fov } : null }; },
  project(x, y, elevationFeet = 0) {
    if (!camera) return null;
    const point = new THREE.Vector3(x * FEET, elevationFeet * FEET, -y * FEET).project(driving?.camera || walk?.camera || camera);
    const rect = wrap.getBoundingClientRect();
    return { x: (point.x + 1) * rect.width / 2, y: (1 - point.y) * rect.height / 2 };
  }
}), writable: false });

function createInteriorLighting(data) {
  const polygonValid = p => Array.isArray(p) && p.length >= 3 && p.every(v => Array.isArray(v) && v.length === 2 && v.every(Number.isFinite));
  const buildings = (data.buildings || []).filter(b => typeof b.id === 'string' && Number.isFinite(b.floor) && Number.isFinite(b.floorElevationFeet) && polygonValid(b.polygonWorldFeet));
  const rooms = (data.rooms || []).filter(r => typeof r.id === 'string' && polygonValid(r.polygonWorldFeet));
  const contains = (polygon, x, y) => {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const a = polygon[i], b = polygon[j];
      if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
    return inside;
  };
  // Fixture emission and the campus lighting stay independent of camera
  // proximity. Keep location diagnostics, without moving extra lights between
  // ceiling panels as the visitor walks or flies through the building.
  let location = null;
  function update(activeCamera, firstPerson) {
    const x = activeCamera.position.x / FEET, y = -activeCamera.position.z / FEET, elevation = activeCamera.position.y / FEET;
    const building = firstPerson && buildings.find(b => {
      const height = Number.isFinite(b.interiorHeightFeet) && b.interiorHeightFeet > 0
        ? b.interiorHeightFeet : (b.floor === 1 ? 14.05 : 13.4);
      return elevation >= b.floorElevationFeet && elevation < b.floorElevationFeet + height && contains(b.polygonWorldFeet, x, y);
    });
    if (!building) {
      location = null;
      return;
    }
    const room = rooms.find(r => r.building === building.id && r.floor === building.floor && contains(r.polygonWorldFeet, x, y));
    location = { building: building.id, floor: building.floor, roomId: room?.id || null };
  }
  return Object.freeze({ update, get state() { return { ready: true, active: Boolean(location), ...location, poolSize: 0, proximityEffects: false, shadowCasting: false, lights: [] }; } });
}

async function warmModel() {
  // Compile every material and upload the whole scene before declaring ready.
  // This is a single preparation render, independent of visibility/navigation.
  const textures = new Set(), culling = [];
  scene.traverse(object => {
    if (!object.isMesh && !object.isLine && !object.isPoints) return;
    culling.push([object, object.frustumCulled]);
    object.frustumCulled = false;
    for (const material of (Array.isArray(object.material) ? object.material : [object.material])) {
      if (material) for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    }
  });
  try {
    await renderer.compileAsync(scene, camera);
    for (const texture of textures) renderer.initTexture(texture);
    preparedTextures = textures.size;
    campusAtmosphere?.updateCamera(camera);
    renderer.render(scene, camera);
    preparationRenders++;
    renderedFrames++;
  } finally {
    for (const [object, previous] of culling) object.frustumCulled = previous;
  }
}

async function loadVehicle() {
  const url = './vehicle-config.json?v=b3c85f5b4ae43393';
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Vehicle metadata HTTP ${response.status}`);
  const bytes = await response.arrayBuffer();
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('');
  const expected = new URL(url, location.href).searchParams.get('v');
  if (expected && !digest.startsWith(expected)) throw new Error('The vehicle metadata changed while loading. Please reload.');
  const config = JSON.parse(new TextDecoder().decode(bytes));
  if (config.version !== 1 || !/^[a-f0-9]{64}$/.test(config.model?.sha256 || '') || !Number.isSafeInteger(config.model?.bytes) || config.model.bytes <= 0) throw new Error('Invalid vehicle metadata.');
  const asset = new URL(config.model.url, location.href);
  if (asset.origin !== location.origin || !asset.pathname.includes('/vehicles/')) throw new Error('Invalid vehicle asset URL.');
  let count = 0;
  const loaded = await loadHashedCampusModel(new GLTFLoader(), asset.href, progress => { count = progress.loaded; });
  if (loaded.sha256 !== config.model.sha256 || count !== config.model.bytes) throw new Error('Vehicle model verification failed. Please reload.');
  return {config, ...loaded};
}

async function init() {
  // Native depth testing rejects hidden room fragments before shading them.
  // Logarithmic depth writes gl_FragDepth and disables that optimization on
  // affected GPUs. The campus camera range does not need logarithmic depth.
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
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
  planGround = createCampusPlanGround({ renderer, requestDraw, onBounds: bounds => { flatBounds = bounds; walk?.setFlatBounds(bounds); } });
  planGround.setOptions(planOptions);
  if (walkPresentation === '2d') planGround.preload();
  scene = new THREE.Scene();
  setOldOutlines({ visible: oldOutlineVisible, polygons: oldOutlinePolygons });
  scene.background = new THREE.Color(resolvedTheme === 'dark' ? 0x181818 : 0xffffff);
  hemi = new THREE.HemisphereLight(0xd3e3f0, 0x6c735f, 1.6);
  scene.add(hemi);
  sun = new THREE.DirectionalLight(0xfff8ef, 2.5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.bias = -0.00015;
  // Keep contact shadows close to walls, benches, and planting.
  sun.shadow.normalBias = 0.035;
  scene.add(sun, sun.target);
  camera = new THREE.PerspectiveCamera(AERIAL_FOV, 1, 0.1, 5000);
  setDragMode(dragMode, false);
  installEmbeddedNavigation();
  function resize() {
    const { width, height } = wrap.getBoundingClientRect();
    if (width <= 0 || height <= 0) return;
    renderer.setSize(Math.max(1, width), Math.max(1, height));
    embeddedCamera.width = Math.max(1, width); embeddedCamera.height = Math.max(1, height);
    applyEmbeddedCamera(Boolean(model && active));
    walk?.resize(Math.max(1, width), Math.max(1, height));
    driving?.resize(Math.max(1, width), Math.max(1, height));
  }
  new ResizeObserver(resize).observe(wrap);
  resize();
  const [loadedModel, loadedVehicle] = await Promise.all([loadHashedCampusModel(new GLTFLoader(), `./OLR-New-Campus.glb?v=${ASSET_REVISION}`, event => {
    document.getElementById('loading-text').textContent = event.total ? `Opening the campus… ${Math.min(99, Math.round(event.loaded / event.total * 100))}%` : 'Opening the campus…';
  }), loadVehicle()]);
  const { gltf } = loadedModel;
  modelSha256 = loadedModel.sha256;
  model = gltf.scene;
  model.traverse(object => {
    if (object.isMesh) {
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      const windowGlass = material => /glazing|School clear glass/i.test(material.name);
      // Alpha-blended panes show the actual interior and must not cast a solid
      // opaque window-sized shadow. Door frames and bronze trim remain solid.
      object.castShadow = materials.some(material => !windowGlass(material));
      // This thin sloped apron self-shadows at the campus-wide shadow-map scale.
      object.receiveShadow = object.name !== 'Gaga_Ball_graded_lawn_apron';
      for (const material of materials) {
        if (windowGlass(material)) {
          material.transparent = true;
          material.opacity = Math.min(material.opacity, /School clear glass/i.test(material.name) ? .25 : .35);
          material.depthWrite = false;
          material.side = THREE.DoubleSide;
          material.forceSinglePass = true;
        }
        for (const texture of [material.map, material.normalMap, material.roughnessMap, material.metalnessMap]) {
          if (texture) texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
        }
      }
    }
  });
  // Viewer lighting is controlled here so the model looks consistent on all devices.
  const importedLights = [];
  model.traverse(object => { if (object.isLight) importedLights.push(object); });
  importedLights.forEach(light => light.removeFromParent());
  scene.add(model);
  await fetch(`./campus-interiors.json?v=${ASSET_REVISION}`).then(response => {
    if (!response.ok) throw new Error(`Interior lighting metadata HTTP ${response.status}`);
    return response.json();
  }).then(data => { campusInteriorLighting = createInteriorLighting(data); }).catch(error => console.warn(error));
  await loadCampusBoundary(scene, model, `./boundary-lines.json?v=${ASSET_REVISION}`).catch(error => console.warn(error));
  const bounds = new THREE.Box3().setFromObject(model, true);
  modelBounds = bounds;
  const size = bounds.getSize(new THREE.Vector3());
  target = bounds.getCenter(new THREE.Vector3());
  target.y = Math.max(0, bounds.min.y) + size.y * 0.12;
  extent = Math.max(size.x, size.z);
  applyCampusPalette(model);
  campusAtmosphere = createCampusAtmosphere({ scene, renderer, model, groundColor: CAMPUS_DAYLIGHT.lawnColor });
  campusLighting = createCampusLighting({ scene, model, keyLight: sun, hemisphere: hemi, renderer, target, extent });
  campusLighting.setTime(timeOfDay);
  campusAtmosphere.setTime(campusLighting.state);
  lightingDirty = false;
  walk = createCampusWalk({
    model, canvas: renderer.domElement,
    getAerialCamera: () => camera,
    getAerialPose: () => structuredClone(embeddedCamera),
    requestDraw,
    canFocus: () => active,
    onPose: pose => { if (walkPresentation === '2d') post({type:'olr-3d-walk-pose', ...pose}); },
    onChange: state => {
      resetAerialInput();
      updateOutlineColor();
      if (state.mode === 'aerial') setDragMode(dragMode, false);
      else {
        const flat = walkPresentation === '2d';
        const movement = state.mode === 'flying' ? 'WASD or arrows move; Space or E rises; Q descends; Shift speeds up.' : 'WASD or arrows move; Space jumps; Shift runs.';
        renderer.domElement.setAttribute('aria-label', state.mode === 'placing'
          ? `Choose a starting point on ${flat ? 'the campus plan' : 'a path, lawn, or roof'}.`
          : `First-person ${flat ? 'campus floor plan on a flat ground surface' : 'campus model'} at ${state.mode === 'flying' ? 'your flight altitude' : 'six-foot eye height'}. ${movement} Click to capture the mouse or drag to look; Escape releases the mouse; Normal returns to the aerial view.`);
      }
      post({ type: 'olr-3d-walk', ...state });
      requestDraw();
    }
  });
  walk.command('walk-presentation', walkPresentation);
  if (flatBounds) walk.setFlatBounds(flatBounds);
  walk.resize(wrap.clientWidth, wrap.clientHeight);
  driving = createCampusDriving({
    THREE, scene, canvas:renderer.domElement, getWalk:()=>walk, requestDraw,
    canFocus:()=>active&&!document.hidden, getPresentation:()=>walkPresentation,
    onChange:state=>{
      resetAerialInput();
      if(state.driving)renderer.domElement.setAttribute('aria-label','Driving the red Tesla Model 3. W or up accelerates; S or down brakes and reverses; A and D steer; Space brakes. Mouse or drag looks around. F or Exit car returns to Walking.');
      post({type:'olr-3d-drive',...state});
      requestDraw();
    }
  });
  vehicleModel = loadedVehicle.gltf.scene;
  vehicleConfig = loadedVehicle.config;
  vehicleSha256 = loadedVehicle.sha256;
  driving.setVehicle(vehicleModel, vehicleConfig);
  parkedVehicle = vehicleModel.clone(true);
  parkedVehicle.name = 'Parked red Model 3';
  // The isolated print clone may cast a conventional static shadow, while the
  // live car uses a moving contact shadow without re-rendering campus shadows.
  parkedVehicle.traverse(object=>{if(object.isMesh)object.castShadow=!object.material?.transparent;});
  driving.resize(wrap.clientWidth, wrap.clientHeight);
  applyTheme();
  applyEmbeddedCamera();
  await warmModel();
  modelReady = true;
  loading.hidden = true;
  document.body.classList.add('ready');
  post({ type: 'olr-3d-ready', modelSha256, assetRevision: ASSET_REVISION });
  post({ type: 'olr-3d-walk', ...walk.state });
  publishLighting();
  requestDraw();
}
// The main campus app is the only top-level experience. The document's early
// redirect also covers old links with ?embedded=1; this guard avoids allocating
// WebGL while a top-level redirect is in flight.
if (EMBEDDED) {
  setupTheme();
  setupTimeOfDay();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { driving?.pause(); walk?.pause(); resetAerialInput(); lastDrawTime = null; }
    requestDraw();
  });
  window.addEventListener('blur', () => { driving?.pause(); walk?.pause(); resetAerialInput(); lastDrawTime = null; });
  init().catch(fail);
} else {
  location.replace(new URL('../?view=3d', location.href).href);
}
