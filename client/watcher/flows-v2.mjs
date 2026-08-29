import { asBytes } from './keccak.mjs';
import {
  fieldToLe32,
  noteCommitmentV1,
  nullifierV1,
} from './field.mjs';
import {
  depositContextBindingV2,
  recipientBindingV2,
  withdrawContextBindingV2,
} from './bindings-v2.mjs';
import {
  getMerkleAppendTransitionV2,
  getMerkleProofV2,
  MERKLE_DEPTH_V2,
} from './merkle-v2.mjs';
import {
  buildDepositInstructionV2,
  buildWithdrawInstructionV2,
  deriveNullifierMarkerPdaV2,
} from './instructions-v2.mjs';
import {
  reconstructDepositPublicInputsV2,
  reconstructWithdrawPublicInputsV2,
} from './public-inputs-v2.mjs';

const ZERO_FIELD_BYTES = new Uint8Array(32);
const ZERO_PATH_V2 = Object.freeze(Array.from({ length: MERKLE_DEPTH_V2 }, () => '0'));
const ZERO_BITS_V2 = Object.freeze(Array.from({ length: MERKLE_DEPTH_V2 }, () => 0));

function keyBytes(value, label) {
  let raw = value;
  if (value && typeof value.toBytes === 'function') raw = value.toBytes();
  else if (value && typeof value.toBuffer === 'function') raw = value.toBuffer();
  const bytes = asBytes(raw, label);
  if (bytes.length !== 32) throw new RangeError(`${label} must be exactly 32 bytes`);
  return bytes;
}

function decimalArray(values) {
  return values.map((value) => BigInt(value).toString(10));
}

