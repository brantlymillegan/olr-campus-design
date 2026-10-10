import * as THREE from 'three';

const FEET = 0.3048;
const LATITUDE = THREE.MathUtils.degToRad(35);
const GRID_BEARING = THREE.MathUtils.degToRad(9.067253590763931);
const smooth = (a, b, value) => THREE.MathUtils.smoothstep(value, a, b);
const mix = THREE.MathUtils.lerp;

// Shared by the live explorer and its on-demand still captures. Keep night
// exposure/lamps separate so a clearer daytime image does not wash out night.
export const CAMPUS_DAYLIGHT = Object.freeze({
  sunIntensity: 3.4, hemisphereIntensity: .64, environmentIntensity: .70,
  exposure: 1.14, skyColor: '#c6dff6', groundColor: '#6c735f', sunColor: '#fff8ef',
  lawnColor: Object.freeze([.1021480285 * .90, .1599647863 * 1.12, .0461954114 * .90])
});

export function applyCampusPalette(model) {
  const visited = new Set();
  model.traverse(object => {
    if (!object.isMesh) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (!material?.color || visited.has(material)) continue;
      visited.add(material);
      if (/^Interior[\s_.•-]+ceiling[\s_.•-]+acoustic[\s_.•-]+white$/i.test(material.name)) {
        material.color.setRGB(.86, .86, .86);
        material.roughness = .95;
        // Downward-facing ceilings otherwise receive the outdoor lawn's green
        // bounce. Neutralize that indirect fill and approximate the soft bounce
        // from the always-on interior fixtures (the realtime lights have no GI).
        // Direct fixture pools, shadows, AO and day/night variation remain.
        material.onBeforeCompile = shader => {
          shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_end>', `
            #include <lights_fragment_end>
            const vec3 ceilingLuminance = vec3(0.2126, 0.7152, 0.0722);
            reflectedLight.indirectDiffuse = vec3(0.18 + dot(reflectedLight.indirectDiffuse, ceilingLuminance) * 2.0);
            reflectedLight.indirectSpecular = vec3(dot(reflectedLight.indirectSpecular, ceilingLuminance));
          `);
        };
        material.customProgramCacheKey = () => 'neutral-acoustic-ceiling-v1';
        material.needsUpdate = true;
      }
      if (/^Interior floor • contact shading/.test(material.name) && material.aoMap) {
        // Fixed interior fixtures do not render dynamic shadow maps. Reuse the
        // floor's baked contact sample to ground nearby furniture under their
        // direct light too; indirect AO and the bright tile map stay intact.
        material.onBeforeCompile = shader => {
          shader.fragmentShader = shader.fragmentShader.replace('#include <aomap_fragment>', `
            #include <aomap_fragment>
            #ifdef USE_AOMAP
              reflectedLight.directDiffuse *= mix(1.0, ambientOcclusion, 0.8);
            #endif
          `);
        };
        material.customProgramCacheKey = () => 'interior-floor-contact-direct-v1';
        material.needsUpdate = true;
      }
      let tint;
      if (/^Campus lawn$|Gaga Ball.*level green turf/i.test(material.name)) tint = [.90, 1.12, .90];
      else if (/^Tree canopy|^Planting /i.test(material.name)) tint = [.93, 1.10, .92];
      else if (/Warm red brick/i.test(material.name)) tint = [1.04, .98, .94];
      else if (/Play equipment.*deep teal/i.test(material.name)) tint = [.88, 1.08, 1.12];
      else if (/Play equipment.*warm yellow/i.test(material.name)) tint = [1.08, 1.02, .90];
      if (tint) material.color.multiply(new THREE.Color().setRGB(...tint));
    }
  });
  addAdorationChapelLighting(model);
}

function addAdorationChapelLighting(model) {
  // Add these after imported native lights are removed. Keeping the fixed
  // lights beneath the model also includes them in its on-demand capture clone.
  if (model.getObjectByName('Adoration chapel • fixed lighting')) return;
  const anchorName = '03B • Romanesque bell tower / Interior walls • warm ivory';
  let hasChapel = false;
  model.traverse(object => {
    // GLTFLoader sanitizes object names, retaining the original in userData.
    if (object.isMesh && (object.userData.name === anchorName || object.name === anchorName)) hasChapel = true;
  });
  if (!hasChapel) return;
  const group = new THREE.Group();
  group.name = 'Adoration chapel • fixed lighting';
  // Keep the lower beam beneath the pendant ring to avoid its oversized shadow;
  // the offset upper source lights the tall vault without intersecting its chain.
  const fixtures = [
    { name: 'Pendant illumination', position: [261.5, 104.5, 8.8], target: [261.5, 104.5, -3.7], intensity: 22, distance: 8 },
    { name: 'Concealed vault illumination', position: [262.5, 104.5, 45.5], intensity: 18, distance: 8 }
  ];
  for (const fixture of fixtures) {
    const light = fixture.target
      ? new THREE.SpotLight(0xffd8ad, fixture.intensity, fixture.distance, Math.PI * 0.42, .7, 2)
      : new THREE.PointLight(0xffd8ad, fixture.intensity, fixture.distance, 2);
    light.name = 'Adoration chapel • ' + fixture.name;
    const [x, y, z] = fixture.position;
    light.position.set(x * FEET, z * FEET, -y * FEET);
    if (fixture.target) {
      const [tx, ty, tz] = fixture.target;
      light.target.position.set(tx * FEET, tz * FEET, -ty * FEET);
      group.add(light.target);
    }
    light.castShadow = true;
    light.shadow.mapSize.set(512, 512);
    light.shadow.camera.near = .05;
    light.shadow.camera.far = fixture.distance;
    light.shadow.bias = -.002;
    light.shadow.normalBias = .035;
    light.shadow.radius = 2;
    group.add(light);
  }
  model.add(group);
}

export function normalizeMinutes(value) {
  const number = Number(value);
  return Number.isFinite(number) ? THREE.MathUtils.clamp(Math.round(number), 0, 1439) : 840;
}
export function formatTime(minutes) {
  const hour = Math.floor(minutes / 60), minute = minutes % 60;
  return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
}
export function lightingAtTime(value) {
  const minutes = normalizeMinutes(value);
  // Representative equinox sun path, oriented to the campus grid. This is an
  // exterior lighting study rather than a dated solar/shadow survey.
  const hourAngle = (minutes / 60 - 12) * Math.PI / 12;
  const east = -Math.sin(hourAngle);
  const north = -Math.sin(LATITUDE) * Math.cos(hourAngle);
  const up = Math.cos(LATITUDE) * Math.cos(hourAngle);
  const direction = new THREE.Vector3(
    east * Math.cos(GRID_BEARING) + north * Math.sin(GRID_BEARING),
    up,
    east * Math.sin(GRID_BEARING) - north * Math.cos(GRID_BEARING)
  ).normalize();
  const altitude = THREE.MathUtils.radToDeg(Math.asin(up));
  const daylight = smooth(-9, 12, altitude);
  const nightStrength = 1 - smooth(-5, 7, altitude);
  const sunIntensity = CAMPUS_DAYLIGHT.sunIntensity * smooth(0, 13, altitude);
  const moonIntensity = altitude <= 0 ? 0.38 * (1 - daylight) : 0;
  const phase = altitude < -9 ? 'Night' : altitude < 7 ? (minutes < 720 ? 'Dawn' : 'Dusk') : minutes < 660 ? 'Morning' : minutes < 840 ? 'Midday' : 'Afternoon';
  return { minutes, phase, altitude, daylight, nightStrength, sunIntensity, moonIntensity, sunDirection: direction.toArray() };
}

function ground(x, y) {
  let west = THREE.MathUtils.clamp((-x - 115) / 155, 0, 1);
  west = -14 * west * west * (3 - 2 * west);
  let south = THREE.MathUtils.clamp((125 - y) / 60, 0, 1);
  south = south * south * (3 - 2 * south);
  let east = THREE.MathUtils.clamp((x - 260) / 95, 0, 1);
  east = east * east * (3 - 2 * east);
  return west - 11 * Math.max(south * .75 * THREE.MathUtils.clamp((x - 155) / 110, 0, 1), east * .9);
}

export function createCampusLighting({ scene, model, keyLight, hemisphere, renderer, target, extent }) {
  const focus = target.clone();
  const distance = extent * 1.3;
  const nightColor = new THREE.Color('#101b34');
  const twilightColor = new THREE.Color('#716883');
  const dayColor = new THREE.Color('#cbdde8');
  const coolSky = new THREE.Color('#99b9e6');
  const daySky = new THREE.Color(CAMPUS_DAYLIGHT.skyColor);
  const warmSun = new THREE.Color('#ffae61');
  const highSun = new THREE.Color(CAMPUS_DAYLIGHT.sunColor);
  const glassMaterials = new Map();
  model.traverse(object => {
    if (!object.isMesh) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (/glazing/i.test(material.name) && material.emissive && !glassMaterials.has(material)) {
        glassMaterials.set(material, { color: material.emissive.clone(), intensity: material.emissiveIntensity });
      }
    }
  });

  // These are the seven actual lantern locations in the Blender model. The
  // dedicated glow material never modifies the shared limestone building trim.
  const lampLocations = [[38, 246], [157, 185], [159, 137], [169, 78], [169, 19], [169, -22], [-64, 274]];
  const lampGroup = new THREE.Group();
  lampGroup.name = 'Evening pathway lighting';
  const lampMaterial = new THREE.MeshStandardMaterial({ color: 0xffe4b4, emissive: 0xffc16b, emissiveIntensity: 0, roughness: .55 });
  const lanterns = new THREE.InstancedMesh(new THREE.BoxGeometry(1.12 * FEET, 1.52 * FEET, 1.12 * FEET), lampMaterial, lampLocations.length);
  lanterns.name = 'Warm lantern panes';
  const matrix = new THREE.Matrix4();
  const lamps = lampLocations.map(([x, y], index) => {
    const height = ground(x, y);
    matrix.makeTranslation(x * FEET, (height + 10.05) * FEET, -y * FEET);
    lanterns.setMatrixAt(index, matrix);
    const lamp = new THREE.PointLight(0xffcf8e, 0, 11, 2);
    lamp.position.set(x * FEET, (height + 10.1) * FEET, -y * FEET);
    // The single directional shadow map is reused for sunlight and moonlight.
    // Local lamps add warm illumination without seven extra cube shadow maps.
    lamp.castShadow = false;
    lampGroup.add(lamp);
    return lamp;
  });
  lampGroup.add(lanterns);
  scene.add(lampGroup);
  keyLight.target.position.copy(focus);
  Object.assign(keyLight.shadow.camera, { left: -extent * .72, right: extent * .72, top: extent * .72, bottom: -extent * .72, near: 1, far: extent * 3 });
  keyLight.shadow.camera.updateProjectionMatrix();
  let state, shadowRevision = 0;

  function setTime(value) {
    const next = lightingAtTime(value);
    const sunDirection = new THREE.Vector3(...next.sunDirection);
    const isSun = next.altitude > 0;
    const lightDirection = sunDirection.clone().multiplyScalar(isSun ? 1 : -1);
    keyLight.position.copy(focus).addScaledVector(lightDirection, distance);
    keyLight.intensity = isSun ? next.sunIntensity : next.moonIntensity;
    keyLight.color.copy(isSun ? warmSun.clone().lerp(highSun, smooth(1, 30, next.altitude)) : coolSky);

    const twilight = smooth(-11, -1, next.altitude) * (1 - smooth(0, 15, next.altitude));
    scene.background.copy(nightColor).lerp(dayColor, next.daylight).lerp(twilightColor, twilight * .45);
    renderer.setClearColor(scene.background);
    hemisphere.color.copy(coolSky).lerp(daySky, next.daylight);
    hemisphere.groundColor.set(0x48545b).lerp(new THREE.Color(CAMPUS_DAYLIGHT.groundColor), next.daylight);
    // A restrained sky fill keeps shaded recesses and sunlit surfaces distinct.
    hemisphere.intensity = mix(.16, CAMPUS_DAYLIGHT.hemisphereIntensity, next.daylight);
    scene.environmentIntensity = mix(.035, CAMPUS_DAYLIGHT.environmentIntensity, next.daylight);
    renderer.toneMappingExposure = mix(.95, CAMPUS_DAYLIGHT.exposure, next.daylight);
    for (const [material, original] of glassMaterials) {
      material.emissive.copy(original.color).lerp(new THREE.Color(0xffc680), next.nightStrength);
      material.emissiveIntensity = mix(original.intensity, .72, next.nightStrength);
    }
    for (const lamp of lamps) lamp.intensity = 28 * next.nightStrength;
    lanterns.visible = next.nightStrength > .005;
    lampMaterial.emissiveIntensity = 2.2 * next.nightStrength;
    if (!state || state.minutes !== next.minutes) {
      renderer.shadowMap.needsUpdate = true;
      keyLight.shadow.needsUpdate = true;
      shadowRevision++;
    }
    state = {
      ...next,
      sunPosition: focus.clone().addScaledVector(sunDirection, distance).toArray(),
      shadowDirection: lightDirection.clone().negate().toArray(),
      shadowLight: isSun ? 'sun' : 'moon', shadowRevision,
      lampCount: lamps.length, lampsOn: next.nightStrength > .05
    };
    document.documentElement.dataset.sceneLighting = next.daylight < .25 ? 'night' : 'day';
    return state;
  }
  return { setTime, get state() { return structuredClone(state); } };
}
