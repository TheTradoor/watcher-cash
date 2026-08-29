import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair } from '@solana/web3.js';

import { prepareDepositV2, prepareWithdrawV2 } from './flows-v2.mjs';
import { buildSparseMerkleTreeV2 } from './merkle-v2.mjs';
import { selectInputsV2 } from './selection-v2.mjs';
import { noteCommitmentV1 } from './field.mjs';

const digest = 'ab'.repeat(32);
const fakeProver = async ({ expectedPublicInputs }) => ({
  proof: new Uint8Array(256).fill(7),
  publicInputs: expectedPublicInputs,
  bundleDigest: digest,
});

function accounts() {
  return {
    programId: Keypair.generate().publicKey,
    depositor: Keypair.generate().publicKey,
    config: Keypair.generate().publicKey,
    activeTree: Keypair.generate().publicKey,
    vault: Keypair.generate().publicKey,
    recipient: Keypair.generate().publicKey,
    relayer: Keypair.generate().publicKey,
    treasury: Keypair.generate().publicKey,
  };
}

function record(input) {
  return {
    ...Object.fromEntries(Object.entries(input).map(([key, value]) => [key, typeof value === 'bigint' ? value.toString(10) : value])),
    commitment: noteCommitmentV1(input).toString(10),
    status: 'confirmed',
    kind: 'deposit',
    createdAt: Date.now(),
  };
}

test('V2 browser deposit binds sparse append transition and compact instruction', async () => {
  const keys = accounts();
  const tree = buildSparseMerkleTreeV2([], { epoch: 0 });
  const note = { assetId: 1n, amount: 8_000_000n, owner: 111n, nonce: 222n };
  const prepared = await prepareDepositV2({
    accounts: keys,
    tree,
    note,
    proveDeposit: fakeProver,
  });
  assert.equal(prepared.instruction.data.length, 329);
  assert.equal(prepared.append.index, 0);
  assert.equal(prepared.append.tree.count, 1);
  assert.equal(prepared.publicInputs.length, 8 * 32);
  assert.equal(prepared.bundleDigest, digest);
  assert.equal(prepared.instruction.keys.length, 5);
});

test('V2 one-note exact browser withdrawal creates one marker and no tree append', async () => {
  const keys = accounts();
  const input = { assetId: 1n, amount: 8_000_000n, owner: 111n, nonce: 222n };
  const commitment = noteCommitmentV1(input);
  const tree = buildSparseMerkleTreeV2([commitment], { epoch: 0 });
  const records = [record(input)];
  const selection = selectInputsV2(records, {
    publicAmount: 7_999_000n,
    relayerFee: 1_000n,
  });
  assert.equal(selection.inputCount, 1);
  assert.equal(selection.hasChange, false);

  const prepared = await prepareWithdrawV2({
    accounts: keys,
    tree,
    selection,
    publicAmount: 7_999_000n,
    relayerFee: 1_000n,
    proveWithdraw: fakeProver,
  });
  assert.equal(prepared.instruction.data.length, 634);
  assert.equal(prepared.markerAccounts.length, 1);
  assert.equal(prepared.append, null);
  assert.equal(prepared.changeNote, null);
  assert.equal(prepared.publicInputs.length, 19 * 32);
  assert.equal(prepared.instruction.keys.length, 8);
  assert.equal(prepared.instruction.keys[4].isSigner, true);
});

test('V2 browser withdrawal appends private change only when selection has excess', async () => {
  const keys = accounts();
  const input = { assetId: 1n, amount: 10_000_000n, owner: 333n, nonce: 444n };
  const commitment = noteCommitmentV1(input);
  const tree = buildSparseMerkleTreeV2([commitment], { epoch: 3 });
  const selection = selectInputsV2([record(input)], { publicAmount: 6_000_000n, relayerFee: 1_000n });
  assert.equal(selection.hasChange, true);

  const prepared = await prepareWithdrawV2({
    accounts: keys,
    tree,
    selection,
    change: { assetId: 1n, owner: 555n, nonce: 666n },
    publicAmount: 6_000_000n,
    relayerFee: 1_000n,
    proveWithdraw: fakeProver,
  });
  assert(prepared.append);
  assert(prepared.changeNote);
  assert.equal(prepared.changeNote.amount, 3_999_000n);
  assert.equal(prepared.append.index, 1);
  assert.equal(prepared.witness.Change.Enabled, 1);
});
