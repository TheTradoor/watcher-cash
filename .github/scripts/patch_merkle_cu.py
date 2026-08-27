from pathlib import Path
import re
from textwrap import dedent

processor_path = Path("programs/watcher-protocol/src/processor.rs")
processor = processor_path.read_text()

processor = processor.replace("use sha3::{Digest, Keccak256};\n", "")
processor = processor.replace(
    "const MIMC_ROUNDS_BN254: usize = 110;\n",
    dedent(
        """\
        pub const COMMITMENT_REGISTRY_ACCOUNT_LEN: usize =
            REGISTRY_HEADER_LEN + MERKLE_LEAVES_V1 * 32 + MERKLE_DEPTH_V1 * 32;
        const COMMITMENT_FRONTIER_OFFSET_V1: usize = REGISTRY_HEADER_LEN + MERKLE_LEAVES_V1 * 32;
        const MIMC_CONSTANTS_BN254: [Fr; 110] = include!("mimc_constants_array.in");
        const ZERO_SUBTREES_V1: [Fr; MERKLE_DEPTH_V1] = [
            ark_ff::MontFp!("0"),
            ark_ff::MontFp!("13944871254576092688407995039196385293275829255317419112130051225496143636462"),
            ark_ff::MontFp!("16343093116817376678535597198206140961913989012995557384633161644309886798874"),
            ark_ff::MontFp!("21733524612354527147942681386006398610659529737868531993862559850617141653616"),
        ];
        """
    ),
)
processor = processor.replace(
    "let commitments_len = require_uninitialized(commitments, REGISTRY_HEADER_LEN)?;",
    "let commitments_len = require_uninitialized(commitments, COMMITMENT_REGISTRY_ACCOUNT_LEN)?;",
)
processor, substitutions = re.subn(
    r"fn mimc_constants_bn254\(\) -> Vec<Fr> \{.*?\n\}\n\npub fn mimc_hash_v1",
    "pub fn mimc_hash_v1",
    processor,
    flags=re.S,
)
assert substitutions == 1, f"expected one runtime MiMC constant generator, got {substitutions}"
processor = processor.replace("    let constants = mimc_constants_bn254();\n", "")
processor = processor.replace(
    "for constant in &constants {",
    "for constant in &MIMC_CONSTANTS_BN254 {",
)

insertion_marker = "/// Circuit V1-compatible Merkle root. Commitments are canonical little-endian\n"
assert insertion_marker in processor
incremental = dedent(
    r'''\
    /// Append one commitment and update the fixed-depth frontier in O(log N).
    ///
    /// Layout after the 16 commitment slots:
    /// `filled_subtrees[0..MERKLE_DEPTH_V1]`, each as a canonical LE BN254 field.
    /// The account remains append-only; clients can keep decoding the first `count`
    /// leaves exactly as before and ignore the trailing frontier bytes.
    pub fn append_commitment_v1(
        registry: &mut [u8],
        commitment: [u8; 32],
    ) -> Result<[u8; 32], WatcherError> {
        if registry.len() < COMMITMENT_REGISTRY_ACCOUNT_LEN || registry[0] != STATE_VERSION {
            return Err(WatcherError::InvalidAccountData);
        }
        let count = commitment_count(registry)?;
        if count >= MERKLE_LEAVES_V1 {
            return Err(WatcherError::MerkleTreeFull);
        }
        if contains_32(registry, &commitment)? {
            return Err(WatcherError::DuplicateCommitment);
        }

        let mut current = fr_from_canonical_le32(&commitment)?;
        let mut position = count;
        for level in 0..MERKLE_DEPTH_V1 {
            let frontier_offset = COMMITMENT_FRONTIER_OFFSET_V1 + level * 32;
            if position & 1 == 0 {
                registry[frontier_offset..frontier_offset + 32]
                    .copy_from_slice(&fr_to_le32(current));
                current = parent_v1(current, ZERO_SUBTREES_V1[level]);
            } else {
                let left_bytes: [u8; 32] = registry[frontier_offset..frontier_offset + 32]
                    .try_into()
                    .unwrap();
                let left = fr_from_canonical_le32(&left_bytes)?;
                current = parent_v1(left, current);
            }
            position >>= 1;
        }

        let leaf_offset = REGISTRY_HEADER_LEN + count * 32;
        registry[leaf_offset..leaf_offset + 32].copy_from_slice(&commitment);
        registry[1..5].copy_from_slice(&((count + 1) as u32).to_le_bytes());
        Ok(fr_to_le32(current))
    }

    '''
)
processor = processor.replace(insertion_marker, incremental + insertion_marker)
processor = processor.replace(
    "    append_unique_32(&mut next_commitments, commitment)?;\n    let new_root = commitment_root(&next_commitments)?;",
    "    let new_root = append_commitment_v1(&mut next_commitments, commitment)?;",
)
processor = processor.replace(
    "        append_unique_32(&mut next_commitments, statement.change_commitment)?;\n        let new_root = commitment_root(&next_commitments)?;",
    dedent(
        """\
                let new_root = append_commitment_v1(
                    &mut next_commitments,
                    statement.change_commitment,
                )?;
        """
    ),
)
assert "mimc_constants_bn254" not in processor
assert processor.count("append_commitment_v1(&mut next_commitments, commitment)?") == 1
assert processor.count("let new_root = append_commitment_v1(") == 1
processor_path.write_text(processor)

