import * as THREE from 'three';

const INCH = .0254, FLAKES = 3600, WIDTH = 64, HEIGHT = 30;
const normalize = name => (name || '').replace(/_/g, ' ');
function phaseVisible(object, root) {
  for (let node = object; node && node !== root; node = node.parent) {
    if (node.userData?.constructionPhaseHidden || !node.visible) return false;
  }
  return true;
}
function category(object) {
  const name = normalize(object.name);
  if (/interior|chapel|crucifix|room plaque|room painting|classroom painting|office hallway|window|glazing|door leaf|campus boundary|water|lettering|name plaque/i.test(name)) return null;
  if (/roof|^School canopy|Classical school entrance.*(?:vault|coping)|retained lower school.*top/i.test(name)) return 'roofs';
  if (/landform|surrounding terrain|lawn|asphalt|pedestrian|paving|paver|grass|play surface|safety surface|level pad|landscape.beds|swing garden|East adventure play area|Amphitheater lower/i.test(name)) return 'ground';
  if (/Natural trees|Natural shrubs|Playground shade|Tree canopy|Flower borders/i.test(name)) return 'trees';
  if (/^08/.test(name) || /Gaga Ball.*(?:ball|pit)/i.test(name)) return 'playground';
  if (/^07.*(?:Oiled cedar|Black powder)|^09.*(?:Oiled cedar|Black powder)|Vehicle gates|pedestal/i.test(name)) return 'other';
  return null;
}
function meshCopy(source, material) {
  const mesh = source.isInstancedMesh ? new THREE.InstancedMesh(source.geometry, material, source.count) : new THREE.Mesh(source.geometry, material);
  if (source.isInstancedMesh) mesh.instanceMatrix = source.instanceMatrix;
  mesh.matrixAutoUpdate = false; mesh.matrix.copy(source.matrixWorld); mesh.matrixWorld.copy(source.matrixWorld);
  mesh.frustumCulled = false; mesh.raycast = () => {};
  return mesh;
}
const exposureGLSL = /* glsl */`
uniform sampler2D uSnowExposure;
uniform vec2 uSnowOrigin;
uniform vec2 uSnowSpan;
uniform vec2 uSnowVertical;
uniform float uSnowCell;
uniform float uSnowDepth;
uniform float uSnowEnabled;
float snowTop(vec2 xz) {
  vec2 uv = (xz - uSnowOrigin) / uSnowSpan;
  if (min(uv.x,uv.y) < 0.0 || max(uv.x,uv.y) > 1.0) return -10000.0;
  return uSnowVertical.x - texture2D(uSnowExposure, vec2(uv.x, 1.0-uv.y)).r * uSnowVertical.y;
}
float snowExposure(vec3 p, vec3 n) {
  float bias = .022 + uSnowCell * .65 * length(n.xz) / max(.18,abs(n.y));
  // Snow buries thin paint, curbs and low surface details as its layer grows.
  // Taller shelter still blocks deposition until snow physically reaches it.
  return step(snowTop(p.xz)-bias,p.y+uSnowDepth);
}
float snowCover(vec3 p, vec3 n) {
  float slope = smoothstep(.10,.44,n.y);
  float grain = fract(sin(dot(floor(p.xz*18.0),vec2(12.9898,78.233))) * 43758.5453);
  float coverage = smoothstep(0.0,.018,uSnowDepth*(.7+.3*grain));
  return slope * snowExposure(p,n) * coverage * uSnowEnabled;
}
`;
const flakeVertex = /* glsl */`
attribute vec4 aSeed;
uniform float uSnowTime;
uniform vec3 uSnowCenter;
uniform float uPointScale;
${exposureGLSL}
varying float vAlpha;
void main() {
  vec2 drift=vec2(.42,.16)*uSnowTime + vec2(sin(uSnowTime*.53+aSeed.w*25.0),cos(uSnowTime*.37+aSeed.z*20.0))*.55;
  vec2 xz=mod(aSeed.xy*${WIDTH.toFixed(1)}+drift-uSnowCenter.xz+${WIDTH/2}.0,${WIDTH.toFixed(1)})-${WIDTH/2}.0+uSnowCenter.xz;
  float speed=.65+aSeed.w*.85;
  float y=mod(aSeed.z*${HEIGHT.toFixed(1)}-uSnowTime*speed-uSnowCenter.y+12.0,${HEIGHT.toFixed(1)})-12.0+uSnowCenter.y;
  vec3 world=vec3(xz.x,y,xz.y);
  float top=snowTop(xz)+uSnowDepth;
  float edge=1.0-smoothstep(23.0,32.0,max(abs(xz.x-uSnowCenter.x),abs(xz.y-uSnowCenter.z)));
  vAlpha=step(top+.015,y)*edge*smoothstep(.15,.65,distance(world,uSnowCenter))*uSnowEnabled;
  vec4 view=viewMatrix*vec4(world,1.0);
  gl_Position=projectionMatrix*view;
  gl_PointSize=clamp((.032+aSeed.w*.046)*uPointScale/max(.5,-view.z),1.0,9.0);
}
`;
const flakeFragment=/* glsl */`
varying float vAlpha;
void main() {
  float radius=length(gl_PointCoord-.5);
  float alpha=(1.0-smoothstep(.17,.5,radius))*vAlpha;
  if(alpha<.015)discard;
  gl_FragColor=vec4(.94,.97,1.0,alpha);
  #include <colorspace_fragment>
}
`;

