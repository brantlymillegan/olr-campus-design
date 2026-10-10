import * as THREE from 'three';

const FT = .3048, TAU = Math.PI * 2;
const NO_RAYCAST = () => {};
const freeze = value => Object.freeze(value);
// Small songbirds have different silhouettes as well as plumage. Dimensions
// are in meters before each species' scale; local -Z is the beak direction.
export const CAMPUS_BIRD_SPECIES = freeze([
  freeze({ id: 'cardinal', name: 'Northern cardinal', scale: .35, crest: .070,
    back: '#ad3029', breast: '#d84532', head: '#c6392f', dark: '#622c2b',
    wing: '#a73531', edge: '#bd5140', tail: '#8d302b', beak: '#e58d51', mask: '#262325' }),
  freeze({ id: 'blue-jay', name: 'Blue jay', scale: .44, crest: .050,
    back: '#4b8ab7', breast: '#dddcd0', head: '#649ac5', dark: '#253344',
    wing: '#427dad', edge: '#f0ecdc', tail: '#4179a6', beak: '#333b42', mask: '#263340' }),
  freeze({ id: 'robin', name: 'American robin', scale: .38, crest: 0,
    back: '#66685e', breast: '#ce7244', head: '#424a46', dark: '#41433e',
    wing: '#61665e', edge: '#a09883', tail: '#53584f', beak: '#e0ba59', mask: null }),
  freeze({ id: 'dove', name: 'Mourning dove', scale: .45, crest: 0,
    back: '#a29a89', breast: '#cbb9a0', head: '#aaa499', dark: '#66635e',
    wing: '#a79f8e', edge: '#d5cbb5', tail: '#9f9583', beak: '#4c4b46', mask: null }),
  freeze({ id: 'sparrow', name: 'Song sparrow', scale: .28, crest: 0,
    back: '#81684b', breast: '#d8cbb0', head: '#917557', dark: '#493d30',
    wing: '#8e7252', edge: '#cfb990', tail: '#746048', beak: '#71624c', mask: null }),
  freeze({ id: 'crow', name: 'American crow', scale: .66, crest: 0,
    back: '#292e33', breast: '#363b40', head: '#252b30', dark: '#20262d',
    wing: '#303841', edge: '#414951', tail: '#272f37', beak: '#292c30', mask: null }),
]);

