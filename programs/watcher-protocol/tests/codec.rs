use solana_program::pubkey::Pubkey;
use watcher_protocol_program::{codec::{append_unique_32, contains_32, ConfigAccount, WatcherInstruction, CONFIG_ACCOUNT_LEN}, WatcherError, STATE_VERSION};

#[test]
fn config_round_trip_is_stable() {
    let c = ConfigAccount { authority: Pubkey::new_unique(), treasury: Pubkey::new_unique(), fees_enabled: false, protocol_fee_bps: 0 };
    let mut bytes = vec![0u8; CONFIG_ACCOUNT_LEN];
    c.pack(&mut bytes).unwrap();
    assert_eq!(ConfigAccount::unpack(&bytes).unwrap(), c);
}

#[test]
fn deposit_instruction_decodes_exactly() {
    let mut bytes = vec![1u8]; bytes.extend_from_slice(&[7u8; 32]); bytes.extend_from_slice(&42u64.to_le_bytes());
    assert_eq!(WatcherInstruction::unpack(&bytes).unwrap(), WatcherInstruction::Deposit { commitment: [7u8; 32], amount: 42 });
    bytes.push(0); assert_eq!(WatcherInstruction::unpack(&bytes), Err(WatcherError::InvalidInstruction));
}

#[test]
fn registry_is_versioned_unique_and_bounded() {
    let mut r = vec![0u8; 5 + 64]; r[0] = STATE_VERSION;
    append_unique_32(&mut r, [1u8; 32]).unwrap();
    assert!(contains_32(&r, &[1u8; 32]).unwrap());
    assert_eq!(append_unique_32(&mut r, [1u8; 32]), Err(WatcherError::DuplicateCommitment));
    append_unique_32(&mut r, [2u8; 32]).unwrap();
    assert_eq!(append_unique_32(&mut r, [3u8; 32]), Err(WatcherError::RegistryFull));
}

#[test]
fn malformed_registry_fails_closed() {
    let mut r = vec![0u8; 37]; r[0] = STATE_VERSION; r[1..5].copy_from_slice(&99u32.to_le_bytes());
    assert_eq!(contains_32(&r, &[1u8; 32]), Err(WatcherError::InvalidAccountData));
}
