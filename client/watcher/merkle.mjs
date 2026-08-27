import { asBytes } from './keccak.mjs';
import { assertFieldV1, fieldFromLe32, fieldToLe32, merkleParentV1 } from './field.mjs';

export const MERKLE_DEPTH_V1 = 4;
export const MERKLE_LEAVES_V1 = 1 << MERKLE_DEPTH_V1;
export const STATE_VERSION_V1 = 1;
export const REGISTRY_HEADER_BYTES = 5;

export function buildMerkleTreeFromLeavesV1(rawLeaves) {
  if (!Array.isArray(rawLeaves) || rawLeaves.length !== MERKLE_LEAVES_V1) {
    throw new RangeError(`Circuit V1 requires exactly ${MERKLE_LEAVES_V1} leaves`);
  }
  const levels = [rawLeaves.map((leaf, index) => assertFieldV1(leaf, `leaf ${index}`))];
  for (let depth = 0; depth < MERKLE_DEPTH_V1; depth += 1) {
    const current = levels[depth];
    const next = [];
    for (let index = 0; index < current.length; index += 2) {
      next.push(merkleParentV1(current[index], current[index + 1]));
    }
    levels.push(next);
  }
  return { depth: MERKLE_DEPTH_V1, levels, root: levels[MERKLE_DEPTH_V1][0] };
}

export function buildMerkleTreeV1(commitments) {
  if (!Array.isArray(commitments)) throw new TypeError('commitments must be an array');
  if (commitments.length > MERKLE_LEAVES_V1) {
    throw new RangeError(`Circuit V1 tree is full at ${MERKLE_LEAVES_V1} commitments`);
  }
  if (commitments.length === 0) {
    const empty = buildMerkleTreeFromLeavesV1(new Array(MERKLE_LEAVES_V1).fill(0n));
    return { ...empty, root: 0n, commitmentCount: 0 };
  }
  const leaves = new Array(MERKLE_LEAVES_V1).fill(0n);
  const seen = new Set();
  commitments.forEach((commitment, index) => {
    const field = assertFieldV1(commitment, `commitment ${index}`);
    if (field === 0n) throw new RangeError(`commitment ${index} must be non-zero`);
    const key = field.toString(10);
    if (seen.has(key)) throw new Error(`commitment ${index} is duplicated`);
    seen.add(key);
    leaves[index] = field;
  });
  return { ...buildMerkleTreeFromLeavesV1(leaves), commitmentCount: commitments.length };
}

export function getMerkleAppendTransitionV1(commitments, rawCommitment) {
  if (!Array.isArray(commitments)) throw new TypeError('commitments must be an array');
  if (commitments.length >= MERKLE_LEAVES_V1) {
    throw new RangeError(`Circuit V1 tree is full at ${MERKLE_LEAVES_V1} commitments`);
  }
  const commitment = assertFieldV1(rawCommitment, 'new commitment');
  if (commitment === 0n) throw new RangeError('new commitment must be non-zero');
  const tree = buildMerkleTreeV1(commitments);
  if (commitments.some((value, index) => assertFieldV1(value, `commitment ${index}`) === commitment)) {
    throw new Error('new commitment is already present in the registry');
  }
  const index = commitments.length;
  const path = [];
  const indexBits = [];
  let position = index;
  for (let depth = 0; depth < MERKLE_DEPTH_V1; depth += 1) {
    path.push(tree.levels[depth][position ^ 1]);
    indexBits.push(position & 1);
    position = Math.floor(position / 2);
  }
  const nextLeaves = tree.levels[0].slice();
  nextLeaves[index] = commitment;
  const nextTree = buildMerkleTreeFromLeavesV1(nextLeaves);
  return {
    index,
    path,
    indexBits,
    oldRoot: tree.root,
    newRoot: nextTree.root,
  };
}

export function getMerkleProofV1(treeOrCommitments, index) {
  const tree = Array.isArray(treeOrCommitments)
    ? buildMerkleTreeV1(treeOrCommitments)
    : treeOrCommitments;
  if (!tree || !Array.isArray(tree.levels) || tree.levels.length !== MERKLE_DEPTH_V1 + 1) {
    throw new TypeError('tree is not a Circuit V1 Merkle tree');
  }
  if (!Number.isInteger(index) || index < 0 || index >= MERKLE_LEAVES_V1) {
    throw new RangeError(`index must be between 0 and ${MERKLE_LEAVES_V1 - 1}`);
  }
  if (tree.commitmentCount !== undefined && index >= tree.commitmentCount) {
    throw new RangeError('index does not contain a deposited commitment');
  }
  const path = [];
  const indexBits = [];
  let position = index;
  for (let depth = 0; depth < MERKLE_DEPTH_V1; depth += 1) {
    path.push(tree.levels[depth][position ^ 1]);
    indexBits.push(position & 1);
    position = Math.floor(position / 2);
  }
  return { index, path, indexBits, root: tree.root };
}