export const CAMPUS_BIRD_ROUTE = freeze({ centerFeet: [112,210], radiusFeet: [62,62], altitudeFeet: [64,74], lapSeconds: 25, daylightMinutes: [390,1140] });
export const CAMPUS_BIRD_ROUTES = freeze([
  CAMPUS_BIRD_ROUTE,
  freeze({ centerFeet: [85,35], radiusFeet: [60,48], altitudeFeet: [52,62], lapSeconds: 31 }),
  freeze({ centerFeet: [201,158], radiusFeet: [22,34], altitudeFeet: [58,68], lapSeconds: 22 }),
  freeze({ centerFeet: [-210,50], radiusFeet: [60,50], altitudeFeet: [64,74], lapSeconds: 36 }),
  // Low corridors and all foot placements are checked against the current
  // model. Keep clear of paths through buildings, roads and dense crowns.
  freeze({"centerFeet":[204,159.5],"radiusFeet":[10,14.5],"altitudeFeet":[16,20],"lapSeconds":14}),
  freeze({"centerFeet":[-12.5,299],"radiusFeet":[37.5,19],"altitudeFeet":[4,8],"lapSeconds":23}),
  freeze({"centerFeet":[-189.5,66.5],"radiusFeet":[9.5,18.5],"altitudeFeet":[5,8],"lapSeconds":18}),
]);
export const CAMPUS_BIRD_HABITATS = freeze({
  ground: freeze([{"at":[27,68,-0.09899999946355818],"support":"School walk • grass verges","radiusFeet":0.45,"groundSlope":[0.0,0.0]},{"at":[27,81,-0.0989999994635582],"support":"School walk • grass verges","radiusFeet":0.45,"groundSlope":[0.0,0.0]},{"at":[27,145,-0.0989999994635582],"support":"School walk • grass verges","radiusFeet":0.6,"groundSlope":[6.938893903907228e-17,0.0]},{"at":[27,195,-0.0989999994635582],"support":"School walk • grass verges","radiusFeet":0.6,"groundSlope":[0.0,0.0]},{"at":[190,170,0.1599999964237213],"support":"07 • Paths parking and landscape structure / Campus lawn","radiusFeet":1.1,"groundSlope":[0.0,-1.3877787807814457e-16]},{"at":[194,147,0.1599999964237213],"support":"07 • Paths parking and landscape structure / Campus lawn","radiusFeet":1.5,"groundSlope":[0.0,0.0]},{"at":[218,150,0.1599999964237213],"support":"07 • Paths parking and landscape structure / Campus lawn","radiusFeet":1.5,"groundSlope":[0.0,0.0]},{"at":[219,171,0.1599999964237213],"support":"07 • Paths parking and landscape structure / Campus lawn","radiusFeet":1.1,"groundSlope":[0.0,0.0]},{"at":[10,48,0.1599999964237213],"support":"07 • Paths parking and landscape structure / Campus lawn","radiusFeet":0.7,"groundSlope":[0.0,-1.3877787807814457e-16]},{"at":[232,172,0.1599999964237213],"support":"07 • Paths parking and landscape structure / Campus lawn","radiusFeet":0.7,"groundSlope":[1.3877787807814457e-16,-1.3877787807814457e-16]},{"at":[-190,55,-6.761407852172852],"support":"Landform • upper campus and west slope","radiusFeet":1.5,"groundSlope":[0.13459100723266282,0.0]},{"at":[-190,5,-6.761407852172852],"support":"Landform • upper campus and west slope","radiusFeet":1.5,"groundSlope":[0.13459100723266282,0.0]}]),
  tree: freeze([{"at":[13.109459768490357,331.6757847415655,16.499868832415554],"support":"09L • Natural trees / tree-04 oak","heading":-2.5195366506288983,"species":"sparrow"},{"at":[426.7702124944946,129.81172101861137,9.159316280931593],"support":"09L • Natural trees / tree-10 oak","heading":-0.686129264988071,"species":"sparrow"},{"at":[304.19023973921674,-73.60842912001483,8.634975445728237],"support":"09L • Natural trees / tree-19 oak","heading":2.0639818134731702,"species":"sparrow"},{"at":[337.45376177499764,100.92444957070894,11.362498207415278],"support":"09L • Natural trees / tree-31 oak","heading":-0.5523887224247581,"species":"sparrow"},{"at":[265.06313069661456,86.72885386149089,10.905356149724025],"support":"09L • Natural trees / tree-16 oak","heading":1.1472781206527578,"species":"cardinal"},{"at":[214.08000691731772,-27.69058609008789,12.032833159321367],"support":"09L • Natural trees / tree-28 oak","heading":1.6765704577310578,"species":"robin"},{"at":[291.27085367838544,52.516326904296875,6.950880827751594],"support":"09L • Natural trees / tree-30 maple","heading":2.4696456753743643,"species":"cardinal"},{"at":[-77.85065205891927,335.24830118815106,15.640480456492782],"support":"09L • Natural trees / tree-01 oak","heading":2.846938184073533,"species":"robin"}]),
  roof: freeze([{"at":[-16,120,36.5],"support":"02 • New school buildings / Charcoal shingle roof","heading":1.5707963267948966},{"at":[-16,200,36.5],"support":"02 • New school buildings / Charcoal shingle roof","heading":1.5707963267948966},{"at":[95,140,36.5],"support":"02 • New school buildings / Charcoal shingle roof","heading":1.5707963267948966},{"at":[110,160,36.5],"support":"02 • New school buildings / Charcoal shingle roof","heading":1.5707963267948966},{"at":[348.5,135,40.79999923706055],"support":"03 • Church | photo referenced exterior / Charcoal shingle roof","heading":1.5707963267948966},{"at":[348.5,180,40.79999923706055],"support":"03 • Church | photo referenced exterior / Charcoal shingle roof","heading":1.5707963267948966}]),
});

