import * as THREE from 'three';

const FEET = .3048;
const validId = value => typeof value === 'string' && /^[\w.:-]{1,120}$/.test(value);
const nextTask = () => new Promise(resolve => setTimeout(resolve, 0));
const failure = (code, message) => Object.assign(new Error(message), { code });

// Camera positions/targets are copied from the canonical PDF camera config.
// Blender uses a 36mm horizontal film gate, with lens shifts in gate widths.
export const PDF_PERSPECTIVES = Object.freeze([
  { id: 'frontage-road', title: 'New campus: 3D view from Frontage Road', filename: 'frontage-road.jpg', width: 3072, height: 1860,
    position: [80, 495, 175], target: [130, 105, 10], lens: 23, shiftX: 0, shiftY: -.1 },
  { id: 'james-drive', title: 'New campus: 3D view from James Drive', filename: 'james-drive.jpg', width: 3072, height: 1860,
    position: [-80, -290, 180], target: [100, 95, 10], lens: 28, shiftX: 0, shiftY: -.07 },
  { id: 'campus-overview', title: 'New campus: 3D campus overview', filename: 'campus-overview.jpg', width: 3072, height: 1860,
    position: [-800, -720, 750], target: [10, 80, 4], lens: 40, shiftX: 0, shiftY: 0 },
  { id: 'playground-gardens', title: 'New campus: 3D playground and Guardian Angel garden', filename: 'playground-gardens.jpg', width: 3072, height: 2049,
    position: [-239.35553444751628, -92.18081199482522, 129.37224389533966], target: [114.9943334568776, 100.32696279248414, 0], lens: 29.313100363978613, shiftX: -.09913678799598277, shiftY: -.054870317650571494 }
]);

export function normalizePdfViews(input) {
  if (input === undefined) return PDF_PERSPECTIVES;
  const list = Array.isArray(input) ? input : input?.views;
  const resolution = Array.isArray(input) ? [3072, 1860] : input?.resolution;
  const sizeValid = size => Array.isArray(size) && size.length === 2 && size.every(n => Number.isInteger(n) && n >= 512 && n <= 4096);
  const vectorValid = point => Array.isArray(point) && point.length === 3 && point.every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 10000);
  const numberValid = (number, low, high) => typeof number === 'number' && Number.isFinite(number) && number >= low && number <= high;
  if (!Array.isArray(list) || list.length !== 4 || !sizeValid(resolution)) throw failure('INVALID_CAMERAS', 'Exactly four valid PDF camera views are required.');
  return PDF_PERSPECTIVES.map(expected => {
    const matches = list.filter(view => view?.id === expected.id);
    const view = matches[0], camera = view?.camera, size = view?.resolution ?? resolution;
    if (matches.length !== 1 || !sizeValid(size) || !vectorValid(camera?.position_ft) || !vectorValid(camera?.target_ft)
      || !numberValid(camera.lens_mm, 10, 120) || !numberValid(camera.shift_x ?? 0, -1, 1) || !numberValid(camera.shift_y ?? 0, -1, 1)
      || Math.hypot(...camera.position_ft.map((n, i) => n - camera.target_ft[i])) < 1) throw failure('INVALID_CAMERAS', 'A PDF camera configuration is invalid.');
    return { id: expected.id, title: typeof view.title === 'string' && view.title.length <= 180 ? view.title : expected.title,
      filename: expected.filename, width: size[0], height: size[1], position: [...camera.position_ft], target: [...camera.target_ft],
      lens: camera.lens_mm, shiftX: camera.shift_x ?? 0, shiftY: camera.shift_y ?? 0 };
  });
}

export function createPdfCamera(view, width, height) {
  const camera = new THREE.PerspectiveCamera(50, width / height, .5, 5000);
  camera.filmGauge = 36;
  camera.setFocalLength(view.lens);
  camera.setViewOffset(width, height, view.shiftX * width, -view.shiftY * width, width, height);
  const world = ([x, y, z]) => new THREE.Vector3(x * FEET, z * FEET, -y * FEET);
  camera.position.copy(world(view.position));
  camera.up.set(0, 1, 0);
  camera.lookAt(world(view.target));
  camera.updateMatrixWorld();
  return camera;
}

// Hash and parse the same response bytes. This cannot report one version's
// digest while the GLTFLoader happens to retrieve a different deployed model.
export async function loadHashedCampusModel(loader, url, onProgress) {
  const response = await fetch(url);
  if (!response.ok) throw failure('MODEL_HTTP', `Campus model HTTP ${response.status}`);
  const total = Number(response.headers.get('content-length')) || 0;
  let buffer;
  if (response.body?.getReader) {
    const reader = response.body.getReader(), chunks = [];
    let loaded = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); loaded += value.byteLength;
        onProgress?.({ loaded, total });
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    buffer = bytes.buffer;
  } else {
    buffer = await response.arrayBuffer();
    onProgress?.({ loaded: buffer.byteLength, total });
  }
  if (!globalThis.crypto?.subtle) throw failure('MODEL_DIGEST', 'Secure model verification is unavailable.');
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  const sha256 = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
  const gltf = await loader.parseAsync(buffer, new URL('.', new URL(url, location.href)).href);
  return { gltf, sha256 };
}

