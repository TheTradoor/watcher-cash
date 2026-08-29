import { asBytes, concatBytes } from './keccak.mjs';
import {
  assertFieldV1,
  assertU64,
  fieldFromLe32,
  noteCommitmentV1,
  nullifierV1,
} from './field.mjs';
import { decodeCommitmentRegistryV1 } from './merkle.mjs';

const VAULT_VERSION = 1;
const VAULT_DOMAIN = new TextEncoder().encode('watcher-note-vault-v1');

function requireCrypto() {
  if (!globalThis.crypto?.subtle || typeof globalThis.crypto.getRandomValues !== 'function') {
    throw new Error('Web Crypto is unavailable; private notes cannot be protected on this device');
  }
  return globalThis.crypto;
}

function keyBytes(value, label = 'public key') {
  let raw = value;
  if (value && typeof value.toBytes === 'function') raw = value.toBytes();
  else if (value && typeof value.toBuffer === 'function') raw = value.toBuffer();
  const bytes = asBytes(raw, label);
  if (bytes.length !== 32) throw new RangeError(`${label} must be exactly 32 bytes`);
  return bytes;
}

function hex(bytes) {
  return Array.from(asBytes(bytes), (value) => value.toString(16).padStart(2, '0')).join('');
}

function bytesToBase64(bytes) {
  const input = asBytes(bytes);
  if (typeof btoa === 'function') {
    let binary = '';
    const size = 0x8000;
    for (let offset = 0; offset < input.length; offset += size) {
      binary += String.fromCharCode(...input.subarray(offset, offset + size));
    }
    return btoa(binary);
  }
  if (globalThis.Buffer) return globalThis.Buffer.from(input).toString('base64');
  throw new Error('Base64 encoding is unavailable');
}

function base64ToBytes(value) {
  if (typeof value !== 'string') throw new TypeError('encrypted note vault is malformed');
  if (typeof atob === 'function') {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }
  if (globalThis.Buffer) return Uint8Array.from(globalThis.Buffer.from(value, 'base64'));
  throw new Error('Base64 decoding is unavailable');
}

function storageKey({ publicKey, scope }) {
  const normalizedScope = String(scope || '').trim();
  if (!normalizedScope) throw new TypeError('protocol scope is required');
  return `watcher-note-vault:v${VAULT_VERSION}:${normalizedScope}:${hex(keyBytes(publicKey))}`;
}

function optionalTreeMetadata(record) {
  const protocolVersion = record.protocolVersion === undefined || record.protocolVersion === null
    ? 1
    : Number(record.protocolVersion);
  if (!Number.isInteger(protocolVersion) || protocolVersion < 1 || protocolVersion > 255) {
    throw new RangeError('note protocolVersion is invalid');
  }
  if (protocolVersion < 2) {
    return {
      protocolVersion,
      epoch: null,
      leafIndex: null,
      root: '',
    };
  }
  const epoch = record.epoch === undefined || record.epoch === null ? null : Number(record.epoch);
  const leafIndex = record.leafIndex === undefined || record.leafIndex === null ? null : Number(record.leafIndex);
  if (epoch !== null && (!Number.isSafeInteger(epoch) || epoch < 0)) {
    throw new RangeError('note epoch is invalid');
  }
  if (leafIndex !== null && (!Number.isSafeInteger(leafIndex) || leafIndex < 0)) {
    throw new RangeError('note leafIndex is invalid');
  }
  let root = '';
  if (record.root !== undefined && record.root !== null && record.root !== '') {
    const rootField = assertFieldV1(record.root, 'note root');
    root = rootField.toString(10);
  }
  return { protocolVersion, epoch, leafIndex, root };
}

function normalizeRecord(record) {
  if (!record || typeof record !== 'object') throw new TypeError('note record is invalid');
  const assetId = assertFieldV1(record.assetId ?? 1n, 'note assetId');
  const amount = assertU64(record.amount, 'note amount');
  const owner = assertFieldV1(record.owner, 'note owner');
  const nonce = assertFieldV1(record.nonce, 'note nonce');
  const commitment = noteCommitmentV1({ assetId, amount, owner, nonce });
  if (record.commitment !== undefined && BigInt(record.commitment) !== commitment) {
    throw new Error('stored note commitment does not match its private opening');
  }
  const tree = optionalTreeMetadata(record);
  return {
    id: String(record.id || commitment.toString(16)),
    assetId: assetId.toString(10),
    amount: amount.toString(10),
    owner: owner.toString(10),
    nonce: nonce.toString(10),
    commitment: commitment.toString(10),
    status: ['pending', 'confirmed', 'spent'].includes(record.status)
      ? record.status
      : 'pending',
    kind: record.kind === 'change' ? 'change' : 'deposit',
    createdAt: Number.isFinite(record.createdAt) ? record.createdAt : Date.now(),
    confirmedAt: Number.isFinite(record.confirmedAt) ? record.confirmedAt : null,
    spentAt: Number.isFinite(record.spentAt) ? record.spentAt : null,
    transaction: typeof record.transaction === 'string' ? record.transaction : '',
    spentTransaction: typeof record.spentTransaction === 'string' ? record.spentTransaction : '',
    ...tree,
  };
}

