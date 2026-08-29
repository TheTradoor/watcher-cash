#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const pinPath = resolve(process.env.WATCHER_V2_PROVER_PIN || 'public/watcher-protocol/v2-prover-pin.json');
const outputRoot = resolve(process.env.WATCHER_V2_PROVER_PUBLIC_ROOT || 'public');
const outputDir = resolve(outputRoot, 'watcher-prover-v2');
const tempArchive = resolve(process.env.RUNNER_TEMP || '/tmp', `watcher-v2-pinned-${process.pid}.tar.gz`);
const expectedRepo = process.env.GITHUB_REPOSITORY || 'TheTradoor/watcher-cash';

function fail(message) {
  throw new Error(message);
}

function requireString(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} is missing`);
  return value.trim();
}

function loadPin() {
  if (!existsSync(pinPath)) fail(`V2 prover pin file was not found: ${pinPath}`);
  let pin;
  try {
    pin = JSON.parse(readFileSync(pinPath, 'utf8'));
  } catch {
    fail('V2 prover pin file is not valid JSON');
  }
  if (pin?.version !== 2 || pin?.status !== 'pinned-development-setup') {
    fail('V2 prover pin has an unsupported version or status');
  }
  if (pin.curve !== 'BN254' || pin.scheme !== 'Groth16') fail('V2 prover pin has the wrong proof system');
  if (Number(pin.treeDepth) !== 16 || Number(pin.maxInputs) !== 4) fail('V2 prover pin has unexpected circuit dimensions');
  const releaseTag = requireString(pin.releaseTag, 'releaseTag');
  const bundleFile = requireString(pin.bundleFile, 'bundleFile');
  const bundleSha256 = requireString(pin.bundleSha256, 'bundleSha256').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(bundleSha256)) fail('bundleSha256 must be a SHA-256 digest');
  if (!/^watcher-v2-devnet-prover-[0-9a-f]{16}$/.test(releaseTag)) fail('releaseTag is not content-addressed');
  if (releaseTag.slice(-16) !== bundleSha256.slice(0, 16)) fail('releaseTag does not match bundle SHA-256');
  if (bundleFile !== 'watcher-v2-devnet-browser-bundle.tar.gz') fail('Unexpected V2 prover bundle filename');
  const expectedUrl = `https://github.com/${expectedRepo}/releases/download/${releaseTag}/${bundleFile}`;
  if (pin.bundleUrl !== expectedUrl) fail('V2 prover bundle URL is not the expected repository release URL');
  for (const field of ['depositVkSha256', 'withdrawVkSha256']) {
    const digest = requireString(pin[field], field).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(digest)) fail(`${field} must be a SHA-256 digest`);
  }
  return Object.freeze({ ...pin, releaseTag, bundleFile, bundleSha256, bundleUrl: expectedUrl });
}

async function download(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) fail(`Pinned V2 prover download failed with HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length === 0) fail('Pinned V2 prover bundle download was empty');
  return bytes;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function verifyExtracted(pin) {
  const required = [
    'watcher-v2-prover.wasm',
    'wasm_exec.js',
    'worker.js',
    'assets/manifest.json',
    'assets/deposit.r1cs',
    'assets/deposit.pk',
    'assets/deposit.vk',
    'assets/withdraw.r1cs',
    'assets/withdraw.pk',
    'assets/withdraw.vk',
  ];
  for (const name of required) {
    const path = resolve(outputDir, name);
    if (!existsSync(path)) fail(`Pinned V2 prover bundle is missing ${name}`);
  }
  const manifest = JSON.parse(readFileSync(resolve(outputDir, 'assets/manifest.json'), 'utf8'));
  if (Number(manifest.version) !== 2 || manifest.curve !== 'BN254' || manifest.scheme !== 'Groth16') {
    fail('Pinned V2 browser manifest describes the wrong proof system');
  }
  if (Number(manifest.merkleDepth) !== 16 || Number(manifest.maxInputs) !== 4) {
    fail('Pinned V2 browser manifest has unexpected circuit dimensions');
  }
  const files = manifest.filesSha256 || manifest.files_sha256 || manifest.files || {};
  if (String(files['deposit.vk'] || '').toLowerCase() !== pin.depositVkSha256.toLowerCase()) {
    fail('Pinned deposit VK hash does not match the browser bundle manifest');
  }
  if (String(files['withdraw.vk'] || '').toLowerCase() !== pin.withdrawVkSha256.toLowerCase()) {
    fail('Pinned withdrawal VK hash does not match the browser bundle manifest');
  }
  return manifest;
}

async function main() {
  const pin = loadPin();
  const archive = await download(pin.bundleUrl);
  const actual = sha256(archive);
  if (actual !== pin.bundleSha256) {
    fail(`Pinned V2 prover SHA-256 mismatch: got ${actual}, expected ${pin.bundleSha256}`);
  }
  mkdirSync(dirname(tempArchive), { recursive: true });
  writeFileSync(tempArchive, archive);
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputRoot, { recursive: true });
  const extracted = spawnSync('tar', ['-xzf', tempArchive, '-C', outputRoot], { encoding: 'utf8' });
  rmSync(tempArchive, { force: true });
  if (extracted.status !== 0) fail(`Failed to extract pinned V2 prover bundle: ${extracted.stderr || extracted.stdout}`);
  const manifest = verifyExtracted(pin);
  console.log(JSON.stringify({
    status: 'ready',
    releaseTag: pin.releaseTag,
    bundleSha256: actual,
    depositVkSha256: pin.depositVkSha256,
    withdrawVkSha256: pin.withdrawVkSha256,
    merkleDepth: manifest.merkleDepth,
    maxInputs: manifest.maxInputs,
    outputDir,
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
