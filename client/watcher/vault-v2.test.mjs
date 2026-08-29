import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair, SystemProgram } from '@solana/web3.js';

import { noteCommitmentV1 } from './field.mjs';
import { buildSparseMerkleTreeV2 } from './merkle-v2.mjs';
import {
  createNoteRecordV1,
  deriveNoteVaultKeyV1,
  loadNoteVaultV1,
  saveNoteVaultV1,
} from './vault.mjs';
import { syncNoteRecordsV2 } from './vault-v2.mjs';

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
  };
}

test('encrypted vault preserves V2 epoch/root/leaf metadata', async () => {
  const storage = memoryStorage();
  const publicKey = new Uint8Array(32).fill(3);
  const signature = new Uint8Array(64).fill(4);
  const scope = 'watcher-v2:test';
  const key = await deriveNoteVaultKeyV1({ signature, publicKey, scope });
  const note = createNoteRecordV1({
    amount: 8n,
    owner: 11n,
    nonce: 12n,
    protocolVersion: 2,
    epoch: 7,
    leafIndex: 9,
    root: 123n,
    status: 'confirmed',
  });
  await saveNoteVaultV1({ storage, key, publicKey, scope, records: [note] });
  const restored = await loadNoteVaultV1({ storage, key, publicKey, scope });
  assert.equal(restored[0].protocolVersion, 2);
  assert.equal(restored[0].epoch, 7);
  assert.equal(restored[0].leafIndex, 9);
  assert.equal(restored[0].root, '123');
});

test('V2 sync confirms cached commitments and marks program-owned nullifier marker spent', async () => {
  const programId = Keypair.generate().publicKey;
  const config = Keypair.generate().publicKey;
  const first = createNoteRecordV1({
    amount: 5n,
    owner: 21n,
    nonce: 22n,
    protocolVersion: 2,
    epoch: 0,
  });
  const second = createNoteRecordV1({
    amount: 7n,
    owner: 23n,
    nonce: 24n,
    protocolVersion: 2,
    epoch: 0,
  });
  const tree = buildSparseMerkleTreeV2([
    noteCommitmentV1({ assetId: 1n, amount: 5n, owner: 21n, nonce: 22n }),
    noteCommitmentV1({ assetId: 1n, amount: 7n, owner: 23n, nonce: 24n }),
  ]);
  const connection = {
    async getMultipleAccountsInfo(addresses, commitment) {
      assert.equal(addresses.length, 2);
      assert.equal(commitment, 'confirmed');
      return [
        { owner: programId, data: new Uint8Array(0) },
        { owner: SystemProgram.programId, data: new Uint8Array(0) },
      ];
    },
  };
  const result = await syncNoteRecordsV2({
    connection,
    programId,
    config,
    tree,
    records: [first, second],
  });
  assert.equal(result.records[0].status, 'spent');
  assert.equal(result.records[1].status, 'confirmed');
  assert.equal(result.spentCount, 1);
  assert.equal(result.markerAddresses.length, 2);
});
