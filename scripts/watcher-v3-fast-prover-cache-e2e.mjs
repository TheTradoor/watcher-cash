#!/usr/bin/env node

import { chromium } from 'playwright';

const pageUrl = process.env.WATCHER_V3_CACHE_E2E_URL || 'http://127.0.0.1:3000/';
const basePath = process.env.WATCHER_V3_CACHE_E2E_PROVER_BASE || '/watcher-prover-v3';
const timeout = Number(process.env.WATCHER_V3_CACHE_E2E_TIMEOUT_MS || 180_000);
const CACHE_PREFIX = 'watcher-v3-zk-assets-v1-';

function fail(message) {
  throw new Error(message);
}

async function initializeFreshWorker(page) {
  return page.evaluate(({ proverBase, requestTimeout }) => new Promise((resolve, reject) => {
    const worker = new Worker(`${proverBase}/worker.js`, { name: `watcher-v3-cache-test-${Date.now()}` });
    const id = Math.floor(Math.random() * 1_000_000_000);
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error('V3 fast prover worker initialization timed out'));
    }, requestTimeout);
    worker.onerror = (event) => {
      clearTimeout(timer);
      worker.terminate();
      reject(new Error(event?.message || 'V3 fast prover worker crashed'));
    };
    worker.onmessage = (event) => {
      const message = event.data || {};
      if (message.id !== id) return;
      clearTimeout(timer);
      worker.terminate();
      if (message.type === 'error') reject(new Error(message.error || 'V3 fast prover initialization failed'));
      else resolve(message.payload || {});
    };
    worker.postMessage({ id, type: 'init', payload: { basePath: proverBase } });
  }), { proverBase: basePath, requestTimeout: timeout });
}

function requirePerformance(result, label) {
  if (result?.status !== 'ready' || !result.performance) fail(`${label} did not return ready performance metadata`);
  const info = result.performance;
  if (!Number.isInteger(info.cacheHits) || !Number.isInteger(info.cacheMisses)) {
    fail(`${label} cache counters are invalid`);
  }
  if (!/^[0-9a-f]{64}$/i.test(String(info.manifestDigest || ''))) {
    fail(`${label} manifest digest is invalid`);
  }
  return info;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout });

    const first = requirePerformance(await initializeFreshWorker(page), 'first initialization');
    if (first.cacheHits !== 0 || first.cacheMisses !== 6) {
      fail(`first initialization expected 0 cache hits / 6 misses, got ${first.cacheHits}/${first.cacheMisses}`);
    }

    const corrupted = await page.evaluate(async (prefix) => {
      const names = (await caches.keys()).filter((name) => name.startsWith(prefix));
      if (names.length !== 1) throw new Error(`expected exactly one V3 cache namespace, found ${names.length}`);
      const cache = await caches.open(names[0]);
      const keys = await cache.keys();
      if (keys.length !== 6) throw new Error(`expected 6 verified proving assets in cache, found ${keys.length}`);
      const target = keys[0];
      await cache.put(target, new Response(Uint8Array.of(0xde, 0xad, 0xbe, 0xef), {
        headers: { 'content-type': 'application/octet-stream' },
      }));
      return { cacheName: names[0], target: target.url, entries: keys.length };
    }, CACHE_PREFIX);

    const repaired = requirePerformance(await initializeFreshWorker(page), 'repair initialization');
    if (repaired.manifestDigest !== first.manifestDigest) fail('manifest changed during cache integrity test');
    if (repaired.cacheHits !== 5 || repaired.cacheMisses !== 1) {
      fail(`corrupt-cache repair expected 5 hits / 1 miss, got ${repaired.cacheHits}/${repaired.cacheMisses}`);
    }

    const warm = requirePerformance(await initializeFreshWorker(page), 'warm initialization');
    if (warm.manifestDigest !== first.manifestDigest) fail('manifest changed before warm-cache verification');
    if (warm.cacheHits !== 6 || warm.cacheMisses !== 0) {
      fail(`warm initialization expected 6 hits / 0 misses, got ${warm.cacheHits}/${warm.cacheMisses}`);
    }

    console.log(JSON.stringify({
      status: 'pass',
      cacheNamespace: corrupted.cacheName,
      cachedAssets: corrupted.entries,
      corruptionTarget: corrupted.target,
      first: {
        cacheHits: first.cacheHits,
        cacheMisses: first.cacheMisses,
        totalInitMs: first.totalInitMs,
        assetLoadMs: first.assetLoadMs,
      },
      repaired: {
        cacheHits: repaired.cacheHits,
        cacheMisses: repaired.cacheMisses,
        totalInitMs: repaired.totalInitMs,
        assetLoadMs: repaired.assetLoadMs,
      },
      warm: {
        cacheHits: warm.cacheHits,
        cacheMisses: warm.cacheMisses,
        totalInitMs: warm.totalInitMs,
        assetLoadMs: warm.assetLoadMs,
      },
      manifestDigest: warm.manifestDigest,
      security: 'cached bytes were SHA-256 revalidated; corrupted entry was rejected and repaired from network',
    }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
