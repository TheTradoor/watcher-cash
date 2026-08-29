#!/usr/bin/env node

import { chromium } from 'playwright';

const pageUrl = process.env.WATCHER_V3_LAZY_PERF_URL || 'http://127.0.0.1:3000/';
const basePath = process.env.WATCHER_V3_LAZY_PERF_BASE || '/watcher-prover-v3';
const timeout = Number(process.env.WATCHER_V3_LAZY_PERF_TIMEOUT_MS || 240_000);

function fail(message) { throw new Error(message); }

async function initCircuit(page, circuit) {
  return page.evaluate(({ base, circuitName, requestTimeout }) => new Promise((resolve, reject) => {
    const worker = new Worker(`${base}/worker.js`, { name: `watcher-v3-lazy-perf-${circuitName}` });
    const id = Math.floor(Math.random() * 1_000_000_000);
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error(`${circuitName} initialization timed out`));
    }, requestTimeout);
    worker.onerror = (event) => {
      clearTimeout(timer);
      worker.terminate();
      reject(new Error(event?.message || `${circuitName} worker crashed`));
    };
    worker.onmessage = (event) => {
      const message = event.data || {};
      if (message.id !== id) return;
      clearTimeout(timer);
      worker.terminate();
      if (message.type === 'error') reject(new Error(message.error || `${circuitName} initialization failed`));
      else resolve(message.payload || {});
    };
    worker.postMessage({ id, type: 'init', payload: { basePath: base, circuit: circuitName } });
  }), { base: basePath, circuitName: circuit, requestTimeout: timeout });
}

function metrics(result, label) {
  if (result?.status !== 'ready' || result?.version !== 3 || !result.performance) {
    fail(`${label} did not return V3 performance metadata`);
  }
  const info = result.performance;
  if (info.circuit !== label) fail(`${label} returned metrics for ${info.circuit}`);
  for (const field of ['runtimeMs', 'manifestMs', 'assetLoadMs', 'deserializeMs', 'totalInitMs']) {
    if (!Number.isFinite(Number(info[field])) || Number(info[field]) < 0) fail(`${label} ${field} is invalid`);
  }
  if (!Number.isInteger(info.cacheHits) || !Number.isInteger(info.cacheMisses)) fail(`${label} cache counters are invalid`);
  if (info.cacheHits + info.cacheMisses !== 3) fail(`${label} must verify exactly three circuit assets`);
  return info;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout });
    const deposit = metrics(await initCircuit(page, 'deposit'), 'deposit');
    const withdraw = metrics(await initCircuit(page, 'withdraw'), 'withdraw');
    const cacheState = await page.evaluate(async () => {
      const names = (await caches.keys()).filter((name) => name.startsWith('watcher-v3-zk-assets-v2-'));
      let entries = 0;
      for (const name of names) entries += (await (await caches.open(name)).keys()).length;
      return { namespaces: names.length, entries };
    });
    if (cacheState.namespaces !== 1 || cacheState.entries !== 6) {
      fail(`expected one integrity-bound cache with six circuit assets, got ${JSON.stringify(cacheState)}`);
    }
    console.log(JSON.stringify({
      status: 'pass',
      deposit: {
        totalInitMs: deposit.totalInitMs,
        deserializeMs: deposit.deserializeMs,
        assetLoadMs: deposit.assetLoadMs,
        cacheHits: deposit.cacheHits,
        cacheMisses: deposit.cacheMisses,
      },
      withdraw: {
        totalInitMs: withdraw.totalInitMs,
        deserializeMs: withdraw.deserializeMs,
        assetLoadMs: withdraw.assetLoadMs,
        cacheHits: withdraw.cacheHits,
        cacheMisses: withdraw.cacheMisses,
      },
      cacheState,
      note: 'Each worker deserializes exactly one circuit; proof system and verifying keys are unchanged.',
    }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
