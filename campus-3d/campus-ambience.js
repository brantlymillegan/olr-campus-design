// Default-on 3D ambience. Audio starts only when browser playback policy allows it.
// Recording licenses and attribution: ./audio/ASSET-CREDITS.txt.
const FEET = .3048;
const PLAYGROUND = Object.freeze({ x: 100.962893 * FEET, y: 1.2, z: -48.753048 * FEET });
// Clear interior from the tower model, including its 24-segment barrel vault.
// Site coordinates are feet; renderer coordinates are metres with north = -Z.
const CHAPEL_VAULT = Array.from({ length: 25 }, (_, i) => [
  104.5 - 8.1 * Math.cos(i * Math.PI / 24), 48.7 + 5.6 * Math.sin(i * Math.PI / 24)
]);
const CHANT_URL = new URL('./audio/chapel-gregorian-chant-4c1e2723cd272a32.mp3', import.meta.url).href;
const ASSETS = Object.freeze({
  birds: new URL('./audio/birds-93f2bd591900db6a.mp3', import.meta.url).href,
  playground: new URL('./audio/playground-1f312e3f6a13b00b.mp3', import.meta.url).href
});
const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };

// Zones use the actual clear school outlines and floor/ceiling elevations.
// The optional output object lets the live audio update avoid allocating.
export function schoolPresence(position, phase = 'new', config, out = {}) {
  out.school = 0; out.office = 0; out.buildingId = null; out.floor = null; out.zoneId = null;
  if (!config || phase === 'current' || !position || !Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.z)) return out;
  const x = position.x / FEET, y = -position.z / FEET, height = position.y / FEET;
  let officeZone = null;
  for (const zone of config.zones) {
    if (phase === 'phase1' && zone.buildingId === 'building-2') continue;
    if (height < zone.floor_ft - 1e-8 || height >= zone.ceiling_ft - 1e-8) continue;
    let inside = false, distanceSquared = Infinity;
    const polygon = zone.polygon_ft;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const a = polygon[j], b = polygon[i], dx = b[0] - a[0], dy = b[1] - a[1];
      if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
      const lengthSquared = dx * dx + dy * dy;
      const t = lengthSquared ? clamp(((x - a[0]) * dx + (y - a[1]) * dy) / lengthSquared) : 0;
      distanceSquared = Math.min(distanceSquared, (x - a[0] - t * dx) ** 2 + (y - a[1] - t * dy) ** 2);
    }
    if (!inside || distanceSquared < 1e-12) continue;
    const presence = smooth(0, 1.5, Math.sqrt(distanceSquared)) * smooth(0, .5, zone.ceiling_ft - height);
    if (zone.kind === 'office') {
      if (presence > out.office) { out.office = presence; officeZone = zone; }
    } else if (presence > out.school) {
      out.school = presence; out.buildingId = zone.buildingId; out.floor = zone.floor; out.zoneId = zone.id;
    }
  }
  // An office overlay must be contained by an active occupied school volume.
  if (!out.school) { out.office = 0; return out; }
  out.office = Math.min(out.office, out.school);
  if (officeZone && out.office > 0) out.zoneId = officeZone.id;
  out.school *= 1 - out.office;
  return out;
}

function prepareInteriorAudio(config) {
  if (!config || config.version !== 1 || !Array.isArray(config.zones) || !Array.isArray(config.tracks) || config.zones.length > 128 || config.tracks.length > 3) throw new Error('Invalid school audio configuration.');
  const zoneIds = new Set(), trackIds = new Set();
  const zones = config.zones.map(zone => {
    if (!zone || typeof zone.id !== 'string' || zoneIds.has(zone.id) || !['building-1', 'building-2'].includes(zone.buildingId) || ![1, 2].includes(zone.floor) || !['school', 'office'].includes(zone.kind) || !Number.isFinite(zone.floor_ft) || !Number.isFinite(zone.ceiling_ft) || zone.ceiling_ft <= zone.floor_ft || zone.ceiling_ft - zone.floor_ft > 30 || Math.abs(zone.floor_ft) > 100 || !Array.isArray(zone.polygon_ft) || zone.polygon_ft.length < 3 || zone.polygon_ft.length > 128 || zone.polygon_ft.some(p => !Array.isArray(p) || p.length !== 2 || !p.every(v => Number.isFinite(v) && Math.abs(v) < 2000))) throw new Error('Invalid school audio zone.');
    zoneIds.add(zone.id);
    return { id: zone.id, buildingId: zone.buildingId, floor: zone.floor, kind: zone.kind, floor_ft: zone.floor_ft, ceiling_ft: zone.ceiling_ft, polygon_ft: zone.polygon_ft.map(p => p.slice()) };
  });
  const tracks = config.tracks.map(track => {
    if (!track || typeof track.id !== 'string' || !/^[a-z0-9-]+$/.test(track.id) || trackIds.has(track.id) || !['school', 'office'].includes(track.kind) || typeof track.url !== 'string' || !/^\.\/audio\/[a-z0-9.-]+\.(mp3|ogg|wav)$/.test(track.url) || !/^[a-f0-9]{64}$/.test(track.sha256) || !Number.isInteger(track.bytes) || track.bytes < 1 || track.bytes > 4 * 1024 * 1024) throw new Error('Invalid school audio recording.');
    trackIds.add(track.id);
    return { id: track.id, kind: track.kind, url: new URL(track.url, import.meta.url).href, sha256: track.sha256, bytes: track.bytes, level: Number.isFinite(track.gain) ? clamp(track.gain) : .48, gain: null, target: 0, source: null, buffer: null, loading: null, error: null, offset: 0, startedAt: 0 };
  });
  return { zones, tracks };
}

