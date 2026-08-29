/* global Go, watcherProverV3RuntimeReady, watcherProverV3LoadCircuit, watcherProverV3ProveDeposit, watcherProverV3ProveWithdraw */

const CACHE_PREFIX = 'watcher-v3-zk-assets-v2-';
const CIRCUIT_ASSETS = Object.freeze({
  deposit: ['deposit.r1cs', 'deposit.pk', 'deposit.vk'],
  withdraw: ['withdraw.r1cs', 'withdraw.pk', 'withdraw.vk'],
});

let initialized;
let runtime;
let activeCircuit = '';
let operationQueue = Promise.resolve();

function nowMs() {
  return typeof performance?.now === 'function' ? performance.now() : Date.now();
}

function elapsedMs(startedAt) {
  return Math.max(0, Math.round(nowMs() - startedAt));
}

function postProgress(payload) {
  self.postMessage({ type: 'progress', payload: { circuit: activeCircuit, ...payload } });
}

function normalizedBasePath(value) {
  const text = String(value || '/watcher-prover-v3').trim();
  return (text || '/watcher-prover-v3').replace(/\/+$/, '');
}

function requireCircuit(value) {
  const circuit = String(value || '');
  if (!Object.hasOwn(CIRCUIT_ASSETS, circuit)) throw new Error(`Unsupported V3 browser circuit: ${circuit}`);
  return circuit;
}

function absoluteUrl(value) {
  return new URL(value, self.location.href).toString();
}

async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (value) => value.toString(16).padStart(2, '0')).join('');
}