cargo_path = Path("programs/watcher-protocol/Cargo.toml")
cargo = cargo_path.read_text().replace('sha3 = "0.10"\n', "")
cargo_path.write_text(cargo)

# The four trailing field elements are the incremental frontier. Any test
# account that allocated only the 16 leaf slots must allocate the full state.
for path in Path("programs/watcher-protocol").rglob("*.rs"):
    if path == processor_path:
        continue
    text = path.read_text()
    updated = text.replace("5 + 32 * 16", "5 + 32 * 16 + 32 * 4")
    if updated != text:
        path.write_text(updated)

instructions_path = Path("client/watcher/instructions.mjs")
instructions = instructions_path.read_text().replace(
    "export const COMMITMENT_REGISTRY_LEN_V1 = 5 + (32 * 16);",
    "export const COMMITMENT_REGISTRY_LEN_V1 = 5 + (32 * 16) + (32 * 4);",
)
instructions_path.write_text(instructions)

readme_path = Path("client/watcher/README.md")
readme = readme_path.read_text().replace(
    "commitment registry:  517 bytes",
    "commitment registry:  645 bytes",
)
readme_path.write_text(readme)

test_path = Path("programs/watcher-protocol/tests/merkle_frontier.rs")
test_path.write_text(
    dedent(
        r'''\
        use watcher_protocol_program::{
            processor::{
                append_commitment_v1, commitment_root, COMMITMENT_REGISTRY_ACCOUNT_LEN,
            },
            WatcherError, STATE_VERSION,
        };

        fn field(value: u64) -> [u8; 32] {
            let mut output = [0u8; 32];
            output[..8].copy_from_slice(&value.to_le_bytes());
            output
        }

        #[test]
        fn incremental_frontier_matches_full_circuit_tree_after_every_append() {
            let mut registry = vec![0u8; COMMITMENT_REGISTRY_ACCOUNT_LEN];
            registry[0] = STATE_VERSION;

            for value in 1..=16u64 {
                let incremental = append_commitment_v1(&mut registry, field(value)).unwrap();
                let full = commitment_root(&registry).unwrap();
                assert_eq!(incremental, full, "root mismatch after leaf {value}");
            }
            assert_eq!(
                append_commitment_v1(&mut registry, field(17)),
                Err(WatcherError::MerkleTreeFull)
            );
        }

        #[test]
        fn duplicate_append_does_not_change_frontier_or_leaf_count() {
            let mut registry = vec![0u8; COMMITMENT_REGISTRY_ACCOUNT_LEN];
            registry[0] = STATE_VERSION;
            append_commitment_v1(&mut registry, field(7)).unwrap();
            let before = registry.clone();
            assert_eq!(
                append_commitment_v1(&mut registry, field(7)),
                Err(WatcherError::DuplicateCommitment)
            );
            assert_eq!(registry, before);
        }
        '''
    )
)
