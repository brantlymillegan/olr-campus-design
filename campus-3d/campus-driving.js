// Driving uses world meters, +Y up, and vehicle-local -Z forward.
const FT = .3048, MPH = 2.2369362921;
export const DRIVING_LIMITS = Object.freeze({forward: 10.73, reverse: 3.58, acceleration: 3.4, brake: 8, steering: .51, wheelbase: 2.875, maxDt: .1, step: 1 / 120});
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const approach = (a, b, amount) => a < b ? Math.min(b, a + amount) : Math.max(b, a - amount);

// Pure kinematics; collision acceptance happens separately before any pose commits.
export function advanceDrivingMotion(state, input, dt, limits = DRIVING_LIMITS) {
  const elapsed = clamp(Number.isFinite(dt) ? dt : 0, 0, limits.maxDt);
  let speed = state.speed, heading = state.heading, steering = state.steering, x = state.x, z = state.z;
  const count = Math.max(1, Math.ceil(elapsed / limits.step)), step = elapsed / count;
  const poses = [];
  for (let i = 0; i < count; i++) {
    const throttle = clamp(input.throttle || 0, -1, 1);
    if (input.brake) speed = approach(speed, 0, limits.brake * step);
    else if (throttle && speed * throttle < 0) speed = approach(speed, 0, limits.brake * step);
    else if (throttle) speed = clamp(speed + throttle * limits.acceleration * step, -limits.reverse, limits.forward);
    else speed = approach(speed, 0, (.7 + Math.abs(speed) * .05) * step);
    steering = approach(steering, clamp(input.steer || 0, -1, 1) * limits.steering, 1.4 * step);
    heading += speed / limits.wheelbase * Math.tan(steering) * step;
    x -= Math.sin(heading) * speed * step; z -= Math.cos(heading) * speed * step;
    poses.push({x, z, heading, steering, speed, dt: step});
  }
  return poses;
}

