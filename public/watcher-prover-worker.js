/* global Go */

let initialized;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function fetchBytes(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`failed to fetch ${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function waitForApi(timeoutMs = 30_000) {
  const started = Date.now();
  while (!self.watcherProverV1) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('Watcher WASM prover did not initialize');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return self.watcherProverV1;
}

async function initialize(assetBase) {
  const base = String(assetBase || '').replace(/\/$/, '');
  if (!base) throw new Error('assetBase is required');
  importScripts(`${base}/wasm_exec.js`);
  if (typeof Go !== 'function') throw new Error('Go WASM runtime is unavailable');

  const names = [
    'deposit.r1cs',
    'deposit.pk',
    'deposit.vk',
    'withdraw.r1cs',
    'withdraw.pk',
    'withdraw.vk',
    'watcher-prover.wasm',
  ];
  const loaded = await Promise.all(names.map((name) => fetchBytes(`${base}/${name}`)));
  const [
    depositR1CS,
    depositPK,
    depositVK,
    withdrawR1CS,
    withdrawPK,
    withdrawVK,
    wasm,
  ] = loaded;

  const go = new Go();
  const instantiated = await WebAssembly.instantiate(wasm, go.importObject);
  void go.run(instantiated.instance);
  const api = await waitForApi();
  const raw = api.loadBundle({
    depositR1CS,
    depositPK,
    depositVK,
    withdrawR1CS,
    withdrawPK,
    withdrawVK,
  });
  const result = JSON.parse(raw);
  if (result.error) throw new Error(result.error);
  return result;
}

async function handle(message) {
  const { type } = message;
  if (type === 'init') {
    initialized ??= initialize(message.assetBase);
    return initialized;
  }
  if (!initialized) throw new Error('Watcher prover is not initialized');
  await initialized;
  const api = await waitForApi();
  if (type === 'proveDeposit') {
    const result = JSON.parse(api.proveDeposit(JSON.stringify(message.witness)));
    if (result.error) throw new Error(result.error);
    return result;
  }
  if (type === 'proveWithdraw') {
    const result = JSON.parse(api.proveWithdraw(JSON.stringify(message.witness)));
    if (result.error) throw new Error(result.error);
    return result;
  }
  throw new Error(`unknown Watcher prover request: ${type}`);
}

self.addEventListener('message', async (event) => {
  const message = event.data || {};
  try {
    const result = await handle(message);
    self.postMessage({ id: message.id, ok: true, result });
  } catch (error) {
    self.postMessage({ id: message.id, ok: false, error: errorMessage(error) });
  }
});
