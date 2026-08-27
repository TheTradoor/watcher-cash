import {
  assertFieldV1,
  assertU64,
  fieldToLe32,
  noteCommitmentV1,
  nullifierV1,
  recipientBindingV1,
} from './field.mjs';
import {
  decodeCommitmentRegistryV1,
  encodeCommitmentRegistryV1,
  fetchCommitmentRegistryV1,
  findCommitmentIndexV1,
  getMerkleAppendTransitionV1,
  getMerkleProofV1,
} from './merkle.mjs';

export const DEPOSIT_PUBLIC_INPUT_COUNT_V1 = 6;
export const DEPOSIT_PUBLIC_INPUT_BYTES_V1 = DEPOSIT_PUBLIC_INPUT_COUNT_V1 * 32;
export const PUBLIC_INPUT_COUNT_V1 = 13;
export const PUBLIC_INPUT_BYTES_V1 = PUBLIC_INPUT_COUNT_V1 * 32;

export function encodeDepositPublicInputsV1(fields) {
  const ordered = Array.isArray(fields)
    ? fields
    : [
        fields.commitment,
        fields.amount,
        fields.assetId,
        fields.oldRoot,
        fields.newRoot,
        fields.leafIndex,
      ];
  if (ordered.length !== DEPOSIT_PUBLIC_INPUT_COUNT_V1) {
    throw new RangeError(`Deposit V1 requires ${DEPOSIT_PUBLIC_INPUT_COUNT_V1} public inputs`);
  }
  const output = new Uint8Array(DEPOSIT_PUBLIC_INPUT_BYTES_V1);
  ordered.forEach((value, index) => output.set(fieldToLe32(value), index * 32));
  return output;
}

export function encodePublicInputsV1(fields) {
  const ordered = Array.isArray(fields)
    ? fields
    : [
        fields.merkleRoot,
        fields.nullifier0,
        fields.nullifier1,
        fields.changeCommitment,
        fields.publicAmount,
        fields.protocolFee,
        fields.relayerFee,
        fields.recipientBinding,
        fields.assetId,
        fields.contextBinding,
        fields.currentRoot,
        fields.newMerkleRoot,
        fields.changeLeafIndex,
      ];
  if (ordered.length !== PUBLIC_INPUT_COUNT_V1) {
    throw new RangeError(`Circuit V1 requires ${PUBLIC_INPUT_COUNT_V1} public inputs`);
  }
  const output = new Uint8Array(PUBLIC_INPUT_BYTES_V1);
  ordered.forEach((value, index) => output.set(fieldToLe32(value), index * 32));
  return output;
}

function normalizeInputNote(note, label, assetId) {
  if (!note || typeof note !== 'object') throw new TypeError(`${label} is required`);
  const amount = assertU64(note.amount, `${label}.amount`);
  const owner = assertFieldV1(note.owner, `${label}.owner`);
  const nonce = assertFieldV1(note.nonce, `${label}.nonce`);
  if (amount === 0n) throw new RangeError(`${label}.amount must be non-zero`);
  if (owner === 0n) throw new RangeError(`${label}.owner must be non-zero`);
  if (nonce === 0n) throw new RangeError(`${label}.nonce must be non-zero`);
  return { amount, owner, nonce, commitment: noteCommitmentV1({ assetId, amount, owner, nonce }) };
}

function normalizeChangeNote(note, assetId) {
  if (!note || typeof note !== 'object') throw new TypeError('change is required');
  const amount = assertU64(note.amount, 'change.amount');
  const owner = assertFieldV1(note.owner, 'change.owner');
  const nonce = assertFieldV1(note.nonce, 'change.nonce');
  if (owner === 0n) throw new RangeError('change.owner must be non-zero');
  if (nonce === 0n) throw new RangeError('change.nonce must be non-zero');
  return { amount, owner, nonce, commitment: noteCommitmentV1({ assetId, amount, owner, nonce }) };
}

function decimals(values) {
  return values.map((value) => value.toString(10));
}

export function buildDepositWitnessV1({
  registryAccountData = encodeCommitmentRegistryV1([]),
  owner,
  nonce,
  amount,
  assetId = 1n,
}) {
  const registry = decodeCommitmentRegistryV1(registryAccountData);
  const asset = assertFieldV1(assetId, 'assetId');
  if (asset === 0n) throw new RangeError('assetId must be non-zero');
  const note = normalizeInputNote({ owner, nonce, amount }, 'deposit', asset);
  const transition = getMerkleAppendTransitionV1(registry.commitments, note.commitment);
  const leafIndex = BigInt(transition.index);
  const publicFields = {
    commitment: note.commitment,
    amount: note.amount,
    assetId: asset,
    oldRoot: transition.oldRoot,
    newRoot: transition.newRoot,
    leafIndex,
  };
  return {
    registry,
    transition,
    note,
    witness: {
      Owner: note.owner.toString(10),
      Nonce: note.nonce.toString(10),
      Path: decimals(transition.path),
      Index: transition.indexBits,
      Commitment: note.commitment.toString(10),
      Amount: note.amount.toString(10),
      AssetID: asset.toString(10),
      OldRoot: transition.oldRoot.toString(10),
      NewRoot: transition.newRoot.toString(10),
      LeafIndex: leafIndex.toString(10),
    },
    publicFields,
    publicInputs: encodeDepositPublicInputsV1(publicFields),
    commitment: fieldToLe32(note.commitment),
    amount: note.amount,
  };
}

