'use client';

import { useRef } from 'react';

import {
  backupEnvelopeStorageV3,
  exportEncryptedVaultBackupV3,
  loadNoteVaultV1,
  saveNoteVaultV1,
  upsertNoteRecordV1,
  validateEncryptedVaultBackupV3,
} from '../../client/watcher/index.mjs';
import styles from '../v2/v2.module.css';

export default function VaultBackupControls({
  unlocked,
  publicKey,
  walletAddress,
  runtimeScope,
  network,
  vaultKey,
  records,
  onRestored,
  onMessage,
  onError,
}) {
  const inputRef = useRef(null);

  function reportError(error) {
    onError?.(error?.message || String(error));
  }

  function exportBackup() {
    try {
      if (!unlocked || !publicKey || !vaultKey) throw new Error('Unlock V3 private notes before exporting a backup');
      const backup = exportEncryptedVaultBackupV3({
        publicKey,
        wallet: walletAddress,
        scope: runtimeScope,
        network,
      });
      const blob = new Blob([`${JSON.stringify(backup, null, 2)}\n`], { type: 'application/json' });
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = `watcher-cash-v3-vault-${walletAddress.slice(0, 6)}-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.rel = 'noopener';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(href), 0);
      onMessage?.('Encrypted V3 vault backup downloaded. It contains ciphertext only; keep it private.');
    } catch (error) {
      reportError(error);
    }
  }

  async function restoreBackup(event) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      if (!unlocked || !publicKey || !vaultKey) throw new Error('Unlock V3 private notes before restoring a backup');
      const parsed = JSON.parse(await file.text());
      const backup = validateEncryptedVaultBackupV3({
        backup: parsed,
        wallet: walletAddress,
        scope: runtimeScope,
        network,
      });
      const imported = await loadNoteVaultV1({
        storage: backupEnvelopeStorageV3({ backup, publicKey, scope: runtimeScope }),
        key: vaultKey,
        publicKey,
        scope: runtimeScope,
      });
      let merged = imported;
      for (const record of records) merged = upsertNoteRecordV1(merged, record);
      const saved = await saveNoteVaultV1({
        key: vaultKey,
        publicKey,
        scope: runtimeScope,
        records: merged,
      });
      const synced = await onRestored?.(saved);
      const count = Array.isArray(synced) ? synced.length : saved.length;
      onMessage?.(`Encrypted V3 vault backup restored and synced. ${count} note record${count === 1 ? '' : 's'} available.`);
    } catch (error) {
      reportError(error);
    }
  }

  if (!unlocked) return null;

  return (
    <div className={styles.backupBlock} data-v3-backup-controls>
      <div>
        <small>PORTABLE RECOVERY</small>
        <span>Backup contains the encrypted V3 vault envelope only. Public tree and packed-nullifier state are rebuilt from chain.</span>
      </div>
      <div className={styles.backupActions}>
        <button type="button" data-v3-backup-export onClick={exportBackup}>Export encrypted backup</button>
        <button type="button" data-v3-backup-import onClick={() => inputRef.current?.click()}>Restore backup</button>
        <input
          ref={inputRef}
          data-v3-backup-file
          className={styles.hiddenFile}
          type="file"
          accept="application/json,.json"
          onChange={restoreBackup}
        />
      </div>
    </div>
  );
}
