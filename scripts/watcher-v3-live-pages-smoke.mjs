#!/usr/bin/env node

import fs from 'node:fs';

// This file is also an explicit, V3-only Pages overlay trigger path.
const EXPECTED_V1_PROGRAM_ID = '9urFwd6gEYwkc5Dc8YYakYCX4VEosCRdgfQAz88fYEv5';
const EXPECTED_V2_PROGRAM_ID = 'DMU22YyGkLs9cuZXR6eHt4oZpWtMTMtkCNTNV8SW16HM';
const DEFAULT_BASE_URL = 'https://thetradoor.github.io/watcher-cash/';
const expectedRuntimePath = process.env.WATCHER_V3_EXPECTED_RUNTIME || 'public/watcher-protocol/v3-devnet.json';

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
    headers: { 'cache-control': 'no-cache', range: 'bytes=0-65535' },
  });
  if (!response.ok) throw new Error(`${url.pathname} returned HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length < 4 || bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
    throw new Error('Live V3 prover has an invalid WebAssembly magic header');
  }
  return bytes.length;
}

function expectedV3() {
  if (!fs.existsSync(expectedRuntimePath)) throw new Error(`Expected V3 runtime missing: ${expectedRuntimePath}`);
  return JSON.parse(fs.readFileSync(expectedRuntimePath, 'utf8'));
}

async function oneAttempt(base, token) {
  const expected = expectedV3();
  const [rootHtml, v2Html, v3Html, v1RuntimeText, v2RuntimeText, v3RuntimeText, workerText] = await Promise.all([
    text(busted(new URL('.', base), token)),
    text(busted(new URL('v2/', base), token)),
    text(busted(new URL('v3/', base), token)),
    text(busted(new URL('watcher-protocol/devnet.json', base), token)),
    text(busted(new URL('watcher-protocol/v2-devnet.json', base), token)),
    text(busted(new URL('watcher-protocol/v3-devnet.json', base), token)),
    text(busted(new URL('watcher-prover-v3/worker.js', base), token)),
  ]);

  if (!rootHtml.includes('WATCHER')) throw new Error('Live V1 root is missing its WATCHER marker');
  if (rootHtml.includes('PROTOCOL V2 · ISOLATED') || rootHtml.includes('PROTOCOL V3 · ISOLATED')) {
    throw new Error('Live V1 root appears to have been replaced by an overlay');
  }
  if (!v2Html.includes('/watcher-cash/_next/')) throw new Error('Live /v2 route is missing Next.js chunks');

  const chunkMatch = v3Html.match(/\/watcher-cash\/_next\/static\/chunks\/app\/v3\/page-[A-Za-z0-9]+\.js/);
  if (!chunkMatch) throw new Error('Live /v3 HTML does not reference an app/v3 page chunk');
  const v3Chunk = await text(busted(new URL(`https://thetradoor.github.io${chunkMatch[0]}`), token));
  if (!v3Chunk.includes('Watcher Protocol')) throw new Error('Live V3 page chunk is missing its protocol marker');
  if (!v3Chunk.includes('/watcher-cash/watcher-protocol/v3-devnet.json')) {
    throw new Error('Live V3 page chunk is missing its V3 runtime binding');
  }
  if (!v3Chunk.includes('/watcher-cash/watcher-prover-v3')) {
    throw new Error('Live V3 page chunk is missing its V3 prover binding');
  }

  const v1 = JSON.parse(v1RuntimeText);
  const v2 = JSON.parse(v2RuntimeText);
  const v3 = JSON.parse(v3RuntimeText);
  if (v1.programId !== EXPECTED_V1_PROGRAM_ID || v1.status !== 'ready' || v1.cluster !== 'devnet') {
    throw new Error('Live V1 runtime changed unexpectedly');
  }
  if (v2.programId !== EXPECTED_V2_PROGRAM_ID || v2.status !== 'ready' || v2.network !== 'devnet') {
    throw new Error('Live V2 runtime changed unexpectedly');
  }
  if (v3.programId !== expected.programId || v3.status !== 'ready' || v3.network !== 'devnet') {
    throw new Error(`Live V3 runtime mismatch: ${JSON.stringify({ expected: expected.programId, actual: v3.programId, status: v3.status, network: v3.network })}`);
  }
  if (Number(v3.version) !== 3 || Number(v3.treeDepth) !== 16 || Number(v3.treeCapacity) !== 65_536) {
    throw new Error('Live V3 runtime has unexpected protocol/tree dimensions');
  }
  if (Number(v3.nullifierShardCount) !== 32 || Number(v3.nullifierBucketsPerShard) !== 2048 || Number(v3.nullifierRecordBytes) !== 36) {
    throw new Error('Live V3 runtime has unexpected packed-nullifier geometry');
  }
  if (!Array.isArray(v3.nullifierShards) || v3.nullifierShards.length !== 32) {
    throw new Error('Live V3 runtime does not expose all 32 packed nullifier shards');
  }
  if (v3.proverBasePath !== '/watcher-cash/watcher-prover-v3') {
    throw new Error('Live V3 runtime exposes the wrong GitHub Pages prover base path');
  }
  if (workerText.length < 100) throw new Error('Live V3 browser prover worker is empty or malformed');
  if (!workerText.includes('watcher-v3-zk-assets-v2-') || !workerText.includes('watcherProverV3LoadCircuit')) {
    throw new Error('Live V3 worker is not the circuit-scoped integrity-cache worker');
  }
  const wasmBytesFetched = await wasmPrefix(busted(new URL('watcher-prover-v3/watcher-v3-prover.wasm', base), token));

  return {
    status: 'pass',
    baseUrl: base.toString(),
    v1ProgramId: v1.programId,
    v2ProgramId: v2.programId,
    v3ProgramId: v3.programId,
    v3Config: v3.config,
    v3ActiveTree: v3.activeTree,
    v3Vault: v3.vault,
    v3NullifierShardCount: v3.nullifierShardCount,
    v3PageChunk: chunkMatch[0],
    proverMode: 'circuit-scoped',
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
      console.error(`[v3-live-pages-smoke] attempt ${attempt}/${attempts}: ${error?.message || error}`);
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError || new Error('V3 live Pages smoke failed');
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
