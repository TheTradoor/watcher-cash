import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair } from '@solana/web3.js';

import { noteCommitmentV1 } from './field.mjs';
import { prepareDepositV3, prepareWithdrawV3 } from './flows-v3.mjs';
import { buildSparseMerkleTreeV2 } from './merkle-v2.mjs';
import { selectInputsV2 } from './selection-v2.mjs';
import {
  WATCHER_INSTRUCTION_WITHDRAW_V3,
  deriveNullifierShardForSpendV3,
} from './instructions-v3.mjs';

const digest = 'cd'.repeat(32);
const fakeProver = async ({ expectedPublicInputs }) => ({
  proof: new Uint8Array(256).fill(9),
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

test('V3 browser deposit deliberately preserves the proven V2 deposit wire', async () => {
  const keys = accounts();
  const tree = buildSparseMerkleTreeV2([], { epoch: 0 });
  const prepared = await prepareDepositV3({
    accounts: keys,
    tree,
    note: { assetId: 1n, amount: 8_000_000n, owner: 11n, nonce: 22n },
    proveDeposit: fakeProver,
  });
  assert.equal(prepared.instruction.data[0], 0x20);
  assert.equal(prepared.instruction.data.length, 329);
  assert.equal(prepared.bundleDigest, digest);
});

test('V3 browser withdrawal reuses proof-bound V2 witness but routes replay state to exact shards', async () => {
  const keys = accounts();
  const input = { assetId: 1n, amount: 8_000_000n, owner: 111n, nonce: 222n };
  const tree = buildSparseMerkleTreeV2([noteCommitmentV1(input)], { epoch: 0 });
  const selection = selectInputsV2([record(input)], { publicAmount: 8_000_000n });
  const prepared = await prepareWithdrawV3({
    accounts: keys,
    tree,
    selection,
    publicAmount: 8_000_000n,
    proveWithdraw: fakeProver,
  });

  assert.equal(prepared.instruction.data[0], WATCHER_INSTRUCTION_WITHDRAW_V3);
  assert.equal(prepared.instruction.data.length, 634);
  assert.equal(prepared.shardAccounts.length, 1);
  assert.equal(prepared.shardRoutes.length, 1);
  assert.equal('markerAccounts' in prepared, false);
  assert.equal(prepared.append, null);
  assert.equal(prepared.publicInputs.length, 19 * 32);

  const expected = deriveNullifierShardForSpendV3({
    programId: keys.programId,
    config: keys.config,
    nullifier: prepared.nullifiers[0],
  });
  assert.equal(prepared.shardAccounts[0].toBase58(), expected.pubkey.toBase58());
  assert.equal(prepared.instruction.keys[7].pubkey.toBase58(), expected.pubkey.toBase58());
});

test('V3 browser private-change withdrawal keeps the same proof-bound append semantics', async () => {
  const keys = accounts();
  const input = { assetId: 1n, amount: 10_000_000n, owner: 333n, nonce: 444n };
  const tree = buildSparseMerkleTreeV2([noteCommitmentV1(input)], { epoch: 5 });
  const selection = selectInputsV2([record(input)], { publicAmount: 6_000_000n });
  const prepared = await prepareWithdrawV3({
    accounts: keys,
    tree,
    selection,
    change: { assetId: 1n, owner: 555n, nonce: 666n },
    publicAmount: 6_000_000n,
    proveWithdraw: fakeProver,
  });

  assert(prepared.append);
  assert(prepared.changeNote);
  assert.equal(prepared.changeNote.amount, 4_000_000n);
  assert.equal(prepared.append.index, 1);
  assert.equal(prepared.witness.Change.Enabled, 1);
  assert.equal(prepared.instruction.data[0], WATCHER_INSTRUCTION_WITHDRAW_V3);
});
