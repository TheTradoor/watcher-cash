#!/usr/bin/env node

const EXPECTED_V1_PROGRAM_ID = '9urFwd6gEYwkc5Dc8YYakYCX4VEosCRdgfQAz88fYEv5';
const EXPECTED_V2_PROGRAM_ID = 'DMU22YyGkLs9cuZXR6eHt4oZpWtMTMtkCNTNV8SW16HM';
const DEFAULT_BASE_URL = 'https://thetradoor.github.io/watcher-cash/';

function baseUrl(value) {
  const parsed = new URL(value || DEFAULT_BASE_URL);
  if (parsed.protocol !== 'https:') throw new Error('Live Pages smoke requires HTTPS');
  if (!parsed.pathname.endsWith('/')) parsed.pathname += '/';
  return parsed;
}

function cacheBusted(url, token) {
  const next = new URL(url);
  next.searchParams.set('watcher_live_smoke', token);
  return next;
}

async function request(url, { binary = false } = {}) {
  const response = await fetch(url, {
    cache: 'no-store',
    redirect: 'follow',
    headers: { 'cache-control': 'no-cache' },
  });
  if (!response.ok) throw new Error(`${url.pathname} returned HTTP ${response.status}`);
  if (binary) return new Uint8Array(await response.arrayBuffer());
  return response.text();
}

async function oneAttempt(base, token) {
  const rootUrl = cacheBusted(new URL('.', base), token);
  const v2Url = cacheBusted(new URL('v2/', base), token);
  const v1RuntimeUrl = cacheBusted(new URL('watcher-protocol/devnet.json', base), token);
  const v2RuntimeUrl = cacheBusted(new URL('watcher-protocol/v2-devnet.json', base), token);
  const workerUrl = cacheBusted(new URL('watcher-prover-v2/worker.js', base), token);
  const wasmUrl = cacheBusted(new URL('watcher-prover-v2/watcher-v2-prover.wasm', base), token);

  const [rootHtml, v2Html, v1RuntimeText, v2RuntimeText, workerText, wasm] = await Promise.all([
    request(rootUrl),
    request(v2Url),
    request(v1RuntimeUrl),
    request(v2RuntimeUrl),
    request(workerUrl),
    request(wasmUrl, { binary: true }),
  ]);

  if (!rootHtml.includes('/watcher-cash/_next/')) throw new Error('Live V1 root is missing expected Next assets');
  if (!v2Html.includes('/watcher-cash/_next/')) throw new Error('Live /v2 route is missing expected Next assets');
  if (rootHtml.includes('data-watcher-v2="true"') || rootHtml.includes('PROTOCOL V2 · ISOLATED')) {
    throw new Error('Live V1 root appears to have been replaced by the V2 page');
  }
  if (!v2Html.includes('PROTOCOL V2') && !v2Html.includes('Watcher Protocol')) {
    throw new Error('Live /v2 route does not look like the V2 page');
  }

  const v1 = JSON.parse(v1RuntimeText);
  const v2 = JSON.parse(v2RuntimeText);
  if (v1.programId !== EXPECTED_V1_PROGRAM_ID || v1.status !== 'ready' || v1.cluster !== 'devnet') {
    throw new Error(`Live V1 runtime mismatch: ${JSON.stringify({ status: v1.status, cluster: v1.cluster, programId: v1.programId })}`);
  }
  if (v2.programId !== EXPECTED_V2_PROGRAM_ID || v2.status !== 'ready' || v2.network !== 'devnet') {
    throw new Error(`Live V2 runtime mismatch: ${JSON.stringify({ status: v2.status, network: v2.network, programId: v2.programId })}`);
  }
  if (Number(v2.treeDepth) !== 16 || Number(v2.treeCapacity) !== 65_536) {
    throw new Error('Live V2 runtime has unexpected tree dimensions');
  }
  if (workerText.length < 100 || !workerText.includes('postMessage')) {
    throw new Error('Live V2 browser prover worker is missing or malformed');
  }
  if (wasm.length < 8 || wasm[0] !== 0x00 || wasm[1] !== 0x61 || wasm[2] !== 0x73 || wasm[3] !== 0x6d) {
    throw new Error('Live V2 prover WASM has an invalid WebAssembly magic header');
  }

  return {
    status: 'pass',
    baseUrl: base.toString(),
    v1ProgramId: v1.programId,
    v2ProgramId: v2.programId,
    v2Config: v2.config,
    v2ActiveTree: v2.activeTree,
    v2Vault: v2.vault,
    v2TreeDepth: v2.treeDepth,
    v2TreeCapacity: v2.treeCapacity,
    workerBytes: Buffer.byteLength(workerText),
    wasmBytes: wasm.length,
  };
}

async function main() {
  const base = baseUrl(process.env.WATCHER_PAGES_URL || process.argv[2]);
  const attempts = Number(process.env.WATCHER_LIVE_SMOKE_ATTEMPTS || 30);
  const delayMs = Number(process.env.WATCHER_LIVE_SMOKE_DELAY_MS || 5000);
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await oneAttempt(base, `${Date.now()}-${attempt}`);
      process.stdout.write(`${JSON.stringify({ ...result, attempt }, null, 2)}\n`);
      return;
    } catch (error) {
      lastError = error;
      console.error(`[live-pages-smoke] attempt ${attempt}/${attempts}: ${error?.message || error}`);
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError || new Error('Live Pages smoke failed');
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
