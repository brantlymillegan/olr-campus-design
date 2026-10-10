// Optional ambient sound. No requests, audio graph or sound before unlock().
// Recordings and CC0 credits: ./audio/ASSET-CREDITS.txt.
const FEET = .3048;
const PLAYGROUND = Object.freeze({ x: 100.962893 * FEET, y: 1.2, z: -48.753048 * FEET });
const ASSETS = Object.freeze({
  birds: new URL('./audio/birds-93f2bd591900db6a.mp3', import.meta.url).href,
  playground: new URL('./audio/playground-1f312e3f6a13b00b.mp3', import.meta.url).href
});
const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };

export function createCampusAmbience({ camera } = {}) {
  let context, master, lowpass, birdGain, childrenGain, childPan, windGain, windFilter;
  let enabled = true, volume = .25, unlocked = false, disposed = false, ready = false;
  let running = false, loading = null, resumePending = null, timer = null, error = null;
  let nextBird = 0, nextChildren = 0, lastMix = -1, elapsed = 0;
  let view = { active: false, minutes: 840, interior: false, position: null };
  let targets = { master: 0, birds: 0, children: 0, wind: 0, cutoff: 16000, pan: 0 };
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

  function source(buffer, destination, { duration, offset = 0, pan, loop = false, fade = 1 } = {}) {
    const node = context.createBufferSource(); node.buffer = buffer; node.loop = loop;
    const gain = context.createGain(); node.connect(gain);
    let panner;
    if (pan != null) { panner = context.createStereoPanner(); panner.pan.value = pan; gain.connect(panner); panner.connect(destination); }
    else gain.connect(destination);
    const now = context.currentTime;
    gain.gain.setValueAtTime(0, now); gain.gain.linearRampToValueAtTime(1, now + fade);
    if (!loop) {
      gain.gain.setValueAtTime(1, now + Math.max(fade, duration - fade));
      gain.gain.linearRampToValueAtTime(0, now + duration);
    }
    const record = { node, gain, panner };
    sources.add(record);
    node.onended = () => { sources.delete(record); node.disconnect(); gain.disconnect(); panner?.disconnect(); };
    node.start(now, offset, loop ? undefined : duration);
    return record;
  }

  function stop() {
    if (!context) return;
    if (timer != null) { clearInterval(timer); timer = null; }
    running = false;
    master.gain.cancelScheduledValues(context.currentTime);
    master.gain.setValueAtTime(0, context.currentTime);
    for (const record of [...sources]) {
      record.node.onended = null;
      try { record.node.stop(); } catch {}
      record.node.disconnect(); record.gain.disconnect(); record.panner?.disconnect();
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
      birds: .75 * birds, children: .55 * day * nearby,
      wind: .075 * (1 + .12 * Math.sin(elapsed * .19) + .07 * Math.sin(elapsed * .071)),
      cutoff: 16000 * (1 - indoors) + 850 * indoors, pan
    };
    param(master.gain, targets.master, 1.1); param(birdGain.gain, targets.birds, 1.5);
    param(childrenGain.gain, targets.children, 1.2); param(windGain.gain, targets.wind, 2);
    param(lowpass.frequency, targets.cutoff, .6); param(childPan.pan, pan, .3);
  }

  function schedule() {
    if (!wanted() || !running) { stop(); return; }
    mix();
    const now = context.currentTime;
    if (now >= nextBird) {
      if (targets.birds > .001) {
        const duration = Math.min(buffers.birds.duration, 6 + Math.random() * 4);
        source(buffers.birds, birdGain, { duration, offset: Math.random() * Math.max(0, buffers.birds.duration - duration), pan: Math.random() * 1.4 - .7, fade: 1.2 });
        nextBird = now + duration + 5 + Math.random() * 9;
      } else nextBird = now + 2;
    }
    if (now >= nextChildren) {
      if (targets.children > .0005) {
        const duration = buffers.playground.duration;
        source(buffers.playground, childrenGain, { duration, fade: 3 });
        nextChildren = now + Math.max(1, duration - 3);
      } else nextChildren = now + 1;
    }
  }

  function start() {
    if (!wanted() || !ready || running || context.state !== 'running') return;
    running = true; nextBird = context.currentTime + .7; nextChildren = context.currentTime;
    source(buffers.wind, windFilter, { loop: true, fade: 2 });
    schedule(); timer = setInterval(schedule, 250);
  }

  function sync() {
    if (!wanted()) { stop(); return; }
    if (!context || !ready) return;
    if (context.state === 'running') { start(); return; }
    if (!resumePending) {
      resumePending = context.resume().then(() => { if (wanted()) start(); else stop(); })
        .catch(() => { error = 'Tap the scene to enable sound.'; })
        .finally(() => { resumePending = null; });
    }
  }

  const visibility = () => sync();
  globalThis.document?.addEventListener('visibilitychange', visibility);
  return {
    async unlock() {
      if (disposed || !enabled) return false;
      graph(); if (!context) return false;
      unlocked = true;
      // Invoke resume immediately in the user gesture, before awaiting downloads.
      try { await context.resume(); } catch { error = 'Tap the scene to enable sound.'; return false; }
      if (!wanted()) { stop(); return false; }
      await load(); sync(); return ready && wanted();
    },
    setEnabled(value) {
      enabled = Boolean(value);
      if (enabled && unlocked && context && !ready && !loading) load();
      sync();
    },
    setVolume(value) { volume = clamp(Number.isFinite(Number(value)) ? Number(value) : .25); sync(); if (running) mix(); },
    update(time, state = {}) {
      elapsed = Number.isFinite(time) ? time : elapsed;
      view = { ...view, ...state }; sync();
      if (running && context.currentTime - lastMix >= .12) { lastMix = context.currentTime; mix(); }
    },
    get state() { return {
      enabled, volume, unlocked, ready, loading: Boolean(loading), active: Boolean(view.active),
      playing: running && context?.state === 'running', contextState: context?.state || 'locked',
      sourceCount: sources.size, error, interior: view.interior,
      gains: { ...targets }, assets: Object.keys(ASSETS)
    }; },
    dispose() {
      if (disposed) return;
      disposed = true; abort.abort(); stop();
      globalThis.document?.removeEventListener('visibilitychange', visibility);
      if (context && context.state !== 'closed') context.close().catch(() => {});
      for (const id of Object.keys(buffers)) delete buffers[id];
    }
  };
}
