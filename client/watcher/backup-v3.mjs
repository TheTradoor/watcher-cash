import {
  noteVaultStorageKeyV2,
  validateEncryptedVaultEnvelopeV2,
} from './backup-v2.mjs';

export const WATCHER_V3_BACKUP_FORMAT = 'watcher-cash-encrypted-vault-backup';
export const WATCHER_V3_BACKUP_VERSION = 1;

const TOP_LEVEL_KEYS = Object.freeze([
  'ciphertextOnly',
  'envelope',
  'exportedAt',
  'format',
  'network',
  'protocolVersion',
  'scope',
  'version',
  'wallet',
]);

function requireStorage(storage) {
  if (!storage || typeof storage.getItem !== 'function') {
    throw new Error('Local storage is unavailable for V3 vault backup');
  }
  return storage;
}

function normalizedText(value, label) {
  const text = String(value || '').trim();
  if (!text) throw new TypeError(`${label} is required`);
  return text;
}

function exactTopLevelShape(backup) {
  const keys = Object.keys(backup).sort();
  if (keys.join(',') !== [...TOP_LEVEL_KEYS].sort().join(',')) {
    throw new Error('Encrypted V3 vault backup has unexpected fields');
  }
}

export function exportEncryptedVaultBackupV3({
  storage = globalThis.localStorage,
  publicKey,
  wallet,
  scope,
  network = 'devnet',
  exportedAt = new Date().toISOString(),
} = {}) {
  const source = requireStorage(storage);
  const walletAddress = normalizedText(wallet || publicKey?.toBase58?.(), 'V3 backup wallet address');
  const normalizedScope = normalizedText(scope, 'V3 backup protocol scope');
  const normalizedNetwork = normalizedText(network, 'V3 backup network');
  const storageKey = noteVaultStorageKeyV2({ publicKey, scope: normalizedScope });
  const raw = source.getItem(storageKey);
  if (!raw) throw new Error('No encrypted V3 private vault exists on this device yet');

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Encrypted V3 private vault is malformed');
  }
  const envelope = validateEncryptedVaultEnvelopeV2(parsed);
  return Object.freeze({
    format: WATCHER_V3_BACKUP_FORMAT,
    version: WATCHER_V3_BACKUP_VERSION,
    protocolVersion: 3,
    network: normalizedNetwork,
    wallet: walletAddress,
    scope: normalizedScope,
    exportedAt: String(exportedAt),
    ciphertextOnly: true,
    envelope,
  });
}

export function validateEncryptedVaultBackupV3({
  backup,
  wallet,
  scope,
  network = 'devnet',
} = {}) {
  if (!backup || typeof backup !== 'object' || Array.isArray(backup)) {
    throw new Error('This file is not a Watcher Cash encrypted V3 vault backup');
  }
  exactTopLevelShape(backup);
  if (backup.format !== WATCHER_V3_BACKUP_FORMAT || backup.version !== WATCHER_V3_BACKUP_VERSION) {
    throw new Error('Unsupported Watcher Cash encrypted V3 vault backup format');
  }
  if (backup.protocolVersion !== 3) throw new Error('Encrypted vault backup is not a Watcher Protocol V3 backup');
  if (backup.ciphertextOnly !== true) throw new Error('V3 backup is not marked ciphertext-only');
  if (backup.network !== normalizedText(network, 'V3 backup network')) {
    throw new Error('Encrypted V3 vault backup belongs to another network');
  }
  if (backup.wallet !== normalizedText(wallet, 'V3 backup wallet address')) {
    throw new Error('Encrypted V3 vault backup belongs to another wallet');
  }
  if (backup.scope !== normalizedText(scope, 'V3 backup protocol scope')) {
    throw new Error('Encrypted V3 vault backup belongs to another protocol deployment');
  }
  if (typeof backup.exportedAt !== 'string' || !backup.exportedAt.trim()) {
    throw new Error('Encrypted V3 vault backup export timestamp is invalid');
  }
  return Object.freeze({
    ...backup,
    envelope: validateEncryptedVaultEnvelopeV2(backup.envelope),
  });
}

export function backupEnvelopeStorageV3({ backup, publicKey, scope }) {
  const validated = validateEncryptedVaultEnvelopeV2(backup?.envelope);
  const expectedKey = noteVaultStorageKeyV2({ publicKey, scope });
  return Object.freeze({
    getItem(name) {
      return name === expectedKey ? JSON.stringify(validated) : null;
    },
  });
}
