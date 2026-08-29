import { asBytes } from './keccak.mjs';

export const WATCHER_V2_BACKUP_FORMAT = 'watcher-cash-encrypted-vault-backup';
export const WATCHER_V2_BACKUP_VERSION = 1;

function keyBytes(value, label = 'wallet public key') {
  let raw = value;
  if (value && typeof value.toBytes === 'function') raw = value.toBytes();
  else if (value && typeof value.toBuffer === 'function') raw = value.toBuffer();
  const bytes = asBytes(raw, label);
  if (bytes.length !== 32) throw new RangeError(`${label} must be exactly 32 bytes`);
  return bytes;
}

function hex(bytes) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

export function noteVaultStorageKeyV2({ publicKey, scope }) {
  const normalizedScope = String(scope || '').trim();
  if (!normalizedScope) throw new TypeError('V2 protocol scope is required');
  return `watcher-note-vault:v1:${normalizedScope}:${hex(keyBytes(publicKey))}`;
}

export function validateEncryptedVaultEnvelopeV2(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new Error('Encrypted V2 vault backup envelope is missing');
  }
  const keys = Object.keys(envelope).sort();
  if (keys.join(',') !== 'ciphertext,iv,version') {
    throw new Error('Encrypted V2 vault backup envelope has unexpected fields');
  }
  if (envelope.version !== 1) throw new Error('Unsupported encrypted V2 vault envelope version');
  if (typeof envelope.iv !== 'string' || envelope.iv.length < 8) {
    throw new Error('Encrypted V2 vault backup IV is invalid');
  }
  if (typeof envelope.ciphertext !== 'string' || envelope.ciphertext.length < 16) {
    throw new Error('Encrypted V2 vault backup ciphertext is invalid');
  }
  return Object.freeze({
    version: 1,
    iv: envelope.iv,
    ciphertext: envelope.ciphertext,
  });
}

export function exportEncryptedVaultBackupV2({
  storage = globalThis.localStorage,
  publicKey,
  wallet,
  scope,
  network = 'solana-devnet',
  exportedAt = new Date().toISOString(),
} = {}) {
  if (!storage || typeof storage.getItem !== 'function') {
    throw new Error('Local storage is unavailable for V2 vault backup');
  }
  const walletAddress = String(wallet || publicKey?.toBase58?.() || '').trim();
  if (!walletAddress) throw new TypeError('V2 backup wallet address is required');
  const normalizedScope = String(scope || '').trim();
  if (!normalizedScope) throw new TypeError('V2 backup protocol scope is required');
  const normalizedNetwork = String(network || '').trim();
  if (!normalizedNetwork) throw new TypeError('V2 backup network is required');
  const storageKey = noteVaultStorageKeyV2({ publicKey, scope: normalizedScope });
  const raw = storage.getItem(storageKey);
  if (!raw) throw new Error('No encrypted V2 private vault exists on this device yet');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Encrypted V2 private vault is malformed');
  }
  const envelope = validateEncryptedVaultEnvelopeV2(parsed);
  return Object.freeze({
    format: WATCHER_V2_BACKUP_FORMAT,
    version: WATCHER_V2_BACKUP_VERSION,
    protocolVersion: 2,
    network: normalizedNetwork,
    wallet: walletAddress,
    scope: normalizedScope,
    exportedAt: String(exportedAt),
    ciphertextOnly: true,
    envelope,
  });
}

export function validateEncryptedVaultBackupV2({
  backup,
  wallet,
  scope,
  network = 'solana-devnet',
} = {}) {
  if (!backup || typeof backup !== 'object' || Array.isArray(backup)) {
    throw new Error('This file is not a Watcher Cash encrypted vault backup');
  }
  if (backup.format !== WATCHER_V2_BACKUP_FORMAT || backup.version !== WATCHER_V2_BACKUP_VERSION) {
    throw new Error('Unsupported Watcher Cash encrypted vault backup format');
  }
  if (backup.protocolVersion !== 2) throw new Error('Encrypted vault backup is not a Watcher Protocol V2 backup');
  if (backup.ciphertextOnly !== true) throw new Error('V2 backup is not marked ciphertext-only');
  if (backup.network !== String(network)) throw new Error('Encrypted V2 vault backup belongs to another network');
  if (backup.wallet !== String(wallet)) throw new Error('Encrypted V2 vault backup belongs to another wallet');
  if (backup.scope !== String(scope)) throw new Error('Encrypted V2 vault backup belongs to another protocol deployment');
  return Object.freeze({ ...backup, envelope: validateEncryptedVaultEnvelopeV2(backup.envelope) });
}

export function backupEnvelopeStorageV2({ backup, publicKey, scope }) {
  const validated = validateEncryptedVaultEnvelopeV2(backup?.envelope);
  const expectedKey = noteVaultStorageKeyV2({ publicKey, scope });
  return Object.freeze({
    getItem(name) {
      return name === expectedKey ? JSON.stringify(validated) : null;
    },
  });
}
