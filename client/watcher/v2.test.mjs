import test from 'node:test';
import assert from 'node:assert/strict';

import { noteCommitmentV1 } from './field.mjs';
import {
  MERKLE_DEPTH_V2,
  MERKLE_LEAVES_V2,
  buildSparseMerkleTreeV2,
  getMerkleAppendTransitionV2,
  getMerkleProofV2,
  verifyMerkleProofV2,
  zeroHashesV2,
} from './merkle-v2.mjs';
import { selectInputsV2 } from './selection-v2.mjs';
import { createNoteRecordV1 } from './vault.mjs';

function commitment(index, amount = 1n) {
  return noteCommitmentV1({
    assetId: 1n,
    amount,
    owner: 10_000n + BigInt(index),
    nonce: 20_000n + BigInt(index),
  });
}

function confirmed(amount, index) {
  return createNoteRecordV1({
    assetId: 1n,
    amount: BigInt(amount),
    owner: 30_000n + BigInt(index),
    nonce: 40_000n + BigInt(index),
    status: 'confirmed',
  });
}

test('V2 uses a depth-16 epoch without materializing 65,536 leaves', () => {
  assert.equal(MERKLE_DEPTH_V2, 16);
  assert.equal(MERKLE_LEAVES_V2, 65_536);
  assert.equal(zeroHashesV2().length, MERKLE_DEPTH_V2 + 1);

  const commitments = Array.from({ length: 100 }, (_, index) => commitment(index));
  const tree = buildSparseMerkleTreeV2(commitments, { epoch: 9 });
  const storedNodes = tree.levels.reduce((total, level) => total + level.size, 0);
  assert.equal(tree.count, 100);
  assert.equal(tree.epoch, 9);
  assert.ok(tree.root > 0n);
  assert.ok(storedNodes < 250, `expected sparse storage, got ${storedNodes} materialized nodes`);
});

test('V2 proofs verify against sparse zero siblings', () => {
  const commitments = [commitment(1), commitment(2), commitment(3)];
  const tree = buildSparseMerkleTreeV2(commitments);
  for (let index = 0; index < commitments.length; index += 1) {
    const proof = getMerkleProofV2(tree, index);
    assert.equal(proof.path.length, MERKLE_DEPTH_V2);
    assert.equal(proof.indexBits.length, MERKLE_DEPTH_V2);
    assert.equal(verifyMerkleProofV2({ leaf: commitments[index], ...proof }), true);
  }
});

test('V2 append transition proves the next leaf was empty', () => {
  const commitments = [commitment(1), commitment(2), commitment(3)];
  const tree = buildSparseMerkleTreeV2(commitments, { epoch: 4 });
  const nextCommitment = commitment(4);
  const transition = getMerkleAppendTransitionV2(tree, nextCommitment);
  assert.equal(transition.index, 3);
  assert.equal(transition.oldRoot, tree.root);
  assert.equal(
    verifyMerkleProofV2({
      leaf: 0n,
      path: transition.path,
      indexBits: transition.indexBits,
      root: transition.oldRoot,
    }),
    true,
  );
  assert.equal(transition.tree.count, 4);
  assert.equal(transition.tree.epoch, 4);
  assert.equal(transition.newRoot, transition.tree.root);
});

test('V2 note selector prefers exact coverage to avoid a change leaf', () => {
  const records = [confirmed(8, 1), confirmed(2, 2), confirmed(3, 3)];
  const selected = selectInputsV2(records, { publicAmount: 5n });
  assert.equal(selected.inputCount, 2);
  assert.equal(selected.total, 5n);
  assert.equal(selected.changeAmount, 0n);
  assert.equal(selected.hasChange, false);
  assert.deepEqual(selected.records.map((record) => BigInt(record.amount)), [2n, 3n]);
});

test('V2 note selector can prioritize fewer inputs when requested', () => {
  const records = [confirmed(8, 1), confirmed(2, 2), confirmed(3, 3)];
  const selected = selectInputsV2(records, { publicAmount: 5n, preferExact: false });
  assert.equal(selected.inputCount, 1);
  assert.equal(selected.total, 8n);
  assert.equal(selected.changeAmount, 3n);
  assert.equal(selected.hasChange, true);
});

test('V2 note selector supports one-input exact withdrawals', () => {
  const selected = selectInputsV2([confirmed(5, 1), confirmed(9, 2)], { publicAmount: 5n });
  assert.equal(selected.inputCount, 1);
  assert.equal(selected.changeAmount, 0n);
});

test('V2 note selector fails clearly when more than four notes are required', () => {
  const records = Array.from({ length: 5 }, (_, index) => confirmed(2, index + 1));
  assert.throws(
    () => selectInputsV2(records, { publicAmount: 9n }),
    /more than 4 private notes/,
  );
});