export function createCampusDriving({THREE, scene, canvas, getWalk, requestDraw, onChange = () => {}, canFocus = () => true, getPresentation = () => '3d'}) {
  const camera = new THREE.PerspectiveCamera(72, 1, .035, 2000);camera.rotation.order = 'YXZ';
  let vehicle = null, config = {}, available = false, driving = false, near = false, speed = 0, heading = 0, steering = 0;
  let position = new THREE.Vector3(), lookYaw = 0, lookPitch = 0, collisionCount = 0, distance = 0, feedback = '', lastSignature = '', disposed = false;
  let pointer = null, mousePending = false, wantsPointer = false, wasLocked = false;
  let wheels = [], steerPivots = [], wheelAngle = 0, driverEye = new THREE.Vector3(-.36, 1.12, -.38);
  const keys = new Set(), holds = new Set(), listeners = [], captured = new Set();
  const shadowCanvas=document.createElement('canvas');shadowCanvas.width=128;shadowCanvas.height=256;
  const shadowContext=shadowCanvas.getContext('2d');
  if(shadowContext){const gradient=shadowContext.createRadialGradient(64,128,18,64,128,128);gradient.addColorStop(0,'rgba(0,0,0,.32)');gradient.addColorStop(.55,'rgba(0,0,0,.24)');gradient.addColorStop(1,'rgba(0,0,0,0)');shadowContext.translate(64,0);shadowContext.scale(.5,1);shadowContext.translate(-64,0);shadowContext.fillStyle=gradient;shadowContext.fillRect(-64,0,256,256);}
  const shadowTexture=new THREE.CanvasTexture(shadowCanvas),shadowMaterial=new THREE.MeshBasicMaterial({map:shadowTexture,transparent:true,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-1,toneMapped:false});
  const shadow=new THREE.Mesh(new THREE.PlaneGeometry(1,1),shadowMaterial);shadow.name='Red Model 3 • moving contact shadow';shadow.rotation.x=-Math.PI/2;shadow.userData.walkThrough=true;shadow.visible=false;shadow.raycast=()=>{};scene.add(shadow);
  const hud = document.createElement('div');hud.id = 'campus-driving-hud';hud.className = 'campus-driving-hud';hud.hidden = true;
  hud.innerHTML = `<div class="campus-driving-banner"><button type="button" id="campus-driving-interact">Enter red Model 3</button><span id="campus-driving-speed" aria-live="off"></span><p id="campus-driving-status" role="status"></p><p class="campus-driving-help">WASD / arrows drive · Space brakes · mouse looks · F exits · Esc releases the mouse</p></div><div class="campus-driving-pad" role="group" aria-label="Driving controls"><button type="button" data-drive-control="forward" aria-label="Accelerate">↑</button><button type="button" data-drive-control="left" aria-label="Steer left">←</button><button type="button" data-drive-control="brake" aria-label="Brake">Brake</button><button type="button" data-drive-control="right" aria-label="Steer right">→</button><button type="button" data-drive-control="backward" aria-label="Brake or reverse">↓</button></div>`;
  canvas.parentElement.appendChild(hud);
  const interact = hud.querySelector('#campus-driving-interact'), status = hud.querySelector('#campus-driving-status'), speedLabel = hud.querySelector('#campus-driving-speed'), pad = hud.querySelector('.campus-driving-pad'), help = hud.querySelector('.campus-driving-help');
  function listen(target, name, fn, options) { target.addEventListener(name, fn, options);listeners.push(() => target.removeEventListener(name, fn, options)); }
  const locked = () => document.pointerLockElement === canvas;
  const pointAt = (right, forward) => ({x:position.x + Math.cos(heading) * right - Math.sin(heading) * forward,z:position.z - Math.sin(heading) * right - Math.cos(heading) * forward});
  function exitSpot() {
    const world = getWalk()?.vehicleWorld;if (!world || !vehicle) return null;
    const half = (config.width ?? 1.85) / 2;
    // Prefer the driver's side, then the passenger side and clear rear corners.
    for (const [right, forward] of [[-half-.65,.1],[-half-.95,-.7],[half+.65,.1],[half+.95,-.7],[-half-.8,-2.7],[half+.8,-2.7]]) {
      const p = pointAt(right, forward), surface = world.standingAt(p.x, p.z);
      if (surface && Math.abs(surface.y-position.y)<.65) return {...p,y:surface.y,yaw:Math.atan2(p.x-position.x,p.z-position.z)};
    }
    return null;
  }
  function snapshot() {
    return {available,driving,near,speedMph:speed*MPH,speedMetersPerSecond:speed,heading,steering,position:{x:position.x,y:position.y,z:position.z},siteFeet:{x:position.x/FT,y:-position.z/FT,elevation:position.y/FT},distanceMeters:distance,collisionCount,canExit:!driving||Boolean(exitSpot()),pointerLocked:locked(),prompt:feedback||(driving?'F or Exit car to walk beside the car.':near?'Enter the red Model 3.':'Walk or fly near the red car to drive.'),parked:!driving,driverEye:driverEye.toArray()};
  }
  function refresh() {
    const walk = getWalk()?.state;
    const p = pointAt(-(config.width ?? 1.85)/2,.1);
    near = Boolean(available && getPresentation()==='3d' && ['walking','flying'].includes(walk?.mode) && Math.hypot(walk.feet.x-p.x,walk.feet.z-p.z)<3.2 && Math.abs(walk.feet.y-position.y)<2.1);
    hud.hidden = !(driving || near);pad.hidden = help.hidden = speedLabel.hidden = !driving;
    interact.textContent = driving?'Exit car':'Enter red Model 3';speedLabel.textContent = `${Math.round(Math.abs(speed)*MPH)} mph${speed < -.1?' · Reverse':''}`;
    status.textContent = feedback || (driving?'F or Exit car to return to Walking.':'Press F or choose Enter red Model 3.');
    hud.dataset.driving = String(driving);
    const signature = `${available}|${driving}|${near}|${Math.round(speed*MPH)}|${locked()}|${feedback}`;
    if (signature !== lastSignature) {lastSignature=signature;onChange(snapshot());}
  }
  function syncCamera() {
    if (!vehicle) return;
    vehicle.updateMatrixWorld(true);camera.position.copy(driverEye).applyMatrix4(vehicle.matrixWorld);
    camera.rotation.set(lookPitch,heading+lookYaw,0,'YXZ');camera.updateMatrixWorld();
  }
  function syncVehicle(surface) {
    if (!vehicle) return;vehicle.position.copy(position);vehicle.rotation.set(0,heading,0);
    if (surface?.normal) {
      // A modest slope bank keeps the chassis planted without camera shake.
      const local = surface.normal.clone().applyAxisAngle(new THREE.Vector3(0,1,0),-heading);
      vehicle.rotation.x = clamp(Math.atan2(local.z,local.y),-.25,.25);
      vehicle.rotation.z = clamp(-Math.atan2(local.x,local.y),-.25,.25);
    }
    shadow.visible=vehicle.visible;shadow.position.set(position.x,position.y+.006,position.z);shadow.rotation.set(-Math.PI/2,heading,0,'YXZ');shadow.scale.set((config.width??1.85)*1.2,(config.length??4.72)*1.1,1);
    for (const pivot of steerPivots) pivot.rotation.y=steering;
    for (const wheel of wheels) wheel.rotation.x=wheelAngle;
    syncCamera();
  }
  function releasePointer() {wantsPointer=false;mousePending=false;if(locked())document.exitPointerLock?.();}
  function clearInput() {keys.clear();holds.clear();pointer=null;for(const id of captured){try{canvas.releasePointerCapture(id);}catch{}}captured.clear();for(const b of pad.querySelectorAll('button'))b.removeAttribute('data-held');}
  function pause() {clearInput();speed=0;releasePointer();refresh();requestDraw();}
  function requestPointer() {
    if(!driving||!canFocus())return;wantsPointer=true;if(locked()||mousePending)return;mousePending=true;
    try {const result=canvas.requestPointerLock?.();if(result?.catch)result.catch(()=>{mousePending=false;feedback='Drag the scene to look around.';refresh();});if(!canvas.requestPointerLock)mousePending=false;}catch{mousePending=false;}
  }
  function enter() {
    refresh();if(!available||!near||driving||getPresentation()!=='3d')return false;
    driving=true;speed=0;steering=0;lookYaw=0;lookPitch=0;feedback='';clearInput();getWalk().setExternalControl(true);syncCamera();refresh();canvas.focus({preventScroll:true});
    // Touch controls need ordinary pointer events. A mouse click on the scene
    // can still request capture explicitly on a device with mixed inputs.
    if(window.matchMedia?.('(pointer: coarse)').matches)releasePointer();else requestPointer();
    requestDraw();return true;
  }
  function exit({resumeWalking=true}={}) {
    if(!driving)return false;
    const spot = resumeWalking?exitSpot():null;
    if(resumeWalking&&!spot){speed=0;feedback='No clear space beside the car. Move to an open spot before exiting.';refresh();requestDraw();return false;}
    pause();driving=false;feedback='';getWalk()?.setExternalControl(false);
    if(spot)getWalk()?.resumeFromVehicle({x:spot.x,z:spot.z,elevation:spot.y,yaw:spot.yaw});
    refresh();requestDraw();return true;
  }
  function look(dx,dy,touch=false){lookYaw=clamp(lookYaw-dx*(touch ? .004 : .003),-Math.PI*.88,Math.PI*.88);lookPitch=clamp(lookPitch-dy*(touch ? .004 : .003),-.65,.5);syncCamera();requestDraw();}
  function bodyPlacement(x,z,yaw) {
    const world=getWalk()?.vehicleWorld;if(!world)return null;
    const width=config.width??1.85,length=config.length??4.72,radius=width/2;
    const offsets=[-(length/2-radius),0,length/2-radius];let min=Infinity,max=-Infinity,surface=null;
    const samples=[];
    for(const offset of offsets){
      const p={x:x-Math.sin(yaw)*offset,z:z-Math.cos(yaw)*offset},g=world.groundAt(p.x,p.z);if(!g||g.normal.y<.93)return null;
      min=Math.min(min,g.y);max=Math.max(max,g.y);samples.push([p,g]);if(offset===0)surface=g;
      for(const side of [-radius,radius]){const edge=world.groundAt(p.x+Math.cos(yaw)*side,p.z-Math.sin(yaw)*side);if(!edge||Math.abs(edge.y-g.y)>.22)return null;}
    }
    if(max-min>.4)return null;
    for(const [p,g] of samples)if(world.blockedAt(p.x,p.z,g.y+.008,radius,Math.max(config.height??1.44,2*radius)))return null;
    return surface;
  }
  function inputState() {return {throttle:Number(keys.has('KeyW')||keys.has('ArrowUp')||holds.has('forward'))-Number(keys.has('KeyS')||keys.has('ArrowDown')||holds.has('backward')),steer:Number(keys.has('KeyA')||keys.has('ArrowLeft')||holds.has('left'))-Number(keys.has('KeyD')||keys.has('ArrowRight')||holds.has('right')),brake:keys.has('Space')||holds.has('brake')};}
  function update(dt) {
    if(disposed)return;refresh();if(vehicle)shadow.visible=vehicle.visible;if(!driving||!vehicle)return;
    const input=inputState();
    for(const next of advanceDrivingMotion({x:position.x,z:position.z,heading,steering,speed},input,dt)){
      const surface=bodyPlacement(next.x,next.z,next.heading);
      if(!surface||Math.abs(surface.y-position.y)>.22){if(Math.abs(speed)>.02||Math.abs(next.speed)>.02)collisionCount++;speed=0;steering=next.steering;feedback='Obstacle ahead. Brake and steer or reverse into clear space.';break;}
      const moved=Math.hypot(next.x-position.x,next.z-position.z);distance+=moved;wheelAngle-=Math.sign(next.speed)*moved/(config.wheelRadius??.335);
      position.set(next.x,surface.y,next.z);heading=next.heading;steering=next.steering;speed=next.speed;feedback='';syncVehicle(surface);
    }
    refresh();
  }
  function command(name,value) {
    if(name==='drive-toggle')return driving?exit():enter();
    if(name==='drive-exit')return exit(value||{});
    if(name==='drive-release-pointer'){pause();return true;}
    if(name==='drive-input'&&driving){
      if(value?.kind==='look'&&Number.isFinite(value.dx)&&Number.isFinite(value.dy)){look(value.dx,value.dy,Boolean(value.touch));return true;}
      if(value?.kind==='key'&&['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(value.code)&&typeof value.down==='boolean'){if(value.down)keys.add(value.code);else keys.delete(value.code);requestDraw();return true;}
      if(value?.kind==='move'&&['forward','backward','left','right','brake'].includes(value.direction)&&typeof value.down==='boolean'){if(value.down)holds.add(value.direction);else holds.delete(value.direction);requestDraw();return true;}
      if(value?.kind==='pause'){pause();return true;}
    }
    return false;
  }
  const stop=e=>{e.preventDefault();e.stopImmediatePropagation();};
  listen(document,'keydown',e=>{
    if(e.ctrlKey||e.metaKey||e.altKey||e.target?.closest?.('input,select,textarea,[contenteditable="true"]'))return;
    if(e.code==='KeyF'&&!e.repeat&&(driving||near)&&canFocus()){stop(e);command('drive-toggle');return;}
    if(!driving||!canFocus()||e.target?.closest?.('button'))return;
    if(e.code==='Escape'){stop(e);pause();return;}
    if(command('drive-input',{kind:'key',code:e.code,down:true}))stop(e);
  },{capture:true});
  listen(document,'keyup',e=>{if(e.target?.closest?.('button'))return;if(driving&&command('drive-input',{kind:'key',code:e.code,down:false}))stop(e);},{capture:true});
  listen(canvas,'pointerdown',e=>{if(!driving||(e.pointerType==='mouse'&&e.button!==0))return;stop(e);canvas.focus({preventScroll:true});pointer={id:e.pointerId,x:e.clientX,y:e.clientY,touch:e.pointerType!=='mouse'};if(e.pointerType==='mouse')requestPointer();else{canvas.setPointerCapture(e.pointerId);captured.add(e.pointerId);}},{capture:true});
  listen(canvas,'pointermove',e=>{if(!driving||locked()||pointer?.id!==e.pointerId)return;stop(e);look(e.clientX-pointer.x,e.clientY-pointer.y,pointer.touch);pointer.x=e.clientX;pointer.y=e.clientY;},{capture:true});
  for(const type of ['pointerup','pointercancel','lostpointercapture'])listen(canvas,type,e=>{if(pointer?.id===e.pointerId)pointer=null;captured.delete(e.pointerId);},{capture:true});
  listen(document,'mousemove',e=>{if(driving&&locked()&&canFocus()){stop(e);look(e.movementX,e.movementY);}},{capture:true});
  listen(document,'pointerlockchange',()=>{mousePending=false;const now=locked();if(now&&driving&&!wantsPointer){releasePointer();return;}if(wasLocked&&!now&&driving){clearInput();speed=0;}wasLocked=now;if(driving){refresh();requestDraw();}});
  listen(document,'pointerlockerror',()=>{mousePending=false;});
  listen(window,'blur',()=>{if(driving)pause();});listen(document,'visibilitychange',()=>{if(document.hidden&&driving)pause();});
  listen(interact,'click',()=>command('drive-toggle'));
  for(const button of pad.querySelectorAll('button')){
    const direction=button.dataset.driveControl;
    const down=e=>{if(!driving)return;e.preventDefault();holds.add(direction);button.dataset.held='';if(e.pointerId!==undefined)button.setPointerCapture(e.pointerId);requestDraw();};
    const up=e=>{e.preventDefault();holds.delete(direction);button.removeAttribute('data-held');requestDraw();};
    listen(button,'pointerdown',down);for(const type of ['pointerup','pointercancel','lostpointercapture'])listen(button,type,up);
    listen(button,'keydown',e=>{if(['Enter',' '].includes(e.key))down(e);});listen(button,'keyup',e=>{if(['Enter',' '].includes(e.key))up(e);});listen(button,'blur',()=>{holds.delete(direction);button.removeAttribute('data-held');});
  }
  return Object.freeze({
    setVehicle(root,options={}) {
      if(driving)exit({resumeWalking:false});vehicle=root;const dimensions=options.dimensions_ft??{};config={...options,width:options.width??(dimensions.width*FT||1.85),length:options.length??(dimensions.length*FT||4.72),height:options.height??(dimensions.height*FT||1.44),wheelRadius:options.wheelRadius??options.wheel_nodes?.[0]?.radius_m??.335};available=Boolean(root);if(!root){shadow.visible=false;refresh();return;}
      if(!root.parent)scene.add(root);root.traverse(o=>{if(o.isMesh){o.castShadow=false;o.receiveShadow=true;}});heading=options.park?.heading??options.heading??0;const start=options.park??options.siteFeet??{x:43.5,y:230};
      position.set(start.x*FT,0,-start.y*FT);const ground=getWalk()?.vehicleWorld.groundAt(position.x,position.z);position.y=ground?.y??0;
      driverEye.fromArray(options.driver_eye_m??options.driverEye??[-.36,1.12,-.38]);const wheelNames=options.wheel_nodes?.map(n=>typeof n==='string'?n:n.spin_node??n.name)??['Wheel_FL','Wheel_FR','Wheel_RL','Wheel_RR'];wheels=wheelNames.map(n=>root.getObjectByName(n)).filter(Boolean);steerPivots=['Steer_FL','Steer_FR'].map(n=>root.getObjectByName(n)).filter(Boolean);speed=0;steering=0;wheelAngle=0;syncVehicle(ground);refresh();requestDraw();
    },
    update,command,pause,resize(w,h){camera.aspect=Math.max(1,w)/Math.max(1,h);camera.updateProjectionMatrix();},
    get camera(){return driving?camera:null;},get state(){return snapshot();},get needsAnimation(){const i=inputState();return driving&&(Math.abs(speed)>.001||Boolean(i.throttle||i.steer||i.brake));},
    dispose(){if(disposed)return;if(driving)exit({resumeWalking:false});disposed=true;listeners.forEach(remove=>remove());hud.remove();scene.remove(shadow);shadow.geometry.dispose();shadowMaterial.dispose();shadowTexture.dispose();}
  });
}
