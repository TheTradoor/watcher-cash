import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDepositInstructionV1,
  buildDepositWitnessV1,
  buildWithdrawInstructionV1,
  bytesToHex,
  concatBytes,
  deriveVaultAddressV1,
  encodeCommitmentRegistryV1,
  encodeDepositDataV1,
  encodeDepositPublicInputsV1,
  encodePublicInputsV1,
  encodeWithdrawDataV1,
  fieldToLe32,
  noteCommitmentV1,
  prepareDepositV1,
  prepareWithdrawV1,
  proveDepositWithLocalProverV1,
  withdrawContextBindingBytesV1,
  XARK_PROOF_BYTES_V1,
  DEPOSIT_PUBLIC_INPUT_BYTES_V1,
  WITHDRAW_PUBLIC_INPUT_BYTES_V1,
} from './index.mjs';

class FakeKey {
  constructor(value) {
    this.value = value;
    this.bytes = new Uint8Array(32).fill(value);
  }

  toBytes() {
    return new Uint8Array(this.bytes);
  }
}

function proofBytes(value = 9) {
  return new Uint8Array(XARK_PROOF_BYTES_V1).fill(value);
}

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(payload);
    },
  };
}

function publicInputBytesFromWitness(path, witness) {
  if (path.endsWith('/v1/prove/deposit')) {
    return encodeDepositPublicInputsV1({
      commitment: BigInt(witness.Commitment),
      amount: BigInt(witness.Amount),
      assetId: BigInt(witness.AssetID),
    });
  }
  return encodePublicInputsV1({
    merkleRoot: BigInt(witness.MerkleRoot),
    nullifier0: BigInt(witness.Nullifier0),
    nullifier1: BigInt(witness.Nullifier1),
    changeCommitment: BigInt(witness.ChangeCommitment),
    publicAmount: BigInt(witness.PublicAmount),
    protocolFee: BigInt(witness.ProtocolFee),
    relayerFee: BigInt(witness.RelayerFee),
    recipientBinding: BigInt(witness.RecipientBinding),
    assetId: BigInt(witness.AssetID),
    contextBinding: BigInt(witness.ContextBinding),
  });
}

function matchingProverFetch() {
  return async (url, options = {}) => {
    if (url.endsWith('/healthz')) {
      return response({
        status: 'ready',
        circuits: ['deposit-v1', 'withdraw-v1'],
        bundleDigest: 'ab'.repeat(32),
      });
    }
    const witness = JSON.parse(options.body);
    const publicInputs = publicInputBytesFromWitness(url, witness);
    return response({
      circuit: url.endsWith('/deposit') ? 'deposit-v1' : 'withdraw-v1',
      proofHex: bytesToHex(proofBytes()),
      publicInputsHex: bytesToHex(publicInputs),
      proofBytes: XARK_PROOF_BYTES_V1,
      publicInputBytes: publicInputs.length,
      bundleDigest: 'ab'.repeat(32),
    });
  };
}

test('withdraw context binding matches the Rust and Go custody fixture', async () => {
  const vault = Uint8Array.from([
    0x53, 0x00, 0x97, 0x5d, 0xd0, 0xc0, 0x7b, 0x8b,
    0xc9, 0x07, 0x1d, 0x94, 0xad, 0x6f, 0xcd, 0x4d,
    0x6e, 0x87, 0xb5, 0xf1, 0xef, 0x54, 0xe1, 0x8d,
    0xd9, 0x6f, 0x65, 0x42, 0xba, 0x55, 0x31, 0xf1,
  ]);
  assert.equal(
    bytesToHex(await withdrawContextBindingBytesV1({
      programId: new Uint8Array(32).fill(42),
      config: new Uint8Array(32).fill(43),
      vault,
      relayer: new Uint8Array(32).fill(44),
      treasury: new Uint8Array(32).fill(45),
      assetId: 1n,
    })),
    'b676b04ac36e79d23531ba0835dfec95c8ae1d5975398610b2d588c4aceb4718',
  );
});

test('deposit witness exposes exact commitment, amount, and asset public inputs', () => {
  const result = buildDepositWitnessV1({
    owner: 1111n,
    nonce: 2222n,
    amount: 8_000_000n,
    assetId: 1n,
  });
  assert.equal(result.publicInputs.length, DEPOSIT_PUBLIC_INPUT_BYTES_V1);
  assert.equal(bytesToHex(result.publicInputs.slice(0, 32)), bytesToHex(result.commitment));
  assert.equal(bytesToHex(result.publicInputs.slice(32, 64)).slice(0, 16), '00127a0000000000');
  assert.equal(result.witness.Amount, '8000000');
  assert.equal(result.witness.AssetID, '1');
});

