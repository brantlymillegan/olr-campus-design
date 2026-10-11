// Transport compression only: GLTFLoader receives the exact original GLB bytes.
const TRANSPORT_MANIFEST = './model-transports-907c6d7ad5ae703305bc328dc89d449e63c10ae8a0550b9674e563abf967771c.json';
const CACHE_NAME = 'olr-campus-model-transport-v1';
const MAX_MODEL_BYTES = 256 * 1024 * 1024;
const DIGEST = /^[a-f0-9]{64}$/;
const clock = () => performance.now();
const failure = (code, message) => Object.assign(new Error(message), {code});
let manifestPromise;
let brotliPromise;

async function digest(bytes) {
  if (!globalThis.crypto?.subtle) throw failure('MODEL_DIGEST', 'Secure model verification is unavailable.');
  const result = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, '0')).join('');
}

function assetURL(value, base) {
  if (typeof value !== 'string') throw failure('MODEL_MANIFEST', 'Invalid model asset URL.');
  const url = new URL(value, base);
  if (url.origin !== location.origin || !/^https?:$/.test(url.protocol) || url.username || url.password || url.hash) {
    throw failure('MODEL_MANIFEST', 'Invalid model asset URL.');
  }
  return url;
}

function validateDescriptor(row, base, suffix) {
  if (!row || !DIGEST.test(row.sha256 || '') || !Number.isSafeInteger(row.bytes) || row.bytes < 1 || row.bytes > MAX_MODEL_BYTES) {
    throw failure('MODEL_MANIFEST', 'Invalid model transport identity.');
  }
  const url = assetURL(row.url, base);
  if (!url.pathname.endsWith(suffix)) throw failure('MODEL_MANIFEST', 'Invalid model transport format.');
  return {url: url.href, sha256: row.sha256, bytes: row.bytes};
}

async function manifest() {
  if (!manifestPromise) {
    manifestPromise = (async () => {
      const url = new URL(TRANSPORT_MANIFEST, location.href);
      const response = await fetch(url, {cache: 'force-cache'});
      if (!response.ok) throw failure('MODEL_MANIFEST', `Model transport metadata HTTP ${response.status}`);
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > 65536) throw failure('MODEL_MANIFEST', 'Model transport metadata is too large.');
      const expected = url.searchParams.get('v') || url.pathname.match(/model-transports-([a-f0-9]{64})\.json$/)?.[1];
      if (expected && (!/^[a-f0-9]{16,64}$/.test(expected) || !(await digest(bytes)).startsWith(expected))) {
        throw failure('MODEL_MANIFEST', 'Model transport metadata changed while loading. Please reload.');
      }
      const value = JSON.parse(new TextDecoder().decode(bytes));
      if (value.version !== 1 || !Array.isArray(value.assets) || value.assets.length < 1 || value.assets.length > 2) {
        throw failure('MODEL_MANIFEST', 'Invalid model transport metadata.');
      }
      const assets = value.assets.map(row => ({...validateDescriptor(row, url, '.glb'), gzip: validateDescriptor(row.gzip, url, '.glb.gz'),
        ...(row.brotli ? {brotli: validateDescriptor(row.brotli, url, '.glb.br')} : {})}));
      if (new Set(assets.map(row => new URL(row.url).pathname)).size !== assets.length || new Set(assets.map(row => row.gzip.url)).size !== assets.length) {
        throw failure('MODEL_MANIFEST', 'Duplicate model transport metadata.');
      }
      return {assets};
    })();
    // A temporary network failure may be retried by the page's existing retry flow.
    manifestPromise.catch(() => { manifestPromise = null; });
  }
  return manifestPromise;
}

async function openCache(metrics) {
  try { return globalThis.caches ? await caches.open(CACHE_NAME) : null; }
  catch { metrics.cacheUnavailable = true; return null; }
}

async function readExact(stream, expected, onChunk) {
  if (!stream?.getReader) throw failure('MODEL_STREAM', 'Model streaming is unavailable.');
  const bytes = new Uint8Array(expected), reader = stream.getReader();
  let offset = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array) || offset + value.byteLength > expected) {
        throw failure('MODEL_SIZE', 'The model exceeded its verified size.');
      }
      bytes.set(value, offset); offset += value.byteLength;
      onChunk?.(offset);
    }
    if (offset !== expected) throw failure('MODEL_SIZE', 'The model download was incomplete.');
    return bytes;
  } catch (error) {
    try { await reader.cancel(error); } catch {}
    throw error;
  } finally { reader.releaseLock(); }
}

