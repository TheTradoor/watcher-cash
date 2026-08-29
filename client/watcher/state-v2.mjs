import { PublicKey } from '@solana/web3.js';

import { asBytes } from './keccak.mjs';
import { fieldFromLe32 } from './field.mjs';

export const ACTIVE_TREE_ACCOUNT_LEN_V2 = 591;
export const ACTIVE_TREE_RECENT_ROOTS_V2 = 16;
export const ACTIVE_TREE_VERSION_V2 = 2;

function u32LE(bytes, offset) {
  return (
    bytes[offset]
    | (bytes[offset + 1] << 8)
    | (bytes[offset + 2] << 16)
    | (bytes[offset + 3] << 24)
  ) >>> 0;
}

function u64LE(bytes, offset) {
  let value = 0n;
  for (let index = 7; index >= 0; index -= 1) {
    value = (value << 8n) | BigInt(bytes[offset + index]);
  }
  return value;
}

function isZero(bytes) {
  return bytes.every((value) => value === 0);
}

export function decodeActiveTreeV2(accountData) {
  const bytes = asBytes(accountData, 'V2 active tree account data');
  if (bytes.length < ACTIVE_TREE_ACCOUNT_LEN_V2 || bytes[0] !== ACTIVE_TREE_VERSION_V2) {
    throw new Error('V2 active tree account is invalid or uninitialized');
  }
  const config = new PublicKey(bytes.slice(1, 33));
  const epoch = u64LE(bytes, 33);
  const nextIndex = u32LE(bytes, 41);
  const currentRootBytes = bytes.slice(45, 77);
  const recentRootCount = bytes[77];
  const recentRootCursor = bytes[78];
  if (recentRootCount > ACTIVE_TREE_RECENT_ROOTS_V2 || recentRootCursor >= ACTIVE_TREE_RECENT_ROOTS_V2) {
    throw new Error('V2 active tree root ring is invalid');
  }
  const recentRootBytes = [];
  for (let index = 0; index < ACTIVE_TREE_RECENT_ROOTS_V2; index += 1) {
    const start = 79 + index * 32;
    recentRootBytes.push(bytes.slice(start, start + 32));
  }
  if (nextIndex === 0) {
    if (!isZero(currentRootBytes) || recentRootCount !== 0 || recentRootCursor !== 0) {
      throw new Error('empty V2 active tree has inconsistent root state');
    }
  } else if (isZero(currentRootBytes)) {
    throw new Error('populated V2 active tree has a zero root');
  }

  return Object.freeze({
    version: 2,
    config,
    epoch,
    nextIndex,
    currentRootBytes,
    currentRoot: isZero(currentRootBytes) ? 0n : fieldFromLe32(currentRootBytes, 'V2 active root'),
    recentRootCount,
    recentRootCursor,
    recentRootBytes: Object.freeze(recentRootBytes),
    recentRoots: Object.freeze(
      recentRootBytes.slice(0, recentRootCount).map((root, index) => fieldFromLe32(root, `V2 recent root ${index}`)),
    ),
  });
}

export async function fetchActiveTreeV2({ connection, activeTree, commitment = 'confirmed' }) {
  if (!connection || typeof connection.getAccountInfo !== 'function') {
    throw new TypeError('connection.getAccountInfo is required');
  }
  const info = await connection.getAccountInfo(activeTree, commitment);
  if (!info) throw new Error('V2 active tree account was not found');
  return decodeActiveTreeV2(info.data);
}
