import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey, SystemProgram } from '@solana/web3.js';

import {
  WATCHER_DEPOSIT_PUBLIC_INPUT_BYTES,
  WATCHER_GROTH16_PROOF_BYTES,
  WATCHER_WITHDRAW_PUBLIC_INPUT_BYTES,
  buildDepositInstruction,
  buildInitializeInstruction,
  buildWithdrawInstruction,
  deriveWatcherVaultPda,
  encodeDepositData,
  encodeWithdrawData,
} from './instructions.mjs';

function key(value) {
  return new PublicKey(new Uint8Array(32).fill(value));
}

function bytes(length, value) {
  return new Uint8Array(length).fill(value);
}

test('deposit payload matches the Rust codec layout', () => {
  const commitment = bytes(32, 7);
  const proof = bytes(WATCHER_GROTH16_PROOF_BYTES, 8);
  const publicInputs = bytes(WATCHER_DEPOSIT_PUBLIC_INPUT_BYTES, 9);
  const encoded = encodeDepositData({ commitment, amount: 123_456n, proof, publicInputs });

  assert.equal(encoded[0], 1);
  assert.deepEqual(encoded.slice(1, 33), commitment);
  assert.equal(new DataView(encoded.buffer, encoded.byteOffset + 33, 8).getBigUint64(0, true), 123_456n);
  assert.equal(new DataView(encoded.buffer, encoded.byteOffset + 41, 2).getUint16(0, true), 256);
  assert.equal(
    new DataView(encoded.buffer, encoded.byteOffset + 41 + 2 + 256, 2).getUint16(0, true),
    192,
  );
  assert.equal(encoded.length, 1 + 32 + 8 + 2 + 256 + 2 + 192);
});

test('withdraw payload binds recipient, fees, proof and thirteen public fields', () => {
  const encoded = encodeWithdrawData({
    nullifier0: bytes(32, 1),
    nullifier1: bytes(32, 2),
    changeCommitment: bytes(32, 3),
    recipient: key(4),
    publicAmount: 4_000_000n,
    protocolFee: 0n,
    relayerFee: 1_000_000n,
    proof: bytes(WATCHER_GROTH16_PROOF_BYTES, 5),
    publicInputs: bytes(WATCHER_WITHDRAW_PUBLIC_INPUT_BYTES, 6),
  });

  assert.equal(encoded[0], 2);
  assert.deepEqual(encoded.slice(97, 129), key(4).toBytes());
  assert.equal(new DataView(encoded.buffer, encoded.byteOffset + 129, 8).getBigUint64(0, true), 4_000_000n);
  assert.equal(new DataView(encoded.buffer, encoded.byteOffset + 145, 8).getBigUint64(0, true), 1_000_000n);
  assert.equal(encoded.length, 1 + 32 * 4 + 8 * 3 + 2 + 256 + 2 + 416);
});

test('instruction builders use the exact custody account order', () => {
  const programId = key(42);
  const authority = key(1);
  const config = key(43);
  const commitments = key(2);
  const nullifiers = key(3);
  const rootHistory = key(4);
  const treasury = key(45);
  const recipient = key(7);
  const relayer = key(44);
  const [vault] = deriveWatcherVaultPda({ programId, config });

  const initialize = buildInitializeInstruction({
    programId,
    authority,
    config,
    commitments,
    nullifiers,
    rootHistory,
    treasury,
  });
  assert.deepEqual(
    initialize.keys.map(({ pubkey }) => pubkey.toBase58()),
    [authority, config, commitments, nullifiers, rootHistory, vault, SystemProgram.programId].map(
      (value) => value.toBase58(),
    ),
  );
  assert.equal(initialize.keys[0].isSigner, true);
  assert.equal(initialize.data[0], 0);

  const deposit = buildDepositInstruction({
    programId,
    depositor: authority,
    config,
    commitments,
    rootHistory,
    commitment: bytes(32, 7),
    amount: 8_000_000n,
    proof: bytes(256, 8),
    publicInputs: bytes(192, 9),
  });
  assert.deepEqual(
    deposit.keys.map(({ pubkey }) => pubkey.toBase58()),
    [authority, config, commitments, rootHistory, vault, SystemProgram.programId].map((value) =>
      value.toBase58(),
    ),
  );
  assert.equal(deposit.keys[0].isSigner, true);

  const withdraw = buildWithdrawInstruction({
    programId,
    config,
    commitments,
    nullifiers,
    rootHistory,
    recipient,
    relayer,
    treasury,
    nullifier0: bytes(32, 1),
    nullifier1: bytes(32, 2),
    changeCommitment: bytes(32, 3),
    publicAmount: 4_000_000n,
    relayerFee: 1_000_000n,
    proof: bytes(256, 4),
    publicInputs: bytes(416, 5),
  });
  assert.deepEqual(
    withdraw.keys.map(({ pubkey }) => pubkey.toBase58()),
    [config, commitments, nullifiers, rootHistory, vault, recipient, relayer, treasury].map((value) =>
      value.toBase58(),
    ),
  );
  assert.equal(withdraw.keys.some(({ isSigner }) => isSigner), false);
});

test('malformed proof and public-input lengths fail closed', () => {
  assert.throws(
    () =>
      encodeDepositData({
        commitment: bytes(32, 1),
        amount: 1n,
        proof: bytes(255, 2),
        publicInputs: bytes(192, 3),
      }),
    /256 bytes/,
  );
  assert.throws(
    () =>
      encodeWithdrawData({
        nullifier0: bytes(32, 1),
        nullifier1: bytes(32, 2),
        changeCommitment: bytes(32, 3),
        recipient: key(4),
        publicAmount: 1n,
        proof: bytes(256, 5),
        publicInputs: bytes(415, 6),
      }),
    /416 bytes/,
  );
});
