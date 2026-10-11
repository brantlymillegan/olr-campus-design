/* Exact render-only spatial culling. Original geometry is restored before any
 * collision query, phase change, snowfall update, clone or PDF capture runs. */
import * as THREE from 'three';

const MIN_TRIANGLES = 1800, TILE_METERS = 9, MAX_OPAQUE_GROUPS = Infinity, MAX_TRANSMISSION_GROUPS = Infinity;
const yieldTask = () => new Promise(resolve => setTimeout(resolve, 0));
export function createCampusRenderCulling({model, renderer, requestDraw = () => {}}) {
  const cache = new WeakMap(), proxies = new WeakMap(), worlds = new WeakMap(), meshes = [];
  let entries = [], lastSelection = null;
  const frustum = new THREE.Frustum(), projection = new THREE.Matrix4(), box = new THREE.Box3(), sphere = new THREE.Sphere();
  const stats = {ready: false, candidates: 0, chunks: 0, indexBytes: 0, renderFrames: 0,
    culledTriangles: 0, submittedTriangles: 0, originalTriangles: 0, optimizedMeshes: 0, preparing: false, indexUploads: 0, uploadedIndexBytes: 0, dynamicIndexBytes: 0, selectionCacheHits: 0, worldBoundsRefreshes: 0};
  let preparation = null, pending = false;
  function eligible(object) {
    const g = object.geometry, m = object.material;
    if (!object.isMesh || object.isSkinnedMesh || object.isInstancedMesh || Array.isArray(m)
      || !m || m.transparent || object.frustumCulled === false || object.customDepthMaterial || object.customDistanceMaterial
      || !g?.index || g.groups.length || Object.keys(g.morphAttributes).length) return false;
    // A batched pane anywhere on a floor otherwise triggers a second render of
    // the entire opaque scene. Keep pane triangle order and reject only chunks
    // whose complete bounds are outside the camera.
    if (m.transmission > 0) return g.index.count / 3 <= 256;
    if (g.index.count / 3 < MIN_TRIANGLES) return false;
    if (!g.boundingBox) g.computeBoundingBox();
    return Math.max(g.boundingBox.max.x-g.boundingBox.min.x, g.boundingBox.max.y-g.boundingBox.min.y,
      g.boundingBox.max.z-g.boundingBox.min.z) > 12;
  }
  function matches(record, g) {
    return record && record.index === g.index && record.indexVersion === g.index.version
      && record.start === g.drawRange.start && record.count === g.drawRange.count;
  }
  async function partition(g, transmission) {
    const index = g.index, p = g.attributes.position, bins = new Map();
    const start = Math.max(0,g.drawRange.start), count = Math.min(index.count-start,g.drawRange.count);
    if (start % 3 || count % 3) return null;
    let lastYield = performance.now();
    for (let offset = start; offset < start+count; offset += 3) {
      const a=index.getX(offset),b=index.getX(offset+1),c=index.getX(offset+2);
      const ax=p.getX(a),ay=p.getY(a),az=p.getZ(a),bx=p.getX(b),by=p.getY(b),bz=p.getZ(b),cx=p.getX(c),cy=p.getY(c),cz=p.getZ(c);
      const key=transmission ? Math.floor((offset-start)/6)
        : `${Math.floor((ax+bx+cx)/(3*TILE_METERS))},${Math.floor((ay+by+cy)/(3*TILE_METERS))},${Math.floor((az+bz+cz)/(3*TILE_METERS))}`;
      let bin=bins.get(key);
      if (!bin) {bin={indices:[],bounds:new THREE.Box3()};bins.set(key,bin);}
      bin.indices.push(a,b,c);
      bin.bounds.min.x=Math.min(bin.bounds.min.x,ax,bx,cx);bin.bounds.min.y=Math.min(bin.bounds.min.y,ay,by,cy);bin.bounds.min.z=Math.min(bin.bounds.min.z,az,bz,cz);
      bin.bounds.max.x=Math.max(bin.bounds.max.x,ax,bx,cx);bin.bounds.max.y=Math.max(bin.bounds.max.y,ay,by,cy);bin.bounds.max.z=Math.max(bin.bounds.max.z,az,bz,cz);
      if (offset % 12288 === 0 && performance.now()-lastYield > 8) {await yieldTask();lastYield=performance.now();}
    }
    if (bins.size < 2 && !transmission) return null;
    const reordered = new index.array.constructor(count), chunks=[];
    let offset=0;
    for (const bin of bins.values()) {
      reordered.set(bin.indices,offset);
      // Whole-triangle bounds are conservative even when a triangle crosses tiles.
      chunks.push({start:offset,count:bin.indices.length,bounds:bin.bounds});offset+=bin.indices.length;
    }
    if (!g.boundingBox) g.computeBoundingBox();
    if (!g.boundingSphere) g.computeBoundingSphere();
    return {renderIndex:new THREE.BufferAttribute(reordered,1),chunks,index,indexVersion:index.version,
      start:g.drawRange.start,count:g.drawRange.count,triangles:count/3,transmission};
  }
  const matrixEqual = (a,b) => a.every((value,i)=>value===b[i]);
  function worldRecord(mesh,g,record) {
    let records=worlds.get(mesh);if(!records){records=new WeakMap();worlds.set(mesh,records);}
    let world=records.get(record);
    if(!world){world={matrix:[],box:new THREE.Box3(),sphere:new THREE.Sphere(),chunks:record.chunks.map(()=>new THREE.Box3()),version:0};records.set(record,world);}
    if(!matrixEqual(mesh.matrixWorld.elements,world.matrix)){
      world.matrix=mesh.matrixWorld.elements.slice();world.box.copy(g.boundingBox).applyMatrix4(mesh.matrixWorld);
      world.sphere.copy(g.boundingSphere).applyMatrix4(mesh.matrixWorld);
      for(let i=0;i<record.chunks.length;i++)world.chunks[i].copy(record.chunks[i].bounds).applyMatrix4(mesh.matrixWorld);
      world.version++;stats.worldBoundsRefreshes++;
    }
    return world;
  }
  function shown(mesh){for(let p=mesh;p;p=p.parent)if(!p.visible)return false;return true;}
  function drawSelection(scene,camera,swaps) {
    try {
      for(const [mesh,g,m,geometry,material] of swaps){mesh.geometry=geometry;mesh.material=material;}
      renderer.render(scene,camera);
    } finally {for(const [mesh,g,m]of swaps){mesh.geometry=g;mesh.material=m;}}
  }
  async function prepare() {
    if (preparation) {pending=true;return preparation;}
    preparation=(async()=>{
      stats.preparing=true;lastSelection=null;
      do {
        pending=false;meshes.length=0;
        model.traverse(o=>{if(eligible(o))meshes.push(o)});
        for (const mesh of meshes) {
          const g=mesh.geometry,existing=cache.get(g);
          if (!matches(existing,g)) {const record=await partition(g,mesh.material.transmission > 0);if(record)cache.set(g,record);}
        }
      } while(pending);
      stats.candidates=meshes.length;stats.chunks=0;stats.indexBytes=0;
      const unique=new Set();
      for(const mesh of meshes){const record=cache.get(mesh.geometry);if(record&&!unique.has(record)){unique.add(record);stats.chunks+=record.chunks.length;stats.indexBytes+=record.renderIndex.array.byteLength;}}
      model.updateWorldMatrix(true,true);
      entries=meshes.map(mesh=>{const g=mesh.geometry,record=cache.get(g);return record?{mesh,g,record,world:worldRecord(mesh,g,record)}:null;}).filter(Boolean);
      stats.ready=true;stats.preparing=false;requestDraw();
    })();
    try {await preparation;} finally {preparation=null;stats.preparing=false;}
  }
  function render(scene,camera) {
    // Off-screen geometry can still cast a visible shadow. Refresh those maps
    // using the unchanged scene; normal frames reuse the existing complete maps.
    if (renderer.shadowMap.needsUpdate || !stats.ready || stats.preparing) {renderer.render(scene,camera);return;}
    camera.updateMatrixWorld();model.updateWorldMatrix(true,true);
    let reusable=lastSelection && lastSelection.layerMask===camera.layers.mask
      && matrixEqual(camera.projectionMatrix.elements,lastSelection.projection)
      && matrixEqual(camera.matrixWorld.elements,lastSelection.camera);
    for(const entry of entries){
      const {mesh,g,record}=entry;
      entry.valid=mesh.geometry===g && matches(record,g) && !mesh.material.transparent && mesh.frustumCulled!==false;
      entry.visible=shown(mesh);
      if(entry.valid)entry.world=worldRecord(mesh,g,record);
      if(!entry.valid || entry.previousVisible!==entry.visible || entry.previousMaterial!==mesh.material || entry.previousWorldVersion!==entry.world.version)reusable=false;
    }
    if(reusable){drawSelection(scene,camera,lastSelection.swaps);stats.selectionCacheHits++;stats.renderFrames++;return;}
    projection.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);frustum.setFromProjectionMatrix(projection);
    const changes=[];let originalTriangles=0,submittedTriangles=0,optimizedMeshes=0;
      for(const entry of entries) {
        const {mesh,g,record,world}=entry;
        if(!entry.valid || !entry.visible)continue;
        // Three's default sphere may intersect while the tighter whole-mesh box
        // and every pane are outside. Empty groups also avoid that false positive.
        if(!frustum.intersectsSphere(world.sphere))continue;
        const groups=[];let triangles=0;
        if(frustum.intersectsBox(world.box))for(let i=0;i<record.chunks.length;i++){
          const chunk=record.chunks[i];
          if(!frustum.intersectsBox(world.chunks[i]))continue;
          const previous=groups.at(-1);
          if(previous && previous.start+previous.count===chunk.start)previous.count+=chunk.count;
          else groups.push({start:chunk.start,count:chunk.count,materialIndex:0});
          triangles+=chunk.count/3;
        }
        originalTriangles+=record.triangles;
        if(triangles>record.triangles*(record.transmission ? .999999 : .75) || groups.length>(record.transmission ? MAX_TRANSMISSION_GROUPS : MAX_OPAQUE_GROUPS)){submittedTriangles+=record.triangles;continue;}
        let meshProxies=proxies.get(mesh);
        if(!meshProxies){meshProxies=new WeakMap();proxies.set(mesh,meshProxies);}
        let proxy=meshProxies.get(record);
        if(!proxy) {
          const geometry=new THREE.BufferGeometry();geometry.attributes=g.attributes;
          geometry.setIndex(record.renderIndex);geometry.boundingBox=g.boundingBox;geometry.boundingSphere=g.boundingSphere;
          proxy={geometry,ranges:[],dynamicIndex:null};meshProxies.set(record,proxy);
        }
        // Each instance needs independent groups even if it shares source data.
        // Reuse each phase's proxy on later visits; no new GPU vertex-array
        // objects or index allocations are created by repeated phase switches.
        const changed=proxy.ranges.length!==groups.length || groups.some((range,i)=>range.start!==proxy.ranges[i].start || range.count!==proxy.ranges[i].count);
        if(changed && triangles) {
          if(!proxy.dynamicIndex) {
            proxy.dynamicIndex=new THREE.BufferAttribute(new record.renderIndex.array.constructor(record.renderIndex.count),1);
            proxy.dynamicIndex.setUsage(THREE.DynamicDrawUsage);proxy.geometry.setIndex(proxy.dynamicIndex);
            stats.dynamicIndexBytes+=proxy.dynamicIndex.array.byteLength;
          }
          let next=0;
          for(const range of groups){proxy.dynamicIndex.array.set(record.renderIndex.array.subarray(range.start,range.start+range.count),next);next+=range.count;}
          proxy.dynamicIndex.clearUpdateRanges();proxy.dynamicIndex.addUpdateRange(0,next);proxy.dynamicIndex.needsUpdate=true;
          stats.indexUploads++;stats.uploadedIndexBytes+=next*proxy.dynamicIndex.array.BYTES_PER_ELEMENT;
        }
        proxy.ranges=groups;
        proxy.geometry.groups=triangles?[{start:0,count:triangles*3,materialIndex:0}]:[];
        proxy.geometry.setDrawRange(0,triangles*3);
        changes.push([mesh,g,mesh.material,proxy.geometry,triangles?mesh.material:[mesh.material]]);
        // A zero drawRange still enters Three's transmission list. Empty material
        // groups suppress that entire pass; visible meshes keep the original
        // single material, sorting and one draw call.
        submittedTriangles+=triangles;optimizedMeshes++;
      }
    for(const entry of entries){entry.previousVisible=entry.visible;entry.previousMaterial=entry.mesh.material;entry.previousWorldVersion=entry.world.version;}
    lastSelection={projection:camera.projectionMatrix.elements.slice(),camera:camera.matrixWorld.elements.slice(),layerMask:camera.layers.mask,swaps:changes};
    drawSelection(scene,camera,changes);
    Object.assign(stats,{renderFrames:stats.renderFrames+1,originalTriangles,submittedTriangles,
      culledTriangles:originalTriangles-submittedTriangles,optimizedMeshes});
  }
  return Object.freeze({prepare,render,get state(){return {...stats}}});
}
