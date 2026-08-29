/* global Go, watcherProverV2RuntimeReady, watcherProverV2LoadBundle, watcherProverV2ProveDeposit, watcherProverV2ProveWithdraw */

const REQUIRED_ASSETS = [
  'deposit.r1cs',
  'deposit.pk',
  'deposit.vk',
  'withdraw.r1cs',
  'withdraw.pk',
  'withdraw.vk',
];
const CACHE_PREFIX = 'watcher-v3-zk-assets-v1-';

let initialized;
let runtime;
let operationQueue = Promise.resolve();

function nowMs() {
  return typeof performance?.now === 'function' ? performance.now() : Date.now();
}

function elapsedMs(startedAt) {
  return Math.max(0, Math.round(nowMs() - startedAt));
}

function postProgress(payload) {
  self.postMessage({ type: 'progress', payload });
}

function normalizedBasePath(value) {
  const text = String(value || '/watcher-prover-v3').trim();
  return (text || '/watcher-prover-v3').replace(/\/+$/, '');
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
  postProgress({ stage: 'assets', message: 'Checking fresh proving-bundle manifest…', progress: 0.08 });
  const bytes = await fetchBytes(
    `${basePath}/assets/manifest.json`,
    'V3 proving bundle manifest',
    { cache: 'no-store' },
  );
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
  for (const name of REQUIRED_ASSETS) {
    const expected = String(checksums[name] || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error(`Missing SHA-256 checksum for ${name}`);
  }
  return {
    manifest,
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
    // Cache is a performance layer only. Any cache failure falls back to network.
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
    // Quota/private-mode failures must never break proving.
  }
}

async function loadVerifiedAsset({ basePath, name, expectedSha256, cache }) {
  const url = `${basePath}/assets/${name}`;
  const key = cacheRequest(url, expectedSha256);
  const cached = await readVerifiedCachedBytes(cache, key, expectedSha256);
  if (cached) return { name, bytes: cached, source: 'cache' };

  const bytes = await fetchBytes(url, name, { cache: 'no-store' });
  const actual = await sha256Hex(bytes);
  if (actual !== expectedSha256) {
    throw new Error(`${name} failed its SHA-256 integrity check`);
  }
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
    // Cache cleanup is best effort only.
  }
}

async function prepareVerifiedAssets(basePath) {
  const startedAt = nowMs();
  const { checksums, manifestDigest, manifestMs } = await fetchManifest(basePath);
  const cacheName = `${CACHE_PREFIX}${manifestDigest.slice(0, 24)}`;
  const cache = await openVerifiedCache(manifestDigest);
  let completed = 0;
  let cacheHits = 0;

  const results = await Promise.all(REQUIRED_ASSETS.map(async (name) => {
    const expectedSha256 = String(checksums[name]).toLowerCase();
    const result = await loadVerifiedAsset({ basePath, name, expectedSha256, cache });
    completed += 1;
    if (result.source === 'cache') cacheHits += 1;
    postProgress({
      stage: 'assets',
      message: `Verified ${completed}/${REQUIRED_ASSETS.length} proving assets${result.source === 'cache' ? ' · cache hit' : ''}`,
      progress: 0.14 + (completed / REQUIRED_ASSETS.length) * 0.62,
      cacheHits,
      completedAssets: completed,
      totalAssets: REQUIRED_ASSETS.length,
    });
    return result;
  }));

  const assets = Object.fromEntries(results.map(({ name, bytes }) => [name, bytes]));
  cleanupStaleCaches(cacheName);
  return {
    assets,
    manifestDigest,
    manifestMs,
    assetLoadMs: elapsedMs(startedAt),
    cacheHits,
    cacheMisses: REQUIRED_ASSETS.length - cacheHits,
  };
}

