import { asBytes, concatBytes } from './keccak.mjs';
import { assertFieldV1, assertU64, fieldFromLe32, fieldToLe32 } from './field.mjs';

export const DEPOSIT_PUBLIC_FIELDS_V2 = 8;
export const WITHDRAW_PUBLIC_FIELDS_V2 = 19;
export const DEPOSIT_PUBLIC_INPUT_BYTES_V2 = DEPOSIT_PUBLIC_FIELDS_V2 * 32;
export const WITHDRAW_PUBLIC_INPUT_BYTES_V2 = WITHDRAW_PUBLIC_FIELDS_V2 * 32;
export const MAX_INPUTS_V2 = 4;

function exactFieldBytes(value, label) {
  const bytes = asBytes(value, label);
  if (bytes.length !== 32) throw new RangeError(`${label} must be exactly 32 bytes`);
  fieldFromLe32(bytes, label);
  return bytes;
}

function fieldBytesFromU64(value, label) {
  return fieldToLe32(assertU64(value, label));
}

function normalizeFour(values, label) {
  if (!Array.isArray(values) || values.length !== MAX_INPUTS_V2) {
    throw new RangeError(`${label} must contain exactly ${MAX_INPUTS_V2} fields`);
  }
  return values.map((value, index) => exactFieldBytes(value, `${label}[${index}]`));
}

function isZero32(bytes) {
  return bytes.every((byte) => byte === 0);
}

export function reconstructDepositPublicInputsV2({
  commitment,
  amount,
  assetId = 1n,
  epoch,
  contextBinding,
  oldRoot,
  newRoot,
  leafIndex,
}) {
  const fields = Object.freeze([
    exactFieldBytes(commitment, 'commitment'),
    fieldBytesFromU64(amount, 'amount'),
    fieldToLe32(assertFieldV1(assetId, 'assetId')),
    fieldBytesFromU64(epoch, 'epoch'),
    exactFieldBytes(contextBinding, 'contextBinding'),
    exactFieldBytes(oldRoot, 'oldRoot'),
    exactFieldBytes(newRoot, 'newRoot'),
    fieldBytesFromU64(leafIndex, 'leafIndex'),
  ]);
  if (isZero32(fields[0])) throw new Error('commitment must be non-zero');
  if (assertU64(amount, 'amount') === 0n) throw new RangeError('amount must be non-zero');
  if (isZero32(fields[2])) throw new Error('assetId must be non-zero');
  if (isZero32(fields[4])) throw new Error('contextBinding must be non-zero');
  if (isZero32(fields[6])) throw new Error('newRoot must be non-zero');
  return Object.freeze({
    fields,
    bytes: concatBytes(...fields),
  });
}

export function reconstructWithdrawPublicInputsV2({
  inputCount,
  inputRoots,
  nullifiers,
  changeCommitment,
  publicAmount,
  protocolFee = 0n,
  relayerFee = 0n,
  recipientBinding,
  assetId = 1n,
  contextBinding,
  activeCurrentRoot = new Uint8Array(32),
  activeNextIndex = 0,
  newRoot = new Uint8Array(32),
}) {
  if (!Number.isInteger(inputCount) || inputCount < 1 || inputCount > MAX_INPUTS_V2) {
    throw new RangeError(`inputCount must be between 1 and ${MAX_INPUTS_V2}`);
  }
  const roots = normalizeFour(inputRoots, 'inputRoots');
  const spends = normalizeFour(nullifiers, 'nullifiers');
  for (let index = 0; index < MAX_INPUTS_V2; index += 1) {
    const active = index < inputCount;
    if (active) {
      if (isZero32(roots[index])) throw new Error(`inputRoots[${index}] must be non-zero`);
      if (isZero32(spends[index])) throw new Error(`nullifiers[${index}] must be non-zero`);
    } else if (!isZero32(roots[index]) || !isZero32(spends[index])) {
      throw new Error('inactive V2 proof slots must be canonical zeroes');
    }
  }

  const change = exactFieldBytes(changeCommitment, 'changeCommitment');
  const hasChange = !isZero32(change);
  const activeRoot = exactFieldBytes(activeCurrentRoot, 'activeCurrentRoot');
  const nextRoot = exactFieldBytes(newRoot, 'newRoot');
  if (hasChange) {
    if (isZero32(activeRoot)) throw new Error('change withdrawal requires a non-zero active current root');
    if (isZero32(nextRoot)) throw new Error('change withdrawal requires a non-zero new root');
  } else if (!isZero32(nextRoot)) {
    throw new Error('exact withdrawal must use the zero new-root sentinel');
  }

  const publicValue = assertU64(publicAmount, 'publicAmount');
  if (publicValue === 0n) throw new RangeError('publicAmount must be non-zero');
  const protocolValue = assertU64(protocolFee, 'protocolFee');
  if (protocolValue !== 0n) throw new Error('protocol fees are disabled during development');

  const fields = Object.freeze([
    ...roots,
    ...spends,
    fieldBytesFromU64(inputCount, 'inputCount'),
    change,
    fieldBytesFromU64(publicValue, 'publicAmount'),
    fieldBytesFromU64(protocolValue, 'protocolFee'),
    fieldBytesFromU64(relayerFee, 'relayerFee'),
    exactFieldBytes(recipientBinding, 'recipientBinding'),
    fieldToLe32(assertFieldV1(assetId, 'assetId')),
    exactFieldBytes(contextBinding, 'contextBinding'),
    hasChange ? activeRoot : new Uint8Array(32),
    hasChange ? nextRoot : new Uint8Array(32),
    hasChange ? fieldBytesFromU64(activeNextIndex, 'activeNextIndex') : new Uint8Array(32),
  ]);

  if (isZero32(fields[13])) throw new Error('recipientBinding must be non-zero');
  if (isZero32(fields[14])) throw new Error('assetId must be non-zero');
  if (isZero32(fields[15])) throw new Error('contextBinding must be non-zero');
  if (fields.length !== WITHDRAW_PUBLIC_FIELDS_V2) throw new Error('unexpected V2 withdraw public field count');

  return Object.freeze({
    hasChange,
    fields,
    bytes: concatBytes(...fields),
  });
}
