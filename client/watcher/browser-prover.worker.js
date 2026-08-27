/* global Go, watcherProverRuntimeReady, watcherProverLoadBundle, watcherProverProveDeposit, watcherProverProveWithdraw */

const REQUIRED_ASSETS = [
  'deposit.r1cs',
  'deposit.pk',
  'deposit.vk',
  'withdraw.r1cs',
  'withdraw.pk',
  'withdraw.vk',
];

let initialized;
let runtime;
let operationQueue = Promise.resolve();

function postProgress(payload) {
  self.postMessage({ type: 'progress', payload });
}

function normalizedBasePath(value) {
  const text = String(value || '/watcher-prover').trim();
  return (text || '/watcher-prover').replace(/\/+$/, '');
}

async function fetchBytes(url, label) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${label} download failed with HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (value) => value.toString(16).padStart(2, '0')).join('');
}

async function instantiateGo(basePath) {
  postProgress({ stage: 'runtime', message: 'Loading local zero-knowledge runtime…', progress: 0.04 });
  importScripts(`${basePath}/wasm_exec.js`);
  if (typeof Go !== 'function') throw new Error('Go WebAssembly runtime did not initialize');

  const go = new Go();
  const wasmURL = `${basePath}/watcher-prover.wasm`;
  let instance;
  try {
    const result = await WebAssembly.instantiateStreaming(fetch(wasmURL, { cache: 'no-store' }), go.importObject);
    instance = result.instance;
  } catch {
    const bytes = await fetchBytes(wasmURL, 'WebAssembly prover');
    const result = await WebAssembly.instantiate(bytes, go.importObject);
    instance = result.instance;
  }

  // The Go entrypoint intentionally blocks forever after registering its JS
  // functions. Do not await this promise.
  runtime = go.run(instance).catch((error) => {
    runtime = null;
    initialized = null;
    throw error;
  });

  const deadline = Date.now() + 30_000;
  while (!globalThis.watcherProverRuntimeReady) {
    if (Date.now() > deadline) throw new Error('WebAssembly prover runtime timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  postProgress({ stage: 'runtime', message: 'Zero-knowledge runtime loaded.', progress: 0.12 });
}

async function loadAssets(basePath) {
  postProgress({ stage: 'assets', message: 'Reading matched proving bundle…', progress: 0.14 });
  const manifestResponse = await fetch(`${basePath}/assets/manifest.json`, { cache: 'no-store' });
  if (!manifestResponse.ok) {
    throw new Error(`Proving bundle manifest failed with HTTP ${manifestResponse.status}`);
  }
  const manifest = await manifestResponse.json();
  const checksums = manifest.files_sha256 || manifest.files || {};
  const assets = {};

  for (let index = 0; index < REQUIRED_ASSETS.length; index += 1) {
    const name = REQUIRED_ASSETS[index];
    const progress = 0.16 + ((index + 1) / REQUIRED_ASSETS.length) * 0.63;
    postProgress({
      stage: 'assets',
      message: `Loading ${name} (${index + 1}/${REQUIRED_ASSETS.length})…`,
      progress,
    });
    const bytes = await fetchBytes(`${basePath}/assets/${name}`, name);
    const expected = String(checksums[name] || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expected)) {
      throw new Error(`Missing SHA-256 checksum for ${name}`);
    }
    const actual = await sha256Hex(bytes);
    if (actual !== expected) throw new Error(`${name} failed its SHA-256 integrity check`);
    assets[name] = bytes;
  }

  postProgress({ stage: 'assets', message: 'Loading proving keys into private memory…', progress: 0.84 });
  const response = JSON.parse(globalThis.watcherProverLoadBundle(assets));
  if (response.error) throw new Error(response.error);
  if (response.status !== 'ready' || !/^[0-9a-f]{64}$/i.test(response.bundleDigest || '')) {
    throw new Error('WebAssembly prover rejected the matched proving bundle');
  }
  postProgress({ stage: 'ready', message: 'Browser prover ready.', progress: 1 });
  return response;
}

async function initialize(basePathValue) {
  if (!initialized) {
    initialized = (async () => {
      const basePath = normalizedBasePath(basePathValue);
      await instantiateGo(basePath);
      return loadAssets(basePath);
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
  if (!witness || typeof witness !== 'object') throw new Error('Private witness is missing');
  postProgress({
    stage: 'proving',
    message: circuit === 'deposit'
      ? 'Generating deposit proof locally…'
      : 'Generating withdrawal proof locally…',
    progress: 0,
  });
  const raw = circuit === 'deposit'
    ? globalThis.watcherProverProveDeposit(JSON.stringify(witness))
    : circuit === 'withdraw'
      ? globalThis.watcherProverProveWithdraw(JSON.stringify(witness))
      : null;
  if (raw === null) throw new Error(`Unsupported circuit: ${circuit}`);
  const response = JSON.parse(raw);
  if (response.error) throw new Error(response.error);
  postProgress({ stage: 'proved', message: 'Proof generated and self-verified locally.', progress: 1 });
  return response;
}

async function handleMessage(message) {
  const id = message?.id;
  try {
    if (!Number.isInteger(id)) throw new Error('Browser prover request ID is invalid');
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
    throw new Error(`Unsupported browser prover request: ${message.type}`);
  } catch (error) {
    self.postMessage({
      id,
      type: 'error',
      error: error?.message || String(error),
    });
  }
}

self.onmessage = (event) => {
  operationQueue = operationQueue
    .then(() => handleMessage(event.data || {}))
    .catch((error) => {
      self.postMessage({
        id: event.data?.id,
        type: 'error',
        error: error?.message || String(error),
      });
    });
};
