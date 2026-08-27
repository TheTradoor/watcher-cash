import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createNoteRecordV1,
  deriveNoteVaultKeyV1,
  encodeCommitmentRegistryV1,
  fieldToLe32,
  loadNoteVaultV1,
  noteRecordToInputV1,
  nullifierV1,
  privateBalanceLamportsV1,
  saveNoteVaultV1,
  selectInputPairV1,
  syncNoteRecordsV1,
} from './index.mjs';

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function encodeNullifierRegistry(values, capacity = 64) {
  const output = new Uint8Array(5 + capacity * 32);
  output[0] = 1;
  output[1] = values.length & 0xff;
  output[2] = (values.length >>> 8) & 0xff;
  output[3] = (values.length >>> 16) & 0xff;
  output[4] = (values.length >>> 24) & 0xff;
  values.forEach((value, index) => output.set(fieldToLe32(value), 5 + index * 32));
  return output;
}

test('encrypted note vault round-trips and pair selection preserves change', async () => {
  const storage = memoryStorage();
  const publicKey = new Uint8Array(32).fill(7);
  const signature = new Uint8Array(64).fill(9);
  const scope = 'program:config';
  const key = await deriveNoteVaultKeyV1({ signature, publicKey, scope });
  const records = [
    createNoteRecordV1({ amount: 5n, owner: 11n, nonce: 12n, status: 'confirmed' }),
    createNoteRecordV1({ amount: 7n, owner: 13n, nonce: 14n, status: 'confirmed' }),
    createNoteRecordV1({ amount: 20n, owner: 15n, nonce: 16n, status: 'confirmed' }),
  ];

  await saveNoteVaultV1({ storage, key, publicKey, scope, records });
  const restored = await loadNoteVaultV1({ storage, key, publicKey, scope });
  assert.equal(restored.length, 3);
  assert.equal(privateBalanceLamportsV1(restored), 32n);

  const selected = selectInputPairV1(restored, 10n);
  assert.deepEqual(selected.records.map((record) => BigInt(record.amount)), [5n, 7n]);
  assert.equal(selected.total, 12n);
  assert.equal(selected.changeAmount, 2n);
});

test('chain sync marks observed notes confirmed and spent nullifiers spent', async () => {
  const first = createNoteRecordV1({ amount: 5n, owner: 21n, nonce: 22n });
  const second = createNoteRecordV1({ amount: 7n, owner: 23n, nonce: 24n });
  const firstInput = noteRecordToInputV1(first);
  const secondInput = noteRecordToInputV1(second);
  const commitments = encodeCommitmentRegistryV1([
    firstInput.commitment,
    secondInput.commitment,
  ]);
  const nullifiers = encodeNullifierRegistry([nullifierV1(firstInput)]);
  const connection = {
    async getMultipleAccountsInfo(accounts, commitment) {
      assert.deepEqual(accounts, ['commitments', 'nullifiers']);
      assert.equal(commitment, 'confirmed');
      return [{ data: commitments }, { data: nullifiers }];
    },
  };

  const synced = await syncNoteRecordsV1({
    connection,
    commitmentsAccount: 'commitments',
    nullifiersAccount: 'nullifiers',
    records: [first, second],
  });
  assert.equal(synced.records[0].status, 'spent');
  assert.equal(synced.records[1].status, 'confirmed');
  assert.equal(privateBalanceLamportsV1(synced.records), 7n);
  assert.equal(synced.registry.count, 2);
});
