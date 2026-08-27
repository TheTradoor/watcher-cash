use solana_program::pubkey::Pubkey;
use watcher_protocol_program::{
    codec::{
        append_unique_32, contains_32, ConfigAccount, VaultAccount, WatcherInstruction,
        CONFIG_ACCOUNT_LEN, VAULT_ACCOUNT_LEN,
    },
    WatcherError, STATE_VERSION,
};

#[test]
fn config_round_trip_is_stable() {
    let config = ConfigAccount {
        authority: Pubkey::new_unique(),
        treasury: Pubkey::new_unique(),
        fees_enabled: false,
        protocol_fee_bps: 0,
        merkle_root: [9u8; 32],
    };
    let mut bytes = vec![0u8; CONFIG_ACCOUNT_LEN];
    config.pack(&mut bytes).unwrap();
    assert_eq!(ConfigAccount::unpack(&bytes).unwrap(), config);
}

#[test]
fn vault_round_trip_is_stable() {
    let vault = VaultAccount {
        config: Pubkey::new_unique(),
        bump: 254,
        asset_id: 1,
        tracked_balance: 42_000,
    };
    let mut bytes = vec![0u8; VAULT_ACCOUNT_LEN];
    vault.pack(&mut bytes).unwrap();
    assert_eq!(VaultAccount::unpack(&bytes).unwrap(), vault);
}

#[test]
fn set_merkle_root_instruction_decodes_exactly() {
    let mut bytes = vec![3u8];
    bytes.extend_from_slice(&[9u8; 32]);
    assert_eq!(
        WatcherInstruction::unpack(&bytes).unwrap(),
        WatcherInstruction::SetMerkleRoot { root: [9u8; 32] }
    );
    bytes.push(0);
    assert_eq!(
        WatcherInstruction::unpack(&bytes),
        Err(WatcherError::InvalidInstruction)
    );
}

#[test]
fn deposit_instruction_decodes_proof_and_public_inputs_exactly() {
    let proof = vec![7u8; 256];
    let public_inputs = vec![8u8; 96];
    let mut bytes = vec![1u8];
    bytes.extend_from_slice(&[6u8; 32]);
    bytes.extend_from_slice(&42u64.to_le_bytes());
    bytes.extend_from_slice(&(proof.len() as u16).to_le_bytes());
    bytes.extend_from_slice(&proof);
    bytes.extend_from_slice(&(public_inputs.len() as u16).to_le_bytes());
    bytes.extend_from_slice(&public_inputs);

    assert_eq!(
        WatcherInstruction::unpack(&bytes).unwrap(),
        WatcherInstruction::Deposit {
            commitment: [6u8; 32],
            amount: 42,
            proof,
            public_inputs,
        }
    );
    bytes.push(0);
    assert_eq!(
        WatcherInstruction::unpack(&bytes),
        Err(WatcherError::InvalidInstruction)
    );
}

#[test]
fn truncated_deposit_payload_fails_closed() {
    let mut bytes = vec![1u8];
    bytes.extend_from_slice(&[6u8; 32]);
    bytes.extend_from_slice(&42u64.to_le_bytes());
    bytes.extend_from_slice(&256u16.to_le_bytes());
    bytes.extend_from_slice(&[7u8; 12]);
    assert_eq!(
        WatcherInstruction::unpack(&bytes),
        Err(WatcherError::InvalidInstruction)
    );
}

#[test]
fn registry_is_versioned_unique_and_bounded() {
    let mut registry = vec![0u8; 5 + 64];
    registry[0] = STATE_VERSION;
    append_unique_32(&mut registry, [1u8; 32]).unwrap();
    assert!(contains_32(&registry, &[1u8; 32]).unwrap());
    assert_eq!(
        append_unique_32(&mut registry, [1u8; 32]),
        Err(WatcherError::DuplicateCommitment)
    );
    append_unique_32(&mut registry, [2u8; 32]).unwrap();
    assert_eq!(
        append_unique_32(&mut registry, [3u8; 32]),
        Err(WatcherError::RegistryFull)
    );
}

#[test]
fn malformed_registry_fails_closed() {
    let mut registry = vec![0u8; 37];
    registry[0] = STATE_VERSION;
    registry[1..5].copy_from_slice(&99u32.to_le_bytes());
    assert_eq!(
        contains_32(&registry, &[1u8; 32]),
        Err(WatcherError::InvalidAccountData)
    );
}
