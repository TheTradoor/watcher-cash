use watcher_protocol_program::{
    codec::{append_unique_32, contains_32, REGISTRY_HEADER_LEN},
    processor::COMMITMENT_REGISTRY_ACCOUNT_LEN,
    WatcherError, STATE_VERSION,
};

fn commitment(value: u8) -> [u8; 32] {
    let mut output = [0u8; 32];
    output[0] = value;
    output
}

#[test]
fn append_only_registry_keeps_exact_leaf_order_and_capacity() {
    let mut registry = vec![0u8; COMMITMENT_REGISTRY_ACCOUNT_LEN];
    registry[0] = STATE_VERSION;
    for value in 1..=16u8 {
        append_unique_32(&mut registry, commitment(value)).unwrap();
    }
    assert_eq!(u32::from_le_bytes(registry[1..5].try_into().unwrap()), 16);
    for index in 0..16usize {
        let start = REGISTRY_HEADER_LEN + index * 32;
        assert_eq!(registry[start..start + 32], commitment((index + 1) as u8));
    }
    assert!(contains_32(&registry, &commitment(7)).unwrap());
}

#[test]
fn duplicate_append_fails_without_mutating_registry() {
    let mut registry = vec![0u8; COMMITMENT_REGISTRY_ACCOUNT_LEN];
    registry[0] = STATE_VERSION;
    append_unique_32(&mut registry, commitment(7)).unwrap();
    let before = registry.clone();
    assert_eq!(
        append_unique_32(&mut registry, commitment(7)),
        Err(WatcherError::DuplicateCommitment)
    );
    assert_eq!(registry, before);
}