function normalizeRecords(records) {
  if (!Array.isArray(records)) return [];
  const output = [];
  const seen = new Set();
  for (const candidate of records) {
    const record = normalizeRecord(candidate);
    if (seen.has(record.commitment)) continue;
    seen.add(record.commitment);
    output.push(record);
  }
  return output.sort((left, right) => left.createdAt - right.createdAt);
}

export function randomFieldV1() {
  const crypto = requireCrypto();
  while (true) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    bytes[31] &= 0x1f;
    const value = fieldFromLe32(bytes, 'random note secret');
    if (value !== 0n) return value;
  }
}

export function createNoteRecordV1({
  assetId = 1n,
  amount,
  owner = randomFieldV1(),
  nonce = randomFieldV1(),
  kind = 'deposit',
  status = 'pending',
  transaction = '',
  protocolVersion = 1,
  epoch = null,
  leafIndex = null,
  root = '',
} = {}) {
  return normalizeRecord({
    assetId,
    amount,
    owner,
    nonce,
    kind,
    status,
    transaction,
    protocolVersion,
    epoch,
    leafIndex,
    root,
    createdAt: Date.now(),
  });
}

export function noteRecordToInputV1(record) {
  const normalized = normalizeRecord(record);
  return {
    assetId: BigInt(normalized.assetId),
    amount: BigInt(normalized.amount),
    owner: BigInt(normalized.owner),
    nonce: BigInt(normalized.nonce),
    commitment: BigInt(normalized.commitment),
  };
}

export async function deriveNoteVaultKeyV1({ signature, publicKey, scope }) {
  const crypto = requireCrypto();
  const signatureBytes = asBytes(signature, 'wallet signature');
  if (signatureBytes.length < 32) throw new RangeError('wallet signature is too short');
  const scopeBytes = new TextEncoder().encode(String(scope || '').trim());
  if (scopeBytes.length === 0) throw new TypeError('protocol scope is required');
  const digest = await crypto.subtle.digest(
    'SHA-256',
    concatBytes(VAULT_DOMAIN, keyBytes(publicKey), scopeBytes, signatureBytes),
  );
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function loadNoteVaultV1({
  storage = globalThis.localStorage,
  key,
  publicKey,
  scope,
}) {
  if (!storage || typeof storage.getItem !== 'function') {
    throw new Error('Local storage is unavailable; private notes cannot be restored');
  }
  const name = storageKey({ publicKey, scope });
  const raw = storage.getItem(name);
  if (!raw) return [];
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    throw new Error('Encrypted private note vault is malformed');
  }
  if (envelope?.version !== VAULT_VERSION) throw new Error('Unsupported private note vault version');
  const iv = base64ToBytes(envelope.iv);
  const ciphertext = base64ToBytes(envelope.ciphertext);
  try {
    const plaintext = await requireCrypto().subtle.decrypt(
      {
        name: 'AES-GCM',
        iv,
        additionalData: new TextEncoder().encode(name),
        tagLength: 128,
      },
      key,
      ciphertext,
    );
    const payload = JSON.parse(new TextDecoder().decode(plaintext));
    if (payload?.version !== VAULT_VERSION || payload.scope !== String(scope)) {
      throw new Error('Private note vault belongs to another protocol deployment');
    }
    return normalizeRecords(payload.notes);
  } catch (error) {
    if (/another protocol deployment/.test(error?.message || '')) throw error;
    throw new Error('Could not decrypt private notes with this wallet signature');
  }
}

export async function saveNoteVaultV1({
  storage = globalThis.localStorage,
  key,
  publicKey,
  scope,
  records,
}) {
  if (!storage || typeof storage.setItem !== 'function') {
    throw new Error('Local storage is unavailable; private notes cannot be protected');
  }
  const name = storageKey({ publicKey, scope });
  const notes = normalizeRecords(records);
  const payload = new TextEncoder().encode(JSON.stringify({
    version: VAULT_VERSION,
    scope: String(scope),
    updatedAt: Date.now(),
    notes,
  }));
  const iv = requireCrypto().getRandomValues(new Uint8Array(12));
  const ciphertext = await requireCrypto().subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: new TextEncoder().encode(name),
      tagLength: 128,
    },
    key,
    payload,
  );
  storage.setItem(name, JSON.stringify({
    version: VAULT_VERSION,
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  }));
  return notes;
}

