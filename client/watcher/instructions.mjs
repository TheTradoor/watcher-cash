import { PublicKey, SystemProgram } from '@solana/web3.js';

import { asBytes, concatBytes } from './keccak.mjs';
import { assertU64 } from './field.mjs';

export const WATCHER_INSTRUCTION_INITIALIZE_V1 = 0;
export const WATCHER_INSTRUCTION_DEPOSIT_V1 = 1;
export const WATCHER_INSTRUCTION_WITHDRAW_V1 = 2;
export const VAULT_SEED_V1 = new TextEncoder().encode('watcher-vault-v1');

export const CONFIG_ACCOUNT_LEN_V1 = 100;
export const COMMITMENT_REGISTRY_LEN_V1 = 5 + (32 * 16) + (32 * 4);
export const NULLIFIER_REGISTRY_LEN_V1 = 5 + (32 * 64);
export const ROOT_HISTORY_ACCOUNT_LEN_V1 = 1 + 4 + 4 + (32 * 32);
export const VAULT_ACCOUNT_LEN_V1 = 50;

export const XARK_PROOF_BYTES_V1 = 256;
export const DEPOSIT_INSTRUCTION_PUBLIC_INPUT_BYTES_V1 = 96;
export const WITHDRAW_PUBLIC_INPUT_BYTES_V1 = 320;

// Canonical names used by the browser-facing client. Keep the versioned names
// above for backwards compatibility with the original clean-room SDK.
export const WATCHER_GROTH16_PROOF_BYTES = XARK_PROOF_BYTES_V1;
export const WATCHER_DEPOSIT_PUBLIC_INPUT_BYTES = DEPOSIT_INSTRUCTION_PUBLIC_INPUT_BYTES_V1;
export const WATCHER_WITHDRAW_PUBLIC_INPUT_BYTES = WITHDRAW_PUBLIC_INPUT_BYTES_V1;

export function publicKeyBytesV1(value, label = 'public key') {
  if (value && typeof value.toBytes === 'function') {
    return exactBytes(value.toBytes(), 32, label);
  }
  if (value && typeof value.toBuffer === 'function') {
    return exactBytes(value.toBuffer(), 32, label);
  }
  return exactBytes(value, 32, label);
}

function exactBytes(value, length, label) {
  const bytes = asBytes(value, label);
  if (bytes.length !== length) throw new RangeError(`${label} must be exactly ${length} bytes`);
  return bytes;
}

function publicKey(value, label) {
  return value instanceof PublicKey ? value : new PublicKey(publicKeyBytesV1(value, label));
}

function u16LE(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new RangeError(`${label} must fit in an unsigned 16-bit integer`);
  }
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff);
}

function u64LE(value, label) {
  let remaining = assertU64(value, label);
  const output = new Uint8Array(8);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return output;
}

function prefixedBytes(value, expectedLength, label) {
  const bytes = exactBytes(value, expectedLength, label);
  return concatBytes(u16LE(bytes.length, `${label} length`), bytes);
}

function meta(pubkey, isSigner, isWritable) {
  publicKeyBytesV1(pubkey, 'account pubkey');
  return { pubkey, isSigner, isWritable };
}

export function deriveVaultAddressV1({ programId, config, findProgramAddressSync }) {
  if (typeof findProgramAddressSync !== 'function') {
    throw new TypeError('findProgramAddressSync must be supplied by @solana/web3.js');
  }
  publicKeyBytesV1(programId, 'programId');
  const configBytes = publicKeyBytesV1(config, 'config');
  const result = findProgramAddressSync.call(
    programId?.constructor,
    [VAULT_SEED_V1, configBytes],
    programId,
  );
  if (!Array.isArray(result) || result.length !== 2) {
    throw new Error('findProgramAddressSync returned an invalid PDA result');
  }
  return { vault: result[0], bump: result[1] };
}

export function deriveWatcherVaultPda({ programId, config }) {
  const program = publicKey(programId, 'programId');
  const configBytes = publicKeyBytesV1(config, 'config');
  return PublicKey.findProgramAddressSync([VAULT_SEED_V1, configBytes], program);
}

export function encodeInitializeDataV1({ treasury }) {
  return concatBytes(
    Uint8Array.of(WATCHER_INSTRUCTION_INITIALIZE_V1),
    publicKeyBytesV1(treasury, 'treasury'),
  );
}

export function encodeDepositDataV1({ commitment, amount, proof, publicInputs }) {
  return concatBytes(
    Uint8Array.of(WATCHER_INSTRUCTION_DEPOSIT_V1),
    exactBytes(commitment, 32, 'commitment'),
    u64LE(amount, 'amount'),
    prefixedBytes(proof, XARK_PROOF_BYTES_V1, 'deposit proof'),
    prefixedBytes(
      publicInputs,
      DEPOSIT_INSTRUCTION_PUBLIC_INPUT_BYTES_V1,
      'deposit public inputs',
    ),
  );
}

