import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DOMAIN_MERKLE_V1, mimcHashV1 } from '../client/watcher/field.mjs';
import { keccak256 } from '../client/watcher/keccak.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
process.chdir(repoRoot);

const read = (path) => readFileSync(path, 'utf8');
const write = (path, content) => writeFileSync(path, content);

function replaceOnce(content, needle, replacement, label) {
  const first = content.indexOf(needle);
  if (first === -1) throw new Error(`missing patch needle: ${label}`);
  if (content.indexOf(needle, first + needle.length) !== -1) {
    throw new Error(`patch needle is not unique: ${label}`);
  }
  return content.slice(0, first) + replacement + content.slice(first + needle.length);
}

function replaceRegexOnce(content, pattern, replacement, label) {
  const matches = [...content.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))];
  if (matches.length !== 1) throw new Error(`expected one ${label} match, found ${matches.length}`);
  return content.replace(pattern, replacement);
}

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
}

const modulus = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const bytesToBigIntBE = (bytes) => {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
};

let random = keccak256('seed');
const constants = [];
for (let round = 0; round < 110; round += 1) {
  random = keccak256(random);
  constants.push(bytesToBigIntBE(random) % modulus);
}
write(
  'programs/watcher-protocol/src/mimc_constants_array.in',
  `[\n${constants.map((value) => `    ark_ff::MontFp!("${value}"),`).join('\n')}\n]\n`,
);

const zeroSubtrees = [];
let zero = 0n;
for (let level = 0; level < 4; level += 1) {
  zeroSubtrees.push(zero);
  zero = mimcHashV1([DOMAIN_MERKLE_V1, zero, zero]);
}

const processorPath = 'programs/watcher-protocol/src/processor.rs';
let processor = read(processorPath);
processor = replaceOnce(processor, 'use sha3::{Digest, Keccak256};\n', '', 'sha3 import');
processor = replaceOnce(
  processor,
  'const MIMC_ROUNDS_BN254: usize = 110;\n',
  `pub const COMMITMENT_REGISTRY_ACCOUNT_LEN: usize =\n    REGISTRY_HEADER_LEN + MERKLE_LEAVES_V1 * 32 + MERKLE_DEPTH_V1 * 32;\nconst COMMITMENT_FRONTIER_OFFSET_V1: usize = REGISTRY_HEADER_LEN + MERKLE_LEAVES_V1 * 32;\nconst MIMC_CONSTANTS_BN254: [Fr; 110] = include!("mimc_constants_array.in");\nconst ZERO_SUBTREES_V1: [Fr; MERKLE_DEPTH_V1] = [\n${zeroSubtrees.map((value) => `    ark_ff::MontFp!("${value}"),`).join('\n')}\n];\n`,
  'MiMC runtime constants declaration',
);
processor = replaceOnce(
  processor,
  'let commitments_len = require_uninitialized(commitments, REGISTRY_HEADER_LEN)?;',
  'let commitments_len = require_uninitialized(commitments, COMMITMENT_REGISTRY_ACCOUNT_LEN)?;',
  'commitment registry initialization length',
);
processor = replaceRegexOnce(
  processor,
  /fn mimc_constants_bn254\(\) -> Vec<Fr> \{[\s\S]*?\n\}\n\npub fn mimc_hash_v1/,
  'pub fn mimc_hash_v1',
  'runtime MiMC constants function',
);
processor = replaceOnce(
  processor,
  '    let constants = mimc_constants_bn254();\n',
  '',
  'runtime MiMC constants allocation',
);
processor = replaceOnce(
  processor,
  '        for constant in &constants {',
  '        for constant in &MIMC_CONSTANTS_BN254 {',
  'MiMC constants loop',
);