async function instantiateGo(basePath) {
  const startedAt = nowMs();
  postProgress({ stage: 'runtime', message: 'Loading local zero-knowledge runtime…', progress: 0.04 });
  importScripts(`${basePath}/wasm_exec.js`);
  if (typeof Go !== 'function') throw new Error('Go WebAssembly runtime did not initialize');

  const go = new Go();
  const wasmURL = `${basePath}/watcher-v2-prover.wasm`;
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
  while (!globalThis.watcherProverV2RuntimeReady) {
    if (Date.now() > deadline) throw new Error('V3 WebAssembly prover runtime timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  postProgress({ stage: 'runtime', message: 'Zero-knowledge runtime loaded.', progress: 0.12 });
  return { runtimeMs: elapsedMs(startedAt) };
}

async function initialize(basePathValue) {
  if (!initialized) {
    initialized = (async () => {
      const startedAt = nowMs();
      const basePath = normalizedBasePath(basePathValue);

      // Runtime startup and immutable proving-asset verification are independent,
      // so do them concurrently. No private witness exists at this stage.
      const [runtimeMetrics, bundle] = await Promise.all([
        instantiateGo(basePath),
        prepareVerifiedAssets(basePath),
      ]);

      const loadStartedAt = nowMs();
      postProgress({ stage: 'assets', message: 'Loading verified proving keys into private memory…', progress: 0.84 });
      const response = JSON.parse(globalThis.watcherProverV2LoadBundle(bundle.assets));
      if (response.error) throw new Error(response.error);
      if (response.status !== 'ready' || response.version !== 2 || !/^[0-9a-f]{64}$/i.test(response.bundleDigest || '')) {
        throw new Error('WebAssembly prover rejected the matched V3 proving bundle');
      }

      const performanceInfo = {
        ...runtimeMetrics,
        manifestMs: bundle.manifestMs,
        assetLoadMs: bundle.assetLoadMs,
        bundleLoadMs: elapsedMs(loadStartedAt),
        totalInitMs: elapsedMs(startedAt),
        cacheHits: bundle.cacheHits,
        cacheMisses: bundle.cacheMisses,
        manifestDigest: bundle.manifestDigest,
      };
      postProgress({
        stage: 'ready',
        message: `Browser prover ready · ${performanceInfo.cacheHits}/${REQUIRED_ASSETS.length} assets cached · ${(performanceInfo.totalInitMs / 1000).toFixed(1)}s`,
        progress: 1,
        performance: performanceInfo,
      });
      return { ...response, performance: performanceInfo };
    })().catch((error) => {
      initialized = null;
      throw error;
    });
  }
  return initialized;
}

async function prove(payload) {
  const circuit = payload?.circuit;
  const witness = payload?.witness;
  if (!witness || typeof witness !== 'object') throw new Error('Private V3 witness is missing');
  const startedAt = nowMs();
  postProgress({
    stage: 'proving',
    message: circuit === 'deposit'
      ? 'Generating deposit proof locally…'
      : 'Generating withdrawal proof locally…',
    progress: 0,
  });
  const raw = circuit === 'deposit'
    ? globalThis.watcherProverV2ProveDeposit(JSON.stringify(witness))
    : circuit === 'withdraw'
      ? globalThis.watcherProverV2ProveWithdraw(JSON.stringify(witness))
      : null;
  if (raw === null) throw new Error(`Unsupported V3 circuit: ${circuit}`);
  const response = JSON.parse(raw);
  if (response.error) throw new Error(response.error);
  const proofMs = elapsedMs(startedAt);
  postProgress({
    stage: 'proved',
    message: `Proof generated and self-verified locally in ${(proofMs / 1000).toFixed(1)}s.`,
    progress: 1,
    proofMs,
  });
  return { ...response, performance: { ...(response.performance || {}), proofMs } };
}

async function handleMessage(message) {
  const id = message?.id;
  try {
    if (!Number.isInteger(id)) throw new Error('V3 browser prover request ID is invalid');
    if (message.type === 'init') {
      const result = await initialize(message.payload?.basePath);
      self.postMessage({ id, type: 'ready', payload: result });
      return;
    }
    if (message.type === 'prove') {
      await initialize(message.payload?.basePath);
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