async function decoder(format) {
  try { if (typeof DecompressionStream === 'function') return {stream: new DecompressionStream(format), dispose() {}}; }
  catch {}
  if (format !== 'brotli') return null;
  if (!brotliPromise) brotliPromise = import('./vendor/brotli-3.0.1/brotli_wasm.js').then(async api => { await api.default(); return api; });
  const api = await brotliPromise, instance = new api.DecompressStream();
  let freed = false, complete = false, lastYield = clock();
  const dispose = () => { if (!freed) { freed = true; instance.free(); } };
  const stream = new TransformStream({
    async transform(chunk, controller) {
      if (complete && chunk.byteLength) throw failure('MODEL_BROTLI', 'Unexpected trailing compressed data.');
      for (let start = 0; start < chunk.byteLength; start += 65536) {
        const input = chunk.subarray(start, Math.min(start + 65536, chunk.byteLength));
        let consumed = 0, code;
        do {
          if (freed) throw failure('MODEL_CANCELLED', 'Model decoding was cancelled.');
          const result = instance.decompress(input.subarray(consumed), 262144);
          try {
            const output = result.buf;
            consumed += result.input_offset; code = result.code;
            if (output.byteLength) controller.enqueue(output);
          } finally { result.free(); }
          if (clock() - lastYield > 8) {
            if (globalThis.scheduler?.yield) await scheduler.yield();
            else await new Promise(resolve => setTimeout(resolve, 0));
            lastYield = clock();
          }
        } while (code === api.BrotliStreamResultCode.NeedsMoreOutput);
        if (consumed !== input.byteLength || (code !== api.BrotliStreamResultCode.NeedsMoreInput && code !== api.BrotliStreamResultCode.ResultSuccess)) {
          throw failure('MODEL_BROTLI', 'The compressed model stream is invalid.');
        }
        complete = code === api.BrotliStreamResultCode.ResultSuccess;
        if (complete && start + input.byteLength !== chunk.byteLength) throw failure('MODEL_BROTLI', 'Unexpected trailing compressed data.');
      }
    },
    flush() {
      if (!complete) throw failure('MODEL_BROTLI', 'The compressed model stream is incomplete.');
    }
  });
  return {stream, dispose};
}

async function decodeCompressed(response, entry, transport, codec, onProgress, metrics, source) {
  if (!response.ok || !response.body) throw failure('MODEL_HTTP', `Compressed model HTTP ${response.status}`);
  const packed = new Uint8Array(transport.bytes);
  let offset = 0;
  const started = clock();
  const counted = response.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      if (!(chunk instanceof Uint8Array) || offset + chunk.byteLength > packed.byteLength) {
        throw failure('MODEL_SIZE', 'The compressed model exceeded its verified size.');
      }
      packed.set(chunk, offset); offset += chunk.byteLength;
      if (source === 'network') metrics.networkBytes += chunk.byteLength;
      onProgress?.({loaded: offset, total: packed.byteLength});
      controller.enqueue(chunk);
    }
  }));
  let bytes;
  try { bytes = await readExact(counted.pipeThrough(codec.stream), entry.bytes); }
  finally { codec.dispose(); }
  metrics.readAndDecodeMs += clock() - started;
  if (offset !== packed.byteLength) throw failure('MODEL_SIZE', 'The compressed model download was incomplete.');
  const hashStart = clock();
  if (await digest(packed) !== transport.sha256 || await digest(bytes) !== entry.sha256) {
    throw failure('MODEL_DIGEST', 'Model verification failed.');
  }
  metrics.hashMs += clock() - hashStart;
  return {bytes, packed};
}

async function readRaw(entry, requestedURL, onProgress, metrics) {
  const started = clock(), response = await fetch(requestedURL, {cache: 'no-cache'});
  if (!response.ok) throw failure('MODEL_HTTP', `Campus model HTTP ${response.status}`);
  let previous = 0;
  const bytes = await readExact(response.body, entry.bytes, loaded => {
    metrics.networkBytes += loaded - previous; previous = loaded;
    onProgress?.({loaded, total: entry.bytes});
  });
  metrics.readAndDecodeMs += clock() - started;
  const hashStart = clock();
  if (await digest(bytes) !== entry.sha256) throw failure('MODEL_DIGEST', 'Model verification failed. Please reload.');
  metrics.hashMs += clock() - hashStart;
  return {bytes, packed: null};
}

