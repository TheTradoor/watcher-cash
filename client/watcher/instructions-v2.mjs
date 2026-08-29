import { PublicKey, SystemProgram } from '@solana/web3.js';

import { assertU64 } from './field.mjs';
import { asBytes, concatBytes } from './keccak.mjs';
import { publicKeyBytesV1 } from './instructions.mjs';

export const WATCHER_INSTRUCTION_DEPOSIT_V2 = 0x20;
export const WATCHER_INSTRUCTION_WITHDRAW_V2 = 0x21;
export const WATCHER_INSTRUCTION_INITIALIZE_V2 = 0x22;
export const WATCHER_GROTH16_PROOF_BYTES_V2 = 256;
export const WATCHER_MAX_INPUTS_V2 = 4;
export const WATCHER_DEPOSIT_DATA_BYTES_V2 = 329;
export const WATCHER_WITHDRAW_DATA_BYTES_V2 = 634;
export const NULLIFIER_MARKER_SEED_V2 = new TextEncoder().encode('watcher-nullifier-v2');
export const VAULT_SEED_V2 = new TextEncoder().encode('watcher-vault-v2');

function exactBytes(value, length, label) {
  const bytes = asBytes(value, label);
  if (bytes.length !== length) throw new RangeError(`${label} must be exactly ${length} bytes`);
  return bytes;
}

function isZero32(value) {
  return value.every((byte) => byte === 0);
}