test('instruction encoders match the Rust codec byte layout exactly', () => {
  const commitment = new Uint8Array(32).fill(1);
  const proof = proofBytes(2);
  const depositInputs = new Uint8Array(DEPOSIT_PUBLIC_INPUT_BYTES_V1).fill(3);
  const deposit = encodeDepositDataV1({
    commitment,
    amount: 8_000_000n,
    proof,
    publicInputs: depositInputs,
  });
  assert.equal(deposit.length, 397);
  assert.equal(deposit[0], 1);
  assert.deepEqual(deposit.slice(1, 33), commitment);
  assert.deepEqual(deposit.slice(33, 41), Uint8Array.of(0x00, 0x12, 0x7a, 0x00, 0, 0, 0, 0));
  assert.deepEqual(deposit.slice(41, 43), Uint8Array.of(0x00, 0x01));
  assert.deepEqual(deposit.slice(299, 301), Uint8Array.of(0x60, 0x00));

  const withdrawInputs = new Uint8Array(WITHDRAW_PUBLIC_INPUT_BYTES_V1).fill(4);
  const withdrawal = encodeWithdrawDataV1({
    nullifier0: new Uint8Array(32).fill(5),
    nullifier1: new Uint8Array(32).fill(6),
    changeCommitment: new Uint8Array(32).fill(7),
    recipient: new FakeKey(8),
    publicAmount: 4_000_000n,
    protocolFee: 0n,
    relayerFee: 1_000_000n,
    proof,
    publicInputs: withdrawInputs,
  });
  assert.equal(withdrawal.length, 733);
  assert.equal(withdrawal[0], 2);
  assert.deepEqual(withdrawal.slice(129, 137), Uint8Array.of(0x00, 0x09, 0x3d, 0, 0, 0, 0, 0));
  assert.deepEqual(withdrawal.slice(153, 155), Uint8Array.of(0x00, 0x01));
  assert.deepEqual(withdrawal.slice(411, 413), Uint8Array.of(0x40, 0x01));
});

test('instruction builders preserve the exact account order and mutability', () => {
  const keys = Object.fromEntries(
    ['programId', 'depositor', 'config', 'commitments', 'nullifiers', 'rootHistory', 'vault', 'systemProgram', 'recipient', 'relayer', 'treasury']
      .map((name, index) => [name, new FakeKey(index + 1)]),
  );
  const deposit = buildDepositInstructionV1({
    ...keys,
    commitment: new Uint8Array(32).fill(12),
    amount: 1n,
    proof: proofBytes(),
    publicInputs: new Uint8Array(DEPOSIT_PUBLIC_INPUT_BYTES_V1),
  });
  assert.deepEqual(
    deposit.keys.map((item) => item.pubkey),
    [keys.depositor, keys.config, keys.commitments, keys.rootHistory, keys.vault, keys.systemProgram],
  );
  assert.deepEqual(
    deposit.keys.map(({ isSigner, isWritable }) => [isSigner, isWritable]),
    [[true, true], [false, true], [false, true], [false, true], [false, true], [false, false]],
  );

  const withdrawal = buildWithdrawInstructionV1({
    ...keys,
    statement: {
      nullifier0: new Uint8Array(32).fill(1),
      nullifier1: new Uint8Array(32).fill(2),
      changeCommitment: new Uint8Array(32).fill(3),
      publicAmount: 1n,
      protocolFee: 0n,
      relayerFee: 0n,
    },
    proof: proofBytes(),
    publicInputs: new Uint8Array(WITHDRAW_PUBLIC_INPUT_BYTES_V1),
  });
  assert.deepEqual(
    withdrawal.keys.map((item) => item.pubkey),
    [keys.config, keys.commitments, keys.nullifiers, keys.rootHistory, keys.vault, keys.recipient, keys.relayer, keys.treasury],
  );
  assert.equal(withdrawal.keys.every((item) => !item.isSigner && item.isWritable), true);
});