const insertionMarker = '/// Circuit V1-compatible Merkle root. Commitments are canonical little-endian\n';
const incrementalAppend = `/// Append one commitment and update the fixed-depth frontier in O(log N).\n///\n/// The four trailing field elements hold filled subtrees. The first count\n/// commitment slots remain append-only and keep the existing client codec.\npub fn append_commitment_v1(\n    registry: &mut [u8],\n    commitment: [u8; 32],\n) -> Result<[u8; 32], WatcherError> {\n    if registry.len() < COMMITMENT_REGISTRY_ACCOUNT_LEN || registry[0] != STATE_VERSION {\n        return Err(WatcherError::InvalidAccountData);\n    }\n    let count = commitment_count(registry)?;\n    if count >= MERKLE_LEAVES_V1 {\n        return Err(WatcherError::MerkleTreeFull);\n    }\n    if contains_32(registry, &commitment)? {\n        return Err(WatcherError::DuplicateCommitment);\n    }\n\n    let mut current = fr_from_canonical_le32(&commitment)?;\n    let mut position = count;\n    for level in 0..MERKLE_DEPTH_V1 {\n        let frontier_offset = COMMITMENT_FRONTIER_OFFSET_V1 + level * 32;\n        if position & 1 == 0 {\n            registry[frontier_offset..frontier_offset + 32]\n                .copy_from_slice(&fr_to_le32(current));\n            current = parent_v1(current, ZERO_SUBTREES_V1[level]);\n        } else {\n            let left_bytes: [u8; 32] = registry[frontier_offset..frontier_offset + 32]\n                .try_into()\n                .unwrap();\n            let left = fr_from_canonical_le32(&left_bytes)?;\n            current = parent_v1(left, current);\n        }\n        position >>= 1;\n    }\n\n    let leaf_offset = REGISTRY_HEADER_LEN + count * 32;\n    registry[leaf_offset..leaf_offset + 32].copy_from_slice(&commitment);\n    registry[1..5].copy_from_slice(&((count + 1) as u32).to_le_bytes());\n    Ok(fr_to_le32(current))\n}\n\n`;
processor = replaceOnce(
  processor,
  insertionMarker,
  incrementalAppend + insertionMarker,
  'incremental append insertion point',
);
processor = replaceOnce(
  processor,
  '    append_unique_32(&mut next_commitments, commitment)?;\n    let new_root = commitment_root(&next_commitments)?;',
  '    let new_root = append_commitment_v1(&mut next_commitments, commitment)?;',
  'deposit full-tree update',
);
processor = replaceOnce(
  processor,
  '        append_unique_32(&mut next_commitments, statement.change_commitment)?;\n        let new_root = commitment_root(&next_commitments)?;',
  '        let new_root = append_commitment_v1(\n            &mut next_commitments,\n            statement.change_commitment,\n        )?;',
  'withdraw change full-tree update',
);
if (processor.includes('mimc_constants_bn254')) throw new Error('runtime MiMC generator survived patch');
write(processorPath, processor);

const cargoPath = 'programs/watcher-protocol/Cargo.toml';
let cargo = read(cargoPath);
cargo = replaceOnce(cargo, 'sha3 = "0.10"\n', '', 'sha3 Cargo dependency');
write(cargoPath, cargo);

for (const path of walk('programs/watcher-protocol')) {
  if (!path.endsWith('.rs') || path === processorPath) continue;
  const content = read(path);
  const updated = content.replaceAll('5 + 32 * 16', '5 + 32 * 16 + 32 * 4');
  if (updated !== content) write(path, updated);
}

const instructionsPath = 'client/watcher/instructions.mjs';
let instructions = read(instructionsPath);
instructions = replaceOnce(
  instructions,
  'export const COMMITMENT_REGISTRY_LEN_V1 = 5 + (32 * 16);',
  'export const COMMITMENT_REGISTRY_LEN_V1 = 5 + (32 * 16) + (32 * 4);',
  'client commitment registry length',
);
write(instructionsPath, instructions);

const readmePath = 'client/watcher/README.md';
let readme = read(readmePath);
readme = replaceOnce(
  readme,
  'commitment registry:  517 bytes',
  'commitment registry:  645 bytes',
  'README commitment registry length',
);
write(readmePath, readme);

write(
  'programs/watcher-protocol/tests/merkle_frontier.rs',
  `use watcher_protocol_program::{\n    processor::{\n        append_commitment_v1, commitment_root, COMMITMENT_REGISTRY_ACCOUNT_LEN,\n    },\n    WatcherError, STATE_VERSION,\n};\n\nfn field(value: u64) -> [u8; 32] {\n    let mut output = [0u8; 32];\n    output[..8].copy_from_slice(&value.to_le_bytes());\n    output\n}\n\n#[test]\nfn incremental_frontier_matches_full_circuit_tree_after_every_append() {\n    let mut registry = vec![0u8; COMMITMENT_REGISTRY_ACCOUNT_LEN];\n    registry[0] = STATE_VERSION;\n\n    for value in 1..=16u64 {\n        let incremental = append_commitment_v1(&mut registry, field(value)).unwrap();\n        let full = commitment_root(&registry).unwrap();\n        assert_eq!(incremental, full, "root mismatch after leaf {value}");\n    }\n    assert_eq!(\n        append_commitment_v1(&mut registry, field(17)),\n        Err(WatcherError::MerkleTreeFull)\n    );\n}\n\n#[test]\nfn duplicate_append_does_not_change_frontier_or_leaf_count() {\n    let mut registry = vec![0u8; COMMITMENT_REGISTRY_ACCOUNT_LEN];\n    registry[0] = STATE_VERSION;\n    append_commitment_v1(&mut registry, field(7)).unwrap();\n    let before = registry.clone();\n    assert_eq!(\n        append_commitment_v1(&mut registry, field(7)),\n        Err(WatcherError::DuplicateCommitment)\n    );\n    assert_eq!(registry, before);\n}\n`,
);

console.log('Applied compile-time MiMC constants and incremental Merkle frontier patch.');
