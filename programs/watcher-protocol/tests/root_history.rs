use watcher_protocol_program::{
    root_history::{
        initialize_root_history, latest_root, push_root, require_recent_root,
        root_history_contains, root_history_count, roots_oldest_to_newest,
        ROOT_HISTORY_ACCOUNT_LEN, ROOT_HISTORY_CAPACITY,
    },
    WatcherError, STATE_VERSION,
};

fn root(value: u64) -> [u8; 32] {
    assert_ne!(value, 0);
    let mut output = [0u8; 32];
    output[..8].copy_from_slice(&value.to_le_bytes());
    output
}

#[test]
fn current_and_previous_roots_are_recent() {
    let mut data = vec![0u8; ROOT_HISTORY_ACCOUNT_LEN];
    initialize_root_history(&mut data).unwrap();
    push_root(&mut data, root(1)).unwrap();
    push_root(&mut data, root(2)).unwrap();
    push_root(&mut data, root(3)).unwrap();

    assert_eq!(latest_root(&data).unwrap(), Some(root(3)));
    require_recent_root(&data, &root(3)).unwrap();
    require_recent_root(&data, &root(2)).unwrap();
    assert_eq!(root_history_count(&data).unwrap(), 3);
}

#[test]
fn oldest_root_expires_when_the_ring_wraps() {
    let mut data = vec![0u8; ROOT_HISTORY_ACCOUNT_LEN];
    initialize_root_history(&mut data).unwrap();

    for value in 1..=(ROOT_HISTORY_CAPACITY as u64 + 1) {
        push_root(&mut data, root(value)).unwrap();
    }

    assert_eq!(root_history_count(&data).unwrap(), ROOT_HISTORY_CAPACITY);
    assert_eq!(latest_root(&data).unwrap(), Some(root(33)));
    assert_eq!(
        require_recent_root(&data, &root(1)),
        Err(WatcherError::UnknownMerkleRoot)
    );
    require_recent_root(&data, &root(2)).unwrap();
    require_recent_root(&data, &root(33)).unwrap();

    let ordered = roots_oldest_to_newest(&data).unwrap();
    assert_eq!(ordered.first(), Some(&root(2)));
    assert_eq!(ordered.last(), Some(&root(33)));
}

#[test]
fn duplicate_latest_root_is_a_noop() {
    let mut data = vec![0u8; ROOT_HISTORY_ACCOUNT_LEN];
    initialize_root_history(&mut data).unwrap();
    assert_eq!(push_root(&mut data, root(7)).unwrap(), true);
    let before = data.clone();

    assert_eq!(push_root(&mut data, root(7)).unwrap(), false);
    assert_eq!(data, before);
    assert_eq!(root_history_count(&data).unwrap(), 1);
}

#[test]
fn unknown_and_zero_roots_fail_closed() {
    let mut data = vec![0u8; ROOT_HISTORY_ACCOUNT_LEN];
    initialize_root_history(&mut data).unwrap();
    push_root(&mut data, root(9)).unwrap();

    assert_eq!(
        require_recent_root(&data, &root(10)),
        Err(WatcherError::UnknownMerkleRoot)
    );
    assert_eq!(root_history_contains(&data, &[0u8; 32]).unwrap(), false);
    assert_eq!(
        push_root(&mut data, [0u8; 32]),
        Err(WatcherError::InvalidPublicInputs)
    );
}

#[test]
fn malformed_history_is_rejected() {
    let mut too_short = vec![0u8; ROOT_HISTORY_ACCOUNT_LEN - 1];
    assert_eq!(
        initialize_root_history(&mut too_short),
        Err(WatcherError::InvalidAccountData)
    );

    let mut malformed = vec![0u8; ROOT_HISTORY_ACCOUNT_LEN];
    initialize_root_history(&mut malformed).unwrap();
    malformed[1..5].copy_from_slice(&1u32.to_le_bytes());
    malformed[5..9].copy_from_slice(&0u32.to_le_bytes());
    assert_eq!(malformed[0], STATE_VERSION);
    assert_eq!(latest_root(&malformed), Err(WatcherError::InvalidAccountData));
}
