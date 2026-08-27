import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WatcherProtocolError,
  calculateProtocolFee,
  calculateWithdrawalValue,
  createNoteDraft,
  deriveCommitment,
} from './index.js';

test('protocol fee uses basis points with integer base units', () => {
  assert.equal(calculateProtocolFee(1_000_000n, 20), 2_000n);
  assert.equal(calculateProtocolFee(1_000_000n, 20, 5_000n), 5_000n);
});

test('value conservation accepts an exact transition', () => {
  const result = calculateWithdrawalValue({
    inputs: [700n, 300n],
    publicOutput: 800n,
    privateChange: 150n,
    protocolFee: 30n,
    relayerFee: 20n,
  });
  assert.equal(result.inputTotal, 1_000n);
  assert.equal(result.outputTotal, 1_000n);
});

test('value conservation rejects value creation', () => {
  assert.throws(
    () => calculateWithdrawalValue({
      inputs: [1_000n],
      publicOutput: 1_001n,
      privateChange: 0n,
      protocolFee: 0n,
      relayerFee: 0n,
    }),
    (error) => error instanceof WatcherProtocolError && error.code === 'VALUE_CONSERVATION_FAILED',
  );
});

test('note draft preserves bigint amount and copies secret byte arrays', () => {
  const ownerKey = new Uint8Array([1, 2, 3]);
  const blinding = new Uint8Array(32).fill(7);
  const nonce = new Uint8Array(32).fill(9);
  const note = createNoteDraft({ asset: 'SOL', amount: 42n, ownerKey, blinding, nonce });
  ownerKey[0] = 99;
  assert.equal(note.amount, 42n);
  assert.equal(note.ownerKey[0], 1);
});

test('unfinished cryptography fails closed', () => {
  assert.throws(
    () => deriveCommitment(),
    (error) => error instanceof WatcherProtocolError && error.code === 'CRYPTO_NOT_FINALIZED',
  );
});
