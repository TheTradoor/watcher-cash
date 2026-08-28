import { assertFieldV1, merkleParentV1 } from './field.mjs';

export const MERKLE_DEPTH_V2 = 16;
export const MERKLE_LEAVES_V2 = 1 << MERKLE_DEPTH_V2;

let cachedZeroHashes = null;

export function zeroHashesV2() {
  if (cachedZeroHashes) return cachedZeroHashes;
  const values = [0n];
  for (let depth = 0; depth < MERKLE_DEPTH_V2; depth += 1) {
    values.push(merkleParentV1(values[depth], values[depth]));
  }
  cachedZeroHashes = Object.freeze(values);
  return cachedZeroHashes;
}

function normalizeCommitments(rawCommitments) {
  if (!Array.isArray(rawCommitments)) throw new TypeError('commitments must be an array');
  if (rawCommitments.length > MERKLE_LEAVES_V2) {
    throw new RangeError(`V2 tree epoch is full at ${MERKLE_LEAVES_V2} commitments`);
  }
  const seen = new Set();
  return rawCommitments.map((raw, index) => {
    const value = assertFieldV1(raw, `commitment ${index}`);
    if (value === 0n) throw new RangeError(`commitment ${index} must be non-zero`);
    const key = value.toString(10);
    if (seen.has(key)) throw new Error(`commitment ${index} is duplicated`);
    seen.add(key);
    return value;
  });
}

// V1 materialized all 65,536 leaves when the depth changed. V2 never does that.
// Only populated nodes are stored; empty siblings are derived from deterministic
// zero hashes. Memory therefore scales with deposited commitments, not capacity.
export function buildSparseMerkleTreeV2(rawCommitments, { epoch = 0 } = {}) {
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new RangeError('epoch must be a non-negative safe integer');
  const commitments = normalizeCommitments(rawCommitments);
  const zeros = zeroHashesV2();
  const levels = Array.from({ length: MERKLE_DEPTH_V2 + 1 }, () => new Map());
  commitments.forEach((value, index) => levels[0].set(index, value));

  let width = commitments.length;
  for (let depth = 0; depth < MERKLE_DEPTH_V2; depth += 1) {
    const parentCount = Math.ceil(width / 2);
    if (parentCount === 0) break;
    for (let parent = 0; parent < parentCount; parent += 1) {
      const left = levels[depth].get(parent * 2) ?? zeros[depth];
      const right = levels[depth].get(parent * 2 + 1) ?? zeros[depth];
      levels[depth + 1].set(parent, merkleParentV1(left, right));
    }
    width = parentCount;
  }

  const root = commitments.length === 0 ? 0n : (levels[MERKLE_DEPTH_V2].get(0) ?? 0n);
  return {
    version: 2,
    epoch,
    depth: MERKLE_DEPTH_V2,
    capacity: MERKLE_LEAVES_V2,
    count: commitments.length,
    commitments: Object.freeze([...commitments]),
    levels,
    root,
  };
}

function requireTree(tree) {
  if (
    !tree
    || tree.version !== 2
    || tree.depth !== MERKLE_DEPTH_V2
    || !Array.isArray(tree.levels)
    || tree.levels.length !== MERKLE_DEPTH_V2 + 1
  ) {
    throw new TypeError('tree is not a Watcher V2 sparse Merkle tree');
  }
  return tree;
}

export function getMerkleProofV2(treeOrCommitments, index) {
  const tree = Array.isArray(treeOrCommitments)
    ? buildSparseMerkleTreeV2(treeOrCommitments)
    : requireTree(treeOrCommitments);
  if (!Number.isInteger(index) || index < 0 || index >= tree.count) {
    throw new RangeError('index does not contain a deposited V2 commitment');
  }
  const zeros = zeroHashesV2();
  const path = [];
  const indexBits = [];
  let position = index;
  for (let depth = 0; depth < MERKLE_DEPTH_V2; depth += 1) {
    path.push(tree.levels[depth].get(position ^ 1) ?? zeros[depth]);
    indexBits.push(position & 1);
    position = Math.floor(position / 2);
  }
  return Object.freeze({
    epoch: tree.epoch,
    index,
    path: Object.freeze(path),
    indexBits: Object.freeze(indexBits),
    root: tree.root,
  });
}

export function getMerkleAppendTransitionV2(treeOrCommitments, rawCommitment, options = {}) {
  const tree = Array.isArray(treeOrCommitments)
    ? buildSparseMerkleTreeV2(treeOrCommitments, options)
    : requireTree(treeOrCommitments);
  if (tree.count >= MERKLE_LEAVES_V2) {
    throw new RangeError(`V2 tree epoch is full at ${MERKLE_LEAVES_V2} commitments`);
  }
  const commitment = assertFieldV1(rawCommitment, 'new commitment');
  if (commitment === 0n) throw new RangeError('new commitment must be non-zero');
  if (tree.commitments.some((candidate) => candidate === commitment)) {
    throw new Error('new commitment is already present in this tree epoch');
  }

  const zeros = zeroHashesV2();
  const index = tree.count;
  const path = [];
  const indexBits = [];
  let position = index;
  for (let depth = 0; depth < MERKLE_DEPTH_V2; depth += 1) {
    path.push(tree.levels[depth].get(position ^ 1) ?? zeros[depth]);
    indexBits.push(position & 1);
    position = Math.floor(position / 2);
  }

  const next = buildSparseMerkleTreeV2(
    [...tree.commitments, commitment],
    { epoch: tree.epoch },
  );
  return Object.freeze({
    epoch: tree.epoch,
    index,
    path: Object.freeze(path),
    indexBits: Object.freeze(indexBits),
    oldRoot: tree.root,
    newRoot: next.root,
    tree: next,
  });
}

export function verifyMerkleProofV2({ leaf, path, indexBits, root }) {
  if (!Array.isArray(path) || path.length !== MERKLE_DEPTH_V2) return false;
  if (!Array.isArray(indexBits) || indexBits.length !== MERKLE_DEPTH_V2) return false;
  try {
    let current = assertFieldV1(leaf, 'leaf');
    for (let depth = 0; depth < MERKLE_DEPTH_V2; depth += 1) {
      const sibling = assertFieldV1(path[depth], `path ${depth}`);
      const bit = indexBits[depth];
      if (bit !== 0 && bit !== 1) return false;
      current = bit === 0
        ? merkleParentV1(current, sibling)
        : merkleParentV1(sibling, current);
    }
    return current === assertFieldV1(root, 'root');
  } catch {
    return false;
  }
}