function makeSpecies(spec) {
  const geometries = [];
  const colors = Object.fromEntries(['back','breast','head','dark','wing','edge','tail','beak'].map(key => [key, new THREE.Color(spec[key])]));
  colors.eye = new THREE.Color('#0e1316'); colors.leg = new THREE.Color(spec.id === 'crow' ? '#353c42' : '#987661');
  function batch() {
    const position = [], normal = [], color = [], index = [];
    const matrix = new THREE.Matrix4(), rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3(), center = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0), direction = new THREE.Vector3();
    const normalMatrix = new THREE.Matrix3(), p = new THREE.Vector3(), n = new THREE.Vector3();
    function add(geometry, tint, at, size, quaternion = null) {
      center.set(at[0], at[1], at[2]); scale.set(size[0], size[1], size[2]);
      matrix.compose(center, quaternion || rotation.identity(), scale);
      normalMatrix.getNormalMatrix(matrix);
      const a = geometry.attributes.position, b = geometry.attributes.normal, offset = position.length / 3;
      for (let i = 0; i < a.count; i++) {
        p.fromBufferAttribute(a, i).applyMatrix4(matrix);
        n.fromBufferAttribute(b, i).applyMatrix3(normalMatrix).normalize();
        position.push(p.x, p.y, p.z); normal.push(n.x, n.y, n.z); color.push(tint.r, tint.g, tint.b);
      }
      if (geometry.index) for (let i = 0; i < geometry.index.count; i++) index.push(offset + geometry.index.getX(i));
      else for (let i = 0; i < a.count; i++) index.push(offset + i);
      geometry.dispose();
    }
    function oval(tint, at, size, width = 10, height = 6) {
      add(new THREE.SphereGeometry(1, width, height), tint, at, size);
    }
    function feather(tint, a, b, width, thickness) {
      direction.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      const length = direction.length();
      rotation.setFromUnitVectors(up, direction.multiplyScalar(1 / length));
      add(new THREE.SphereGeometry(1, 6, 4), tint,
        [(a[0] + b[0]) * .5, (a[1] + b[1]) * .5, (a[2] + b[2]) * .5],
        [width, length * .5, thickness], rotation);
    }
    function finish() {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
      geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(color, 3));
      geometry.setIndex(index); geometry.computeBoundingSphere(); geometries.push(geometry);
      return geometry;
    }
    return { add, oval, feather, finish };
  }
  const body = batch();
  body.oval(colors.back, [0,.01,.015], [.105,.09,.235], 12,8);
  body.oval(colors.breast, [0,-.025,-.066], [.091,.071,.155], 12,8);
  for (let i=0;i<5;i++) {
    const spread=(i-2)*.026;
    const tip=spec.id==='dove'?.44:spec.id==='blue-jay'?.43:.38;
    body.feather(i===0||i===4?colors.dark:colors.tail,
      [spread*.35,-.004,.16], [spread,-.022,tip-Math.abs(i-2)*.022],.024,.008);
  }
  if(spec.id==='sparrow')for(let i=-2;i<=2;i++) {
    body.feather(colors.dark,[i*.020,-.074,-.10],[i*.023,-.085,-.04],.005,.004);
  }
  const head=batch();
  head.oval(colors.head,[0,0,0],[.071,.068,.080],12,8);
  head.oval(colors.breast,[0,-.040,-.032],[.050,.034,.045]);
  if(spec.mask) {
    const mask=new THREE.Color(spec.mask);
    for(const sign of [-1,1])head.oval(mask,[sign*.043,-.006,-.047],[.023,.042,.035]);
  }
  const beakRotation=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),-Math.PI/2);
  head.add(new THREE.ConeGeometry(1,2,8),colors.beak,[0,-.018,-.099],
    [spec.id==='cardinal'?.032:.023,spec.id==='crow'?.071:.047,.021],beakRotation);
  for(const sign of [-1,1]) {
    // Pale eye rims and black pupils remain readable up close.
    if(['robin','dove'].includes(spec.id))head.oval(colors.edge,[sign*.065,.018,-.026],[.012,.012,.010],8,6);
    head.oval(colors.eye,[sign*.070,.018,-.026],[.007,.008,.007],8,6);
    head.oval(new THREE.Color('#fff7e9'),[sign*.075,.021,-.029],[.0025,.0025,.0025],6,4);
  }
  if(spec.crest)for(let i=0;i<4;i++)head.feather(colors.head,
    [(i-1.5)*.012,.041,.025],[(i-1.5)*.006,.063+spec.crest,.044+i*.004],.015,.010);
  if(spec.id==='sparrow')for(const sign of [-1,1])head.feather(colors.edge,[sign*.052,.037,-.045],[sign*.060,.037,.034],.007,.006);
  const parts={ body:body.finish(),head:head.finish() };
  for(const sign of [-1,1]) {
    const inner=batch();
    inner.oval(colors.wing,[sign*.14,0,.01],[.19,.022,.125]);
    for(let i=0;i<5;i++) {
      const x=.025+i*.059;
      inner.feather(i<2?colors.edge:colors.wing,[sign*x,.004,-.069+i*.012],[sign*(x+.025),-.004,.12+i*.019],.030,.010);
    }
    // Jay bars, dove spots, and sparrow streaks distinguish folded wings too.
    if(spec.id==='blue-jay')for(let i=0;i<3;i++)inner.feather(i===1?colors.edge:colors.dark,[sign*.12,.024,.025+i*.028],[sign*.27,.024,.045+i*.028],.009,.003);
    if(spec.id==='dove')for(let i=0;i<4;i++)inner.oval(colors.dark,[sign*(.08+i*.042),.024,.055],[.012,.004,.017],6,4);
    if(spec.id==='sparrow')for(let i=0;i<4;i++)inner.feather(colors.dark,[sign*(.05+i*.048),.024,-.015],[sign*(.08+i*.048),.024,.075],.006,.004);
    parts['inner'+sign]=inner.finish();
    const outer=batch();
    for(let i=0;i<6;i++)outer.feather(i===0?colors.wing:colors.dark,
      [sign*.002,0,-.055+i*.021],[sign*(.20-i*.013),-.010,-.010+i*.047],.022,.007);
    parts['outer'+sign]=outer.finish();
  }
  const leg=batch();
  leg.feather(colors.leg,[0,0,0],[0,-.063,.014],.008,.008);
  leg.feather(colors.leg,[0,-.063,.014],[0,-.114,0],.006,.006);
  for(let i=-1;i<=1;i++)leg.feather(colors.leg,[0,-.114,0],[i*.024,-.118,-.047+Math.abs(i)*.009],.004,.004);
  leg.feather(colors.leg,[0,-.114,0],[.004,-.118,.032],.004,.004);
  parts.legs=leg.finish();
  return {parts,geometries};
}

