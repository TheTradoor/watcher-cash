import test from 'node:test';
import assert from 'node:assert/strict';

import { bytesToHex } from './keccak.mjs';
import { encodeCommitmentRegistryV1 } from './merkle.mjs';
import { prepareUiDepositV1 } from './ui-flows.mjs';

function key(value) {
  return {
    toBytes() {
      return new Uint8Array(32).fill(value);
    },
  };
}

function connectionFor(commitments = []) {
  const data = encodeCommitmentRegistryV1(commitments);
  return {
    calls: 0,
    async getAccountInfo() {
      this.calls += 1;
      return { data };
    },
  };
}

function accounts() {
  return {
    programId: key(1),
    depositor: key(2),
    config: key(3),
    commitments: key(4),
    rootHistory: key(5),
    vault: key(6),
    systemProgram: key(7),
  };
}

test('browser deposit flow binds the live append transition and exact proof response', async () => {
  let witnessed;
  const connection = connectionFor([]);
  const prover = {
    async proveDeposit({ witness, expectedPublicInputs }) {
      witnessed = witness;
      return {
        proof: new Uint8Array(256).fill(9),
        publicInputs: new Uint8Array(expectedPublicInputs),
        bundleDigest: 'test-bundle',
      };
    },
  };
  const result = await prepareUiDepositV1({
    connection,
    accounts: accounts(),
    owner: 1111n,
    nonce: 2222n,
    amount: 8_000_000n,
    assetId: 1n,
    prover,
  });

  assert.equal(connection.calls, 1);
  assert.equal(witnessed.Owner, '1111');
  assert.equal(witnessed.Nonce, '2222');
  assert.equal(witnessed.Amount, '8000000');
  assert.equal(witnessed.AssetID, '1');
  assert.equal(witnessed.Commitment, result.note.commitment.toString(10));
  assert.equal(witnessed.OldRoot, '0');
  assert.equal(witnessed.NewRoot, result.publicFields.newRoot.toString(10));
  assert.equal(witnessed.LeafIndex, '0');
  assert.deepEqual(witnessed.Index, [0, 0, 0, 0]);
  assert.equal(witnessed.Path.length, 4);
  assert.equal(result.transition.index, 0);
  assert.equal(result.publicInputs.length, 192);
  assert.equal(result.instruction.keys.length, 6);
  assert.equal(result.instruction.data[0], 1);
  assert.equal(result.instruction.data.length, 1 + 32 + 8 + 2 + 256 + 2 + 192);
  assert.equal(
    bytesToHex(result.instruction.data.slice(1, 33)),
    bytesToHex(result.commitmentBytes),
  );
});

test('browser deposit flow derives the next leaf index from a non-empty registry', async () => {
  const connection = connectionFor([123n]);
  const prover = {
    async proveDeposit({ expectedPublicInputs }) {
      return {
        proof: new Uint8Array(256).fill(4),
        publicInputs: new Uint8Array(expectedPublicInputs),
      };
    },
  };
  const result = await prepareUiDepositV1({
    connection,
    accounts: accounts(),
    owner: 3333n,
    nonce: 4444n,
    amount: 2_000_000n,
    prover,
  });

  assert.equal(result.registry.count, 1);
  assert.equal(result.transition.index, 1);
  assert.equal(result.witness.LeafIndex, '1');
  assert.deepEqual(result.witness.Index, [1, 0, 0, 0]);
  assert.equal(result.publicInputs.length, 192);
});

test('browser deposit flow rejects a prover that changes public inputs', async () => {
  const prover = {
    async proveDeposit({ expectedPublicInputs }) {
      const changed = new Uint8Array(expectedPublicInputs);
      changed[0] ^= 1;
      if (bytesToHex(changed) !== bytesToHex(expectedPublicInputs)) {
        throw new Error('deposit prover public inputs do not match the browser-built statement');
      }
      return { proof: new Uint8Array(256), publicInputs: changed };
    },
  };
  await assert.rejects(
    prepareUiDepositV1({
      connection: connectionFor([]),
      accounts: accounts(),
      owner: 11n,
      nonce: 22n,
      amount: 10n,
      prover,
    }),
    /public inputs do not match/,
  );
});
