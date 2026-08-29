import { PublicKey, SystemProgram } from '@solana/web3.js';

import { fieldToLe32 } from './field.mjs';
import { concatBytes, keccak256 } from './keccak.mjs';
import { publicKeyBytesV1 } from './instructions.mjs';
import {
  encodeWithdrawDataV2,
  WATCHER_MAX_INPUTS_V2,
  WATCHER_WITHDRAW_DATA_BYTES_V2,
} from './instructions-v2.mjs';

export const WATCHER_INSTRUCTION_WITHDRAW_V3 = 0x31;
export const WATCHER_INSTRUCTION_INITIALIZE_NULLIFIER_SHARD_V3 = 0x33;
export const NULLIFIER_SHARD_SEED_V3 = new TextEncoder().encode('watcher-nullifier-shard-v3');
export const NULLIFIER_BUCKET_DOMAIN_V3 = new TextEncoder().encode('watcher-nullifier-bucket-v3');
export const NULLIFIER_SHARD_COUNT_V3 = 32;
export const NULLIFIER_BUCKETS_PER_SHARD_V3 = 2048;
export const NULLIFIER_SHARD_HEADER_BYTES_V3 = 8_240;
export const NULLIFIER_RECORD_BYTES_V3 = 36;

function toPublicKey(value, label) {
  return value instanceof PublicKey ? value : new PublicKey(publicKeyBytesV1(value, label));
}

function exact32(value, label) {
  const bytes = value instanceof Uint8Array ? new Uint8Array(value) : Uint8Array.from(value || []);
  if (bytes.length !== 32) throw new RangeError(`${label} must be exactly 32 bytes`);
  if (bytes.every((byte) => byte === 0)) throw new Error(`${label} must be non-zero`);
  return bytes;
}

function meta(pubkey, isSigner, isWritable) {
  return { pubkey: toPublicKey(pubkey, 'account pubkey'), isSigner, isWritable };
}

export function routeNullifierV3({ config, nullifier }) {
  const configBytes = publicKeyBytesV1(config, 'config');
  const nullifierBytes = exact32(nullifier, 'nullifier');
  const digest = keccak256(concatBytes(NULLIFIER_BUCKET_DOMAIN_V3, configBytes, nullifierBytes));
  const key = (digest[0] << 8) | digest[1];
  return Object.freeze({
    shard: key >>> 11,
    bucket: key & 0x07ff,
  });
}

export function deriveNullifierShardPdaV3({ programId, config, shard }) {
  if (!Number.isInteger(shard) || shard < 0 || shard >= NULLIFIER_SHARD_COUNT_V3) {
    throw new RangeError(`shard must be between 0 and ${NULLIFIER_SHARD_COUNT_V3 - 1}`);
  }
  const program = toPublicKey(programId, 'programId');
  const configBytes = publicKeyBytesV1(config, 'config');
  return PublicKey.findProgramAddressSync(
    [NULLIFIER_SHARD_SEED_V3, configBytes, Uint8Array.of(shard)],
    program,
  );
}

export function deriveNullifierShardForSpendV3({ programId, config, nullifier }) {
  const route = routeNullifierV3({ config, nullifier });
  const [pubkey, bump] = deriveNullifierShardPdaV3({ programId, config, shard: route.shard });
  return Object.freeze({ ...route, pubkey, bump });
}

export function encodeInitializeNullifierShardDataV3(shard) {
  if (!Number.isInteger(shard) || shard < 0 || shard >= NULLIFIER_SHARD_COUNT_V3) {
    throw new RangeError(`shard must be between 0 and ${NULLIFIER_SHARD_COUNT_V3 - 1}`);
  }
  return Uint8Array.of(WATCHER_INSTRUCTION_INITIALIZE_NULLIFIER_SHARD_V3, shard);
}

export function buildInitializeNullifierShardInstructionV3({
  programId,
  authority,
  config,
  shard,
  systemProgram = SystemProgram.programId,
}) {
  const [shardPda] = deriveNullifierShardPdaV3({ programId, config, shard });
  return {
    programId: toPublicKey(programId, 'programId'),
    keys: [
      meta(authority, true, true),
      meta(config, false, false),
      meta(shardPda, false, true),
      meta(systemProgram, false, false),
    ],
    data: encodeInitializeNullifierShardDataV3(shard),
    shardPda,
  };
}

export function encodeWithdrawDataV3(options) {
  const data = new Uint8Array(encodeWithdrawDataV2(options));
  if (data.length !== WATCHER_WITHDRAW_DATA_BYTES_V2) {
    throw new Error('unexpected V3 withdraw wire length');
  }
  data[0] = WATCHER_INSTRUCTION_WITHDRAW_V3;
  return data;
}

export function buildWithdrawInstructionV3({
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
  sealedRootAccounts = [],
  systemProgram = SystemProgram.programId,
}) {
  if (!Number.isInteger(inputCount) || inputCount < 1 || inputCount > WATCHER_MAX_INPUTS_V2) {
    throw new RangeError(`inputCount must be between 1 and ${WATCHER_MAX_INPUTS_V2}`);
  }
  if (!Array.isArray(nullifiers) || nullifiers.length !== WATCHER_MAX_INPUTS_V2) {
    throw new RangeError(`nullifiers must contain exactly ${WATCHER_MAX_INPUTS_V2} fields`);
  }
  if (!Array.isArray(sealedRootAccounts)) throw new TypeError('sealedRootAccounts must be an array');

  // Keep one account meta per active input, even when two nullifiers route to
  // the same shard. Solana permits duplicate metas and the program consumes
  // accounts positionally while appending both exact 32-byte values atomically.
  const shardAccounts = nullifiers.slice(0, inputCount).map((nullifier) =>
    deriveNullifierShardForSpendV3({ programId, config, nullifier }).pubkey);

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
      ...shardAccounts.map((account) => meta(account, false, true)),
      ...sealedRootAccounts.map((account) => meta(account, false, false)),
    ],
    data: encodeWithdrawDataV3({
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
    shardAccounts,
  };
}

export function nullifierFieldToRouteV3({ config, nullifierField }) {
  return routeNullifierV3({ config, nullifier: fieldToLe32(nullifierField) });
}