test('vault PDA helper uses the Watcher seed and config bytes', () => {
  const programId = new FakeKey(42);
  const config = new FakeKey(43);
  const expectedVault = new FakeKey(44);
  const result = deriveVaultAddressV1({
    programId,
    config,
    findProgramAddressSync(seeds, program) {
      assert.equal(program, programId);
      assert.equal(new TextDecoder().decode(seeds[0]), 'watcher-vault-v1');
      assert.deepEqual(seeds[1], config.toBytes());
      return [expectedVault, 255];
    },
  });
  assert.equal(result.vault, expectedVault);
  assert.equal(result.bump, 255);
});

test('local prover response is rejected when public inputs differ from the client statement', async () => {
  const expected = new Uint8Array(DEPOSIT_PUBLIC_INPUT_BYTES_V1).fill(1);
  await assert.rejects(
    proveDepositWithLocalProverV1({
      witness: { Owner: '1' },
      expectedPublicInputs: expected,
      fetchImpl: async () => response({
        circuit: 'deposit-v1',
        proofHex: bytesToHex(proofBytes()),
        publicInputsHex: bytesToHex(new Uint8Array(DEPOSIT_PUBLIC_INPUT_BYTES_V1).fill(2)),
        proofBytes: XARK_PROOF_BYTES_V1,
        publicInputBytes: DEPOSIT_PUBLIC_INPUT_BYTES_V1,
        bundleDigest: 'ab'.repeat(32),
      }),
    }),
    /do not match/,
  );
});

test('high-level deposit flow produces a proof-bound instruction descriptor', async () => {
  const accounts = {
    programId: new FakeKey(1), depositor: new FakeKey(2), config: new FakeKey(3),
    commitments: new FakeKey(4), rootHistory: new FakeKey(5), vault: new FakeKey(6),
    systemProgram: new FakeKey(7),
  };
  const result = await prepareDepositV1({
    accounts,
    owner: 1111n,
    nonce: 2222n,
    amount: 8_000_000n,
    fetchImpl: matchingProverFetch(),
  });
  assert.equal(result.instruction.data[0], 1);
  assert.equal(result.proof.length, XARK_PROOF_BYTES_V1);
  assert.equal(result.instruction.keys[0].pubkey, accounts.depositor);
  assert.equal(result.bundleDigest, 'ab'.repeat(32));
});

test('high-level withdraw flow derives context, paths, proof, and account binding', async () => {
  const assetId = 1n;
  const input0 = { amount: 8_000_000n, owner: 1111n, nonce: 2222n };
  const input1 = { amount: 3_000_000n, owner: 3333n, nonce: 4444n };
  const registryData = encodeCommitmentRegistryV1([
    noteCommitmentV1({ assetId, ...input0 }),
    noteCommitmentV1({ assetId, ...input1 }),
  ]);
  const accounts = {
    programId: new FakeKey(42), config: new FakeKey(43), commitments: new FakeKey(10),
    nullifiers: new FakeKey(11), rootHistory: new FakeKey(12),
    vault: { toBytes: () => Uint8Array.from([
      0x53, 0x00, 0x97, 0x5d, 0xd0, 0xc0, 0x7b, 0x8b,
      0xc9, 0x07, 0x1d, 0x94, 0xad, 0x6f, 0xcd, 0x4d,
      0x6e, 0x87, 0xb5, 0xf1, 0xef, 0x54, 0xe1, 0x8d,
      0xd9, 0x6f, 0x65, 0x42, 0xba, 0x55, 0x31, 0xf1,
    ]) },
    recipient: new FakeKey(7), relayer: new FakeKey(44), treasury: new FakeKey(45),
  };
  const connection = {
    async getAccountInfo(account, commitment) {
      assert.equal(account, accounts.commitments);
      assert.equal(commitment, 'confirmed');
      return { data: registryData };
    },
  };
  const result = await prepareWithdrawV1({
    connection,
    accounts,
    input0,
    input1,
    change: { amount: 6_000_000n, owner: 5555n, nonce: 6666n },
    publicAmount: 4_000_000n,
    relayerFee: 1_000_000n,
    fetchImpl: matchingProverFetch(),
  });
  assert.equal(result.instruction.data[0], 2);
  assert.deepEqual(result.depositIndices, { input0: 0, input1: 1 });
  assert.equal(
    bytesToHex(fieldToLe32(result.contextBinding)),
    'b676b04ac36e79d23531ba0835dfec95c8ae1d5975398610b2d588c4aceb4718',
  );
  assert.equal(result.instruction.keys[5].pubkey, accounts.recipient);
  assert.equal(result.instruction.keys[6].pubkey, accounts.relayer);
  assert.equal(result.instruction.keys[7].pubkey, accounts.treasury);
});
