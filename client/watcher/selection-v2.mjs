import { assertU64 } from './field.mjs';
import {
  confirmedNoteRecordsV1,
  noteRecordToInputV1,
  privateBalanceLamportsV1,
} from './vault.mjs';

export const MAX_INPUTS_V2 = 4;

function compareCandidates(left, right) {
  const leftAmount = BigInt(left.amount);
  const rightAmount = BigInt(right.amount);
  if (leftAmount < rightAmount) return -1;
  if (leftAmount > rightAmount) return 1;
  if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
  return String(left.commitment).localeCompare(String(right.commitment));
}

function betterSelection(current, candidate, target) {
  if (!candidate || candidate.total < target) return current;
  if (!current) return candidate;
  if (candidate.total < current.total) return candidate;
  if (candidate.total > current.total) return current;
  const candidateKey = candidate.records.map((record) => record.commitment).join(':');
  const currentKey = current.records.map((record) => record.commitment).join(':');
  return candidateKey < currentKey ? candidate : current;
}

function findOne(candidates, target) {
  let best = null;
  for (const record of candidates) {
    const total = BigInt(record.amount);
    if (total >= target) best = betterSelection(best, { records: [record], total }, target);
  }
  return best;
}

function findTwo(candidates, target) {
  let best = null;
  let left = 0;
  let right = candidates.length - 1;
  while (left < right) {
    const total = BigInt(candidates[left].amount) + BigInt(candidates[right].amount);
    if (total >= target) {
      best = betterSelection(best, {
        records: [candidates[left], candidates[right]],
        total,
      }, target);
      right -= 1;
    } else {
      left += 1;
    }
  }
  return best;
}

function findThree(candidates, target) {
  let best = null;
  for (let first = 0; first < candidates.length - 2; first += 1) {
    let left = first + 1;
    let right = candidates.length - 1;
    const firstAmount = BigInt(candidates[first].amount);
    while (left < right) {
      const total = firstAmount + BigInt(candidates[left].amount) + BigInt(candidates[right].amount);
      if (total >= target) {
        best = betterSelection(best, {
          records: [candidates[first], candidates[left], candidates[right]],
          total,
        }, target);
        right -= 1;
      } else {
        left += 1;
      }
    }
  }
  return best;
}

function findFour(candidates, target) {
  let best = null;
  for (let first = 0; first < candidates.length - 3; first += 1) {
    const firstAmount = BigInt(candidates[first].amount);
    for (let second = first + 1; second < candidates.length - 2; second += 1) {
      const fixed = firstAmount + BigInt(candidates[second].amount);
      let left = second + 1;
      let right = candidates.length - 1;
      while (left < right) {
        const total = fixed + BigInt(candidates[left].amount) + BigInt(candidates[right].amount);
        if (total >= target) {
          best = betterSelection(best, {
            records: [candidates[first], candidates[second], candidates[left], candidates[right]],
            total,
          }, target);
          right -= 1;
        } else {
          left += 1;
        }
      }
    }
  }
  return best;
}

function findForCount(candidates, target, count) {
  if (candidates.length < count) return null;
  switch (count) {
    case 1: return findOne(candidates, target);
    case 2: return findTwo(candidates, target);
    case 3: return findThree(candidates, target);
    case 4: return findFour(candidates, target);
    default: throw new RangeError(`V2 supports between 1 and ${MAX_INPUTS_V2} inputs`);
  }
}

// V2 selection policy is intentionally explicit. By default it prefers an exact
// combination (which avoids creating another tree leaf) and then uses the fewest
// inputs. If no exact combination exists, it falls back to the fewest inputs and
// the smallest possible private change.
export function selectInputsV2(records, {
  publicAmount,
  protocolFee = 0n,
  relayerFee = 0n,
  preferExact = true,
} = {}) {
  const publicValue = assertU64(publicAmount, 'publicAmount');
  const protocolValue = assertU64(protocolFee, 'protocolFee');
  const relayerValue = assertU64(relayerFee, 'relayerFee');
  if (publicValue === 0n) throw new RangeError('publicAmount must be non-zero');
  const target = publicValue + protocolValue + relayerValue;
  if (target > ((1n << 64n) - 1n)) throw new RangeError('withdrawal outputs exceed u64');

  const candidates = confirmedNoteRecordsV1(records).slice().sort(compareCandidates);
  if (candidates.length === 0) throw new Error('No confirmed private notes are available');

  const bestByCount = [];
  for (let count = 1; count <= MAX_INPUTS_V2; count += 1) {
    const best = findForCount(candidates, target, count);
    bestByCount.push(best);
    if (preferExact && best?.total === target) {
      return finalize(best, target);
    }
    if (!preferExact && best) {
      return finalize(best, target);
    }
  }

  const fallback = bestByCount.find(Boolean);
  if (fallback) return finalize(fallback, target);

  const privateBalance = privateBalanceLamportsV1(records);
  if (privateBalance < target) {
    throw new Error('Private balance is too low for this withdrawal and its fees');
  }
  throw new Error(`This withdrawal needs more than ${MAX_INPUTS_V2} private notes; choose a smaller amount or consolidate notes first`);
}

function finalize(selection, target) {
  const changeAmount = selection.total - target;
  return Object.freeze({
    records: Object.freeze([...selection.records]),
    inputs: Object.freeze(selection.records.map((record) => noteRecordToInputV1(record))),
    inputCount: selection.records.length,
    target,
    total: selection.total,
    changeAmount,
    hasChange: changeAmount > 0n,
  });
}