function u64LE(value, label) {
  let remaining = assertU64(value, label);
  const output = new Uint8Array(8);
  for (let index = 0; index < 8; index += 1) {
    output[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return output;
}

function normalizeFields(values, label) {
  if (!Array.isArray(values) || values.length !== WATCHER_MAX_INPUTS_V2) {
    throw new RangeError(`${label} must contain exactly ${WATCHER_MAX_INPUTS_V2} fields`);
  }
  return values.map((value, index) => exactBytes(value, 32, `${label}[${index}]`));
}

function toPublicKey(value, label) {
  return value instanceof PublicKey ? value : new PublicKey(publicKeyBytesV1(value, label));
}

function meta(pubkey, isSigner, isWritable) {
  return { pubkey: toPublicKey(pubkey, 'account pubkey'), isSigner, isWritable };
}

export function deriveWatcherVaultPdaV2({ programId, config }) {
  const program = toPublicKey(programId, 'programId');
  const configBytes = publicKeyBytesV1(config, 'config');
  return PublicKey.findProgramAddressSync([VAULT_SEED_V2, configBytes], program);
}

export function validateWithdrawStatementV2({
  inputCount,
  inputRoots,
  nullifiers,
  changeCommitment,
  publicAmount,
  protocolFee = 0n,
  newRoot,
}) {
  if (!Number.isInteger(inputCount) || inputCount < 1 || inputCount > WATCHER_MAX_INPUTS_V2) {
    throw new RangeError(`inputCount must be between 1 and ${WATCHER_MAX_INPUTS_V2}`);
  }
  const roots = normalizeFields(inputRoots, 'inputRoots');
  const spends = normalizeFields(nullifiers, 'nullifiers');
  for (let index = 0; index < WATCHER_MAX_INPUTS_V2; index += 1) {
    const active = index < inputCount;
    if (active) {
      if (isZero32(roots[index])) throw new Error(`inputRoots[${index}] must be non-zero`);
      if (isZero32(spends[index])) throw new Error(`nullifiers[${index}] must be non-zero`);
    } else if (!isZero32(roots[index]) || !isZero32(spends[index])) {
      throw new Error('inactive V2 proof slots must use canonical zero roots/nullifiers');
    }
  }
  for (let left = 0; left < inputCount; left += 1) {
    for (let right = left + 1; right < inputCount; right += 1) {
      if (spends[left].every((byte, index) => byte === spends[right][index])) {
        throw new Error('duplicate active V2 nullifier');
      }
    }
  }
  if (assertU64(publicAmount, 'publicAmount') === 0n) {
    throw new RangeError('publicAmount must be non-zero');
  }
  if (assertU64(protocolFee, 'protocolFee') !== 0n) {
    throw new Error('protocol fees are disabled during development');
  }
  const change = exactBytes(changeCommitment, 32, 'changeCommitment');
  const nextRoot = exactBytes(newRoot, 32, 'newRoot');
  if (isZero32(change) !== isZero32(nextRoot)) {
    throw new Error('changeCommitment and newRoot must both be zero or both be non-zero');
  }
  return { roots, spends, change, nextRoot };
}

export function encodeInitializeDataV2({ treasury }) {
  return concatBytes(
    Uint8Array.of(WATCHER_INSTRUCTION_INITIALIZE_V2),
    publicKeyBytesV1(treasury, 'treasury'),
  );
}

export function encodeDepositDataV2({ commitment, amount, newRoot, proof }) {
  const commitmentBytes = exactBytes(commitment, 32, 'commitment');
  const newRootBytes = exactBytes(newRoot, 32, 'newRoot');
  if (isZero32(commitmentBytes) || isZero32(newRootBytes)) {
    throw new Error('commitment and newRoot must be non-zero');
  }
  if (assertU64(amount, 'amount') === 0n) throw new RangeError('amount must be non-zero');
  const output = concatBytes(
    Uint8Array.of(WATCHER_INSTRUCTION_DEPOSIT_V2),
    commitmentBytes,
    u64LE(amount, 'amount'),
    newRootBytes,
    exactBytes(proof, WATCHER_GROTH16_PROOF_BYTES_V2, 'deposit proof'),
  );
  if (output.length !== WATCHER_DEPOSIT_DATA_BYTES_V2) throw new Error('unexpected V2 deposit encoding length');
  return output;
}

export function encodeWithdrawDataV2({
  inputCount,
  inputRoots,
  nullifiers,
  changeCommitment,
  recipient,
  publicAmount,
  protocolFee = 0n,
  relayerFee = 0n,
  newRoot,
  proof,
}) {
  const { roots, spends, change, nextRoot } = validateWithdrawStatementV2({
    inputCount,
    inputRoots,
    nullifiers,
    changeCommitment,
    publicAmount,
    protocolFee,
    newRoot,
  });
  const output = concatBytes(
    Uint8Array.of(WATCHER_INSTRUCTION_WITHDRAW_V2, inputCount),
    ...roots,
    ...spends,
    change,
    publicKeyBytesV1(recipient, 'recipient'),
    u64LE(publicAmount, 'publicAmount'),
    u64LE(protocolFee, 'protocolFee'),
    u64LE(relayerFee, 'relayerFee'),
    nextRoot,
    exactBytes(proof, WATCHER_GROTH16_PROOF_BYTES_V2, 'withdraw proof'),
  );
  if (output.length !== WATCHER_WITHDRAW_DATA_BYTES_V2) throw new Error('unexpected V2 withdraw encoding length');
  return output;
}

export function deriveNullifierMarkerPdaV2({ programId, config, nullifier }) {
  const program = toPublicKey(programId, 'programId');
  const configBytes = publicKeyBytesV1(config, 'config');
  const nullifierBytes = exactBytes(nullifier, 32, 'nullifier');
  if (isZero32(nullifierBytes)) throw new Error('nullifier must be non-zero');
  return PublicKey.findProgramAddressSync(
    [NULLIFIER_MARKER_SEED_V2, configBytes, nullifierBytes],
    program,
  );
}

export function buildInitializeInstructionV2({
  programId,
  authority,
  config,
  activeTree,
  vault,
  treasury,
  systemProgram = SystemProgram.programId,
}) {
  return {
    programId: toPublicKey(programId, 'programId'),
    keys: [
      meta(authority, true, true),
      meta(config, false, true),
      meta(activeTree, false, true),
      meta(vault, false, true),
      meta(systemProgram, false, false),
    ],
    data: encodeInitializeDataV2({ treasury }),
  };
}

export function buildDepositInstructionV2({
  programId,
  depositor,
  config,
  activeTree,
  vault,
  commitment,
  amount,
  newRoot,
  proof,
  systemProgram = SystemProgram.programId,
}) {
  return {
    programId: toPublicKey(programId, 'programId'),
    keys: [
      meta(depositor, true, true),
      meta(config, false, false),
      meta(activeTree, false, true),
      meta(vault, false, true),
      meta(systemProgram, false, false),
    ],
    data: encodeDepositDataV2({ commitment, amount, newRoot, proof }),
  };
}

export function buildWithdrawInstructionV2({
  programId,
  config,
  activeTree,
  vault,
  recipient,
  relayer,
  treasury,
  inputCount,
  inputRoots,
  nullifiers,
  changeCommitment,
  publicAmount,
  protocolFee = 0n,
  relayerFee = 0n,
  newRoot,
  proof,
  markerAccounts,
  sealedRootAccounts = [],
  systemProgram = SystemProgram.programId,
}) {
  if (!Array.isArray(markerAccounts) || markerAccounts.length !== inputCount) {
    throw new RangeError('markerAccounts must contain one PDA for each active V2 input');
  }
  if (!Array.isArray(sealedRootAccounts)) throw new TypeError('sealedRootAccounts must be an array');
  return {
    programId: toPublicKey(programId, 'programId'),
    keys: [
      meta(config, false, false),
      meta(activeTree, false, true),
      meta(vault, false, true),
      meta(recipient, false, true),
      meta(relayer, true, true),
      meta(treasury, false, true),
      meta(systemProgram, false, false),
      ...markerAccounts.map((account) => meta(account, false, true)),
      ...sealedRootAccounts.map((account) => meta(account, false, false)),
    ],
    data: encodeWithdrawDataV2({
      inputCount,
      inputRoots,
      nullifiers,
      changeCommitment,
      recipient,
      publicAmount,
      protocolFee,
      relayerFee,
      newRoot,
      proof,
    }),
  };
}