export function createCampusPdfCapture({ getModel, getSourceScene, getModelSha256, getAssetRevision, createAtmosphere, daylight }) {
  let job = null, completed = 0;
  function cancel(requestId) {
    if (!job || job.requestId !== requestId) return false;
    job.cancelled = true;
    return true;
  }
  async function capture(requestId, options = {}, onProgress = () => {}) {
    if (!validId(requestId)) throw failure('INVALID_REQUEST', 'A valid PDF request ID is required.');
    if (job) throw failure('BUSY', 'Another PDF capture is already running.');
    const requestedViews = normalizePdfViews(options.views);
    const originalModel = getModel(), originalScene = getSourceScene();
    const modelSha256 = getModelSha256(), assetRevision = getAssetRevision();
    if (!originalModel || !/^[a-f0-9]{64}$/.test(modelSha256 || '')) throw failure('NOT_READY', 'The campus model is still loading.');
    const current = job = { requestId, cancelled: false };
    const check = () => { if (current.cancelled) throw failure('CANCELLED', 'PDF generation was cancelled.'); };
    let renderer, atmosphere, keyLight, canvas;
    const ownedMaterials = new Set();
    try {
      check();
      canvas = document.createElement('canvas');
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
      canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); current.cancelled = true; });
      renderer.setPixelRatio(1);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.AgXToneMapping;
      renderer.toneMappingExposure = 1.02;
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.shadowMap.autoUpdate = false;
      const scene = new THREE.Scene();
      scene.background = new THREE.Color('#cbdde8');
      scene.environmentIntensity = .65;
      const materials = new Map();
      function copyMaterial(material) {
        if (!materials.has(material)) {
          const copy = material.clone();
          // The live lighting module may currently have nighttime glazing glow.
          if (/glazing/i.test(copy.name) && copy.emissive) { copy.emissive.set(0); copy.emissiveIntensity = 0; }
          materials.set(material, copy); ownedMaterials.add(copy);
        }
        return materials.get(material);
      }
      function cloneForCapture(source) {
        const copy = source.clone(true);
        copy.traverse(object => {
          if (object.material) object.material = Array.isArray(object.material) ? object.material.map(copyMaterial) : copyMaterial(object.material);
        });
        return copy;
      }
      const model = cloneForCapture(originalModel);
      model.visible = true;
      scene.add(model);
      const boundary = originalScene.getObjectByName('Campus boundary annotation');
      if (boundary) scene.add(cloneForCapture(boundary));
      const bounds = new THREE.Box3().setFromObject(model, true), size = bounds.getSize(new THREE.Vector3());
      const target = bounds.getCenter(new THREE.Vector3());
      target.y = Math.max(0, bounds.min.y) + size.y * .12;
      const extent = Math.max(size.x, size.z);
      scene.add(new THREE.HemisphereLight(0xc6dff6, 0x6c735f, .68));
      keyLight = new THREE.DirectionalLight(0xfff8ef, daylight.sunIntensity);
      keyLight.position.copy(target).addScaledVector(new THREE.Vector3(...daylight.sunDirection), extent * 1.3);
      keyLight.target.position.copy(target);
      keyLight.castShadow = true;
      keyLight.shadow.mapSize.set(4096, 4096);
      keyLight.shadow.bias = -.00015; keyLight.shadow.normalBias = .035;
      Object.assign(keyLight.shadow.camera, { left: -extent * .72, right: extent * .72, top: extent * .72, bottom: -extent * .72, near: 1, far: extent * 3 });
      keyLight.shadow.camera.updateProjectionMatrix();
      scene.add(keyLight, keyLight.target);
      atmosphere = createAtmosphere({ scene, renderer, model, groundColor: [.102034, .160133, .045757] });
      atmosphere.setTime(daylight);
      renderer.shadowMap.needsUpdate = true;
      const maxWidth = Number.isFinite(options.maxWidth) ? THREE.MathUtils.clamp(Math.round(options.maxWidth), 1024, 3072) : 3072;
      const limit = Math.min(maxWidth, renderer.capabilities.maxTextureSize, renderer.getContext().getParameter(renderer.getContext().MAX_RENDERBUFFER_SIZE));
      const views = [];
      for (const view of requestedViews) {
        await nextTask(); check();
        const width = Math.min(view.width, limit), height = Math.round(view.height * width / view.width);
        renderer.setSize(width, height, false);
        const camera = createPdfCamera(view, width, height);
        atmosphere.updateCamera(camera);
        renderer.render(scene, camera);
        if (renderer.getContext().isContextLost()) throw failure('WEBGL_CONTEXT', 'The 3D capture ran out of graphics resources. Please try again.');
        // toBlob snapshots the just-rendered default framebuffer before the
        // event loop yields; preserveDrawingBuffer is not needed for the app.
        const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(failure('ENCODING', 'A 3D view could not be encoded.')), 'image/jpeg', .95));
        check();
        views.push({ id: view.id, title: view.title, filename: view.filename, width, height, mimeType: 'image/jpeg', buffer: await blob.arrayBuffer() });
        check();
        onProgress({ requestId, completed: views.length, total: PDF_PERSPECTIVES.length, viewId: view.id });
      }
      completed++;
      return { requestId, modelSha256, assetRevision, minutes: 720, cameraSource: options.views === undefined ? 'bundled' : 'request', views };
    } finally {
      // Shared model geometry and image textures belong to the live viewer.
      // Dispose only clone-owned state and the temporary GPU context.
      atmosphere?.dispose();
      keyLight?.shadow.map?.dispose(); keyLight?.shadow.mapPass?.dispose();
      for (const material of ownedMaterials) material.dispose();
      renderer?.dispose(); renderer?.forceContextLoss();
      if (canvas) { canvas.width = 1; canvas.height = 1; }
      if (job === current) job = null;
    }
  }
  return Object.freeze({ capture, cancel, get state() { return { busy: Boolean(job), requestId: job?.requestId ?? null, completed, views: PDF_PERSPECTIVES.length }; } });
}
