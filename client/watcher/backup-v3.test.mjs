import assert from 'node:assert/strict';
import test from 'node:test';

import {
  backupEnvelopeStorageV3,
  exportEncryptedVaultBackupV3,
  validateEncryptedVaultBackupV3,
} from './backup-v3.mjs';
import { noteVaultStorageKeyV2 } from './backup-v2.mjs';

const bytes = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const publicKey = {
  toBytes: () => bytes,
  toBase58: () => 'V3Wallet111111111111111111111111111111111',
};
const wallet = publicKey.toBase58();
const scope = 'watcher-v3:Program111:Config111';
const network = 'devnet';
const envelope = Object.freeze({
  version: 1,
  iv: 'abcdefgh12345678',
  ciphertext: 'ciphertext-only-value-1234567890',
});

function storageWithEnvelope() {
  const key = noteVaultStorageKeyV2({ publicKey, scope });
  return {
    getItem(name) {
      return name === key ? JSON.stringify(envelope) : null;
    },
  };
}

test('V3 backup exports ciphertext only and binds wallet/deployment/network', () => {
  const backup = exportEncryptedVaultBackupV3({
    storage: storageWithEnvelope(),
    publicKey,
    wallet,
    scope,
    network,
    exportedAt: '2026-08-30T00:00:00.000Z',
  });
  assert.equal(backup.protocolVersion, 3);
  assert.equal(backup.ciphertextOnly, true);
  assert.deepEqual(backup.envelope, envelope);
  assert.deepEqual(Object.keys(backup).sort(), [
    'ciphertextOnly', 'envelope', 'exportedAt', 'format', 'network',
    'protocolVersion', 'scope', 'version', 'wallet',
  ]);
  const serialized = JSON.stringify(backup);
  for (const forbidden of ['Owner', 'Nonce', 'Amount', 'leafIndex', 'commitment', 'nullifier']) {
    assert.equal(serialized.includes(forbidden), false, `backup leaked ${forbidden}`);
  }
  assert.doesNotThrow(() => validateEncryptedVaultBackupV3({ backup, wallet, scope, network }));
});

test('V3 backup rejects wrong protocol, wallet, deployment, network, and extra plaintext fields', () => {
  const backup = exportEncryptedVaultBackupV3({
    storage: storageWithEnvelope(), publicKey, wallet, scope, network,
  });
  assert.throws(() => validateEncryptedVaultBackupV3({ backup: { ...backup, protocolVersion: 2 }, wallet, scope, network }), /not a Watcher Protocol V3 backup/);
  assert.throws(() => validateEncryptedVaultBackupV3({ backup, wallet: 'AnotherWallet', scope, network }), /another wallet/);
  assert.throws(() => validateEncryptedVaultBackupV3({ backup, wallet, scope: 'watcher-v3:Other:Config', network }), /another protocol deployment/);
  assert.throws(() => validateEncryptedVaultBackupV3({ backup, wallet, scope, network: 'mainnet-beta' }), /another network/);
  assert.throws(() => validateEncryptedVaultBackupV3({ backup: { ...backup, notes: [{ amount: '1' }] }, wallet, scope, network }), /unexpected fields/);
});

test('V3 backup envelope storage exposes only the exact deployment storage key', () => {
  const backup = exportEncryptedVaultBackupV3({
    storage: storageWithEnvelope(), publicKey, wallet, scope, network,
  });
  const source = backupEnvelopeStorageV3({ backup, publicKey, scope });
  const expectedKey = noteVaultStorageKeyV2({ publicKey, scope });
  assert.equal(source.getItem(expectedKey), JSON.stringify(envelope));
  assert.equal(source.getItem(`${expectedKey}:other`), null);
});
