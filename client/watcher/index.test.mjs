import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BN254_SCALAR_MODULUS,
  buildMerkleTreeFromLeavesV1,
  buildWithdrawWitnessFromChainV1,
  buildWithdrawWitnessV1,
  bytesToHex,
  decodeCommitmentRegistryV1,
  encodeCommitmentRegistryV1,
  fieldToLe32,
  getMerkleProofV1,
  keccak256,
  MERKLE_LEAVES_V1,
  noteCommitmentV1,
  recipientBindingBytesV1,
  verifyMerkleProofV1,
} from './index.mjs';

const FIXTURE_ROOT_LE_HEX = 'f2cbdbcda94d3b4a69f8107c6dc1bd798363d40cffbecf1e8487e8b9c39ea128';

test('Keccak-256 implementation matches the standard empty input vector', () => {
  assert.equal(
    bytesToHex(keccak256(new Uint8Array())),
    'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
  );
});

test('JS MiMC tree exactly matches the current sequential Circuit V1 Go fixture root', () => {
  const assetId = 1n;
  const commitment0 = noteCommitmentV1({
    assetId,
    amount: 8_000_000n,
    owner: 1111n,
    nonce: 2222n,
  });
  const commitment1 = noteCommitmentV1({
    assetId,
    amount: 3_000_000n,
    owner: 3333n,
    nonce: 4444n,
  });
  const leaves = new Array(MERKLE_LEAVES_V1).fill(0n);
  leaves[0] = commitment0;
  leaves[1] = commitment1;
  const tree = buildMerkleTreeFromLeavesV1(leaves);
  assert.equal(bytesToHex(fieldToLe32(tree.root)), FIXTURE_ROOT_LE_HEX);
});

test('registry decoding preserves actual append indices and generates valid proofs', () => {
  const commitments = [11n, 22n, 33n, 44n];
  const accountData = encodeCommitmentRegistryV1(commitments, 16);
  const decoded = decodeCommitmentRegistryV1(accountData);
  assert.deepEqual(decoded.commitments, commitments);

  for (let index = 0; index < commitments.length; index += 1) {
    const proof = getMerkleProofV1(decoded.tree, index);
    assert.equal(proof.index, index);
    assert.deepEqual(proof.indexBits, [index & 1, (index >> 1) & 1, 0, 0]);
    assert.equal(
      verifyMerkleProofV1({
        leaf: commitments[index],
        path: proof.path,
        indexBits: proof.indexBits,
        root: decoded.root,
      }),
      true,
    );
  }
});

test('withdraw witness is derived from the real registry rather than manual paths', async () => {
  const assetId = 1n;
  const input0 = { amount: 8_000_000n, owner: 1111n, nonce: 2222n };
  const input1 = { amount: 3_000_000n, owner: 3333n, nonce: 4444n };
  const filler = noteCommitmentV1({ assetId, amount: 1n, owner: 77n, nonce: 88n });
  const commitment0 = noteCommitmentV1({ assetId, ...input0 });
  const commitment1 = noteCommitmentV1({ assetId, ...input1 });
  const registryAccountData = encodeCommitmentRegistryV1([
    filler,
    commitment1,
    noteCommitmentV1({ assetId, amount: 2n, owner: 99n, nonce: 100n }),
    commitment0,
  ]);
  const recipient = new Uint8Array(32).fill(7);

  const result = await buildWithdrawWitnessV1({
    registryAccountData,
    input0,
    input1,
    change: { amount: 6_000_000n, owner: 5555n, nonce: 6666n },
    publicAmount: 4_000_000n,
    protocolFee: 0n,
    relayerFee: 1_000_000n,
    recipient,
    assetId,
    contextBinding: 202n,
  });

  assert.deepEqual(result.depositIndices, { input0: 3, input1: 1 });
  assert.equal(result.witness.Input0Index.join(','), '1,1,0,0');
  assert.equal(result.witness.Input1Index.join(','), '1,0,0,0');
  assert.equal(result.publicInputs.length, 416);
  assert.equal(result.witness.MerkleRoot, result.registry.root.toString(10));
  assert.equal(result.witness.CurrentRoot, result.registry.root.toString(10));
  assert.equal(result.witness.NewMerkleRoot, result.transition.newRoot.toString(10));
  assert.equal(result.witness.ChangeLeafIndex, '4');
  assert.equal(
    verifyMerkleProofV1({
      leaf: commitment0,
      path: result.proofs.input0.path,
      indexBits: result.proofs.input0.indexBits,
      root: result.registry.root,
    }),
    true,
  );
  assert.equal(
    bytesToHex(result.publicInputs.slice(0, 32)),
    bytesToHex(fieldToLe32(result.registry.root)),
  );
  assert.equal(
    bytesToHex(result.publicInputs.slice(4 * 32, 5 * 32)).slice(0, 16),
    '00093d0000000000',
  );
});

test('recipient binding matches the existing verifier fixture', async () => {
  const recipient = new Uint8Array(32).fill(7);
  assert.equal(
    bytesToHex(await recipientBindingBytesV1(recipient)),
    '9aab992c0da2c09036f03213a555c11a8034ee94234b0a5b4c5fcd624334da1f',
  );
});

test('chain helper fetches registry bytes and builds the same witness', async () => {
  const assetId = 1n;
  const input0 = { amount: 5n, owner: 10n, nonce: 11n };
  const input1 = { amount: 7n, owner: 12n, nonce: 13n };
  const commitments = [
    noteCommitmentV1({ assetId, ...input0 }),
    noteCommitmentV1({ assetId, ...input1 }),
  ];
  const data = encodeCommitmentRegistryV1(commitments);
  const connection = {
    async getAccountInfo(account, commitment) {
      assert.equal(account, 'registry-account');
      assert.equal(commitment, 'confirmed');
      return { data };
    },
  };
  const result = await buildWithdrawWitnessFromChainV1({
    connection,
    commitmentsAccount: 'registry-account',
    input0,
    input1,
    change: { amount: 2n, owner: 14n, nonce: 15n },
    publicAmount: 10n,
    recipient: new Uint8Array(32).fill(1),
    assetId,
    contextBinding: 2n,
  });
  assert.deepEqual(result.depositIndices, { input0: 0, input1: 1 });
});

test('invalid registries and missing notes fail closed', async () => {
  assert.throws(() => fieldToLe32(BN254_SCALAR_MODULUS), /canonical BN254/);

  const tooMany = new Uint8Array(5 + 17 * 32);
  tooMany[0] = 1;
  tooMany[1] = 17;
  assert.throws(() => decodeCommitmentRegistryV1(tooMany), /capacity/);

  const assetId = 1n;
  const inRegistry = { amount: 5n, owner: 10n, nonce: 11n };
  const absent = { amount: 7n, owner: 12n, nonce: 13n };
  const data = encodeCommitmentRegistryV1([noteCommitmentV1({ assetId, ...inRegistry })]);
  await assert.rejects(
    buildWithdrawWitnessV1({
      registryAccountData: data,
      input0: inRegistry,
      input1: absent,
      change: { amount: 2n, owner: 14n, nonce: 15n },
      publicAmount: 10n,
      recipient: new Uint8Array(32).fill(1),
      assetId,
      contextBinding: 2n,
    }),
    /not present/,
  );
});