export function upsertNoteRecordV1(records, candidate) {
  const next = normalizeRecord(candidate);
  const current = normalizeRecords(records);
  const index = current.findIndex((record) => record.commitment === next.commitment);
  if (index === -1) current.push(next);
  else current[index] = { ...current[index], ...next };
  return normalizeRecords(current);
}

export function removeNoteRecordV1(records, idOrCommitment) {
  const target = String(idOrCommitment);
  return normalizeRecords(records).filter(
    (record) => record.id !== target && record.commitment !== target,
  );
}

function decodeRegistryValuesV1(accountData, label, maximum) {
  const bytes = asBytes(accountData, `${label} account data`);
  if (bytes.length < 5 || bytes[0] !== 1) throw new Error(`${label} is invalid or uninitialized`);
  const count = (
    bytes[1]
    | (bytes[2] << 8)
    | (bytes[3] << 16)
    | (bytes[4] << 24)
  ) >>> 0;
  if (count > maximum) throw new Error(`${label} count exceeds protocol capacity`);
  if (5 + count * 32 > bytes.length) throw new Error(`${label} is truncated`);
  const values = [];
  for (let index = 0; index < count; index += 1) {
    values.push(fieldFromLe32(bytes.slice(5 + index * 32, 5 + (index + 1) * 32), `${label} ${index}`));
  }
  return values;
}

export async function syncNoteRecordsV1({
  connection,
  commitmentsAccount,
  nullifiersAccount,
  records,
  commitment = 'confirmed',
}) {
  if (!connection || typeof connection.getMultipleAccountsInfo !== 'function') {
    throw new TypeError('connection.getMultipleAccountsInfo is required');
  }
  const [commitmentsInfo, nullifiersInfo] = await connection.getMultipleAccountsInfo(
    [commitmentsAccount, nullifiersAccount],
    commitment,
  );
  if (!commitmentsInfo) throw new Error('Commitment registry account was not found');
  if (!nullifiersInfo) throw new Error('Nullifier registry account was not found');

  const registry = decodeCommitmentRegistryV1(commitmentsInfo.data);
  const commitments = new Set(registry.commitments.map((value) => value.toString(10)));
  const spentNullifiers = new Set(
    decodeRegistryValuesV1(nullifiersInfo.data, 'nullifier registry', 64)
      .map((value) => value.toString(10)),
  );
  const now = Date.now();
  const next = normalizeRecords(records).map((record) => {
    const note = noteRecordToInputV1(record);
    const nullifier = nullifierV1(note).toString(10);
    if (spentNullifiers.has(nullifier)) {
      return {
        ...record,
        status: 'spent',
        spentAt: record.spentAt || now,
      };
    }
    if (commitments.has(record.commitment)) {
      return {
        ...record,
        status: 'confirmed',
        confirmedAt: record.confirmedAt || now,
        spentAt: null,
      };
    }
    return { ...record, status: 'pending' };
  });

  return {
    records: normalizeRecords(next),
    registry,
    nullifierCount: spentNullifiers.size,
  };
}

export function confirmedNoteRecordsV1(records) {
  return normalizeRecords(records).filter(
    (record) => record.status === 'confirmed' && BigInt(record.amount) > 0n,
  );
}

export function privateBalanceLamportsV1(records) {
  return confirmedNoteRecordsV1(records)
    .reduce((total, record) => total + BigInt(record.amount), 0n);
}

export function selectInputPairV1(records, publicAmount) {
  const target = assertU64(publicAmount, 'publicAmount');
  if (target === 0n) throw new RangeError('publicAmount must be non-zero');
  const candidates = confirmedNoteRecordsV1(records);
  let best = null;
  for (let left = 0; left < candidates.length; left += 1) {
    for (let right = left + 1; right < candidates.length; right += 1) {
      const first = candidates[left];
      const second = candidates[right];
      const total = BigInt(first.amount) + BigInt(second.amount);
      // Circuit V1 always creates a change note. Require at least one lamport
      // of change so the appended note remains spendable in a later pair.
      if (total <= target) continue;
      const excess = total - target;
      if (
        !best
        || excess < best.changeAmount
        || (excess === best.changeAmount && total < best.total)
      ) {
        best = {
          records: [first, second],
          inputs: [noteRecordToInputV1(first), noteRecordToInputV1(second)],
          total,
          changeAmount: excess,
        };
      }
    }
  }
  if (!best) {
    if (candidates.length < 2) {
      throw new Error('Two confirmed private notes are required before withdrawing');
    }
    throw new Error('No pair of private notes can cover this withdrawal plus one lamport of change');
  }
  return best;
}