/** Scene sibling, separate from the model and its collision/picking tree.
 * Forty individuals are drawn in seven instanced batches per species. Each
 * keeps its own pose and timing, with no per-frame geometry or material work.
 */
export function createCampusBird({scene}) {
  if(!scene?.isScene)throw new TypeError('createCampusBird requires a THREE.Scene');
  const material=new THREE.MeshStandardMaterial({vertexColors:true,roughness:.82,metalness:0});
  material.name='Campus birds • natural plumage';
  const flock=new THREE.Group();flock.name='Campus ambience • bird flock';
  flock.userData.campusAmbient=true;flock.userData.excludeFromCollision=true;
  scene.add(flock);flock.visible=false;
  const species=CAMPUS_BIRD_SPECIES.map(spec=>({...spec,...makeSpecies(spec),birds:[],batches:{}}));
  const birds=[];
  function bird(type,behavior,data) {
    const spec=species.find(s=>s.id===type),index=birds.length;
    const item={index,id:'campus-bird-'+(index+1),spec,behavior,...data,originalHabitat:data.habitat,
      slot:spec.birds.length,phase:.72+index*1.371,scale:spec.scale*(.96+(index%3)*.04),
      position:new THREE.Vector3(),heading:0,rootMatrix:new THREE.Matrix4()};
    birds.push(item);spec.birds.push(item);
  }
  const flightTypes=['crow','dove','blue-jay','robin','cardinal','sparrow'];
  CAMPUS_BIRD_ROUTES.forEach((route,i)=>[0,1].forEach(member=>bird(flightTypes[(i*2+member)%6],i<4?'high-flight':'low-flight',
    {route,routeIndex:i,member,direction:i%2?-1:1})));
  CAMPUS_BIRD_HABITATS.ground.forEach((habitat,i)=>bird(['robin','sparrow','dove','blue-jay'][i%4],'ground', {habitat}));
  CAMPUS_BIRD_HABITATS.tree.forEach(habitat=>bird(habitat.species,'tree-perch',{habitat}));
  CAMPUS_BIRD_HABITATS.roof.forEach((habitat,i)=>bird(i%2?'dove':'crow','roof-perch',{habitat}));
  let triangles=0,meshCount=0;
  for(const spec of species)for(const [part,geometry] of Object.entries(spec.parts)) {
    const count=spec.birds.length*(part==='legs'?2:1);
    const mesh=new THREE.InstancedMesh(geometry,material,count);
    mesh.name=spec.name+' • '+part;mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow=false;mesh.receiveShadow=false;mesh.raycast=NO_RAYCAST;
    // One conservative bound contains every route, toe, and wing pose. This
    // avoids rescanning all instance bounds every frame or stale-pose culling.
    mesh.boundingSphere=new THREE.Sphere(new THREE.Vector3(),400);
    flock.add(mesh);spec.batches[part]=mesh;triangles+=geometry.index.count/3*count;meshCount++;
  }
  const positionsMeters=birds.map(()=>[0,0,0]);
  const individuals=birds.map(b=>({id:b.id,species:b.spec.id,behavior:b.behavior,positionMeters:positionsMeters[b.index],
    support:b.habitat?.support||null,supportFeet:b.habitat?.at||null,headingRadians:0,walking:false,pecking:false,wingSpanMeters:1.26*b.scale}));
  const counts=key=>Object.fromEntries([...new Set(individuals.map(b=>b[key]))].map(k=>[k,individuals.filter(b=>b[key]===k).length]));
  const state={active:false,visible:false,daylight:false,paused:true,flightSeconds:0,laps:0,constructionPhase:'new',
    birdCount:birds.length,routeCount:CAMPUS_BIRD_ROUTES.length,speciesCount:species.length,
    species:counts('species'),behaviors:counts('behavior'),individuals,
    triangles,meshCount,uniqueGeometries:species.reduce((n,s)=>n+s.geometries.length,0),materialCount:1,
    positionMeters:positionsMeters[0],positionsMeters,wingSpanMeters:1.26*species[0].scale};
  let enabled=true,disposed=false,lastElapsed=null,flightTime=0,previousRunning=false;
  const q=new THREE.Quaternion(),rotation=new THREE.Euler(0,0,0,'YXZ');
  const v=new THREE.Vector3(),scale=new THREE.Vector3(),unit=new THREE.Vector3(1,1,1);
  const local=new THREE.Matrix4(),body=new THREE.Matrix4(),joint=new THREE.Matrix4(),partMatrix=new THREE.Matrix4();
  function compose(target,x,y,z,pitch=0,yaw=0,roll=0) {
    v.set(x,y,z);q.setFromEuler(rotation.set(pitch,yaw,roll,'YXZ'));return target.compose(v,q,unit);
  }
  function write(bird,part,matrix,slot=bird.slot) {bird.spec.batches[part].setMatrixAt(slot,matrix);}
  function pose(bird,now,dt) {
    const {spec,phase,behavior}=bird;
    const flying=behavior.endsWith('flight');
    let pitch=0,roll=0,walking=false,peck=0,hop=0,legCycle=0;
    if(flying) {
      const {route,direction,member,routeIndex}=bird;
      const a=now*TAU/route.lapSeconds*direction+.72+routeIndex*.87+member*Math.PI;
      const [rx,ry]=route.radiusFeet,amp=(route.altitudeFeet[1]-route.altitudeFeet[0])*.5;
      const height=(route.altitudeFeet[1]+route.altitudeFeet[0])*.5+amp*Math.sin(2*a+.35)+(routeIndex<4?(member?.6:-.6):0);
      bird.position.set((route.centerFeet[0]+rx*Math.cos(a))*FT,height*FT,-(route.centerFeet[1]+ry*Math.sin(a))*FT);
      pitch=Math.atan2(2*amp*Math.cos(2*a+.35)*direction,Math.hypot(rx*Math.sin(a),ry*Math.cos(a)));
      bird.heading=Math.atan2(rx*Math.sin(a)*direction,ry*Math.cos(a)*direction);roll=.10*direction;
    }else {
      const {at,radiusFeet=0,heading=0,groundSlope=[0,0]}=bird.habitat;
      let x=at[0],north=at[1];
      if(behavior==='ground') {
        // Walk for four seconds, pause to forage for five. Smooth starts and
        // stops avoid skating; each bird follows a small, independently phased oval.
        const t=now+phase*3,cycle=t%9,lap=Math.floor(t/9);
        walking=cycle<4;
        const progress=walking?(cycle-Math.sin(TAU*cycle/4)*4/TAU)/4:1;
        const a=phase+(lap+progress)*.72;
        x+=radiusFeet*Math.cos(a);north+=radiusFeet*.65*Math.sin(a);
        bird.heading=Math.atan2(radiusFeet*Math.sin(a),radiusFeet*.65*Math.cos(a));
        const stride=Math.sin(Math.PI*cycle/4)**2;
        legCycle=walking?Math.sin(cycle*TAU*3.7)*stride:0;
        hop=walking?Math.abs(legCycle)*.008:0;
        peck=walking?0:Math.max(0,Math.sin((cycle-4)*TAU*.64))**8*Math.sin(Math.PI*(cycle-4)/5)**2;
      }else bird.heading=heading;
      const height=at[2]+groundSlope[0]*(x-at[0])+groundSlope[1]*(north-at[1]);
      bird.position.set(x*FT,height*FT,-north*FT);
      // Branch/ridge coordinates mark the middle of the toes. Keep feet fixed
      // on that support while the head looks around independently.
      if(behavior!=='ground') {
        bird.position.x-=Math.sin(bird.heading)*.045*bird.scale;
        bird.position.z-=Math.cos(bird.heading)*.045*bird.scale;
      }
      pitch=-peck*.33;
    }
    scale.setScalar(bird.scale);q.setFromEuler(rotation.set(0,bird.heading,0,'YXZ'));
    bird.rootMatrix.compose(bird.position,q,scale);
    compose(local,0,.165+hop,0,pitch,0,roll);body.multiplyMatrices(bird.rootMatrix,local);
    write(bird,'body',body);
    compose(local,0,.055-peck*.013,-.195,-peck*.55, flying?.02*Math.sin(now+phase):.25*Math.sin(now*.75+phase));
    partMatrix.multiplyMatrices(body,local);write(bird,'head',partMatrix);
    const period=spec.id==='crow'?8.4:spec.id==='sparrow'?2.7:4.2;
    const flapping=spec.id==='crow'?3:period*.76;
    const cycle=(now+phase)%period,env=cycle<flapping?Math.sin(Math.PI*cycle/flapping)**2:0;
    const speed=spec.id==='crow'?2.1:spec.id==='dove'?5:spec.id==='sparrow'?6.5:4.8;
    const flap=Math.sin((now+phase)*TAU*speed)*.60*env;
    const fold=Math.max(0,Math.cos((now+phase)*TAU*speed))*.23*env;
    for(const sign of [-1,1]) {
      compose(local,sign*.075,.020,-.025,0,flying?0:-sign*1.29,sign*(flying?.055+flap:-.32));
      joint.multiplyMatrices(body,local);write(bird,'inner'+sign,joint);
      compose(local,sign*.30,0,.042,0,flying?-sign*(.04+fold*.6):-sign*.65,sign*(flying?-.04-flap*.34+fold:.25));
      partMatrix.multiplyMatrices(joint,local);write(bird,'outer'+sign,partMatrix);
      compose(local,sign*.036,flying?.128:.118+Math.max(0,legCycle*sign)*.018,flying?.10:.045+legCycle*sign*.018,flying?1.15:legCycle*sign*.12);
      partMatrix.multiplyMatrices(bird.rootMatrix,local);write(bird,'legs',partMatrix,bird.slot*2+(sign>0?1:0));
    }
    const info=individuals[bird.index],p=info.positionMeters;
    p[0]=bird.position.x;p[1]=bird.position.y;p[2]=bird.position.z;
    info.headingRadians=bird.heading;info.walking=walking;info.pecking=peck>.15;
  }
  function update(elapsedSeconds,options) {
    if(disposed)return state;
    const elapsed=Number.isFinite(elapsedSeconds)?elapsedSeconds:0;
    const active=options?.active!==false;
    const minutes=Number.isFinite(options?.minutes)?((options.minutes%1440)+1440)%1440:840;
    const daylight=minutes>=390&&minutes<1140,running=enabled&&active&&daylight;
    const dt=lastElapsed===null?0:Math.max(0,Math.min(.1,elapsed-lastElapsed));lastElapsed=elapsed;
    if(running&&previousRunning)flightTime+=dt;previousRunning=running;
    state.active=enabled&&active;state.daylight=daylight;state.visible=flock.visible=running;state.paused=!running;
    if(!running)return state;
    for(const bird of birds)pose(bird,flightTime,dt);
    for(const spec of species)for(const mesh of Object.values(spec.batches))mesh.instanceMatrix.needsUpdate=true;
    state.flightSeconds=flightTime;state.laps=flightTime/CAMPUS_BIRD_ROUTE.lapSeconds;return state;
  }
  function setActive(value) {
    enabled=!!value;
    if(!enabled){flock.visible=false;previousRunning=false;state.visible=false;state.paused=true;state.active=false;}
  }
  function setPhase(value) {
    if(disposed||!['new','phase1','phase2'].includes(value)||state.constructionPhase===value)return;
    state.constructionPhase=value;
    // Building 2 has not been built in Phase 1. Its two ridge birds use
    // separated, supported positions on Building 1 instead, keeping the flock
    // and animation timing intact while construction views change.
    for(const bird of birds) {
      const home=bird.originalHabitat;
      if(bird.behavior!=='roof-perch'||!home||home.at[0]<42||home.at[0]>153)continue;
      bird.habitat=value==='phase1'?{...home,at:home.at[0]===95?[-16,160,36.5]:[-16,240,34.815943]}:home;
      individuals[bird.index].supportFeet=bird.habitat.at;
      pose(bird,flightTime,0);
    }
    for(const spec of species)for(const mesh of Object.values(spec.batches))mesh.instanceMatrix.needsUpdate=true;
  }
  function dispose() {
    if(disposed)return;disposed=true;scene.remove(flock);
    for(const spec of species) {
      for(const mesh of Object.values(spec.batches))mesh.dispose();
      for(const geometry of spec.geometries)geometry.dispose();
    }
    material.dispose();flock.clear();state.active=false;state.visible=false;state.paused=true;
  }
  return {update,setActive,setPhase,state,dispose};
}
