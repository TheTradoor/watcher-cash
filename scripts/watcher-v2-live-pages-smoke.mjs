#!/usr/bin/env node

const EXPECTED_V1_PROGRAM_ID = '9urFwd6gEYwkc5Dc8YYakYCX4VEosCRdgfQAz88fYEv5';
const EXPECTED_V2_PROGRAM_ID = 'DMU22YyGkLs9cuZXR6eHt4oZpWtMTMtkCNTNV8SW16HM';
const DEFAULT_BASE_URL = 'https://thetradoor.github.io/watcher-cash/';

function normalizeBase(value) {
  const url = new URL(value || DEFAULT_BASE_URL);
  if (url.protocol !== 'https:') throw new Error('Live Pages smoke requires HTTPS');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

function busted(url, token) {
  const next = new URL(url);
  next.searchParams.set('watcher_live_smoke', token);
  return next;
}

async function text(url) {
  const response = await fetch(url, {
    cache: 'no-store',
    redirect: 'follow',
    headers: { 'cache-control': 'no-cache' },
  });
  if (!response.ok) throw new Error(`${url.pathname} returned HTTP ${response.status}`);
  const body = await response.text();
  if (!body) throw new Error(`${url.pathname} returned an empty body`);
  return body;
}

async function wasmPrefix(url) {
  const response = await fetch(url, {
    cache: 'no-store',
    redirect: 'follow',
    headers: {
      'cache-control': 'no-cache',
      range: 'bytes=0-65535',
    },
  });
  if (!response.ok) throw new Error(`${url.pathname} returned HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length < 4 || bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
    throw new Error('Live V2 prover has an invalid WebAssembly magic header');
  }
  return bytes.length;
}

async function oneAttempt(base, token) {
  const rootHtml = await text(busted(new URL('.', base), token));
  const v2Html = await text(busted(new URL('v2/', base), token));
  const v1RuntimeText = await text(busted(new URL('watcher-protocol/devnet.json', base), token));
  const v2RuntimeText = await text(busted(new URL('watcher-protocol/v2-devnet.json', base), token));
  const workerText = await text(busted(new URL('watcher-prover-v2/worker.js', base), token));

  if (!rootHtml.includes('WATCHER')) throw new Error('Live V1 root is missing its WATCHER marker');
  if (rootHtml.includes('data-watcher-v2="true"') || rootHtml.includes('PROTOCOL V2 · ISOLATED')) {
    throw new Error('Live V1 root appears to have been replaced by V2');
  }

  const chunkMatch = v2Html.match(/\/watcher-cash\/_next\/static\/chunks\/app\/v2\/page-[A-Za-z0-9]+\.js/);
  if (!chunkMatch) throw new Error('Live /v2 HTML does not reference an app/v2 page chunk');
  const chunkUrl = busted(new URL(`https://thetradoor.github.io${chunkMatch[0]}`), token);
  const v2Chunk = await text(chunkUrl);
  if (!v2Chunk.includes('Watcher Protocol')) throw new Error('Live V2 page chunk is missing its V2 marker');
  if (!v2Chunk.includes('/watcher-cash/watcher-protocol/v2-devnet.json')) {
    throw new Error('Live V2 page chunk is missing its V2 runtime binding');
  }
  if (!v2Chunk.includes('/watcher-cash/watcher-prover-v2')) {
    throw new Error('Live V2 page chunk is missing its V2 prover binding');
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
  if (workerText.length < 100) throw new Error('Live V2 browser prover worker is empty or malformed');

  const wasmBytesFetched = await wasmPrefix(busted(new URL('watcher-prover-v2/watcher-v2-prover.wasm', base), token));

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
    v2PageChunk: chunkMatch[0],
    workerBytes: Buffer.byteLength(workerText),
    wasmBytesFetched,
  };
}

async function main() {
  const base = normalizeBase(process.env.WATCHER_PAGES_URL || process.argv[2]);
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