function requireProver(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a proving function`);
  return value;
}

function requireTree(tree) {
  if (!tree || tree.version !== 2 || !Array.isArray(tree.commitments)) {
    throw new TypeError('a verified V2 sparse Merkle tree is required');
  }
  return tree;
}

function requireAccounts(accounts, names) {
  if (!accounts || typeof accounts !== 'object') throw new TypeError('accounts are required');
  for (const name of names) {
    if (accounts[name] === undefined || accounts[name] === null) {
      throw new TypeError(`accounts.${name} is required`);
    }
  }
}

function commitmentIndex(tree, commitment) {
  const target = BigInt(commitment);
  const index = tree.commitments.findIndex((candidate) => candidate === target);
  if (index < 0) {
    throw new Error('A selected V2 note is not present in the verified active-tree cache');
  }
  return index;
}

export async function prepareDepositV2({
  accounts,
  tree,
  note,
  assetId = 1n,
  proveDeposit,
  proverOptions = {},
}) {
  requireAccounts(accounts, ['programId', 'depositor', 'config', 'activeTree', 'vault']);
  const verifiedTree = requireTree(tree);
  if (!note || typeof note !== 'object') throw new TypeError('note is required');
  const normalizedNote = {
    assetId: BigInt(note.assetId ?? assetId),
    amount: BigInt(note.amount),
    owner: BigInt(note.owner),
    nonce: BigInt(note.nonce),
  };
  const commitment = noteCommitmentV1(normalizedNote);
  const append = getMerkleAppendTransitionV2(verifiedTree, commitment);
  const contextBinding = await depositContextBindingV2({
    programId: keyBytes(accounts.programId, 'programId'),
    config: keyBytes(accounts.config, 'config'),
    vault: keyBytes(accounts.vault, 'vault'),
    activeTree: keyBytes(accounts.activeTree, 'activeTree'),
    assetId: normalizedNote.assetId,
  });
  const publicInputs = reconstructDepositPublicInputsV2({
    commitment: fieldToLe32(commitment),
    amount: normalizedNote.amount,
    assetId: normalizedNote.assetId,
    epoch: verifiedTree.epoch,
    contextBinding: contextBinding.bytes,
    oldRoot: fieldToLe32(append.oldRoot),
    newRoot: fieldToLe32(append.newRoot),
    leafIndex: append.index,
  });
  const witness = {
    Owner: normalizedNote.owner.toString(10),
    Nonce: normalizedNote.nonce.toString(10),
    Path: decimalArray(append.path),
    Index: [...append.indexBits],
    Commitment: commitment.toString(10),
    Amount: normalizedNote.amount.toString(10),
    AssetID: normalizedNote.assetId.toString(10),
    Epoch: BigInt(verifiedTree.epoch).toString(10),
    ContextBinding: contextBinding.field.toString(10),
    OldRoot: append.oldRoot.toString(10),
    NewRoot: append.newRoot.toString(10),
    LeafIndex: BigInt(append.index).toString(10),
  };
  const generated = await requireProver(proveDeposit, 'proveDeposit')({
    witness,
    expectedPublicInputs: publicInputs.bytes,
    ...proverOptions,
  });
  const instruction = buildDepositInstructionV2({
    ...accounts,
    commitment: fieldToLe32(commitment),
    amount: normalizedNote.amount,
    newRoot: fieldToLe32(append.newRoot),
    proof: generated.proof,
  });
  return Object.freeze({
    note: Object.freeze({ ...normalizedNote, commitment }),
    commitment,
    append,
    contextBinding,
    witness: Object.freeze(witness),
    publicInputs: publicInputs.bytes,
    proof: generated.proof,
    bundleDigest: generated.bundleDigest,
    instruction,
  });
}

export async function prepareWithdrawV2({
  accounts,
  tree,
  selection,
  change,
  publicAmount,
  protocolFee = 0n,
  relayerFee = 0n,
  assetId = 1n,
  proveWithdraw,
  proverOptions = {},
  sealedRootAccounts = [],
}) {
  requireAccounts(accounts, [
    'programId', 'config', 'activeTree', 'vault', 'recipient', 'relayer', 'treasury',
  ]);
  const verifiedTree = requireTree(tree);
  if (!selection || !Array.isArray(selection.inputs) || selection.inputs.length < 1 || selection.inputs.length > 4) {
    throw new TypeError('a V2 1-4 note selection is required');
  }
  const publicValue = BigInt(publicAmount);
  const protocolValue = BigInt(protocolFee);
  const relayerValue = BigInt(relayerFee);
  const expectedChange = selection.total - publicValue - protocolValue - relayerValue;
  if (expectedChange < 0n || expectedChange !== BigInt(selection.changeAmount)) {
    throw new Error('V2 selection does not balance against withdrawal outputs');
  }

  const activeInputs = selection.inputs.map((input) => {
    if (BigInt(input.assetId) !== BigInt(assetId)) throw new Error('V2 input asset does not match withdrawal asset');
    const index = commitmentIndex(verifiedTree, input.commitment);
    const membership = getMerkleProofV2(verifiedTree, index);
    const nullifier = nullifierV1(input);
    return Object.freeze({ input, index, membership, nullifier });
  });

  const inputRoots = Array.from({ length: 4 }, (_, index) => (
    index < activeInputs.length ? fieldToLe32(activeInputs[index].membership.root) : ZERO_FIELD_BYTES
  ));
  const nullifiers = Array.from({ length: 4 }, (_, index) => (
    index < activeInputs.length ? fieldToLe32(activeInputs[index].nullifier) : ZERO_FIELD_BYTES
  ));

  let changeNote = null;
  let changeCommitment = 0n;
  let append = null;
  if (selection.hasChange) {
    if (!change || typeof change !== 'object') throw new TypeError('change note secrets are required');
    changeNote = {
      assetId: BigInt(change.assetId ?? assetId),
      amount: BigInt(selection.changeAmount),
      owner: BigInt(change.owner),
      nonce: BigInt(change.nonce),
    };
    if (changeNote.assetId !== BigInt(assetId)) throw new Error('V2 change asset does not match withdrawal asset');
    changeCommitment = noteCommitmentV1(changeNote);
    append = getMerkleAppendTransitionV2(verifiedTree, changeCommitment);
  }

  const recipientBinding = await recipientBindingV2(keyBytes(accounts.recipient, 'recipient'));
  const contextBinding = await withdrawContextBindingV2({
    programId: keyBytes(accounts.programId, 'programId'),
    config: keyBytes(accounts.config, 'config'),
    vault: keyBytes(accounts.vault, 'vault'),
    activeTree: keyBytes(accounts.activeTree, 'activeTree'),
    relayer: keyBytes(accounts.relayer, 'relayer'),
    treasury: keyBytes(accounts.treasury, 'treasury'),
    assetId,
  });

  const publicInputs = reconstructWithdrawPublicInputsV2({
    inputCount: activeInputs.length,
    inputRoots,
    nullifiers,
    changeCommitment: fieldToLe32(changeCommitment),
    publicAmount: publicValue,
    protocolFee: protocolValue,
    relayerFee: relayerValue,
    recipientBinding: recipientBinding.bytes,
    assetId,
    contextBinding: contextBinding.bytes,
    activeCurrentRoot: selection.hasChange ? fieldToLe32(verifiedTree.root) : ZERO_FIELD_BYTES,
    activeNextIndex: selection.hasChange ? verifiedTree.count : 0,
    newRoot: selection.hasChange ? fieldToLe32(append.newRoot) : ZERO_FIELD_BYTES,
  });

  const inputs = Array.from({ length: 4 }, (_, index) => {
    const active = activeInputs[index];
    if (!active) {
      return {
        Enabled: 0,
        Amount: '0',
        Owner: '0',
        Nonce: '0',
        Path: [...ZERO_PATH_V2],
        Index: [...ZERO_BITS_V2],
        Root: '0',
        Nullifier: '0',
      };
    }
    return {
      Enabled: 1,
      Amount: BigInt(active.input.amount).toString(10),
      Owner: BigInt(active.input.owner).toString(10),
      Nonce: BigInt(active.input.nonce).toString(10),
      Path: decimalArray(active.membership.path),
      Index: [...active.membership.indexBits],
      Root: active.membership.root.toString(10),
      Nullifier: active.nullifier.toString(10),
    };
  });

  const witness = {
    Inputs: inputs,
    Change: selection.hasChange ? {
      Enabled: 1,
      Amount: changeNote.amount.toString(10),
      Owner: changeNote.owner.toString(10),
      Nonce: changeNote.nonce.toString(10),
      Path: decimalArray(append.path),
      Index: [...append.indexBits],
    } : {
      Enabled: 0,
      Amount: '0',
      Owner: '0',
      Nonce: '0',
      Path: [...ZERO_PATH_V2],
      Index: [...ZERO_BITS_V2],
    },
    InputCount: BigInt(activeInputs.length).toString(10),
    ChangeCommitment: changeCommitment.toString(10),
    PublicAmount: publicValue.toString(10),
    ProtocolFee: protocolValue.toString(10),
    RelayerFee: relayerValue.toString(10),
    RecipientBinding: recipientBinding.field.toString(10),
    AssetID: BigInt(assetId).toString(10),
    ContextBinding: contextBinding.field.toString(10),
    CurrentRoot: selection.hasChange ? verifiedTree.root.toString(10) : '0',
    NewMerkleRoot: selection.hasChange ? append.newRoot.toString(10) : '0',
    ChangeLeafIndex: selection.hasChange ? BigInt(append.index).toString(10) : '0',
  };

  const generated = await requireProver(proveWithdraw, 'proveWithdraw')({
    witness,
    expectedPublicInputs: publicInputs.bytes,
    ...proverOptions,
  });
  const markerAccounts = activeInputs.map(({ nullifier }) => deriveNullifierMarkerPdaV2({
    programId: accounts.programId,
    config: accounts.config,
    nullifier: fieldToLe32(nullifier),
  })[0]);
  const instruction = buildWithdrawInstructionV2({
    ...accounts,
    inputCount: activeInputs.length,
    inputRoots,
    nullifiers,
    changeCommitment: fieldToLe32(changeCommitment),
    publicAmount: publicValue,
    protocolFee: protocolValue,
    relayerFee: relayerValue,
    newRoot: selection.hasChange ? fieldToLe32(append.newRoot) : ZERO_FIELD_BYTES,
    proof: generated.proof,
    markerAccounts,
    sealedRootAccounts,
  });

  return Object.freeze({
    activeInputs: Object.freeze(activeInputs),
    inputRoots: Object.freeze(inputRoots),
    nullifiers: Object.freeze(nullifiers),
    markerAccounts: Object.freeze(markerAccounts),
    changeNote: changeNote ? Object.freeze({ ...changeNote, commitment: changeCommitment }) : null,
    append,
    recipientBinding,
    contextBinding,
    witness: Object.freeze(witness),
    publicInputs: publicInputs.bytes,
    proof: generated.proof,
    bundleDigest: generated.bundleDigest,
    instruction,
  });
}
