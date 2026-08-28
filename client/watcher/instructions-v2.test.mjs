import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';

import {
  WATCHER_DEPOSIT_DATA_BYTES_V2,
  WATCHER_WITHDRAW_DATA_BYTES_V2,
  deriveNullifierMarkerPdaV2,
  encodeDepositDataV2,
  encodeWithdrawDataV2,
} from './instructions-v2.mjs';

function field(value) {
  const output = new Uint8Array(32);
  output[0] = value;
  return output;
}

function withdrawFixture(inputCount = 4, hasChange = true) {
  const roots = Array.from({ length: 4 }, (_, index) => index < inputCount ? field(10 + index) : new Uint8Array(32));
  const nullifiers = Array.from({ length: 4 }, (_, index) => index < inputCount ? field(20 + index) : new Uint8Array(32));
  return {
    inputCount,
    inputRoots: roots,
    nullifiers,
    changeCommitment: hasChange ? field(30) : new Uint8Array(32),
    recipient: Keypair.generate().publicKey,
    publicAmount: 5_000_000n,
    protocolFee: 0n,
    relayerFee: 1_000n,
    newRoot: hasChange ? field(31) : new Uint8Array(32),
    proof: new Uint8Array(256).fill(7),
  };
}

test('V2 deposit wire is fixed at 329 bytes without duplicated public inputs', () => {
  const data = encodeDepositDataV2({
    commitment: field(1),
    amount: 1_000_000n,
    newRoot: field(2),
    proof: new Uint8Array(256).fill(3),
  });
  assert.equal(data.length, WATCHER_DEPOSIT_DATA_BYTES_V2);
  assert.equal(data.length, 329);
  assert.equal(data[0], 0x20);
  assert.equal(data[1], 1);
  assert.equal(data[33], 0x40); // 1_000_000 little-endian low byte
  assert.equal(data[41], 2);
});

test('V2 four-input withdrawal wire is fixed at 634 bytes', () => {
  const data = encodeWithdrawDataV2(withdrawFixture(4, true));
  assert.equal(data.length, WATCHER_WITHDRAW_DATA_BYTES_V2);
  assert.equal(data.length, 634);
  assert.equal(data[0], 0x21);
  assert.equal(data[1], 4);
  assert.equal(data[2], 10);
  assert.equal(data[2 + (32 * 4)], 20);
});

test('V2 one-input exact withdrawal uses zero inactive slots and no new root', () => {
  const fixture = withdrawFixture(1, false);
  const data = encodeWithdrawDataV2(fixture);
  assert.equal(data.length, 634);
  assert.equal(data[1], 1);
});

test('V2 encoder rejects a nonzero inactive slot', () => {
  const fixture = withdrawFixture(1, false);
  fixture.inputRoots[2] = field(99);
  assert.throws(() => encodeWithdrawDataV2(fixture), /inactive V2 proof slots/);
});

test('V2 encoder rejects duplicate active nullifiers', () => {
  const fixture = withdrawFixture(2, true);
  fixture.nullifiers[1] = fixture.nullifiers[0];
  assert.throws(() => encodeWithdrawDataV2(fixture), /duplicate active V2 nullifier/);
});

test('V2 exact withdrawal cannot smuggle a new active root', () => {
  const fixture = withdrawFixture(1, false);
  fixture.newRoot = field(99);
  assert.throws(() => encodeWithdrawDataV2(fixture), /both be zero or both be non-zero/);
});

test('V2 nullifier marker PDA is deterministic and config-scoped', () => {
  const programId = Keypair.generate().publicKey;
  const configA = Keypair.generate().publicKey;
  const configB = Keypair.generate().publicKey;
  const nullifier = field(88);
  const [first] = deriveNullifierMarkerPdaV2({ programId, config: configA, nullifier });
  const [second] = deriveNullifierMarkerPdaV2({ programId, config: configA, nullifier });
  const [otherConfig] = deriveNullifierMarkerPdaV2({ programId, config: configB, nullifier });
  assert.equal(first.toBase58(), second.toBase58());
  assert.notEqual(first.toBase58(), otherConfig.toBase58());
});
