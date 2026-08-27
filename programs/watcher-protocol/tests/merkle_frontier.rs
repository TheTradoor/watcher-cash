use watcher_protocol_program::{
    processor::{append_commitment_v1, commitment_root, COMMITMENT_REGISTRY_ACCOUNT_LEN},
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
