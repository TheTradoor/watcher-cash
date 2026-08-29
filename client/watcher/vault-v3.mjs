import { fieldToLe32, nullifierV1 } from './field.mjs';
import {
  NULLIFIER_RECORD_BYTES_V3,
  NULLIFIER_SHARD_HEADER_BYTES_V3,
  deriveNullifierShardForSpendV3,
} from './instructions-v3.mjs';
import { publicKeyBytesV1 } from './instructions.mjs';
import {
  noteRecordToInputV1,
  upsertNoteRecordV1,
} from './vault.mjs';

const MAGIC = Uint8Array.from([0x57, 0x4e, 0x55, 0x4c, 0x4c, 0x56, 0x33, 0x00]); // WNULLV3\0
const VERSION_OFFSET = 8;
const SHARD_OFFSET = 9;
const CONFIG_OFFSET = 12;
const COUNT_OFFSET = 44;
const HEADS_OFFSET = 48;
const HEAD_NONE = 0xffff_ffff;

function normalizeRecords(records) {
  if (!Array.isArray(records)) return [];
  let output = [];
  for (const record of records) output = upsertNoteRecordV1(output, record);
  return output;
}

function bytesEqual(left, right) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function readU32(data, offset) {
  if (offset < 0 || offset + 4 > data.length) throw new Error('V3 nullifier shard is truncated');
  return new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0, true);
}

export function nullifierSpentInShardDataV3({ config, nullifier, route, data }) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data || []);
  if (bytes.length < NULLIFIER_SHARD_HEADER_BYTES_V3) throw new Error('V3 nullifier shard header is truncated');
  if (!bytesEqual(bytes.subarray(0, MAGIC.length), MAGIC) || bytes[VERSION_OFFSET] !== 3) {
    throw new Error('V3 nullifier shard header is invalid');
  }
  if (bytes[SHARD_OFFSET] !== route.shard) throw new Error('V3 nullifier shard index does not match route');
  const configBytes = publicKeyBytesV1(config, 'config');
  if (!bytesEqual(bytes.subarray(CONFIG_OFFSET, CONFIG_OFFSET + 32), configBytes)) {
    throw new Error('V3 nullifier shard belongs to another config');
  }

  const count = readU32(bytes, COUNT_OFFSET);
  const usedLength = NULLIFIER_SHARD_HEADER_BYTES_V3 + (count * NULLIFIER_RECORD_BYTES_V3);
  if (usedLength > bytes.length) throw new Error('V3 nullifier shard count exceeds account data');
  let index = readU32(bytes, HEADS_OFFSET + (route.bucket * 4));
  let traversed = 0;
  while (index !== HEAD_NONE) {
    if (index >= count || traversed >= count) throw new Error('V3 nullifier shard linked list is invalid');
    const offset = NULLIFIER_SHARD_HEADER_BYTES_V3 + (index * NULLIFIER_RECORD_BYTES_V3);
    if (offset + NULLIFIER_RECORD_BYTES_V3 > bytes.length) throw new Error('V3 nullifier record is truncated');
    if (bytesEqual(bytes.subarray(offset, offset + 32), nullifier)) return true;
    index = readU32(bytes, offset + 32);
    traversed += 1;
  }
  return false;
}

export async function syncNoteRecordsV3({
  connection,
  programId,
  config,
  tree,
  records,
  commitment = 'confirmed',
}) {
  if (!connection || typeof connection.getMultipleAccountsInfo !== 'function') {
    throw new TypeError('connection.getMultipleAccountsInfo is required');
  }
  if (!tree || tree.version !== 2 || !Array.isArray(tree.commitments)) {
    throw new TypeError('a verified V2 sparse Merkle tree is required');
  }

  const normalized = normalizeRecords(records);
  const commitments = new Set(tree.commitments.map((value) => BigInt(value).toString(10)));
  const spends = normalized.map((record) => {
    const note = noteRecordToInputV1(record);
    const nullifier = fieldToLe32(nullifierV1(note));
    const routed = deriveNullifierShardForSpendV3({ programId, config, nullifier });
    return Object.freeze({ nullifier, ...routed });
  });

  const unique = [];
  const indexByAddress = new Map();
  for (const spend of spends) {
    const address = spend.pubkey.toBase58();
    if (!indexByAddress.has(address)) {
      indexByAddress.set(address, unique.length);
      unique.push(spend.pubkey);
    }
  }
  const shardInfos = unique.length > 0
    ? await connection.getMultipleAccountsInfo(unique, commitment)
    : [];
  if (!Array.isArray(shardInfos) || shardInfos.length !== unique.length) {
    throw new Error('V3 nullifier shard lookup returned an invalid response');
  }
  for (let index = 0; index < shardInfos.length; index += 1) {
    if (!shardInfos[index] || !shardInfos[index].owner?.equals?.(programId)) {
      throw new Error(`V3 nullifier shard ${unique[index].toBase58()} is missing or has the wrong owner`);
    }
  }

  const now = Date.now();
  let spentCount = 0;
  const next = normalized.map((record, recordIndex) => {
    const spend = spends[recordIndex];
    const info = shardInfos[indexByAddress.get(spend.pubkey.toBase58())];
    const spent = nullifierSpentInShardDataV3({
      config,
      nullifier: spend.nullifier,
      route: spend,
      data: info.data,
    });
    if (spent) {
      spentCount += 1;
      return {
        ...record,
        status: 'spent',
        spentAt: record.spentAt || now,
        protocolVersion: 3,
      };
    }
    if (commitments.has(record.commitment)) {
      return {
        ...record,
        status: 'confirmed',
        confirmedAt: record.confirmedAt || now,
        spentAt: null,
        protocolVersion: 3,
        epoch: record.epoch ?? tree.epoch,
      };
    }
    return { ...record, status: 'pending', protocolVersion: 3 };
  });

  return Object.freeze({
    records: normalizeRecords(next),
    shardAddresses: Object.freeze(spends.map((value) => value.pubkey)),
    spentCount,
  });
}
