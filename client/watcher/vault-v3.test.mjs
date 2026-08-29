import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair } from '@solana/web3.js';

import { fieldToLe32, noteCommitmentV1, nullifierV1 } from './field.mjs';
import {
  NULLIFIER_BUCKETS_PER_SHARD_V3,
  NULLIFIER_RECORD_BYTES_V3,
  NULLIFIER_SHARD_HEADER_BYTES_V3,
  deriveNullifierShardForSpendV3,
} from './instructions-v3.mjs';
import { nullifierSpentInShardDataV3, syncNoteRecordsV3 } from './vault-v3.mjs';

const HEAD_NONE = 0xffff_ffff;

function writeU32(data, offset, value) {
  new DataView(data.buffer, data.byteOffset + offset, 4).setUint32(0, value, true);
}

function shardData({ config, shard, route, nullifier = null }) {
  const count = nullifier ? 1 : 0;
  const data = new Uint8Array(NULLIFIER_SHARD_HEADER_BYTES_V3 + (count * NULLIFIER_RECORD_BYTES_V3));
  data.set([0x57, 0x4e, 0x55, 0x4c, 0x4c, 0x56, 0x33, 0x00], 0);
  data[8] = 3;
  data[9] = shard;
  data.set(config.toBytes(), 12);
  writeU32(data, 44, count);
  for (let bucket = 0; bucket < NULLIFIER_BUCKETS_PER_SHARD_V3; bucket += 1) {
    writeU32(data, 48 + (bucket * 4), HEAD_NONE);
  }
  if (nullifier) {
    writeU32(data, 48 + (route.bucket * 4), 0);
    const offset = NULLIFIER_SHARD_HEADER_BYTES_V3;
    data.set(nullifier, offset);
    writeU32(data, offset + 32, HEAD_NONE);
  }
  return data;
}

function record(note) {
  return {
    id: noteCommitmentV1(note).toString(16),
    assetId: note.assetId.toString(),
    amount: note.amount.toString(),
    owner: note.owner.toString(),
    nonce: note.nonce.toString(),
    commitment: noteCommitmentV1(note).toString(),
    status: 'confirmed',
    kind: 'deposit',
    protocolVersion: 3,
    epoch: 0,
    leafIndex: 0,
    createdAt: Date.now(),
  };
}

test('V3 packed shard lookup compares the full exact nullifier', () => {
  const programId = Keypair.generate().publicKey;
  const config = Keypair.generate().publicKey;
  const note = { assetId: 1n, amount: 8_000_000n, owner: 11n, nonce: 22n };
  const nullifier = fieldToLe32(nullifierV1({ ...note, commitment: noteCommitmentV1(note) }));
  const route = deriveNullifierShardForSpendV3({ programId, config, nullifier });
  const data = shardData({ config, shard: route.shard, route, nullifier });
  assert.equal(nullifierSpentInShardDataV3({ config, nullifier, route, data }), true);

  const other = nullifier.slice();
  other[31] ^= 1;
  const otherRoute = deriveNullifierShardForSpendV3({ programId, config, nullifier: other });
  if (otherRoute.shard === route.shard && otherRoute.bucket === route.bucket) {
    assert.equal(nullifierSpentInShardDataV3({ config, nullifier: other, route: otherRoute, data }), false);
  }
});

test('V3 note sync marks a note spent from packed shard state', async () => {
  const programId = Keypair.generate().publicKey;
  const config = Keypair.generate().publicKey;
  const note = { assetId: 1n, amount: 8_000_000n, owner: 111n, nonce: 222n };
  const commitment = noteCommitmentV1(note);
  const nullifier = fieldToLe32(nullifierV1({ ...note, commitment }));
  const route = deriveNullifierShardForSpendV3({ programId, config, nullifier });
  const data = shardData({ config, shard: route.shard, route, nullifier });
  const connection = {
    async getMultipleAccountsInfo(addresses) {
      return addresses.map(() => ({ owner: programId, data }));
    },
  };
  const result = await syncNoteRecordsV3({
    connection,
    programId,
    config,
    tree: { version: 2, epoch: 0, commitments: [commitment] },
    records: [record(note)],
  });
  assert.equal(result.spentCount, 1);
  assert.equal(result.records[0].status, 'spent');
  assert.equal(result.records[0].protocolVersion, 3);
});

test('V3 note sync keeps an included unspent note confirmed', async () => {
  const programId = Keypair.generate().publicKey;
  const config = Keypair.generate().publicKey;
  const note = { assetId: 1n, amount: 5_000_000n, owner: 333n, nonce: 444n };
  const commitment = noteCommitmentV1(note);
  const nullifier = fieldToLe32(nullifierV1({ ...note, commitment }));
  const route = deriveNullifierShardForSpendV3({ programId, config, nullifier });
  const data = shardData({ config, shard: route.shard, route });
  const connection = {
    async getMultipleAccountsInfo(addresses) {
      return addresses.map(() => ({ owner: programId, data }));
    },
  };
  const result = await syncNoteRecordsV3({
    connection,
    programId,
    config,
    tree: { version: 2, epoch: 0, commitments: [commitment] },
    records: [record(note)],
  });
  assert.equal(result.spentCount, 0);
  assert.equal(result.records[0].status, 'confirmed');
  assert.equal(result.records[0].protocolVersion, 3);
});
