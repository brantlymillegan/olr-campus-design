import * as THREE from 'three';

const FT = .3048;
const PLAN_REVISION = 'cb56cdf117a3b7f9';
const DETAIL_FEET = 128, DETAIL_STEP_FEET = 32;

// Only these two textures are resident: a campus overview and one sharp local
// patch. SVG is rasterized when the selected plan or patch changes, never in the
// animation loop. The old patch stays visible until its replacement is ready.
export function createCampusPlanGround({ renderer, requestDraw, onBounds = () => {} }) {
  const scene = new THREE.Scene();
  const group = new THREE.Group(); scene.add(group);
  const paper = new THREE.Mesh(new THREE.PlaneGeometry(20000, 20000), new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, side: THREE.DoubleSide }));
  paper.rotation.x = -Math.PI / 2; paper.renderOrder = -1; group.add(paper);
  const overview = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ toneMapped: false, side: THREE.DoubleSide, depthTest: false }));
  overview.rotation.x = -Math.PI / 2; overview.visible = false; group.add(overview);
  const detail = new THREE.Mesh(new THREE.PlaneGeometry(DETAIL_FEET * FT, DETAIL_FEET * FT), new THREE.MeshBasicMaterial({ toneMapped: false, side: THREE.DoubleSide, depthTest: false }));
  detail.rotation.x = -Math.PI / 2; detail.renderOrder = 1; detail.visible = false; group.add(detail);
  const maxRasterSize = Math.min(2048, renderer.capabilities.maxTextureSize);
  const anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  let manifest = null, svgRoot = null, overviewKey = '', detailKey = '', optionsKey = '';
  let options = { floor: 0, theme: 'light', oldBuildings: true };
  let generation = 0, enabled = false, busy = false, pending = false;
  let wantedCenter = { x: 0, y: 0 }, appliedCenter = null, elevation = 0;
  let error = null, rasterCount = 0, discardedRasters = 0, textureBytes = 0;
  let manifestPromise = null;
  const worldDirection = new THREE.Vector3();
  function color() { return options.theme === 'dark' ? '#181818' : '#ffffff'; }
  function setColors() {
    paper.material.color.set(color());
    scene.background = new THREE.Color(options.theme === 'dark' ? '#20242a' : '#dce8ed');
  }
  setColors();
  async function loadManifest() {
    if (!manifestPromise) manifestPromise = fetch(new URL(`./plan-ground/manifest.json?v=${PLAN_REVISION}`, import.meta.url), { cache: 'no-cache' }).then(response => {
      if (!response.ok) throw new Error(`Plan manifest: ${response.status}`);
      return response.json();
    }).then(data => {
      if (!Array.isArray(data.boundsFeet) || data.boundsFeet.length !== 4 || !data.boundsFeet.every(Number.isFinite) || !data.variants) throw new Error('Invalid flat-plan manifest');
      manifest = data; onBounds(data.boundsFeet); return data;
    }).catch(reason => { manifestPromise = null; throw reason; });
    return manifestPromise;
  }
  function variantKey() { return `${options.floor}-${options.theme}-${options.oldBuildings ? '1' : '0'}`; }
  async function loadSvg(key) {
    const data = await loadManifest();
    const filename = data.variants[key];
    if (typeof filename !== 'string' || filename.includes('..') || /^[a-z]+:/i.test(filename)) throw new Error(`Missing flat plan: ${key}`);
    const url = new URL(`./plan-ground/${filename}`, import.meta.url);
    url.searchParams.set('v', data.revision);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Plan drawing: ${response.status}`);
    const root = new DOMParser().parseFromString(await response.text(), 'image/svg+xml').documentElement;
    if (root.localName !== 'svg') throw new Error('Invalid flat-plan SVG');
    return root;
  }
  async function raster(root, viewBox, width, height, background) {
    const clone = root.cloneNode(true);
    clone.setAttribute('viewBox', viewBox.join(' '));
    clone.setAttribute('width', width); clone.setAttribute('height', height);
    clone.setAttribute('preserveAspectRatio', 'none');
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' }));
    const image = new Image();
    try {
      await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('Plan drawing could not be rasterized')); image.src = url; });
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.fillStyle = background; ctx.fillRect(0, 0, width, height); ctx.drawImage(image, 0, 0, width, height);
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = anisotropy;
      texture.minFilter = THREE.LinearMipmapLinearFilter; texture.magFilter = THREE.LinearFilter;
      rasterCount++; return texture;
    } finally { URL.revokeObjectURL(url); image.src = ''; }
  }
  function replaceTexture(mesh, texture) {
    mesh.material.map?.dispose(); mesh.material.map = texture; mesh.material.needsUpdate = true;
    mesh.visible = true;
    textureBytes = [overview, detail].reduce((sum, object) => {
      const image = object.material.map?.image;
      return sum + (image ? Math.ceil(image.width * image.height * 4 * 4 / 3) : 0);
    }, 0);
  }
  async function work() {
    if (busy || !enabled) { pending = true; return; }
    busy = true; pending = false;
    const ticket = generation, key = variantKey();
    try {
      if (optionsKey !== key || !svgRoot) {
        const root = await loadSvg(key);
        if (ticket !== generation || !enabled) return;
        svgRoot = root; optionsKey = key;
      }
      const [minX, minY, maxX, maxY] = manifest.boundsFeet;
      const sizeX = maxX - minX, sizeY = maxY - minY;
      const fullBox = svgRoot.getAttribute('viewBox').split(/[\s,]+/).map(Number);
      const pixelX = fullBox[2] / sizeX, pixelY = fullBox[3] / sizeY;
      if (overviewKey !== key || !overview.visible) {
        const scale = maxRasterSize / Math.max(fullBox[2], fullBox[3]);
        const texture = await raster(svgRoot, fullBox, Math.max(1, Math.round(fullBox[2] * scale)), Math.max(1, Math.round(fullBox[3] * scale)), color());
        if (ticket !== generation || !enabled) { texture.dispose(); discardedRasters++; return; }
        overview.scale.set(sizeX * FT, sizeY * FT, 1);
        overview.position.set((minX + maxX) * .5 * FT, 0, -(minY + maxY) * .5 * FT);
        replaceTexture(overview, texture); overviewKey = key;
        // A previous theme or floor must never float above the new overview.
        detail.visible = false; detailKey = ''; requestDraw();
      }
      const center = { ...wantedCenter };
      const nextDetailKey = `${key}:${center.x}:${center.y}`;
      if (detailKey !== nextDetailKey || !detail.visible) {
        const region = [fullBox[0] + (center.x - DETAIL_FEET / 2 - minX) * pixelX,
          fullBox[1] + (maxY - center.y - DETAIL_FEET / 2) * pixelY,
          DETAIL_FEET * pixelX, DETAIL_FEET * pixelY];
        const texture = await raster(svgRoot, region, maxRasterSize, maxRasterSize, color());
        if (ticket !== generation || !enabled) { texture.dispose(); discardedRasters++; return; }
        detail.position.set(center.x * FT, 0, -center.y * FT);
        replaceTexture(detail, texture); detailKey = nextDetailKey; appliedCenter = center; requestDraw();
      }
      error = null;
    } catch (reason) {
      error = reason.message; console.warn('Campus flat plan:', reason); requestDraw();
    } finally {
      busy = false;
      if (enabled && (pending || ticket !== generation)) { pending = false; queueMicrotask(work); }
    }
  }
  function setOptions(value) {
    const next = {
      floor: [0, 1, 2].includes(value?.floor) ? value.floor : options.floor,
      theme: ['light', 'dark'].includes(value?.theme) ? value.theme : options.theme,
      oldBuildings: typeof value?.oldBuildings === 'boolean' ? value.oldBuildings : options.oldBuildings
    };
    if (JSON.stringify(next) === JSON.stringify(options)) return;
    options = next; generation++; setColors();
    // Hide mismatched content immediately; work replaces it atomically per layer.
    overview.visible = false; detail.visible = false;
    if (enabled) work(); requestDraw();
  }
  function setEnabled(value) {
    if (enabled === value) return;
    enabled = value;
    if (enabled) work();
  }
  function update(camera, supportY) {
    elevation = supportY; group.position.y = elevation;
    let x = camera.position.x / FT, y = -camera.position.z / FT;
    // Keep the sharp patch under the nearby view, including when looking down
    // from flying mode. The horizon still uses the fixed overview texture.
    camera.getWorldDirection(worldDirection);
    const eyeAbove = Math.max(0, camera.position.y - elevation);
    if (worldDirection.y < -.1) {
      const ahead = Math.min(32 * FT, eyeAbove / -worldDirection.y);
      x += worldDirection.x * ahead / FT; y -= worldDirection.z * ahead / FT;
    }
    const next = { x: Math.round(x / DETAIL_STEP_FEET) * DETAIL_STEP_FEET, y: Math.round(y / DETAIL_STEP_FEET) * DETAIL_STEP_FEET };
    if (next.x !== wantedCenter.x || next.y !== wantedCenter.y) {
      wantedCenter = next;
      if (enabled) work();
    }
  }
  function state() {
    return Object.freeze({
      ready: Boolean(manifest && overview.visible && overviewKey === variantKey()), detailReady: Boolean(detail.visible && detailKey.startsWith(`${variantKey()}:`)),
      flat: true, active: enabled, enabled, ...options, revision: manifest?.revision ?? null,
      boundsFeet: manifest?.boundsFeet ?? null, elevationFeet: elevation / FT,
      textureSize: maxRasterSize, detailSpanFeet: DETAIL_FEET, detailCenterFeet: appliedCenter,
      textureCount: Number(Boolean(overview.material.map)) + Number(Boolean(detail.material.map)),
      estimatedTextureBytes: textureBytes, rasterCount, discardedRasters, busy, error
    });
  }
  function preload() { return loadManifest().catch(reason => { error = reason.message; return null; }); }
  return Object.freeze({ scene, setOptions, setEnabled, update, preload, get state() { return state(); } });
}
