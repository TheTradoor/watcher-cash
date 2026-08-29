import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair } from '@solana/web3.js';

import {
  backupEnvelopeStorageV2,
  exportEncryptedVaultBackupV2,
  noteVaultStorageKeyV2,
  validateEncryptedVaultBackupV2,
} from './backup-v2.mjs';

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
}

function fixture() {
  const storage = new MemoryStorage();
  const keypair = Keypair.generate();
  const wallet = keypair.publicKey.toBase58();
  const scope = 'watcher-v2:program:config';
  const storageKey = noteVaultStorageKeyV2({ publicKey: keypair.publicKey, scope });
  storage.setItem(storageKey, JSON.stringify({
    version: 1,
    iv: 'abcdefghijklmnop',
    ciphertext: 'ciphertext-base64-placeholder',
  }));
  return { storage, keypair, wallet, scope, storageKey };
}

test('exports only encrypted V2 envelope and deployment metadata', () => {
  const { storage, keypair, wallet, scope } = fixture();
  const backup = exportEncryptedVaultBackupV2({
    storage,
    publicKey: keypair.publicKey,
    wallet,
    scope,
    network: 'localnet',
    exportedAt: '2026-08-29T00:00:00.000Z',
  });
  assert.equal(backup.protocolVersion, 2);
  assert.equal(backup.ciphertextOnly, true);
  assert.deepEqual(Object.keys(backup.envelope).sort(), ['ciphertext', 'iv', 'version']);
  const serialized = JSON.stringify(backup);
  assert.doesNotMatch(serialized, /"owner"/);
  assert.doesNotMatch(serialized, /"nonce"/);
  assert.doesNotMatch(serialized, /"notes"/);
});

test('rejects wallet, deployment and network mismatch before restore', () => {
  const { storage, keypair, wallet, scope } = fixture();
  const backup = exportEncryptedVaultBackupV2({
    storage,
    publicKey: keypair.publicKey,
    wallet,
    scope,
    network: 'localnet',
  });
  assert.throws(
    () => validateEncryptedVaultBackupV2({ backup, wallet: 'different-wallet', scope, network: 'localnet' }),
    /another wallet/,
  );
  assert.throws(
    () => validateEncryptedVaultBackupV2({ backup, wallet, scope: 'watcher-v2:other:config', network: 'localnet' }),
    /another protocol deployment/,
  );
  assert.throws(
    () => validateEncryptedVaultBackupV2({ backup, wallet, scope, network: 'solana-devnet' }),
    /another network/,
  );
});

test('restore storage exposes only the imported encrypted envelope at the exact vault key', () => {
  const { storage, keypair, wallet, scope, storageKey } = fixture();
  const backup = exportEncryptedVaultBackupV2({ storage, publicKey: keypair.publicKey, wallet, scope });
  const imported = backupEnvelopeStorageV2({ backup, publicKey: keypair.publicKey, scope });
  assert.equal(imported.getItem('wrong-key'), null);
  assert.deepEqual(JSON.parse(imported.getItem(storageKey)), backup.envelope);
});
