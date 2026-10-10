import * as THREE from 'three';

const FT = .3048;
const PHASES = new Set(['new', 'phase1', 'phase2']);
const PHASE_GROUP = 'Construction phase only geometry';

// Only the active presentation is changed. Original geometries remain intact
// for exact restoration and for the separate completed-proposal print clone.
export function createCampusPhases({ model, config, modelSha256 }) {
  if (config?.version !== 1 || config.model_sha256 !== modelSha256) throw new Error('Construction phases do not match the campus model. Please reload.');
  const originals = new Map(), names = new Map(), materials = new Map();
  model.traverse(object => {
    originals.set(object.name, object.visible);
    if (object.userData?.name) names.set(object.userData.name, object);
    names.set(object.name, object);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) if (material) materials.set(material.name, material);
  });
  const find = name => names.get(name) || model.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(name));
  const hidden = config.phase1.hide_nodes.map(row => {
    const object = find(row.name);
    if (!object) throw new Error(`Missing phase building component: ${row.name}`);
    return { object, visible: object.visible, row };
  });
  const filtered = config.phase1.index_filters.map(row => {
    const object = find(row.name), matches = [];
    object?.traverse(child => {
      if (child.isMesh && child.material?.name === row.material) matches.push(child);
    });
    if (matches.length !== 1) throw new Error(`Ambiguous phase surface: ${row.name}`);
    const mesh = matches[0], original = mesh.geometry, index = original.index;
    if (!index || index.count !== row.index_count || original.attributes.position.count !== row.position_count) throw new Error(`Outdated phase geometry: ${row.name}`);
    const keep = new Uint8Array(index.count / 3).fill(1);
    let removed = 0, previous = 0;
    for (const [start, end] of row.remove_triangle_ranges) {
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < previous || end <= start || end > keep.length) throw new Error('Invalid phase triangle range.');
      keep.fill(0, start, end); removed += end - start; previous = end;
    }
    if (removed !== row.removed_triangles) throw new Error('Incomplete phase surface selection.');
    const values = new index.array.constructor((keep.length - removed) * 3);
    for (let triangle = 0, next = 0; triangle < keep.length; triangle++) {
      if (!keep[triangle]) continue;
      for (let k = 0; k < 3; k++) values[next++] = index.getX(triangle * 3 + k);
    }
    // Share immutable position/normal/UV arrays. Only the small index list is
    // new; this avoids duplicating the dense model or touching source buffers.
    const geometry = new THREE.BufferGeometry();
    for (const [name, attribute] of Object.entries(original.attributes)) geometry.setAttribute(name, attribute);
    geometry.setIndex(new THREE.BufferAttribute(values, 1));
    geometry.boundingBox = original.boundingBox?.clone() || null;
    geometry.boundingSphere = original.boundingSphere?.clone() || null;
    return { mesh, original, geometry, row };
  });
  const group = new THREE.Group(); group.name = PHASE_GROUP;
  const phaseMaterials = [];
  const roofMaterial = new THREE.MeshStandardMaterial({ name: 'Phase retained school roof membrane', color: 0x56595a, roughness: .95, metalness: 0 });
  phaseMaterials.push(roofMaterial); materials.set('phase-roof', roofMaterial);
  function add(definition) {
    let geometry;
    if (definition.kind === 'box') {
      const a = definition.min, b = definition.max;
      geometry = new THREE.BoxGeometry((b[0] - a[0]) * FT, (b[2] - a[2]) * FT, (b[1] - a[1]) * FT);
      geometry.translate((a[0] + b[0]) * FT / 2, (a[2] + b[2]) * FT / 2, -(a[1] + b[1]) * FT / 2);
    } else if (definition.kind === 'polygon') {
      const points = definition.polygon.map(([x, y]) => new THREE.Vector2(x * FT, -y * FT));
      const triangles = THREE.ShapeUtils.triangulateShape(points, []);
      const vertices = [];
      for (const triangle of triangles) for (const i of [...triangle].reverse()) vertices.push(points[i].x, definition.elevation * FT, points[i].y);
      geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3)); geometry.computeVertexNormals();
    } else if (definition.kind === 'perimeter') {
      const vertices = [], uv = [], poly = definition.polygon;
      // Every outer face is wound outward. The source footprint is clockwise
      // in site east/north coordinates, and the y->-z mapping preserves this.
      const area = poly.reduce((sum, a, i) => { const b = poly[(i + 1) % poly.length]; return sum + a[0] * b[1] - b[0] * a[1]; }, 0);
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length], z = definition.base, h = definition.height;
        const face = [[a[0], a[1], z], [b[0], b[1], z], [b[0], b[1], z + h], [a[0], a[1], z + h]];
        const len = Math.hypot(a[0] - b[0], a[1] - b[1]);
        const order = area < 0 ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3];
        for (const k of order) {
          const p = face[k]; vertices.push(p[0] * FT, p[2] * FT, -p[1] * FT);
          uv.push((k === 1 || k === 2 ? len : 0) / 8, k >= 2 ? h / 8 : 0);
        }
      }
      geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3)); geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); geometry.computeVertexNormals();
    } else throw new Error('Unknown phase-only geometry.');
    const material = materials.get(definition.material);
    if (!material) throw new Error(`Missing phase finish: ${definition.material}`);
    if (definition.material === 'Warm red brick • running bond') {
      // The authored brick is world-projected at a 1.4-metre repeat. Original
      // material variants can use uv, uv1 or uv2 after native consolidation.
      // Match both its physical scale and every channel used by the finish.
      const positions = geometry.getAttribute('position'), normals = geometry.getAttribute('normal');
      const uv = new Float32Array(positions.count * 2);
      for (let i = 0; i < positions.count; i++) {
        const nx = Math.abs(normals.getX(i)), ny = Math.abs(normals.getY(i)), nz = Math.abs(normals.getZ(i));
        if (ny >= nx && ny >= nz) { uv[i * 2] = positions.getX(i) / 1.4; uv[i * 2 + 1] = -positions.getZ(i) / 1.4; }
        else { uv[i * 2] = (nx > nz ? -positions.getZ(i) : positions.getX(i)) / 1.4; uv[i * 2 + 1] = positions.getY(i) / 1.4; }
      }
      const attribute = new THREE.BufferAttribute(uv, 2); geometry.setAttribute('uv', attribute);
      for (const texture of [material.map, material.normalMap, material.roughnessMap, material.metalnessMap]) {
        if (texture?.channel > 0) geometry.setAttribute(`uv${texture.channel}`, attribute);
      }
    }
    const mesh = new THREE.Mesh(geometry, material); mesh.name = definition.name;
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.userData.constructionPhaseOnly = true; group.add(mesh);
  }
  config.phase1.additions.forEach(add); model.add(group); group.visible = false; group.userData.constructionPhaseHidden = true;
  let phase = 'new', disposed = false;
  function setPhase(value) {
    if (!PHASES.has(value) || disposed || phase === value) return false;
    const enabled = value === 'phase1';
    for (const row of hidden) { row.object.visible = enabled ? false : row.visible; row.object.userData.constructionPhaseHidden = enabled; }
    for (const row of filtered) row.mesh.geometry = enabled ? row.geometry : row.original;
    group.visible = enabled; group.userData.constructionPhaseHidden = !enabled;
    const geometryChanged = (phase === 'phase1') !== enabled;
    phase = value; model.updateMatrixWorld(true);
    return geometryChanged;
  }
  function createCompletedModelClone() {
    const clone = model.clone(true); clone.getObjectByName(PHASE_GROUP)?.removeFromParent();
    clone.traverse(object => { if (originals.has(object.name)) object.visible = originals.get(object.name); delete object.userData.constructionPhaseHidden; });
    for (const row of filtered) {
      const mesh = clone.getObjectByName(row.mesh.name);
      if (!mesh) throw new Error('Completed model clone is missing a surface.');
      mesh.geometry = row.original;
    }
    return clone;
  }
  function isRetainedSchoolOutline(polygon) {
    const source = config.retained_school.footprint_site_ft;
    if (!Array.isArray(polygon) || polygon.length < source.length) return false;
    return source.every(([x, y]) => polygon.some(p => Math.abs(p[0] - x) < .03 && Math.abs(p[1] - y) < .03));
  }
  function dispose() {
    if (disposed) return;
    setPhase('new'); group.removeFromParent(); group.traverse(object => object.geometry?.dispose());
    for (const row of filtered) row.geometry.dispose();
    phaseMaterials.forEach(material => material.dispose()); disposed = true;
  }
  return Object.freeze({ setPhase, createCompletedModelClone, isRetainedSchoolOutline, dispose,
    get state() { return { ready: true, phase, modelSha256, hiddenNodeCount: phase === 'phase1' ? hidden.length : 0,
      filteredMeshCount: phase === 'phase1' ? filtered.length : 0, retainedSchoolVisible: group.visible,
      bridgeClosureVisible: group.visible, phaseOnlyMeshes: group.children.length, completeModelUnchanged: true, disposed }; }
  });
}