async function fetchBytes(url, label, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`${label} download failed with HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function fetchManifest(basePath) {
  const startedAt = nowMs();
  postProgress({ stage: 'manifest', message: 'Checking fresh proving-bundle manifest…', progress: 0.05 });
  const bytes = await fetchBytes(`${basePath}/assets/manifest.json`, 'V3 proving bundle manifest', { cache: 'no-store' });
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('V3 proving bundle manifest is not valid JSON');
  }
  if (Number(manifest.version) !== 2 || manifest.curve !== 'BN254' || manifest.scheme !== 'Groth16') {
    throw new Error('V3 proving bundle manifest does not describe the expected BN254 Groth16 setup');
  }
  if (Number(manifest.merkleDepth) !== 16 || Number(manifest.maxInputs) !== 4) {
    throw new Error('V3 proving bundle manifest has unexpected circuit dimensions');
  }
  const checksums = manifest.filesSha256 || manifest.files_sha256 || manifest.files || {};
  for (const name of [...CIRCUIT_ASSETS.deposit, ...CIRCUIT_ASSETS.withdraw]) {
    const expected = String(checksums[name] || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error(`Missing SHA-256 checksum for ${name}`);
  }
  return {
    checksums,
    manifestDigest: await sha256Hex(bytes),
    manifestMs: elapsedMs(startedAt),
  };
}

async function openVerifiedCache(manifestDigest) {
  if (!globalThis.caches || typeof globalThis.caches.open !== 'function') return null;
  try {
    return await globalThis.caches.open(`${CACHE_PREFIX}${manifestDigest.slice(0, 24)}`);
  } catch {
    return null;
  }
}

function cacheRequest(url, expectedSha256) {
  const key = new URL(absoluteUrl(url));
  key.searchParams.set('watcher_verified_sha256', expectedSha256);
  return new Request(key.toString(), { method: 'GET' });
}

async function readVerifiedCachedBytes(cache, cacheKey, expectedSha256) {
  if (!cache) return null;
  try {
    const cached = await cache.match(cacheKey);
    if (!cached) return null;
    const bytes = new Uint8Array(await cached.arrayBuffer());
    const actual = await sha256Hex(bytes);
    if (actual === expectedSha256) return bytes;
    await cache.delete(cacheKey);
  } catch {
    // Persistent cache is never trusted and never required for correctness.
  }
  return null;
}

async function storeVerifiedBytes(cache, cacheKey, bytes, expectedSha256) {
  if (!cache) return;
  try {
    await cache.put(cacheKey, new Response(bytes, {
      status: 200,
      headers: {
        'content-type': 'application/octet-stream',
        'x-watcher-sha256': expectedSha256,
      },
    }));
  } catch {
    // Quota/private-mode failures fall back to network on the next load.
  }
}

async function loadVerifiedAsset({ basePath, name, expectedSha256, cache }) {
  const url = `${basePath}/assets/${name}`;
  const key = cacheRequest(url, expectedSha256);
  const cached = await readVerifiedCachedBytes(cache, key, expectedSha256);
  if (cached) return { name, bytes: cached, source: 'cache' };
  const bytes = await fetchBytes(url, name, { cache: 'no-store' });
  const actual = await sha256Hex(bytes);
  if (actual !== expectedSha256) throw new Error(`${name} failed its SHA-256 integrity check`);
  await storeVerifiedBytes(cache, key, bytes, expectedSha256);
  return { name, bytes, source: 'network' };
}

async function cleanupStaleCaches(currentName) {
  if (!globalThis.caches || typeof globalThis.caches.keys !== 'function') return;
  try {
    const names = await globalThis.caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith(CACHE_PREFIX) && name !== currentName)
      .map((name) => globalThis.caches.delete(name)));
  } catch {
    // Best effort only.
  }
}

async function prepareCircuitAssets(basePath, circuit) {
  const startedAt = nowMs();
  const { checksums, manifestDigest, manifestMs } = await fetchManifest(basePath);
  const cacheName = `${CACHE_PREFIX}${manifestDigest.slice(0, 24)}`;
  const cache = await openVerifiedCache(manifestDigest);
  const names = CIRCUIT_ASSETS[circuit];
  let completed = 0;
  let cacheHits = 0;
  const results = await Promise.all(names.map(async (name) => {
    const result = await loadVerifiedAsset({
      basePath,
      name,
      expectedSha256: String(checksums[name]).toLowerCase(),
      cache,
    });
    completed += 1;
    if (result.source === 'cache') cacheHits += 1;
    postProgress({
      stage: 'assets',
      message: `Verified ${completed}/${names.length} ${circuit} proving assets${result.source === 'cache' ? ' · cache hit' : ''}`,
      progress: 0.12 + (completed / names.length) * 0.32,
      cacheHits,
      completedAssets: completed,
      totalAssets: names.length,
    });
    return result;
  }));
  cleanupStaleCaches(cacheName);
  return {
    assets: Object.fromEntries(results.map(({ name, bytes }) => [name, bytes])),
    manifestDigest,
    manifestMs,
    assetLoadMs: elapsedMs(startedAt),
    cacheHits,
    cacheMisses: names.length - cacheHits,
  };
}

async function instantiateGo(basePath) {
  const startedAt = nowMs();
  postProgress({ stage: 'runtime', message: 'Loading circuit-scoped zero-knowledge runtime…', progress: 0.02 });
  importScripts(`${basePath}/wasm_exec.js`);
  if (typeof Go !== 'function') throw new Error('Go WebAssembly runtime did not initialize');
  const go = new Go();
  const wasmURL = `${basePath}/watcher-v3-prover.wasm`;
  let instance;
  try {
    const result = await WebAssembly.instantiateStreaming(fetch(wasmURL, { cache: 'no-cache' }), go.importObject);
    instance = result.instance;
  } catch {
    const bytes = await fetchBytes(wasmURL, 'V3 WebAssembly prover', { cache: 'no-cache' });
    const result = await WebAssembly.instantiate(bytes, go.importObject);
    instance = result.instance;
  }
  runtime = go.run(instance).catch((error) => {
    runtime = null;
    initialized = null;
    throw error;
  });
  const deadline = Date.now() + 30_000;
  while (!globalThis.watcherProverV3RuntimeReady) {
    if (Date.now() > deadline) throw new Error('V3 WebAssembly prover runtime timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return { runtimeMs: elapsedMs(startedAt) };
}

async function initialize(basePathValue, circuitValue) {
  const circuit = requireCircuit(circuitValue);
  if (activeCircuit && activeCircuit !== circuit) throw new Error(`V3 worker is already scoped to ${activeCircuit}`);
  activeCircuit = circuit;
  if (!initialized) {
    initialized = (async () => {
      const startedAt = nowMs();
      const basePath = normalizedBasePath(basePathValue);
      const [runtimeMetrics, bundle] = await Promise.all([
        instantiateGo(basePath),
        prepareCircuitAssets(basePath, circuit),
      ]);
      const deserializeStartedAt = nowMs();
      postProgress({ stage: 'deserialize', message: `Loading verified ${circuit} proving system into private memory…`, progress: 0.5 });
      const response = JSON.parse(globalThis.watcherProverV3LoadCircuit(circuit, bundle.assets, bundle.manifestDigest));
      if (response.error) throw new Error(response.error);
      if (response.status !== 'ready' || response.version !== 3 || response.circuit !== circuit) {
        throw new Error(`WebAssembly prover rejected the V3 ${circuit} proving system`);
      }
      const performanceInfo = {
        circuit,
        runtimeMs: runtimeMetrics.runtimeMs,
        manifestMs: bundle.manifestMs,
        assetLoadMs: bundle.assetLoadMs,
        deserializeMs: elapsedMs(deserializeStartedAt),
        totalInitMs: elapsedMs(startedAt),
        cacheHits: bundle.cacheHits,
        cacheMisses: bundle.cacheMisses,
        manifestDigest: bundle.manifestDigest,
      };
      postProgress({
        stage: 'ready',
        message: `${circuit === 'deposit' ? 'Deposit' : 'Withdraw'} prover ready · ${performanceInfo.cacheHits}/${CIRCUIT_ASSETS[circuit].length} assets cached · ${(performanceInfo.totalInitMs / 1000).toFixed(1)}s`,
        progress: 1,
        performance: performanceInfo,
      });
      return {
        status: 'ready',
        version: 3,
        circuit,
        bundleDigest: bundle.manifestDigest,
        performance: performanceInfo,
      };
    })().catch((error) => {
      initialized = null;
      throw error;
    });
  }
  return initialized;
}

async function prove(payload) {
  const circuit = requireCircuit(payload?.circuit);
  if (circuit !== activeCircuit) throw new Error(`V3 worker is scoped to ${activeCircuit || 'no circuit'}, not ${circuit}`);
  const witness = payload?.witness;
  if (!witness || typeof witness !== 'object') throw new Error('Private V3 witness is missing');
  const startedAt = nowMs();
  postProgress({ stage: 'proving', message: `Generating ${circuit} proof locally…`, progress: 0 });
  const raw = circuit === 'deposit'
    ? globalThis.watcherProverV3ProveDeposit(JSON.stringify(witness))
    : globalThis.watcherProverV3ProveWithdraw(JSON.stringify(witness));
  const response = JSON.parse(raw);
  if (response.error) throw new Error(response.error);
  const proofMs = elapsedMs(startedAt);
  postProgress({ stage: 'proved', message: `Proof generated and self-verified locally in ${(proofMs / 1000).toFixed(1)}s.`, progress: 1, proofMs });
  return response;
}

async function handleMessage(message) {
  const id = message?.id;
  try {
    if (!Number.isInteger(id)) throw new Error('V3 browser prover request ID is invalid');
    if (message.type === 'init') {
      const result = await initialize(message.payload?.basePath, message.payload?.circuit);
      self.postMessage({ id, type: 'ready', payload: result });
      return;
    }
    if (message.type === 'prove') {
      await initialize(message.payload?.basePath, message.payload?.circuit);
      const result = await prove(message.payload);
      self.postMessage({ id, type: 'result', payload: result });
      return;
    }
    throw new Error(`Unsupported V3 browser prover request: ${message.type}`);
  } catch (error) {
    self.postMessage({ id, type: 'error', error: error?.message || String(error) });
  }
}

self.onmessage = (event) => {
  operationQueue = operationQueue
    .then(() => handleMessage(event.data || {}))
    .catch((error) => {
      self.postMessage({ id: event.data?.id, type: 'error', error: error?.message || String(error) });
    });
};