export function verifyMerkleProofV1({ leaf, path, indexBits, root }) {
  if (!Array.isArray(path) || path.length !== MERKLE_DEPTH_V1) return false;
  if (!Array.isArray(indexBits) || indexBits.length !== MERKLE_DEPTH_V1) return false;
  try {
    let current = assertFieldV1(leaf, 'leaf');
    for (let depth = 0; depth < MERKLE_DEPTH_V1; depth += 1) {
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

function readU32LE(bytes, offset) {
  return (
    bytes[offset]
    | (bytes[offset + 1] << 8)
    | (bytes[offset + 2] << 16)
    | (bytes[offset + 3] << 24)
  ) >>> 0;
}

export function decodeCommitmentRegistryV1(accountData) {
  const bytes = asBytes(accountData, 'commitment registry account data');
  if (bytes.length < REGISTRY_HEADER_BYTES || bytes[0] !== STATE_VERSION_V1) {
    throw new Error('invalid or uninitialized commitment registry');
  }
  const count = readU32LE(bytes, 1);
  if (count > MERKLE_LEAVES_V1) {
    throw new RangeError(`commitment registry exceeds Circuit V1 capacity of ${MERKLE_LEAVES_V1}`);
  }
  const requiredLength = REGISTRY_HEADER_BYTES + count * 32;
  if (requiredLength > bytes.length) throw new Error('commitment registry is truncated');
  const commitments = [];
  const seen = new Set();
  for (let index = 0; index < count; index += 1) {
    const start = REGISTRY_HEADER_BYTES + index * 32;
    const commitment = fieldFromLe32(bytes.slice(start, start + 32), `commitment ${index}`);
    if (commitment === 0n) throw new Error(`commitment ${index} is zero`);
    const key = commitment.toString(10);
    if (seen.has(key)) throw new Error(`commitment ${index} is duplicated`);
    seen.add(key);
    commitments.push(commitment);
  }
  const tree = buildMerkleTreeV1(commitments);
  return { version: bytes[0], count, commitments, tree, root: tree.root };
}

export function encodeCommitmentRegistryV1(commitments, capacity = MERKLE_LEAVES_V1) {
  buildMerkleTreeV1(commitments);
  if (!Number.isInteger(capacity) || capacity < commitments.length || capacity > MERKLE_LEAVES_V1) {
    throw new RangeError(`capacity must be between commitment count and ${MERKLE_LEAVES_V1}`);
  }
  const output = new Uint8Array(REGISTRY_HEADER_BYTES + capacity * 32);
  output[0] = STATE_VERSION_V1;
  const count = commitments.length;
  output[1] = count & 0xff;
  output[2] = (count >>> 8) & 0xff;
  output[3] = (count >>> 16) & 0xff;
  output[4] = (count >>> 24) & 0xff;
  commitments.forEach((commitment, index) => {
    output.set(fieldToLe32(commitment), REGISTRY_HEADER_BYTES + index * 32);
  });
  return output;
}

export function findCommitmentIndexV1(commitments, commitment) {
  const target = assertFieldV1(commitment, 'commitment');
  const matches = [];
  commitments.forEach((candidate, index) => {
    if (assertFieldV1(candidate, `commitment ${index}`) === target) matches.push(index);
  });
  if (matches.length === 0) throw new Error('note commitment is not present in the on-chain registry');
  if (matches.length > 1) throw new Error('note commitment appears more than once in the registry');
  return matches[0];
}

export function getMerkleProofForCommitmentV1(registryAccountData, commitment) {
  const registry = decodeCommitmentRegistryV1(registryAccountData);
  const index = findCommitmentIndexV1(registry.commitments, commitment);
  return { registry, ...getMerkleProofV1(registry.tree, index) };
}

export async function fetchCommitmentRegistryV1(connection, commitmentsAccount, commitment = 'confirmed') {
  if (!connection || typeof connection.getAccountInfo !== 'function') {
    throw new TypeError('connection must expose getAccountInfo');
  }
  const info = await connection.getAccountInfo(commitmentsAccount, commitment);
  if (!info) throw new Error('commitment registry account was not found');
  return decodeCommitmentRegistryV1(info.data);
}