/** Transient snowfall: exact active time/10 = inches; no accumulation cap.
 * Original meshes/textures stay intact. Only low-cost surface copies rise;
 * dense foliage/play equipment receive coating in their existing draw calls.
 */
export function createCampusSnow({ scene, model, renderer } = {}) {
  if (!scene?.isScene || !model?.isObject3D || !renderer?.isWebGLRenderer) throw new TypeError('Snow needs the campus scene, model and renderer.');
  const group=new THREE.Group();group.name='Weather • transient snow';group.visible=false;group.userData.snowEffect=true;scene.add(group);
  const uniforms={uSnowExposure:{value:null},uSnowOrigin:{value:new THREE.Vector2()},uSnowSpan:{value:new THREE.Vector2(1,1)},uSnowVertical:{value:new THREE.Vector2(100,200)},uSnowCell:{value:.1},uSnowDepth:{value:0},uSnowEnabled:{value:0}};
  let enabled=false,active=false,ready=false,disposed=false,dirty=true,lastNow=null,elapsed=0,time=0,buildCount=0;
  let target=null,flakes=null,flakeMaterial=null,flakeGeometry=null;
  let originals=[],materials=[],overlays=[],ownedGeometry=[],categories={},surfaceCount=0,mapMeshCount=0,mapTriangles=0,exposureBounds=null;
  const cameraPosition=new THREE.Vector3(),size=new THREE.Vector2();
  function restoreMaterials(){for(const row of originals)row.object.material=row.material;}
  function installMaterials(){for(const row of originals)row.object.material=row.coated;}
  function releaseSurfaces(){restoreMaterials();for(const mesh of overlays)group.remove(mesh);for(const material of materials)material.dispose();for(const geometry of ownedGeometry)geometry.dispose();target?.dispose();target=null;originals=[];materials=[];overlays=[];ownedGeometry=[];ready=false;}
  function patch(material, original, raised=false, skirt=false) {
    const oldCompile=original?.onBeforeCompile;
    material.onBeforeCompile=(shader,renderingRenderer)=>{
      oldCompile?.call(original,shader,renderingRenderer);
      // PDF capture uses a fresh renderer and must see the original design.
      if(renderingRenderer!==renderer)return;
      Object.assign(shader.uniforms,uniforms);
      shader.vertexShader='varying vec3 vSnowPosition; varying vec3 vSnowNormal;\nuniform float uSnowDepth;\n'+(skirt?'attribute float aSnowLift;\n':'')+shader.vertexShader;
      shader.vertexShader=shader.vertexShader.replace('#include <project_vertex>',`
        vec4 snowLocal=vec4(transformed,1.0);
        #ifdef USE_BATCHING
          snowLocal=batchingMatrix*snowLocal;
        #endif
        #ifdef USE_INSTANCING
          snowLocal=instanceMatrix*snowLocal;
        #endif
        vec4 snowWorld=modelMatrix*snowLocal;
        vSnowPosition=snowWorld.xyz;
        vSnowNormal=inverseTransformDirection(transformedNormal,viewMatrix);
        ${raised?'snowWorld.y += uSnowDepth'+(skirt?'*aSnowLift':'')+' + .002;':''}
        vec4 mvPosition=viewMatrix*snowWorld;
        gl_Position=projectionMatrix*mvPosition;
      `);
      shader.fragmentShader='varying vec3 vSnowPosition; varying vec3 vSnowNormal;\n'+exposureGLSL+shader.fragmentShader;
      shader.fragmentShader=shader.fragmentShader.replace('#include <color_fragment>',`#include <color_fragment>
        vec3 snowNormal;
        // Some preserved flat-shaded roofs intentionally have no NORMAL
        // attribute. Recover their visible face normal without changing buffers.
        if(${material.flatShading?'true':'dot(vSnowNormal,vSnowNormal)<.01'}) {
          snowNormal=normalize(cross(dFdx(vSnowPosition),dFdy(vSnowPosition)));
        } else {
          snowNormal=normalize(vSnowNormal);
          ${original?.side===THREE.DoubleSide?'snowNormal *= gl_FrontFacing ? 1.0 : -1.0;':''}
        }
        float snow=snowCover(vSnowPosition,${skirt?'vec3(0.0,1.0,0.0)':'snowNormal'});
        ${raised?'if(snow<.035) discard; diffuseColor.rgb=vec3(.91,.945,.98);':'diffuseColor.rgb=mix(diffuseColor.rgb,vec3(.91,.945,.98),snow);'}
      `);
    };
    material.customProgramCacheKey=()=>`campus-snow-v1-${raised}-${skirt}-${original?.customProgramCacheKey?.()||''}`;
    material.needsUpdate=true;materials.push(material);return material;
  }
  function roofSkirt(source, material) {
    // Only boundary edges of upward roof triangles, never every leaf/ground
    // triangle. Their lower edge remains on the roof as snow thickness grows.
    const p=source.geometry.getAttribute('position'),idx=source.geometry.index,edges=new Map();
    if(!p || (idx?.count||p.count)>24000 || source.isInstancedMesh)return;
    const a=new THREE.Vector3(),b=new THREE.Vector3(),c=new THREE.Vector3(),ab=new THREE.Vector3(),ac=new THREE.Vector3();
    const key=v=>v.toArray().map(n=>Math.round(n*10000)).join(',');
    for(let i=0;i+2<(idx?.count||p.count);i+=3){a.fromBufferAttribute(p,idx?idx.getX(i):i);b.fromBufferAttribute(p,idx?idx.getX(i+1):i+1);c.fromBufferAttribute(p,idx?idx.getX(i+2):i+2);if(ab.subVectors(b,a).cross(ac.subVectors(c,a)).normalize().y<.12)continue;
      for(const [v,w]of[[a,b],[b,c],[c,a]]){const av=key(v),bv=key(w),id=av<bv?av+'|'+bv:bv+'|'+av;if(edges.has(id))edges.delete(id);else edges.set(id,[v.clone(),w.clone()]);}}
    if(!edges.size)return;const positions=[],normals=[],lifts=[],indices=[];
    for(const [a,b]of edges.values()){const start=positions.length/3;for(const p of[a,b,b,a]){positions.push(p.x,p.y,p.z);normals.push(0,1,0)}lifts.push(0,0,1,1);indices.push(start,start+1,start+2,start,start+2,start+3)}
    const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));geometry.setAttribute('aSnowLift',new THREE.Float32BufferAttribute(lifts,1));geometry.setIndex(indices);ownedGeometry.push(geometry);
    const mesh=new THREE.Mesh(geometry,material);mesh.matrixAutoUpdate=false;mesh.matrix.copy(source.matrixWorld);mesh.matrixWorld.copy(source.matrixWorld);mesh.name='Snow roof edge • '+source.name;mesh.frustumCulled=false;mesh.raycast=()=>{};group.add(mesh);overlays.push(mesh);
  }
  function buildSurfaceMap(){
    releaseSurfaces();model.updateMatrixWorld(true);scene.updateMatrixWorld(true);
    const sources=[];model.traverse(o=>{if(o.isMesh&&o.geometry?.getAttribute('position')&&phaseVisible(o,model))sources.push(o)});
    scene.traverse(o=>{if(o.isMesh&&/Atmosphere.*surrounding terrain/i.test(normalize(o.name)))sources.push(o)});
    const bounds=new THREE.Box3().setFromObject(model);bounds.min.x-=1;bounds.min.z-=1;bounds.max.x+=1;bounds.max.z+=1;
    const spanX=bounds.max.x-bounds.min.x,spanZ=bounds.max.z-bounds.min.z,resolution=Math.min(2048,renderer.capabilities.maxTextureSize);
    const depthTexture=new THREE.DepthTexture(resolution,resolution,THREE.UnsignedIntType);depthTexture.minFilter=depthTexture.magFilter=THREE.NearestFilter;
    target=new THREE.WebGLRenderTarget(resolution,resolution,{format:THREE.RedFormat,type:THREE.UnsignedByteType,minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter,depthBuffer:true,stencilBuffer:false,depthTexture});target.texture.name='Snow • cached top exposure';
    const top=bounds.max.y+5,near=.1,far=top-bounds.min.y+20;
    const depthCamera=new THREE.OrthographicCamera(-spanX/2,spanX/2,spanZ/2,-spanZ/2,near,far);depthCamera.position.set((bounds.min.x+bounds.max.x)/2,top,(bounds.min.z+bounds.max.z)/2);depthCamera.up.set(0,0,-1);depthCamera.lookAt(depthCamera.position.x,0,depthCamera.position.z);depthCamera.updateMatrixWorld(true);
    const depthScene=new THREE.Scene(),depthMaterial=new THREE.MeshBasicMaterial({color:0xffffff,side:THREE.DoubleSide});mapMeshCount=0;mapTriangles=0;
    for(const source of sources){const name=normalize(source.name);if(/room|painting|furniture|plaque|chapel|crucifix|ceiling light|interior door|interior white trim|campus boundary|water|surrounding terrain/i.test(name))continue;const mesh=meshCopy(source,depthMaterial);depthScene.add(mesh);mapMeshCount++;mapTriangles+=(source.geometry.index?.count||source.geometry.attributes.position.count)/3*(source.isInstancedMesh?source.count:1)}
    const previous={target:renderer.getRenderTarget(),color:renderer.getClearColor(new THREE.Color()),alpha:renderer.getClearAlpha(),autoClear:renderer.autoClear,xr:renderer.xr.enabled,shadow:renderer.shadowMap.autoUpdate};
    try{renderer.xr.enabled=false;renderer.shadowMap.autoUpdate=false;renderer.autoClear=true;renderer.setRenderTarget(target);renderer.setClearColor(0xffffff,1);renderer.clear();renderer.render(depthScene,depthCamera)}finally{renderer.setRenderTarget(previous.target);renderer.setClearColor(previous.color,previous.alpha);renderer.autoClear=previous.autoClear;renderer.xr.enabled=previous.xr;renderer.shadowMap.autoUpdate=previous.shadow;depthMaterial.dispose()}
    uniforms.uSnowExposure.value=depthTexture;uniforms.uSnowOrigin.value.set(bounds.min.x,bounds.min.z);uniforms.uSnowSpan.value.set(spanX,spanZ);uniforms.uSnowVertical.value.set(top-near,far-near);uniforms.uSnowCell.value=Math.max(spanX,spanZ)/resolution;
    categories={ground:0,roofs:0,trees:0,playground:0,other:0};surfaceCount=0;
    const coatingCache=new Map();const surfaceMaterial=patch(new THREE.MeshStandardMaterial({color:0xf1f5f9,roughness:.96,metalness:0,side:THREE.DoubleSide}),null,true,false);const flatSurfaceMaterial=patch(new THREE.MeshStandardMaterial({color:0xf1f5f9,roughness:.96,metalness:0,side:THREE.DoubleSide,flatShading:true}),null,true,false);const skirtMaterial=patch(new THREE.MeshStandardMaterial({color:0xe7eef5,roughness:1,metalness:0,side:THREE.DoubleSide}),null,true,true);
    for(const source of sources){const kind=category(source);if(!kind)continue;categories[kind]++;surfaceCount++;
      if(kind==='ground'||kind==='roofs'){const mesh=meshCopy(source,source.geometry.getAttribute('normal')?surfaceMaterial:flatSurfaceMaterial);mesh.name='Snow surface • '+source.name;mesh.receiveShadow=true;group.add(mesh);overlays.push(mesh);if(kind==='roofs')roofSkirt(source,skirtMaterial)}
      else{const original=source.material;const coat=m=>{if(!coatingCache.has(m)){const clone=m.clone();clone.name=m.name+' • transient snow';coatingCache.set(m,patch(clone,m))}return coatingCache.get(m)};const coated=Array.isArray(original)?original.map(coat):coat(original);originals.push({object:source,material:original,coated});source.material=coated}}
    exposureBounds={min:bounds.min.toArray(),max:bounds.max.toArray(),resolution};ready=true;dirty=false;buildCount++;
  }
  function createFlakes(){
    if(flakes)return;const positions=new Float32Array(FLAKES*3),seeds=new Float32Array(FLAKES*4);let seed=98521;for(let i=0;i<seeds.length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;seeds[i]=seed/4294967296}
    flakeGeometry=new THREE.BufferGeometry();flakeGeometry.setAttribute('position',new THREE.BufferAttribute(positions,3));flakeGeometry.setAttribute('aSeed',new THREE.BufferAttribute(seeds,4));flakeMaterial=new THREE.ShaderMaterial({uniforms:{...uniforms,uSnowTime:{value:0},uSnowCenter:{value:new THREE.Vector3()},uPointScale:{value:500}},vertexShader:flakeVertex,fragmentShader:flakeFragment,transparent:true,depthTest:true,depthWrite:false});flakes=new THREE.Points(flakeGeometry,flakeMaterial);flakes.name='Snow • falling flakes';flakes.frustumCulled=false;flakes.raycast=()=>{};group.add(flakes);
  }
  function setActive(value){const next=Boolean(value);if(next!==active){active=next;lastNow=null}group.visible=enabled&&active&&ready;uniforms.uSnowEnabled.value=enabled&&active?1:0}
  function reset(){elapsed=0;time=0;lastNow=null;uniforms.uSnowDepth.value=0}
  function setEnabled(value){if(disposed)return false;const next=Boolean(value);if(next===enabled)return false;enabled=next;lastNow=null;if(!enabled){reset();restoreMaterials();group.visible=false;uniforms.uSnowEnabled.value=0}else{if(ready&&!dirty)installMaterials();setActive(active)}return true}
  function update(now,{camera,active:visible=active}={}){if(disposed)return;setActive(visible);if(!enabled||!active){lastNow=null;return}if(dirty||!ready){buildSurfaceMap();createFlakes()}if(Number.isFinite(now)){if(lastNow!==null&&now>=lastNow){const delta=now-lastNow;elapsed+=delta;time+=delta}lastNow=now}uniforms.uSnowDepth.value=elapsed/10*INCH;uniforms.uSnowEnabled.value=1;group.visible=true;if(camera?.isCamera){camera.getWorldPosition(cameraPosition);flakeMaterial.uniforms.uSnowCenter.value.copy(cameraPosition);renderer.getDrawingBufferSize(size);flakeMaterial.uniforms.uPointScale.value=size.y*.5*camera.projectionMatrix.elements[5]}flakeMaterial.uniforms.uSnowTime.value=time}
  function withClearMaterials(callback){restoreMaterials();try{return callback()}finally{if(enabled&&ready)installMaterials()}}
  function dispose(){if(disposed)return;disposed=true;enabled=false;releaseSurfaces();flakeGeometry?.dispose();flakeMaterial?.dispose();scene.remove(group)}
  return Object.freeze({setEnabled,setActive,update,reset,withClearMaterials,refreshSurfaceMap(){dirty=true;lastNow=null},dispose,get needsAnimation(){return enabled&&active&&!disposed},get visible(){return enabled&&active&&ready&&!disposed},get state(){return{enabled,active,ready,visible:enabled&&active&&ready&&!disposed,depthInches:elapsed/10,depthMeters:elapsed/10*INCH,elapsedSeconds:elapsed,flakeCount:FLAKES,coatingMeshCount:originals.length,raisedSurfaceCount:overlays.length,categories:{...categories},exposure:{...exposureBounds,meshCount:mapMeshCount,triangles:mapTriangles,buildCount,perFrameRaycasts:0},perFrameModelRebuilds:0,accumulationRateInchesPerSecond:.1,accumulationCapped:false,materialsRestored:!enabled,needsAnimation:enabled&&active&&!disposed}}});
}
