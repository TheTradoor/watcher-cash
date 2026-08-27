import { asBytes, concatBytes, keccak256 } from './keccak.mjs';

export const BN254_SCALAR_MODULUS =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const DOMAIN_NOTE_V1 = 91_001n;
export const DOMAIN_NULLIFIER_V1 = 91_002n;
export const DOMAIN_MERKLE_V1 = 91_003n;

export function toBigInt(value, label = 'value') {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new RangeError(`${label} must be a safe integer`);
    return BigInt(value);
  }
  if (typeof value === 'string' && /^(?:0x[0-9a-fA-F]+|\d+)$/.test(value)) return BigInt(value);
  throw new TypeError(`${label} must be bigint, safe integer, or unsigned integer string`);
}

export function assertFieldV1(value, label = 'field') {
  const field = toBigInt(value, label);
  if (field < 0n || field >= BN254_SCALAR_MODULUS) {
    throw new RangeError(`${label} is not a canonical BN254 scalar`);
  }
  return field;
}

export function assertU64(value, label = 'value') {
  const result = toBigInt(value, label);
  if (result < 0n || result > 0xffff_ffff_ffff_ffffn) {
    throw new RangeError(`${label} must fit in an unsigned 64-bit integer`);
  }
  return result;
}

export function bytesToBigIntLE(bytes) {
  const input = asBytes(bytes);
  let result = 0n;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    result = (result << 8n) | BigInt(input[index]);
  }
  return result;
}

function bytesToBigIntBE(bytes) {
  let result = 0n;
  for (const byte of asBytes(bytes)) result = (result << 8n) | BigInt(byte);
  return result;
}

export function fieldToLe32(value) {
  let remaining = assertFieldV1(value);
  const output = new Uint8Array(32);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return output;
}

export function fieldFromLe32(bytes, label = 'field') {
  const input = asBytes(bytes, label);
  if (input.length !== 32) throw new RangeError(`${label} must be exactly 32 bytes`);
  return assertFieldV1(bytesToBigIntLE(input), label);
}

let cachedConstants;
function mimcConstantsV1() {
  if (cachedConstants) return cachedConstants;
  let random = keccak256('seed');
  const constants = [];
  for (let round = 0; round < 110; round += 1) {
    random = keccak256(random);
    constants.push(bytesToBigIntBE(random) % BN254_SCALAR_MODULUS);
  }
  cachedConstants = Object.freeze(constants);
  return cachedConstants;
}

function mod(value) {
  const reduced = value % BN254_SCALAR_MODULUS;
  return reduced >= 0n ? reduced : reduced + BN254_SCALAR_MODULUS;
}

function pow5(value) {
  const squared = mod(value * value);
  return mod(squared * squared * value);
}

export function mimcHashV1(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError('MiMC input must be a non-empty array of fields');
  }
  const constants = mimcConstantsV1();
  let hash = 0n;
  for (let inputIndex = 0; inputIndex < values.length; inputIndex += 1) {
    const data = assertFieldV1(values[inputIndex], `MiMC input ${inputIndex}`);
    let message = data;
    for (const constant of constants) message = pow5(message + hash + constant);
    message = mod(message + hash);
    hash = mod(message + hash + data);
  }
  return hash;
}

export function noteCommitmentV1({ assetId, amount, owner, nonce }) {
  return mimcHashV1([
    DOMAIN_NOTE_V1,
    assertFieldV1(assetId, 'assetId'),
    assertU64(amount, 'amount'),
    assertFieldV1(owner, 'owner'),
    assertFieldV1(nonce, 'nonce'),
  ]);
}

export function nullifierV1({ owner, nonce, commitment }) {
  return mimcHashV1([
    DOMAIN_NULLIFIER_V1,
    assertFieldV1(owner, 'owner'),
    assertFieldV1(nonce, 'nonce'),
    assertFieldV1(commitment, 'commitment'),
  ]);
}

export function merkleParentV1(left, right) {
  return mimcHashV1([
    DOMAIN_MERKLE_V1,
    assertFieldV1(left, 'left child'),
    assertFieldV1(right, 'right child'),
  ]);
}

export async function recipientBindingBytesV1(recipientBytes) {
  if (!globalThis.crypto?.subtle) throw new Error('Web Crypto SHA-256 is unavailable');
  const recipient = asBytes(recipientBytes, 'recipient');
  if (recipient.length !== 32) throw new RangeError('recipient must be exactly 32 bytes');
  const domain = new TextEncoder().encode('watcher-recipient-v1');
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest('SHA-256', concatBytes(domain, recipient)),
  );
  digest[31] &= 0x1f;
  return digest;
}

export async function recipientBindingV1(recipientBytes) {
  return fieldFromLe32(await recipientBindingBytesV1(recipientBytes), 'recipient binding');
}
