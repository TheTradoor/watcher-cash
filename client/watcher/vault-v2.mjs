import { fieldToLe32, nullifierV1 } from './field.mjs';
import { deriveNullifierMarkerPdaV2 } from './instructions-v2.mjs';
import {
  noteRecordToInputV1,
  upsertNoteRecordV1,
} from './vault.mjs';

function normalizeRecords(records) {
  if (!Array.isArray(records)) return [];
  let output = [];
  for (const record of records) output = upsertNoteRecordV1(output, record);
  return output;
}

export async function syncNoteRecordsV2({
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
  const markerAddresses = normalized.map((record) => {
    const note = noteRecordToInputV1(record);
    const nullifier = nullifierV1(note);
    return deriveNullifierMarkerPdaV2({
      programId,
      config,
      nullifier: fieldToLe32(nullifier),
    })[0];
  });
  const markerInfos = markerAddresses.length > 0
    ? await connection.getMultipleAccountsInfo(markerAddresses, commitment)
    : [];
  if (!Array.isArray(markerInfos) || markerInfos.length !== markerAddresses.length) {
    throw new Error('V2 nullifier marker lookup returned an invalid response');
  }

  const now = Date.now();
  let spentCount = 0;
  const next = normalized.map((record, index) => {
    const marker = markerInfos[index];
    const spent = Boolean(marker && marker.owner?.equals?.(programId));
    if (spent) {
      spentCount += 1;
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
        protocolVersion: 2,
        epoch: record.epoch ?? tree.epoch,
      };
    }
    return { ...record, status: 'pending' };
  });

  return Object.freeze({
    records: normalizeRecords(next),
    markerAddresses: Object.freeze(markerAddresses),
    spentCount,
  });
}
