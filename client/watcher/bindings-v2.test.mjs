import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';

import {
  depositContextBindingV2,
  recipientBindingV2,
  withdrawContextBindingV2,
} from './bindings-v2.mjs';
import { fieldToLe32 } from './field.mjs';
import {
  DEPOSIT_PUBLIC_INPUT_BYTES_V2,
  WITHDRAW_PUBLIC_INPUT_BYTES_V2,
  reconstructDepositPublicInputsV2,
  reconstructWithdrawPublicInputsV2,
} from './public-inputs-v2.mjs';

function bytes(pubkey) {
  return pubkey.toBytes();
}

function field(value) {
  return fieldToLe32(BigInt(value));
}

function roots(inputCount) {
  return Array.from({ length: 4 }, (_, index) => index < inputCount ? field(10 + index) : new Uint8Array(32));
}

function nullifiers(inputCount) {
  return Array.from({ length: 4 }, (_, index) => index < inputCount ? field(20 + index) : new Uint8Array(32));
}

test('V2 binding domains are deterministic and deployment scoped', async () => {
  const programId = Keypair.generate().publicKey;
  const config = Keypair.generate().publicKey;
  const vault = Keypair.generate().publicKey;
  const activeTree = Keypair.generate().publicKey;
  const relayer = Keypair.generate().publicKey;
  const treasury = Keypair.generate().publicKey;
  const first = await withdrawContextBindingV2({
    programId: bytes(programId),
    config: bytes(config),
    vault: bytes(vault),
    activeTree: bytes(activeTree),
    relayer: bytes(relayer),
    treasury: bytes(treasury),
  });
  const second = await withdrawContextBindingV2({
    programId: bytes(programId),
    config: bytes(config),
    vault: bytes(vault),
    activeTree: bytes(activeTree),
    relayer: bytes(relayer),
    treasury: bytes(treasury),
  });
  const changedTree = await withdrawContextBindingV2({
    programId: bytes(programId),
    config: bytes(config),
    vault: bytes(vault),
    activeTree: bytes(Keypair.generate().publicKey),
    relayer: bytes(relayer),
    treasury: bytes(treasury),
  });
  const deposit = await depositContextBindingV2({
    programId: bytes(programId),
    config: bytes(config),
    vault: bytes(vault),
    activeTree: bytes(activeTree),
  });
  assert.deepEqual(first.bytes, second.bytes);
  assert.equal(first.field, second.field);
  assert.notEqual(first.field, changedTree.field);
  assert.notEqual(first.field, deposit.field);
});

test('V2 recipient binding changes with the destination', async () => {
  const left = await recipientBindingV2(bytes(Keypair.generate().publicKey));
  const right = await recipientBindingV2(bytes(Keypair.generate().publicKey));
  assert.notEqual(left.field, right.field);
  assert.equal(left.bytes.length, 32);
});

test('V2 deposit public input order is fixed at eight fields', () => {
  const reconstructed = reconstructDepositPublicInputsV2({
    commitment: field(1),
    amount: 55n,
    assetId: 1n,
    epoch: 9n,
    contextBinding: field(2),
    oldRoot: field(3),
    newRoot: field(4),
    leafIndex: 23n,
  });
  assert.equal(reconstructed.fields.length, 8);
  assert.equal(reconstructed.bytes.length, DEPOSIT_PUBLIC_INPUT_BYTES_V2);
  assert.deepEqual(reconstructed.fields[0], field(1));
  assert.deepEqual(reconstructed.fields[3], field(9));
  assert.deepEqual(reconstructed.fields[4], field(2));
  assert.deepEqual(reconstructed.fields[7], field(23));
});

test('V2 change withdrawal public input order is fixed at nineteen fields', () => {
  const reconstructed = reconstructWithdrawPublicInputsV2({
    inputCount: 2,
    inputRoots: roots(2),
    nullifiers: nullifiers(2),
    changeCommitment: field(30),
    publicAmount: 5_000_000n,
    protocolFee: 0n,
    relayerFee: 1000n,
    recipientBinding: field(40),
    assetId: 1n,
    contextBinding: field(41),
    activeCurrentRoot: field(42),
    activeNextIndex: 77,
    newRoot: field(43),
  });
  assert.equal(reconstructed.hasChange, true);
  assert.equal(reconstructed.fields.length, 19);
  assert.equal(reconstructed.bytes.length, WITHDRAW_PUBLIC_INPUT_BYTES_V2);
  assert.deepEqual(reconstructed.fields[0], field(10));
  assert.deepEqual(reconstructed.fields[4], field(20));
  assert.deepEqual(reconstructed.fields[8], field(2));
  assert.deepEqual(reconstructed.fields[9], field(30));
  assert.deepEqual(reconstructed.fields[16], field(42));
  assert.deepEqual(reconstructed.fields[17], field(43));
  assert.deepEqual(reconstructed.fields[18], field(77));
});

test('V2 exact withdrawal public inputs are independent of active append state', () => {
  const base = {
    inputCount: 1,
    inputRoots: roots(1),
    nullifiers: nullifiers(1),
    changeCommitment: new Uint8Array(32),
    publicAmount: 5_000_000n,
    recipientBinding: field(40),
    contextBinding: field(41),
    newRoot: new Uint8Array(32),
  };
  const first = reconstructWithdrawPublicInputsV2({
    ...base,
    activeCurrentRoot: field(90),
    activeNextIndex: 1,
  });
  const second = reconstructWithdrawPublicInputsV2({
    ...base,
    activeCurrentRoot: field(91),
    activeNextIndex: 999,
  });
  assert.equal(first.hasChange, false);
  assert.deepEqual(first.bytes, second.bytes);
  assert.deepEqual(first.fields[16], new Uint8Array(32));
  assert.deepEqual(first.fields[17], new Uint8Array(32));
  assert.deepEqual(first.fields[18], new Uint8Array(32));
});