export function encodeWithdrawDataV1({
  nullifier0,
  nullifier1,
  changeCommitment,
  recipient,
  publicAmount,
  protocolFee = 0n,
  relayerFee = 0n,
  proof,
  publicInputs,
}) {
  return concatBytes(
    Uint8Array.of(WATCHER_INSTRUCTION_WITHDRAW_V1),
    exactBytes(nullifier0, 32, 'nullifier0'),
    exactBytes(nullifier1, 32, 'nullifier1'),
    exactBytes(changeCommitment, 32, 'changeCommitment'),
    publicKeyBytesV1(recipient, 'recipient'),
    u64LE(publicAmount, 'publicAmount'),
    u64LE(protocolFee, 'protocolFee'),
    u64LE(relayerFee, 'relayerFee'),
    prefixedBytes(proof, XARK_PROOF_BYTES_V1, 'withdraw proof'),
    prefixedBytes(publicInputs, WITHDRAW_PUBLIC_INPUT_BYTES_V1, 'withdraw public inputs'),
  );
}

export const encodeInitializeData = encodeInitializeDataV1;
export const encodeDepositData = encodeDepositDataV1;
export const encodeWithdrawData = encodeWithdrawDataV1;

export function buildInitializeInstructionV1({
  programId,
  authority,
  config,
  commitments,
  nullifiers,
  rootHistory,
  vault,
  treasury,
  systemProgram,
}) {
  publicKeyBytesV1(programId, 'programId');
  return {
    programId,
    keys: [
      meta(authority, true, true),
      meta(config, false, true),
      meta(commitments, false, true),
      meta(nullifiers, false, true),
      meta(rootHistory, false, true),
      meta(vault, false, true),
      meta(systemProgram, false, false),
    ],
    data: encodeInitializeDataV1({ treasury }),
  };
}

export function buildDepositInstructionV1({
  programId,
  depositor,
  config,
  commitments,
  rootHistory,
  vault,
  systemProgram,
  commitment,
  amount,
  proof,
  publicInputs,
}) {
  publicKeyBytesV1(programId, 'programId');
  return {
    programId,
    keys: [
      meta(depositor, true, true),
      meta(config, false, true),
      meta(commitments, false, true),
      meta(rootHistory, false, true),
      meta(vault, false, true),
      meta(systemProgram, false, false),
    ],
    data: encodeDepositDataV1({ commitment, amount, proof, publicInputs }),
  };
}

export function buildWithdrawInstructionV1({
  programId,
  config,
  commitments,
  nullifiers,
  rootHistory,
  vault,
  recipient,
  relayer,
  treasury,
  statement,
  proof,
  publicInputs,
}) {
  publicKeyBytesV1(programId, 'programId');
  if (!statement || typeof statement !== 'object') throw new TypeError('statement is required');
  return {
    programId,
    keys: [
      meta(config, false, true),
      meta(commitments, false, true),
      meta(nullifiers, false, true),
      meta(rootHistory, false, true),
      meta(vault, false, true),
      meta(recipient, false, true),
      meta(relayer, false, true),
      meta(treasury, false, true),
    ],
    data: encodeWithdrawDataV1({
      ...statement,
      recipient,
      proof,
      publicInputs,
    }),
  };
}

export function buildInitializeInstruction({
  programId,
  authority,
  config,
  commitments,
  nullifiers,
  rootHistory,
  treasury,
}) {
  const [vault] = deriveWatcherVaultPda({ programId, config });
  return buildInitializeInstructionV1({
    programId,
    authority,
    config,
    commitments,
    nullifiers,
    rootHistory,
    vault,
    treasury,
    systemProgram: SystemProgram.programId,
  });
}

export function buildDepositInstruction({
  programId,
  depositor,
  config,
  commitments,
  rootHistory,
  commitment,
  amount,
  proof,
  publicInputs,
}) {
  const [vault] = deriveWatcherVaultPda({ programId, config });
  return buildDepositInstructionV1({
    programId,
    depositor,
    config,
    commitments,
    rootHistory,
    vault,
    systemProgram: SystemProgram.programId,
    commitment,
    amount,
    proof,
    publicInputs,
  });
}

export function buildWithdrawInstruction({
  programId,
  config,
  commitments,
  nullifiers,
  rootHistory,
  recipient,
  relayer,
  treasury,
  nullifier0,
  nullifier1,
  changeCommitment,
  publicAmount,
  protocolFee = 0n,
  relayerFee = 0n,
  proof,
  publicInputs,
}) {
  const [vault] = deriveWatcherVaultPda({ programId, config });
  return buildWithdrawInstructionV1({
    programId,
    config,
    commitments,
    nullifiers,
    rootHistory,
    vault,
    recipient,
    relayer,
    treasury,
    statement: {
      nullifier0,
      nullifier1,
      changeCommitment,
      recipient,
      publicAmount,
      protocolFee,
      relayerFee,
    },
    proof,
    publicInputs,
  });
}