// Stream views of the already-verified compressed buffer. Response.clone() would
// retain an unbounded second queue while its slower consumer waits for validation.
function compressedResponse(bytes) {
  let offset = 0;
  const stream = new ReadableStream({pull(controller) {
    if (offset === bytes.byteLength) { controller.close(); return; }
    const end = Math.min(offset + 262144, bytes.byteLength);
    controller.enqueue(bytes.subarray(offset, end)); offset = end;
  }});
  return new Response(stream, {headers: {'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.byteLength)}});
}

async function pruneCache(cache, entry, transport, assets) {
  const requests = await cache.keys(), urls = new Set(requests.map(request => request.url));
  const keep = new Set(assets.map(asset => asset.url === entry.url ? transport.url
    : [asset.brotli?.url, asset.gzip.url].find(url => urls.has(url))).filter(Boolean));
  for (const request of requests) if (!keep.has(request.url)) await cache.delete(request);
}

async function retainVerified(cache, entry, transport, packed, assets, metrics) {
  if (!cache || !packed) return;
  const started = clock();
  try {
    await cache.put(transport.url, compressedResponse(packed));
    metrics.cacheStored = true;
    // This dedicated cache holds only the two current compressed model versions.
    // Prune only after the replacement is fully verified and successfully stored.
    await pruneCache(cache, entry, transport, assets);
  } catch { metrics.cacheWriteFailed = true; }
  metrics.cacheWriteMs += clock() - started;
}

export async function loadHashedCampusModel(loader, url, onProgress) {
  const started = clock(), data = await manifest();
  const requested = assetURL(url, location.href);
  const entry = data.assets.find(row => new URL(row.url).pathname === requested.pathname);
  if (!entry) throw failure('MODEL_ASSET', 'This model is not in the current verified release.');
  const metrics = {networkBytes: 0, readAndDecodeMs: 0, hashMs: 0, parseMs: 0, cacheWriteMs: 0, cacheHit: false, cacheStored: false};
  const cache = await openCache(metrics);
  let result, source = 'network', encoding = 'raw', transport = entry;
  for (const format of ['brotli', 'gzip']) {
    if (!entry[format]) continue;
    let codec;
    try { codec = await decoder(format); }
    catch { metrics[`${format}FallbackReason`] = 'DECODER_UNAVAILABLE'; continue; }
    if (!codec) { metrics[`${format}FallbackReason`] = 'GZIP_UNAVAILABLE'; continue; }
    const candidate = entry[format];
    let cached;
    try { cached = cache ? await cache.match(candidate.url) : null; }
    catch { metrics.cacheUnavailable = true; }
    if (cached) {
      try {
        result = await decodeCompressed(cached, entry, candidate, codec, onProgress, metrics, 'cache');
        source = 'cache'; metrics.cacheHit = true;
      } catch {
        metrics.invalidCacheRemoved = true;
        try { await cache.delete(candidate.url); } catch {}
        codec.dispose();
        try { codec = await decoder(format); }
        catch { metrics[`${format}FallbackReason`] = 'DECODER_UNAVAILABLE'; continue; }
      }
    }
    if (!result) {
      try {
        const response = await fetch(candidate.url, {cache: 'force-cache'});
        result = await decodeCompressed(response, entry, candidate, codec, onProgress, metrics, 'network');
      } catch (error) { metrics[`${format}FallbackReason`] = error.code || error.name || 'MODEL_COMPRESSED'; }
    }
    codec?.dispose();
    if (result) { encoding = format; transport = candidate; break; }
  }
  if (!result) {
    encoding = 'raw';
    result = await readRaw(entry, requested.href, onProgress, metrics);
  }
  const {bytes, packed} = result;
  const caching = encoding === 'raw' ? Promise.resolve() : source === 'network'
    ? retainVerified(cache, entry, transport, packed, data.assets, metrics)
    : (cache ? pruneCache(cache, entry, transport, data.assets).catch(() => {}) : Promise.resolve());
  const parseStart = clock();
  const gltf = await loader.parseAsync(bytes.buffer, new URL('.', requested).href);
  metrics.parseMs = clock() - parseStart;
  await caching;
  metrics.totalMs = clock() - started;
  return {gltf, sha256: entry.sha256, byteLength: bytes.byteLength,
    transport: {encoding, source, url: encoding === 'raw' ? requested.href : transport.url, bytes: transport.bytes}, metrics};
}
