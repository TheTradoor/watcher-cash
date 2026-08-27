import { asBytes } from './keccak.mjs';
import {
  assertFieldV1,
  assertU64,
  bytesToBigIntLE,
  fieldToLe32,
  merkleParentV1,
  noteCommitmentV1,
  nullifierV1,
} from './field.mjs';
import { recipientBindingBytesV1, withdrawContextBindingV1 } from './bindings.mjs';
import {
  buildDepositInstruction,
  buildWithdrawInstruction,
  deriveWatcherVaultPda,
} from './instructions.mjs';
import { proveDepositLocally, proveWithdrawLocally } from './prover.node.mjs';

export const WATCHER_MERKLE_DEPTH_V1 = 4;
export const WATCHER_MERKLE_LEAVES_V1 = 1 << WATCHER_MERKLE_DEPTH_V1;
export const WATCHER_SOL_ASSET_ID_V1 = 1n;

function keyBytes(value, label) {
  if (value?.toBytes) return new Uint8Array(value.toBytes());
  const bytes = asBytes(value, label);
  if (bytes.length !== 32) throw new RangeError(`${label} must be exactly 32 bytes`);
  return bytes;
}

function nonZeroField(value, label) {
  const field = assertFieldV1(value, label);
  if (field === 0n) throw new RangeError(`${label} must be non-zero`);
  return field;
}

export function decodeCommitmentRegistryV1(data) {
  const bytes = asBytes(data, 'commitment registry');
  if (bytes.length < 5 || bytes[0] !== 1) throw new Error('invalid commitment registry header');
  const count = new DataView(bytes.buffer, bytes.byteOffset + 1, 4).getUint32(0, true);
  if (count > WATCHER_MERKLE_LEAVES_V1) throw new Error('commitment registry exceeds Circuit V1 capacity');
  const end = 5 + count * 32;
  if (end > bytes.length) throw new Error('truncated commitment registry');
  const commitments = [];
  for (let index = 0; index < count; index += 1) {
    const raw = bytes.slice(5 + index * 32, 5 + (index + 1) * 32);
    commitments.push(assertFieldV1(bytesToBigIntLE(raw), `commitment ${index}`));
  }
  return Object.freeze(commitments);
}

export function buildCommitmentTreeV1(commitments) {
  if (!Array.isArray(commitments) || commitments.length > WATCHER_MERKLE_LEAVES_V1) {
    throw new RangeError('commitments must fit in the fixed 16-leaf tree');
  }
  const levels = [Array.from({ length: WATCHER_MERKLE_LEAVES_V1 }, () => 0n)];
  commitments.forEach((commitment, index) => {
    levels[0][index] = assertFieldV1(commitment, `commitment ${index}`);
  });
  for (let depth = 0; depth < WATCHER_MERKLE_DEPTH_V1; depth += 1) {
    const current = levels[depth];
    const next = [];
    for (let index = 0; index < current.length; index += 2) {
      next.push(merkleParentV1(current[index], current[index + 1]));
    }
    levels.push(next);
  }
  return Object.freeze({
    root: levels[WATCHER_MERKLE_DEPTH_V1][0],
    levels: Object.freeze(levels.map((level) => Object.freeze([...level]))),
  });
}

export function merklePathV1(tree, leafIndex) {
  if (!Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex >= WATCHER_MERKLE_LEAVES_V1) {
    throw new RangeError('leafIndex is outside the fixed tree');
  }
  const path = [];
  const indexBits = [];
  let position = leafIndex;
  for (let depth = 0; depth < WATCHER_MERKLE_DEPTH_V1; depth += 1) {
    const isRight = position & 1;
    path.push(tree.levels[depth][isRight ? position - 1 : position + 1]);
    indexBits.push(BigInt(isRight));
    position >>= 1;
  }
  return Object.freeze({ path: Object.freeze(path), indexBits: Object.freeze(indexBits) });
}

export function normalizeNoteV1(note, assetId = WATCHER_SOL_ASSET_ID_V1) {
  if (!note || typeof note !== 'object') throw new TypeError('note must be an object');
  const normalized = Object.freeze({
    assetId: assertFieldV1(note.assetId ?? assetId, 'note assetId'),
    amount: assertU64(note.amount, 'note amount'),
    owner: nonZeroField(note.owner, 'note owner'),
    nonce: nonZeroField(note.nonce, 'note nonce'),
  });
  const commitment = noteCommitmentV1(normalized);
  if (note.commitment !== undefined && assertFieldV1(note.commitment) !== commitment) {
    throw new Error('note commitment does not match its private fields');
  }
  return Object.freeze({ ...normalized, commitment });
}

