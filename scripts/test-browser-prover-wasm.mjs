#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import vm from 'node:vm';

const [bundleDirectoryArg, wasmPathArg, wasmExecPathArg] = process.argv.slice(2);
if (!bundleDirectoryArg || !wasmPathArg || !wasmExecPathArg) {
  console.error('usage: node scripts/test-browser-prover-wasm.mjs <bundle-dir> <wasm> <wasm_exec.js>');
  process.exit(2);
}

const bundleDirectory = resolve(bundleDirectoryArg);
const wasmPath = resolve(wasmPathArg);
const wasmExecPath = resolve(wasmExecPathArg);
const requiredAssets = [
  'deposit.r1cs', 'deposit.pk', 'deposit.vk',
  'withdraw.r1cs', 'withdraw.pk', 'withdraw.vk',
];

async function waitFor(predicate, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`${label} timed out`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
}

function normalizeIndexBits(witness, label) {
  const value = witness[label];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((bit, index) => {
    const normalized = Number(bit);
    if (!Number.isInteger(normalized) || (normalized !== 0 && normalized !== 1)) {
      throw new Error(`${label}[${index}] must be 0 or 1`);
    }
    return normalized;
  });
}

async function main() {
  const wasmExec = await readFile(wasmExecPath, 'utf8');
  vm.runInThisContext(wasmExec, { filename: wasmExecPath });
  assert.equal(typeof globalThis.Go, 'function', 'wasm_exec.js did not register Go');

  const go = new globalThis.Go();
  const wasm = await readFile(wasmPath);
  const { instance } = await WebAssembly.instantiate(wasm, go.importObject);
  const runtime = go.run(instance);
  runtime.catch((error) => {
    console.error('Go WebAssembly runtime stopped:', error);
    process.exitCode = 1;
  });
  await waitFor(() => globalThis.watcherProverRuntimeReady === true, 'Go prover runtime');

  const assets = {};
  for (const name of requiredAssets) {
    assets[name] = Uint8Array.from(await readFile(resolve(bundleDirectory, name)));
  }
  const ready = JSON.parse(globalThis.watcherProverLoadBundle(assets));
  assert.equal(ready.error, undefined);
  assert.equal(ready.status, 'ready');
  assert.match(ready.bundleDigest, /^[0-9a-f]{64}$/);

  const depositWitness = JSON.parse(await readFile(
    resolve(bundleDirectory, 'sample-deposit-0-witness.json'),
    'utf8',
  ));
  depositWitness.Index = normalizeIndexBits(depositWitness, 'Index');
  const deposit = JSON.parse(
    globalThis.watcherProverProveDeposit(JSON.stringify(depositWitness)),
  );
  assert.equal(deposit.error, undefined);
  assert.equal(deposit.proofBytes, 256);
  assert.equal(deposit.publicInputBytes, 192);
  assert.deepEqual(
    Buffer.from(deposit.publicInputsHex, 'hex'),
    await readFile(resolve(bundleDirectory, 'sample-deposit-0-public-inputs.bin')),
  );

  const withdrawWitness = JSON.parse(await readFile(
    resolve(bundleDirectory, 'sample-withdraw-witness.json'),
    'utf8',
  ));
  // The setup fixture stores every witness value as a decimal string for
  // deterministic JSON. The browser client emits numeric index bits, so
  // normalize every uint8 path-index array before exercising the same decoder.
  withdrawWitness.Input0Index = normalizeIndexBits(withdrawWitness, 'Input0Index');
  withdrawWitness.Input1Index = normalizeIndexBits(withdrawWitness, 'Input1Index');
  withdrawWitness.ChangeIndex = normalizeIndexBits(withdrawWitness, 'ChangeIndex');
  const withdrawal = JSON.parse(
    globalThis.watcherProverProveWithdraw(JSON.stringify(withdrawWitness)),
  );
  assert.equal(withdrawal.error, undefined);
  assert.equal(withdrawal.proofBytes, 256);
  assert.equal(withdrawal.publicInputBytes, 416);
  assert.deepEqual(
    Buffer.from(withdrawal.publicInputsHex, 'hex'),
    await readFile(resolve(bundleDirectory, 'sample-withdraw-public-inputs.bin')),
  );
  assert.equal(withdrawal.bundleDigest, ready.bundleDigest);

  console.log(JSON.stringify({
    status: 'PASS',
    bundleDigest: ready.bundleDigest,
    depositProofBytes: deposit.proofBytes,
    depositPublicInputBytes: deposit.publicInputBytes,
    withdrawalProofBytes: withdrawal.proofBytes,
    withdrawalPublicInputBytes: withdrawal.publicInputBytes,
  }, null, 2));
  // The Go entrypoint intentionally blocks forever after registering its JS
  // bridge. Exit explicitly once the proof assertions are complete.
  process.exit(0);
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
