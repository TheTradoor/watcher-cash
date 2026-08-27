import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { proveDepositLocally, proveWithdrawLocally } from './prover.node.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(directory, '..', '..');
const fakeProver = path.join(directory, 'testdata', 'fake-prover.mjs');

async function withBundle(run) {
  const bundle = await mkdtemp(path.join(tmpdir(), 'watcher-fake-bundle-'));
  try {
    for (const circuit of ['deposit', 'withdraw']) {
      await writeFile(path.join(bundle, `${circuit}.pk`), 'fake');
      await writeFile(path.join(bundle, `${circuit}.vk`), 'fake');
    }
    return await run(bundle);
  } finally {
    await rm(bundle, { recursive: true, force: true });
  }
}

test('deposit proving remains local and returns strict wire lengths', async () => {
  await withBundle(async (bundleDirectory) => {
    const result = await proveDepositLocally({
      witness: { ownerBigInt: 123456789n },
      bundleDirectory,
      command: [process.execPath, fakeProver],
      repositoryRoot,
    });
    assert.equal(result.proof.length, 256);
    assert.equal(result.publicInputs.length, 96);
    assert.equal(result.proof[0], 1);
    assert.equal(result.publicInputs[0], 3);
    assert.equal(result.manifest.circuit, 'deposit');
  });
});

test('withdraw proving uses the ten-field public-input wire format', async () => {
  await withBundle(async (bundleDirectory) => {
    const result = await proveWithdrawLocally({
      witness: { ownerBigInt: 123456789n },
      bundleDirectory,
      command: [process.execPath, fakeProver],
      repositoryRoot,
    });
    assert.equal(result.proof.length, 256);
    assert.equal(result.publicInputs.length, 320);
    assert.equal(result.proof[0], 2);
    assert.equal(result.publicInputs[0], 4);
  });
});

test('invalid circuit selection fails before spawning a process', async () => {
  await assert.rejects(
    () =>
      proveDepositLocally({
        witness: null,
        bundleDirectory: '/tmp/none',
        command: [process.execPath, fakeProver],
        repositoryRoot,
      }),
    /witness must be an object/,
  );
});
