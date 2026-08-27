import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';

import { fieldToLe32, noteCommitmentV1 } from './field.mjs';
import {
  buildWithdrawalWitnessForStateV1,
  decodeCommitmentRegistryV1,
} from './flow.mjs';

function key(value) {
  return new PublicKey(new Uint8Array(32).fill(value));
}

function registry(commitments) {
  const output = new Uint8Array(5 + 32 * 16);
  output[0] = 1;
  new DataView(output.buffer).setUint32(1, commitments.length, true);
  commitments.forEach((commitment, index) => output.set(fieldToLe32(commitment), 5 + index * 32));
  return output;
}

function hex(value) {
  return Buffer.from(value).toString('hex');
}

test('two append-only deposits become a complete Circuit V1 withdrawal witness', async () => {
  const note0 = { assetId: 1n, amount: 8_000_000n, owner: 1111n, nonce: 2222n };
  const note1 = { assetId: 1n, amount: 3_000_000n, owner: 3333n, nonce: 4444n };
  const commitment0 = noteCommitmentV1(note0);
  const commitment1 = noteCommitmentV1(note1);
  const registryData = registry([commitment0, commitment1]);

  assert.deepEqual(decodeCommitmentRegistryV1(registryData), [commitment0, commitment1]);
  const prepared = await buildWithdrawalWitnessForStateV1({
    registryData,
    inputNotes: [note0, note1],
    recipient: key(7),
    programId: key(42),
    config: key(43),
    relayer: key(44),
    treasury: key(45),
    publicAmount: 4_000_000n,
    protocolFee: 0n,
    relayerFee: 1_000_000n,
    changeOwner: 5555n,
    changeNonce: 6666n,
  });

  assert.deepEqual(prepared.inputIndices, [0, 1]);
  assert.deepEqual(prepared.witness.Input0Index, [0n, 0n, 0n, 0n]);
  assert.deepEqual(prepared.witness.Input1Index, [1n, 0n, 0n, 0n]);
  assert.equal(prepared.change.amount, 6_000_000n);
  assert.equal(
    hex(fieldToLe32(prepared.root)),
    'f2cbdbcda94d3b4a69f8107c6dc1bd798363d40cffbecf1e8487e8b9c39ea128',
  );
  assert.equal(prepared.statement.publicAmount, 4_000_000n);
  assert.equal(prepared.statement.relayerFee, 1_000_000n);
  assert.equal(prepared.statement.protocolFee, 0n);
});

test('missing deposits and value creation fail before proving', async () => {
  const note0 = { amount: 8_000_000n, owner: 1111n, nonce: 2222n };
  const note1 = { amount: 3_000_000n, owner: 3333n, nonce: 4444n };
  const oneCommitment = noteCommitmentV1({ ...note0, assetId: 1n });
  const common = {
    inputNotes: [note0, note1],
    recipient: key(7),
    programId: key(42),
    config: key(43),
    relayer: key(44),
    treasury: key(45),
    protocolFee: 0n,
    changeOwner: 5555n,
    changeNonce: 6666n,
  };

  await assert.rejects(
    () =>
      buildWithdrawalWitnessForStateV1({
        ...common,
        registryData: registry([oneCommitment]),
        publicAmount: 4_000_000n,
        relayerFee: 1_000_000n,
      }),
    /absent from the on-chain registry/,
  );

  await assert.rejects(
    () =>
      buildWithdrawalWitnessForStateV1({
        ...common,
        registryData: registry([
          oneCommitment,
          noteCommitmentV1({ ...note1, assetId: 1n }),
        ]),
        publicAmount: 10_000_000n,
        relayerFee: 1_000_000n,
      }),
    /positive private change/,
  );
});