export async function buildWithdrawalWitnessForStateV1({
  registryData,
  inputNotes,
  recipient,
  programId,
  config,
  relayer,
  treasury,
  publicAmount,
  protocolFee = 0n,
  relayerFee = 0n,
  changeOwner,
  changeNonce,
  assetId = WATCHER_SOL_ASSET_ID_V1,
}) {
  if (!Array.isArray(inputNotes) || inputNotes.length !== 2) {
    throw new RangeError('Circuit V1 requires exactly two input notes');
  }
  const asset = assertFieldV1(assetId, 'assetId');
  if (asset !== WATCHER_SOL_ASSET_ID_V1) throw new Error('only native SOL is supported');
  const notes = inputNotes.map((note) => normalizeNoteV1(note, asset));
  if (notes[0].commitment === notes[1].commitment) throw new Error('input commitments must differ');

  const commitments = decodeCommitmentRegistryV1(registryData);
  const indices = notes.map((note) => commitments.findIndex((value) => value === note.commitment));
  if (indices.some((index) => index < 0)) throw new Error('an input note is absent from the on-chain registry');
  if (indices[0] === indices[1]) throw new Error('input notes resolve to the same deposit index');

  const tree = buildCommitmentTreeV1(commitments);
  const proofs = indices.map((index) => merklePathV1(tree, index));
  const publicValue = assertU64(publicAmount, 'publicAmount');
  const protocolValue = assertU64(protocolFee, 'protocolFee');
  const relayerValue = assertU64(relayerFee, 'relayerFee');
  if (protocolValue !== 0n) throw new Error('protocol fees are disabled during development');
  const totalInput = notes[0].amount + notes[1].amount;
  const publicOutput = publicValue + protocolValue + relayerValue;
  if (publicOutput >= totalInput) throw new Error('withdrawal must leave a positive private change note');
  const changeAmount = totalInput - publicOutput;
  const change = normalizeNoteV1(
    { amount: changeAmount, owner: changeOwner, nonce: changeNonce, assetId: asset },
    asset,
  );

  const recipientBytes = keyBytes(recipient, 'recipient');
  const programBytes = keyBytes(programId, 'programId');
  const configBytes = keyBytes(config, 'config');
  const relayerBytes = keyBytes(relayer, 'relayer');
  const treasuryBytes = keyBytes(treasury, 'treasury');
  const [vault] = deriveWatcherVaultPda({ programId, config });
  const recipientBinding = await recipientBindingBytesV1(recipientBytes);
  const contextBinding = await withdrawContextBindingV1({
    programId: programBytes,
    config: configBytes,
    vault: vault.toBytes(),
    relayer: relayerBytes,
    treasury: treasuryBytes,
    assetId: asset,
  });
  const nullifiers = notes.map((note) =>
    nullifierV1({ owner: note.owner, nonce: note.nonce, commitment: note.commitment }),
  );

  const witness = Object.freeze({
    Input0Amount: notes[0].amount,
    Input0Owner: notes[0].owner,
    Input0Nonce: notes[0].nonce,
    Input0Path: proofs[0].path,
    Input0Index: proofs[0].indexBits,
    Input1Amount: notes[1].amount,
    Input1Owner: notes[1].owner,
    Input1Nonce: notes[1].nonce,
    Input1Path: proofs[1].path,
    Input1Index: proofs[1].indexBits,
    ChangeAmount: change.amount,
    ChangeOwner: change.owner,
    ChangeNonce: change.nonce,
    MerkleRoot: tree.root,
    Nullifier0: nullifiers[0],
    Nullifier1: nullifiers[1],
    ChangeCommitment: change.commitment,
    PublicAmount: publicValue,
    ProtocolFee: protocolValue,
    RelayerFee: relayerValue,
    RecipientBinding: recipientBinding.field,
    AssetID: asset,
    ContextBinding: contextBinding.field,
  });

  return Object.freeze({
    witness,
    statement: Object.freeze({
      nullifier0: fieldToLe32(nullifiers[0]),
      nullifier1: fieldToLe32(nullifiers[1]),
      changeCommitment: fieldToLe32(change.commitment),
      recipient,
      publicAmount: publicValue,
      protocolFee: protocolValue,
      relayerFee: relayerValue,
    }),
    vault,
    root: tree.root,
    inputIndices: Object.freeze(indices),
    change,
  });
}

export async function preparePrivateDepositV1({
  bundleDirectory,
  programId,
  depositor,
  config,
  commitments,
  rootHistory,
  note,
  proverOptions = {},
}) {
  const normalized = normalizeNoteV1(note);
  const proof = await proveDepositLocally({
    bundleDirectory,
    witness: {
      Owner: normalized.owner,
      Nonce: normalized.nonce,
      Commitment: normalized.commitment,
      Amount: normalized.amount,
      AssetID: normalized.assetId,
    },
    ...proverOptions,
  });
  return Object.freeze({
    note: normalized,
    proof,
    instruction: buildDepositInstruction({
      programId,
      depositor,
      config,
      commitments,
      rootHistory,
      commitment: fieldToLe32(normalized.commitment),
      amount: normalized.amount,
      proof: proof.proof,
      publicInputs: proof.publicInputs,
    }),
  });
}

export async function preparePrivateWithdrawalV1({
  bundleDirectory,
  programId,
  config,
  commitments,
  nullifiers,
  rootHistory,
  recipient,
  relayer,
  treasury,
  registryData,
  inputNotes,
  publicAmount,
  protocolFee = 0n,
  relayerFee = 0n,
  changeOwner,
  changeNonce,
  proverOptions = {},
}) {
  const prepared = await buildWithdrawalWitnessForStateV1({
    registryData,
    inputNotes,
    recipient,
    programId,
    config,
    relayer,
    treasury,
    publicAmount,
    protocolFee,
    relayerFee,
    changeOwner,
    changeNonce,
  });
  const proof = await proveWithdrawLocally({
    bundleDirectory,
    witness: prepared.witness,
    ...proverOptions,
  });
  return Object.freeze({
    ...prepared,
    proof,
    instruction: buildWithdrawInstruction({
      programId,
      config,
      commitments,
      nullifiers,
      rootHistory,
      recipient,
      relayer,
      treasury,
      ...prepared.statement,
      proof: proof.proof,
      publicInputs: proof.publicInputs,
    }),
  });
}