export async function buildDepositWitnessFromChainV1({
  connection,
  commitmentsAccount,
  commitment = 'confirmed',
  ...witnessOptions
}) {
  const registry = await fetchCommitmentRegistryV1(connection, commitmentsAccount, commitment);
  return buildDepositWitnessV1({
    ...witnessOptions,
    registryAccountData: encodeCommitmentRegistryV1(registry.commitments),
  });
}

export async function buildWithdrawWitnessV1({
  registryAccountData,
  input0,
  input1,
  change,
  publicAmount,
  protocolFee = 0n,
  relayerFee = 0n,
  recipient,
  recipientBinding,
  assetId,
  contextBinding,
}) {
  const registry = decodeCommitmentRegistryV1(registryAccountData);
  if (registry.count === 0) throw new Error('cannot withdraw from an empty commitment registry');
  const asset = assertFieldV1(assetId, 'assetId');
  const context = assertFieldV1(contextBinding, 'contextBinding');
  if (asset === 0n) throw new RangeError('assetId must be non-zero');
  if (context === 0n) throw new RangeError('contextBinding must be non-zero');

  const first = normalizeInputNote(input0, 'input0', asset);
  const second = normalizeInputNote(input1, 'input1', asset);
  if (first.commitment === second.commitment) throw new Error('input notes must be different');
  const firstIndex = findCommitmentIndexV1(registry.commitments, first.commitment);
  const secondIndex = findCommitmentIndexV1(registry.commitments, second.commitment);
  const firstProof = getMerkleProofV1(registry.tree, firstIndex);
  const secondProof = getMerkleProofV1(registry.tree, secondIndex);

  const changeNote = normalizeChangeNote(change, asset);
  const transition = getMerkleAppendTransitionV1(registry.commitments, changeNote.commitment);
  const publicValue = assertU64(publicAmount, 'publicAmount');
  if (publicValue === 0n) throw new RangeError('publicAmount must be non-zero');
  const protocolValue = assertU64(protocolFee, 'protocolFee');
  const relayerValue = assertU64(relayerFee, 'relayerFee');
  const inputsTotal = first.amount + second.amount;
  const outputsTotal = publicValue + protocolValue + relayerValue + changeNote.amount;
  if (inputsTotal !== outputsTotal) {
    throw new Error(`value conservation failed: inputs=${inputsTotal} outputs=${outputsTotal}`);
  }

  const binding = recipientBinding === undefined
    ? await recipientBindingV1(recipient)
    : assertFieldV1(recipientBinding, 'recipientBinding');
  if (binding === 0n) throw new RangeError('recipientBinding must be non-zero');
  const nullifier0 = nullifierV1(first);
  const nullifier1 = nullifierV1(second);
  if (nullifier0 === nullifier1) throw new Error('input notes produce the same nullifier');
  const changeLeafIndex = BigInt(transition.index);

  const publicFields = {
    merkleRoot: registry.root,
    nullifier0,
    nullifier1,
    changeCommitment: changeNote.commitment,
    publicAmount: publicValue,
    protocolFee: protocolValue,
    relayerFee: relayerValue,
    recipientBinding: binding,
    assetId: asset,
    contextBinding: context,
    currentRoot: registry.root,
    newMerkleRoot: transition.newRoot,
    changeLeafIndex,
  };
  const witness = {
    Input0Amount: first.amount.toString(10),
    Input0Owner: first.owner.toString(10),
    Input0Nonce: first.nonce.toString(10),
    Input0Path: decimals(firstProof.path),
    Input0Index: firstProof.indexBits,
    Input1Amount: second.amount.toString(10),
    Input1Owner: second.owner.toString(10),
    Input1Nonce: second.nonce.toString(10),
    Input1Path: decimals(secondProof.path),
    Input1Index: secondProof.indexBits,
    ChangeAmount: changeNote.amount.toString(10),
    ChangeOwner: changeNote.owner.toString(10),
    ChangeNonce: changeNote.nonce.toString(10),
    ChangePath: decimals(transition.path),
    ChangeIndex: transition.indexBits,
    MerkleRoot: registry.root.toString(10),
    Nullifier0: nullifier0.toString(10),
    Nullifier1: nullifier1.toString(10),
    ChangeCommitment: changeNote.commitment.toString(10),
    PublicAmount: publicValue.toString(10),
    ProtocolFee: protocolValue.toString(10),
    RelayerFee: relayerValue.toString(10),
    RecipientBinding: binding.toString(10),
    AssetID: asset.toString(10),
    ContextBinding: context.toString(10),
    CurrentRoot: registry.root.toString(10),
    NewMerkleRoot: transition.newRoot.toString(10),
    ChangeLeafIndex: changeLeafIndex.toString(10),
  };
  return {
    registry,
    transition,
    depositIndices: { input0: firstIndex, input1: secondIndex },
    proofs: { input0: firstProof, input1: secondProof },
    witness,
    publicFields,
    publicInputs: encodePublicInputsV1(publicFields),
    statement: {
      nullifier0: fieldToLe32(nullifier0),
      nullifier1: fieldToLe32(nullifier1),
      changeCommitment: fieldToLe32(changeNote.commitment),
      publicAmount: publicValue,
      protocolFee: protocolValue,
      relayerFee: relayerValue,
    },
  };
}

export async function buildWithdrawWitnessFromChainV1({
  connection,
  commitmentsAccount,
  commitment = 'confirmed',
  ...witnessOptions
}) {
  const registry = await fetchCommitmentRegistryV1(connection, commitmentsAccount, commitment);
  return buildWithdrawWitnessV1({
    ...witnessOptions,
    registryAccountData: encodeCommitmentRegistryV1(registry.commitments),
  });
}
