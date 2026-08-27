import test from 'node:test';
import assert from 'node:assert/strict';

import { bytesToHex } from './keccak.mjs';
import { prepareUiDepositV1 } from './ui-flows.mjs';

function key(value) {
  return {
    toBytes() {
      return new Uint8Array(32).fill(value);
    },
  };
}

test('browser deposit flow binds the exact proof response to the instruction', async () => {
  let witnessed;
  const prover = {
    async proveDeposit(witness, expectedPublicInputs) {
      witnessed = witness;
      return {
        proof: new Uint8Array(256).fill(9),
        publicInputs: new Uint8Array(expectedPublicInputs),
        bundleDigest: 'test-bundle',
      };
    },
  };
  const result = await prepareUiDepositV1({
    accounts: {
      programId: key(1),
      depositor: key(2),
      config: key(3),
      commitments: key(4),
      rootHistory: key(5),
      vault: key(6),
      systemProgram: key(7),
    },
    owner: 1111n,
    nonce: 2222n,
    amount: 8_000_000n,
    assetId: 1n,
    prover,
  });

  assert.equal(witnessed.Owner, '1111');
  assert.equal(witnessed.Nonce, '2222');
  assert.equal(witnessed.Amount, '8000000');
  assert.equal(witnessed.AssetID, '1');
  assert.equal(witnessed.Commitment, result.note.commitment.toString(10));
  assert.equal(result.publicInputs.length, 96);
  assert.equal(result.instruction.keys.length, 6);
  assert.equal(result.instruction.data[0], 1);
  assert.equal(result.instruction.data.length, 1 + 32 + 8 + 2 + 256 + 2 + 96);
  assert.equal(
    bytesToHex(result.instruction.data.slice(1, 33)),
    bytesToHex(result.commitmentBytes),
  );
});

test('browser deposit flow rejects a prover that changes public inputs', async () => {
  const prover = {
    async proveDeposit(_witness, expectedPublicInputs) {
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
      accounts: {
        programId: key(1),
        depositor: key(2),
        config: key(3),
        commitments: key(4),
        rootHistory: key(5),
        vault: key(6),
        systemProgram: key(7),
      },
      owner: 11n,
      nonce: 22n,
      amount: 10n,
      prover,
    }),
    /public inputs do not match/,
  );
});
