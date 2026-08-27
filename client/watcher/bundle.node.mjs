import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const WATCHER_DEVELOPMENT_BUNDLE_URL =
  'https://github.com/TheTradoor/watcher-cash/releases/download/watcher-dev-prover/watcher-development-prover-bundle.tar.gz';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function runTar(archive, destination) {
  await new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xzf', archive, '-C', destination], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const errors = [];
    child.stderr.on('data', (chunk) => errors.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar failed: ${Buffer.concat(errors).toString('utf8')}`));
    });
  });
}

export async function verifyWatcherDevelopmentBundle(bundleDirectory) {
  const manifestPath = path.join(bundleDirectory, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.warning?.includes('DEVELOPMENT') !== true) {
    throw new Error('prover bundle is missing its development-only warning');
  }
  for (const [name, expected] of Object.entries(manifest.files_sha256 ?? {})) {
    const content = await readFile(path.join(bundleDirectory, name));
    const actual = sha256(content);
    if (actual !== expected) throw new Error(`prover bundle checksum mismatch for ${name}`);
  }
  for (const required of ['deposit.pk', 'deposit.vk', 'withdraw.pk', 'withdraw.vk']) {
    await access(path.join(bundleDirectory, required));
  }
  return manifest;
}

export async function ensureWatcherDevelopmentBundle({
  cacheDirectory,
  url = WATCHER_DEVELOPMENT_BUNDLE_URL,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!cacheDirectory) throw new TypeError('cacheDirectory is required');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is unavailable');
  const target = path.resolve(cacheDirectory, 'local-prover');
  try {
    await verifyWatcherDevelopmentBundle(target);
    return target;
  } catch {
    // Missing, partial or stale cache. Rebuild it atomically below.
  }

  const temporary = await mkdtemp(path.join(tmpdir(), 'watcher-prover-download-'));
  try {
    const response = await fetchImpl(url);
    if (!response.ok) throw new Error(`failed to download prover bundle: HTTP ${response.status}`);
    const archive = path.join(temporary, 'bundle.tar.gz');
    await writeFile(archive, new Uint8Array(await response.arrayBuffer()), { mode: 0o600 });
    await runTar(archive, temporary);
    const extracted = path.join(temporary, 'local-prover');
    await verifyWatcherDevelopmentBundle(extracted);

    await rm(target, { recursive: true, force: true });
    await rename(extracted, target);
    return target;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