export function chapelPresence(position) {
  if (!position || !['x', 'y', 'z'].every(key => Number.isFinite(position[key]))) return 0;
  const x = position.x / FEET, y = -position.z / FEET, height = position.y / FEET;
  if (x <= 253.4 || x >= 269.6 || y <= 96.4 || y >= 112.6 || height < -3.7) return 0;
  let ceiling = 48.7;
  for (let i = 1; i < CHAPEL_VAULT.length; i++) {
    const [a, low] = CHAPEL_VAULT[i - 1], [b, high] = CHAPEL_VAULT[i];
    if (y <= b) { ceiling = low + (high - low) * (y - a) / (b - a); break; }
  }
  if (height >= ceiling) return 0;
  // Fade within the west entrance, reaching silence at the threshold. Also
  // taper immediately under the vault for visitors flying out through it.
  return smooth(0, 2, x - 253.4) * smooth(0, 1, ceiling - height);
}

export function createCampusAmbience({ camera } = {}) {
  let context, master, lowpass, birdGain, childrenGain, childPan, windGain, windFilter;
  let rainGain, rainFilter, thunderGain, thunderFilter, rainSource = null;
  let bellGain, bellFilter, bellPan, bellLimiter, bellStrikes = 0, lastBellStrike = -Infinity;
  let bellPosition = { x: 261.5 * FEET, y: 63.6 * FEET, z: -104.5 * FEET };
  let bellMix = { gain: 0, distanceFeet: 0, pan: 0, cutoff: 7800 };
  let weatherEnabled = false;
  let chantGain, chantSource = null, chantLoading = null, chantError = null;
  let chantOffset = 0, chantStartedAt = 0, chantTarget = 0, chantPresence = 0;
  let interiorAudio = null;
  const indoorPresence = { school: 0, office: 0, buildingId: null, floor: null, zoneId: null };
  let enabled = true, volume = .25, unlocked = false, disposed = false, ready = false;
  let running = false, loading = null, resumePending = null, timer = null, error = null;
  let nextBird = 0, nextChildren = 0, lastMix = -1, elapsed = 0;
  let view = { active: false, minutes: 840, interior: false, position: null, phase: 'new' };
  let targets = { master: 0, birds: 0, children: 0, wind: 0, rain: 0, thunder: 0, cutoff: 16000, pan: 0 };
  const sources = new Set(), buffers = {}, abort = new AbortController();
  const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
  const wanted = () => !disposed && unlocked && enabled && volume > 0 && view.active && visible();
  const param = (p, value, seconds = .5) => {
    p.cancelScheduledValues(context.currentTime);
    p.setTargetAtTime(value, context.currentTime, seconds);
  };

  function graph() {
    if (context || disposed) return;
    const Audio = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Audio) { error = 'Audio is not supported in this browser.'; return; }
    context = new Audio({ latencyHint: 'playback' });
    master = context.createGain(); master.gain.value = 0;
    lowpass = context.createBiquadFilter(); lowpass.type = 'lowpass'; lowpass.frequency.value = 16000;
    lowpass.Q.value = .55; lowpass.connect(master); master.connect(context.destination);
    birdGain = context.createGain(); birdGain.connect(lowpass); birdGain.gain.value = 0;
    childrenGain = context.createGain(); childrenGain.gain.value = 0;
    childPan = context.createStereoPanner(); childrenGain.connect(childPan); childPan.connect(lowpass);
    windGain = context.createGain(); windGain.gain.value = 0;
    windFilter = context.createBiquadFilter(); windFilter.type = 'lowpass'; windFilter.frequency.value = 650;
    windFilter.Q.value = .35; windFilter.connect(windGain); windGain.connect(lowpass);
    // A soft, low-frequency air bed; generated once and smoothly joined at its loop.
    const wind = context.createBuffer(1, context.sampleRate * 8, context.sampleRate);
    const data = wind.getChannelData(0); let brown = 0;
    for (let i = 0; i < data.length; i++) { brown = (brown + (Math.random() * 2 - 1) * .025) / 1.025; data[i] = brown * 3; }
    const edge = Math.round(context.sampleRate * .3);
    for (let i = 0; i < edge; i++) data[data.length - edge + i] = data[data.length - edge + i] * (1 - i / (edge - 1)) + data[0] * (i / (edge - 1));
    buffers.wind = wind;
  }

  function weatherGraph() {
    if (rainGain || !context || disposed) return;
    rainGain = context.createGain(); rainGain.gain.value = 0; rainGain.connect(lowpass);
    rainFilter = context.createBiquadFilter(); rainFilter.type = 'lowpass';
    rainFilter.frequency.value = 6200; rainFilter.Q.value = .35; rainFilter.connect(rainGain);
    thunderGain = context.createGain(); thunderGain.gain.value = 0; thunderGain.connect(lowpass);
    thunderFilter = context.createBiquadFilter(); thunderFilter.type = 'lowpass';
    thunderFilter.frequency.value = 340; thunderFilter.Q.value = .45; thunderFilter.connect(thunderGain);
    // Generated once per context; no sound files or per-frame audio allocation.
    const rain = context.createBuffer(2, context.sampleRate * 6, context.sampleRate);
    for (let channel = 0; channel < 2; channel++) {
      const data = rain.getChannelData(channel); let soft = 0;
      for (let i = 0; i < data.length; i++) {
        const white = Math.random() * 2 - 1;
        soft = .92 * soft + .08 * white;
        data[i] = white * .18 + soft * .44;
      }
      const edge = Math.round(context.sampleRate * .25);
      for (let i = 0; i < edge; i++) {
        const mix = i / (edge - 1);
        data[data.length - edge + i] = data[data.length - edge + i] * (1 - mix) + data[0] * mix;
      }
    }
    buffers.rain = rain;
    const thunder = context.createBuffer(1, context.sampleRate * 8, context.sampleRate);
    const data = thunder.getChannelData(0); let low = 0, deep = 0, peak = 0;
    for (let i = 0; i < data.length; i++) {
      const white = Math.random() * 2 - 1, t = i / context.sampleRate;
      low = .975 * low + .025 * white; deep = .997 * deep + .003 * white;
      const rolling = .72 + .18 * Math.sin(t * 3.1) + .10 * Math.sin(t * 7.3);
      const envelope = (1 - Math.exp(-t * 4)) * Math.exp(-t * .43) * Math.min(1, (8 - t) / 1.5);
      data[i] = (low * .7 + deep * 2.2) * rolling * envelope;
      peak = Math.max(peak, Math.abs(data[i]));
    }
    if (peak > 0) for (let i = 0; i < data.length; i++) data[i] *= .82 / peak;
    buffers.thunder = thunder;
  }

  function bellGraph() {
    if (bellGain || !context || disposed) return;
    // The tower bell shares the context and sound controls. Its bus bypasses
    // outdoor ambience muffling: a bell overhead must remain audible in chapel.
    bellGain = context.createGain(); bellGain.gain.value = 0;
    bellFilter = context.createBiquadFilter(); bellFilter.type = 'lowpass';
    bellFilter.frequency.value = 7800; bellFilter.Q.value = .45;
    bellPan = context.createStereoPanner();
    bellLimiter = context.createDynamicsCompressor();
    bellLimiter.threshold.value = -8; bellLimiter.knee.value = 8;
    bellLimiter.ratio.value = 3; bellLimiter.attack.value = .008; bellLimiter.release.value = .25;
    bellFilter.connect(bellPan); bellPan.connect(bellLimiter);
    bellLimiter.connect(bellGain); bellGain.connect(context.destination);
    // Cast bronze modes: hum, prime, minor-third tierce, quint and nominal,
    // followed by short-lived inharmonic overtones. Close pairs create beating.
    // Recurrence avoids a costly sine call per sample. This buffer is made once,
    // on the first clapper strike, after the gesture has already resumed audio.
    const seconds = 12, rate = context.sampleRate;
    const buffer = context.createBuffer(1, Math.round(rate * seconds), rate);
    const data = buffer.getChannelData(0);
    const modes = [[.5,.24,6.8],[1,.27,5.8],[1.194,.21,4.4],[1.506,.12,3.8],
      [2,.37,3.5],[2.514,.10,2.6],[2.99,.11,2.1],[3.54,.075,1.7],
      [4.07,.06,1.25],[4.82,.04,.9],[5.62,.03,.65],[6.29,.025,.45]];
    for (const [ratio, amplitude, decay] of modes) {
      for (const detune of [-.0008, .0008]) {
        const step = 2 * Math.PI * 220 * ratio * (1 + detune) / rate;
        const cs = Math.cos(step), sn = Math.sin(step), loss = Math.exp(-1 / (rate * decay));
        let sine = 0, cosine = 1, level = amplitude * .5;
        for (let i = 0; i < data.length; i++) {
          data[i] += sine * level;
          const next = sine * cs + cosine * sn;
          cosine = cosine * cs - sine * sn; sine = next; level *= loss;
        }
      }
    }
    let peak = 0, seed = 1987, soft = 0;
    for (let i = 0; i < data.length; i++) {
      const t = i / rate;
      // A brief felt/metal contact transient, not a cartoon chime or a click.
      seed = (1664525 * seed + 1013904223) >>> 0;
      soft = .76 * soft + .24 * (seed / 2147483648 - 1);
      const attack = Math.min(1, t / .003), tail = Math.min(1, (seconds - t) / 1.6);
      data[i] = (data[i] + soft * .13 * Math.exp(-t * 35)) * attack * tail;
      peak = Math.max(peak, Math.abs(data[i]));
    }
    if (peak) for (let i = 0; i < data.length; i++) data[i] *= .82 / peak;
    buffers.bell = buffer;
  }

  function mixBell() {
    if (!bellGain) return;
    const position = view.position || camera?.position || bellPosition;
    const dx = bellPosition.x - position.x, dy = bellPosition.y - (position.y || 0), dz = bellPosition.z - position.z;
    const distance = Math.hypot(dx, dy, dz), indoors = typeof view.interior === 'number' ? clamp(view.interior) : view.interior ? 1 : 0;
    const matrix = camera?.matrixWorld?.elements;
    const pan = matrix ? clamp((dx * matrix[0] + dz * matrix[2]) / Math.max(1, Math.hypot(dx, dz)), -.9, .9) : 0;
    const rolloff = (1 - smooth(180, 430, distance)) / Math.sqrt(1 + (distance / 28) ** 2);
    bellMix = { gain: wanted() ? volume * rolloff * (1 - indoors * .3) : 0,
      distanceFeet: distance / FEET, pan, cutoff: Math.max(900, (7800 - indoors * 4800) / (1 + distance / 240)) };
    param(bellGain.gain, bellMix.gain, .18); param(bellPan.pan, pan, .12);
    param(bellFilter.frequency, bellMix.cutoff, .2);
  }

  async function loadChant() {
    if (buffers.chant || chantLoading || !context || disposed) return chantLoading;
    chantLoading = (async () => {
      const response = await fetch(CHANT_URL, { signal: abort.signal, credentials: 'same-origin' });
      if (!response.ok) throw new Error(`Chapel chant HTTP ${response.status}`);
      const bytes = await response.arrayBuffer();
      if (disposed) return;
      const buffer = await context.decodeAudioData(bytes);
      if (!disposed) { buffers.chant = buffer; chantError = null; sync(); }
    })().catch(e => {
      if (!disposed && e.name !== 'AbortError') chantError = 'Chapel chant could not load. Toggle sound to retry.';
    }).finally(() => { chantLoading = null; });
    return chantLoading;
  }

  function stopChant() {
    if (chantGain) {
      chantGain.gain.cancelScheduledValues(context.currentTime);
      chantGain.gain.setValueAtTime(0, context.currentTime);
    }
    chantTarget = 0;
    if (chantSource) {
      chantOffset = (chantOffset + Math.max(0, context.currentTime - chantStartedAt)) % buffers.chant.duration;
      stopSource(chantSource);
    }
  }

  function mixChant() {
    chantPresence = chapelPresence(view.position || camera?.position);
    if (!wanted() || !chantPresence) { stopChant(); return; }
    // Independent loading/bus: neither failed outdoor recordings nor their
    // interior low-pass filter may silence or muffle the chapel recording.
    if (!buffers.chant) { if (!chantLoading && !chantError) void loadChant(); return; }
    if (context.state !== 'running') return;
    if (!chantGain) {
      chantGain = context.createGain(); chantGain.gain.value = 0;
      chantGain.connect(context.destination);
    }
    if (!chantSource) {
      chantStartedAt = context.currentTime;
      chantSource = source(buffers.chant, chantGain, { loop: true, offset: chantOffset, fade: .7, kind: 'chant' });
    }
    const target = volume * .8 * chantPresence;
    if (Math.abs(target - chantTarget) > .00001) { chantTarget = target; param(chantGain.gain, target, .1); }
  }

  async function loadInteriorTrack(track) {
    if (track.buffer || track.loading || track.error || !context || disposed) return track.loading;
    track.loading = (async () => {
      const response = await fetch(track.url, { signal: abort.signal, credentials: 'same-origin' });
      if (!response.ok) throw new Error(`Interior sound HTTP ${response.status}`);
      const bytes = await response.arrayBuffer();
      if (disposed) return;
      if (bytes.byteLength !== track.bytes) throw new Error('Interior sound size mismatch.');
      const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
      const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      if (hash !== track.sha256) throw new Error('Interior sound identity mismatch.');
      if (disposed) return;
      const buffer = await context.decodeAudioData(bytes);
      if (!disposed && interiorAudio?.tracks.includes(track)) { track.buffer = buffer; track.error = null; sync(); }
    })().catch(e => {
      if (!disposed && e.name !== 'AbortError') track.error = `${track.kind === 'office' ? 'Office' : 'School'} sound could not load. Toggle sound to retry.`;
    }).finally(() => { track.loading = null; });
    return track.loading;
  }

  function stopInteriorTrack(track) {
    if (!track.source && track.target === 0) return;
    if (track.gain) {
      track.gain.gain.cancelScheduledValues(context.currentTime);
      track.gain.gain.setValueAtTime(0, context.currentTime);
    }
    track.target = 0;
    if (track.source) {
      track.offset = (track.offset + Math.max(0, context.currentTime - track.startedAt)) % track.buffer.duration;
      stopSource(track.source);
    }
  }

  function mixInterior() {
    schoolPresence(view.position || camera?.position, view.phase, interiorAudio, indoorPresence);
    if (!interiorAudio) return;
    for (const track of interiorAudio.tracks) {
      const presence = indoorPresence[track.kind];
      if (!wanted() || presence <= 0) { stopInteriorTrack(track); continue; }
      // This independent bus shares the unlocked context and user volume, but
      // bypasses the outdoor low-pass/master that deliberately muffles indoors.
      if (!track.buffer) { if (!track.loading && !track.error) void loadInteriorTrack(track); continue; }
      if (context.state !== 'running') continue;
      if (!track.gain) { track.gain = context.createGain(); track.gain.gain.value = 0; track.gain.connect(context.destination); }
      if (!track.source) {
        track.startedAt = context.currentTime;
        track.source = source(track.buffer, track.gain, { loop: true, offset: track.offset, fade: .65, kind: 'interior' });
        track.source.interiorTrack = track;
      }
      const target = volume * track.level * presence;
      if (Math.abs(target - track.target) > .00001) { track.target = target; param(track.gain.gain, target, .12); }
    }
  }

  async function load() {
    if (ready || loading || !context || disposed) return loading;
    loading = Promise.all(Object.entries(ASSETS).map(async ([id, url]) => {
      if (buffers[id]) return;
      const response = await fetch(url, { signal: abort.signal, credentials: 'same-origin' });
      if (!response.ok) throw new Error(`Ambient sound could not load (${response.status}).`);
      const bytes = await response.arrayBuffer();
      if (disposed) return;
      buffers[id] = await context.decodeAudioData(bytes);
    })).then(() => { if (!disposed) { ready = true; error = null; sync(); } })
      .catch(e => { if (!disposed && e.name !== 'AbortError') error = 'Ambient sound could not load. Toggle sound to retry.'; })
      .finally(() => { loading = null; });
    return loading;
  }

  function source(buffer, destination, { duration, offset = 0, pan, loop = false, fade = 1, delay = 0, level = 1, kind = 'ambient' } = {}) {
    const node = context.createBufferSource(); node.buffer = buffer; node.loop = loop;
    const gain = context.createGain(); node.connect(gain);
    let panner;
    if (pan != null) { panner = context.createStereoPanner(); panner.pan.value = pan; gain.connect(panner); panner.connect(destination); }
    else gain.connect(destination);
    const now = context.currentTime + delay;
    gain.gain.setValueAtTime(0, context.currentTime); gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(level, now + fade);
    if (!loop) {
      gain.gain.setValueAtTime(level, now + Math.max(fade, duration - fade));
      gain.gain.linearRampToValueAtTime(0, now + duration);
    }
    const record = { node, gain, panner, kind, stopping: false };
    sources.add(record);
    node.onended = () => cleanup(record);
    node.start(now, offset, loop ? undefined : duration);
    return record;
  }

  function cleanup(record) {
    sources.delete(record); record.node.onended = null;
    record.node.disconnect(); record.gain.disconnect(); record.panner?.disconnect();
    if (rainSource === record) rainSource = null;
    if (chantSource === record) chantSource = null;
    if (record.interiorTrack?.source === record) record.interiorTrack.source = null;
  }

  function stopSource(record) {
    try { record.node.stop(); } catch {}
    cleanup(record);
  }

  function weatherSource() {
    if (!context || !running) return;
    if (weatherEnabled) {
      weatherGraph();
      if (rainSource?.stopping) stopSource(rainSource);
      if (!rainSource) rainSource = source(buffers.rain, rainFilter, { loop: true, fade: 1.2, kind: 'rain' });
    } else if (rainSource && !rainSource.stopping) {
      rainSource.stopping = true;
      rainSource.node.stop(context.currentTime + 1.8);
    }
  }

  function stop() {
    if (!context) return;
    if (timer != null) { clearInterval(timer); timer = null; }
    running = false;
    stopChant();
    if (interiorAudio) for (const track of interiorAudio.tracks) stopInteriorTrack(track);
    master.gain.cancelScheduledValues(context.currentTime);
    master.gain.setValueAtTime(0, context.currentTime);
    if (bellGain) { bellGain.gain.cancelScheduledValues(context.currentTime); bellGain.gain.setValueAtTime(0, context.currentTime); }
    bellMix.gain = 0;
    for (const record of [...sources]) {
      stopSource(record);
    }
    sources.clear(); targets.master = 0;
    if (context.state === 'running') context.suspend().catch(() => {});
  }

  function mix() {
    if (!context) return;
    const minutes = ((Number(view.minutes) || 0) % 1440 + 1440) % 1440;
    const day = smooth(390, 480, minutes) * (1 - smooth(1080, 1170, minutes));
    const birds = smooth(300, 390, minutes) * (1 - smooth(1140, 1230, minutes));
    const indoors = typeof view.interior === 'number' ? clamp(view.interior) : view.interior ? 1 : 0;
    const position = view.position || camera?.position || PLAYGROUND;
    const dx = PLAYGROUND.x - position.x, dz = PLAYGROUND.z - position.z;
    const distance = Math.hypot(dx, dz, (position.y || 0) - PLAYGROUND.y);
    const nearby = (1 - smooth(18, 85, distance)) / (1 + Math.pow(distance / 35, 2));
    const matrix = camera?.matrixWorld?.elements;
    const pan = matrix && distance > .01 ? clamp((dx * matrix[0] + dz * matrix[2]) / Math.max(1, Math.hypot(dx, dz)), -.8, .8) : 0;
    targets = {
      master: wanted() ? volume * (1 - indoors * .94) : 0,
      birds: weatherEnabled ? 0 : .75 * birds, children: weatherEnabled ? 0 : .55 * day * nearby,
      wind: .075 * (1 + .12 * Math.sin(elapsed * .19) + .07 * Math.sin(elapsed * .071)),
      rain: weatherEnabled ? .62 : 0, thunder: weatherEnabled ? .65 : 0,
      cutoff: 16000 * (1 - indoors) + 850 * indoors, pan
    };
    param(master.gain, targets.master, 1.1); param(birdGain.gain, targets.birds, 1.5);
    param(childrenGain.gain, targets.children, 1.2); param(windGain.gain, targets.wind, 2);
    param(lowpass.frequency, targets.cutoff, .6); param(childPan.pan, pan, .3);
    if (rainGain) { param(rainGain.gain, targets.rain, .3); param(thunderGain.gain, targets.thunder, .2); }
    mixBell();
    mixChant();
    mixInterior();
  }

  function schedule() {
    if (!wanted() || !running) { stop(); return; }
    mix();
    const now = context.currentTime;
    if (ready && now >= nextBird) {
      if (targets.birds > .001) {
        const duration = Math.min(buffers.birds.duration, 6 + Math.random() * 4);
        source(buffers.birds, birdGain, { duration, offset: Math.random() * Math.max(0, buffers.birds.duration - duration), pan: Math.random() * 1.4 - .7, fade: 1.2 });
        nextBird = now + duration + 5 + Math.random() * 9;
      } else nextBird = now + 2;
    }
    if (ready && now >= nextChildren) {
      if (targets.children > .0005) {
        const duration = buffers.playground.duration;
        source(buffers.playground, childrenGain, { duration, fade: 3 });
        nextChildren = now + Math.max(1, duration - 3);
      } else nextChildren = now + 1;
    }
  }

  function start() {
    if (!wanted() || (!ready && !weatherEnabled) || running || context.state !== 'running') return;
    running = true; nextBird = context.currentTime + .7; nextChildren = context.currentTime;
    source(buffers.wind, windFilter, { loop: true, fade: 2 });
    weatherSource();
    schedule(); timer = setInterval(schedule, 250);
  }

  function sync() {
    if (!wanted()) { stop(); return; }
    if (!context) return;
    mixChant();
    mixInterior();
    // An unlock can finish before the asynchronous 3D activation message.
    // Complete that pending intent when the view becomes active, once only.
    if (!ready && !weatherEnabled && !loading && !error) void load();
    if (context.state === 'running') { start(); return; }
    if (!resumePending) {
      resumePending = context.resume().then(() => { if (wanted()) { start(); mixChant(); mixInterior(); } else stop(); })
        .catch(() => { error = 'Tap the scene to enable sound.'; })
        .finally(() => { resumePending = null; });
    }
  }

  const visibility = () => sync();
  globalThis.document?.addEventListener('visibilitychange', visibility);
  return {
    async unlock() {
      if (disposed || !enabled || volume <= 0) return false;
      error = null;
      chantError = null;
      if (interiorAudio) for (const track of interiorAudio.tracks) track.error = null;
      graph(); if (!context) return false;
      unlocked = true;
      // Invoke resume immediately in the user gesture, before awaiting downloads.
      try { await context.resume(); } catch { error = 'Tap the scene to enable sound.'; return false; }
      if (!wanted()) { stop(); return false; }
      mixInterior();
      // Another concurrent resume may have already finished a failed load.
      // Keep that error until a later, explicit retry instead of fetching twice.
      if (error) return false;
      if (weatherEnabled) { sync(); return wanted() && context.state === 'running'; }
      await load(); sync(); return (ready || weatherEnabled) && wanted();
    },
    setEnabled(value) {
      enabled = Boolean(value);
      if (enabled) chantError = null;
      if (enabled && interiorAudio) for (const track of interiorAudio.tracks) track.error = null;
      sync();
    },
    configureInteriorAudio(config) {
      if (disposed) return false;
      const prepared = prepareInteriorAudio(config);
      if (interiorAudio) for (const track of interiorAudio.tracks) { stopInteriorTrack(track); track.gain?.disconnect(); }
      interiorAudio = prepared; sync(); return true;
    },
    setVolume(value) { volume = clamp(Number.isFinite(Number(value)) ? Number(value) : .25); sync(); if (running) mix(); else mixBell(); },
    setBellPosition(position) {
      if (position && ['x','y','z'].every(key => Number.isFinite(position[key]))) bellPosition = { x: position.x, y: position.y, z: position.z };
      mixBell();
    },
    strikeBell(strength = 1, { position } = {}) {
      // No downloads and no second AudioContext. The selecting gesture must
      // already call unlock(); a slow or failed bird recording is irrelevant.
      if (!wanted() || context?.state !== 'running') return false;
      const level = clamp(Number.isFinite(Number(strength)) ? Number(strength) : 1);
      if (level <= 0 || context.currentTime - lastBellStrike < .12) return false;
      if (position && ['x','y','z'].every(key => Number.isFinite(position[key]))) bellPosition = { x: position.x, y: position.y, z: position.z };
      bellGraph(); mixBell();
      const voices = [...sources].filter(record => record.kind === 'bell');
      if (voices.length >= 6) {
        // Keep six ringing tails and at most one brief, smoothly retiring tail.
        for (const record of [...sources]) if (record.kind === 'bell-retiring') stopSource(record);
        const oldest = voices[0]; oldest.kind = 'bell-retiring';
        param(oldest.gain.gain, 0, .02); oldest.node.stop(context.currentTime + .08);
      }
      source(buffers.bell, bellFilter, { duration: buffers.bell.duration, fade: .003, level: .8 * Math.sqrt(level), kind: 'bell' });
      lastBellStrike = context.currentTime; bellStrikes++;
      return true;
    },
    setWeather(value) {
      if (disposed) return;
      weatherEnabled = Boolean(value);
      if (weatherEnabled && context) weatherGraph();
      if (!weatherEnabled) for (const record of [...sources]) if (record.kind === 'thunder') stopSource(record);
      weatherSource(); if (running) mix(); sync();
    },
    thunder({ delaySeconds = 0, strength = .55, pan = 0 } = {}) {
      if (!weatherEnabled || !wanted() || !running || context?.state !== 'running') return false;
      if ([...sources].filter(record => record.kind === 'thunder').length >= 2) return false;
      weatherGraph();
      const number = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
      source(buffers.thunder, thunderFilter, { duration: buffers.thunder.duration, fade: .16,
        delay: clamp(number(delaySeconds, 0), 0, 10), level: clamp(number(strength, .55)),
        pan: clamp(number(pan, 0), -.8, .8), kind: 'thunder' });
      return true;
    },
    update(time, state = {}) {
      elapsed = Number.isFinite(time) ? time : elapsed;
      Object.assign(view, state); sync();
      if ((running || bellGain) && context.currentTime - lastMix >= .12) { lastMix = context.currentTime; if (running) mix(); else mixBell(); }
    },
    get state() {
      const indoorTracks = interiorAudio?.tracks.filter(track => indoorPresence[track.kind] > 0) || [];
      const indoorPlaying = indoorTracks.some(track => track.source) && wanted() && context?.state === 'running';
      const indoorReady = indoorTracks.length > 0 && indoorTracks.every(track => track.buffer);
      return {
      enabled, volume, unlocked, ready: ready || indoorReady || Boolean(weatherEnabled && buffers.rain), loading: indoorTracks.length ? indoorTracks.some(track => track.loading) : Boolean(loading), active: Boolean(view.active),
      playing: (running || indoorPlaying) && context?.state === 'running', contextState: context?.state || 'locked',
      sourceCount: sources.size, error: chantPresence > 0 && chantError ? chantError : indoorTracks.length ? indoorTracks.find(track => track.error)?.error || null : weatherEnabled && running ? null : error, interior: view.interior,
      weatherEnabled, rainPlaying: Boolean(rainSource && !rainSource.stopping && running && context?.state === 'running'),
      thunderSourceCount: [...sources].filter(record => record.kind === 'thunder').length,
      bell: { strikeCount: bellStrikes, activeVoices: [...sources].filter(record => record.kind.startsWith('bell')).length,
        enabled: enabled && volume > 0, ready: Boolean(buffers.bell), position: { ...bellPosition }, ...bellMix },
      chant: { inside: chantPresence > 0, presence: chantPresence, ready: Boolean(buffers.chant),
        loading: Boolean(chantLoading), playing: Boolean(chantSource && wanted() && context?.state === 'running'),
        gain: chantTarget, error: chantError, sourceCount: [...sources].filter(record => record.kind === 'chant').length,
        url: CHANT_URL },
      interiorAudio: { configured: Boolean(interiorAudio), ...indoorPresence, phase: view.phase,
        sourceCount: interiorAudio?.tracks.reduce((sum, track) => sum + Number(Boolean(track.source)), 0) || 0,
        tracks: interiorAudio?.tracks.map(track => ({ id: track.id, kind: track.kind, ready: Boolean(track.buffer),
          loading: Boolean(track.loading), error: track.error, gain: track.target,
          playing: Boolean(track.source && wanted() && context?.state === 'running'), url: track.url })) || [] },
      gains: { ...targets }, assets: [...Object.keys(ASSETS), 'chant', ...(interiorAudio?.tracks.map(track => track.id) || [])]
    }; },
    dispose() {
      if (disposed) return;
      disposed = true; abort.abort(); stop();
      globalThis.document?.removeEventListener('visibilitychange', visibility);
      if (context && context.state !== 'closed') context.close().catch(() => {});
      for (const id of Object.keys(buffers)) delete buffers[id];
      if (interiorAudio) for (const track of interiorAudio.tracks) { track.buffer = null; track.gain?.disconnect(); }
    }
  };
}
