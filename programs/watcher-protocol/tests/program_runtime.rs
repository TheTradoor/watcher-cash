use solana_program::{account_info::AccountInfo, clock::Epoch, program_error::ProgramError, pubkey::Pubkey};
use watcher_protocol_program::{
    codec::{contains_32, ConfigAccount, CONFIG_ACCOUNT_LEN},
    process_instruction,
    processor::commitment_root,
    WatcherError,
    STATE_VERSION,
};

fn program_account<'a>(
    key: &'a Pubkey,
    owner: &'a Pubkey,
    lamports: &'a mut u64,
    data: &'a mut [u8],
    signer: bool,
) -> AccountInfo<'a> {
    AccountInfo::new(
        key,
        signer,
        true,
        lamports,
        data,
        owner,
        false,
        Epoch::default(),
    )
}

fn init_data(treasury: &Pubkey) -> Vec<u8> {
    let mut value = vec![0];
    value.extend_from_slice(treasury.as_ref());
    value
}

fn deposit_data(commitment: [u8; 32], amount: u64) -> Vec<u8> {
    let mut value = vec![1];
    value.extend_from_slice(&commitment);
    value.extend_from_slice(&amount.to_le_bytes());
    value
}

fn set_root_data(root: [u8; 32]) -> Vec<u8> {
    let mut value = vec![3];
    value.extend_from_slice(&root);
    value
}

fn withdraw_data(
    nullifier_0: [u8; 32],
    nullifier_1: [u8; 32],
    change: [u8; 32],
    recipient: &Pubkey,
) -> Vec<u8> {
    let mut value = vec![2];
    value.extend_from_slice(&nullifier_0);
    value.extend_from_slice(&nullifier_1);
    value.extend_from_slice(&change);
    value.extend_from_slice(recipient.as_ref());
    value.extend_from_slice(&1_000u64.to_le_bytes());
    value.extend_from_slice(&0u64.to_le_bytes());
    value.extend_from_slice(&5u64.to_le_bytes());

    let proof = [9u8; 8];
    value.extend_from_slice(&(proof.len() as u16).to_le_bytes());
    value.extend_from_slice(&proof);

    let inputs = [8u8; 8];
    value.extend_from_slice(&(inputs.len() as u16).to_le_bytes());
    value.extend_from_slice(&inputs);
    value
}

fn initialized_config(
    program_id: &Pubkey,
    authority: &Pubkey,
    treasury: &Pubkey,
    config_key: &Pubkey,
) -> (u64, Vec<u8>) {
    let commitments_key = Pubkey::new_unique();
    let nullifiers_key = Pubkey::new_unique();
    let mut authority_lamports = 1;
    let mut config_lamports = 1;
    let mut commitments_lamports = 1;
    let mut nullifiers_lamports = 1;
    let mut authority_data = [];
    let mut config_data = vec![0u8; CONFIG_ACCOUNT_LEN];
    let mut commitments_data = vec![0u8; 69];
    let mut nullifiers_data = vec![0u8; 69];

    {
        let accounts = vec![
            program_account(
                authority,
                program_id,
                &mut authority_lamports,
                &mut authority_data,
                true,
            ),
            program_account(
                config_key,
                program_id,
                &mut config_lamports,
                &mut config_data,
                true,
            ),
            program_account(
                &commitments_key,
                program_id,
                &mut commitments_lamports,
                &mut commitments_data,
                true,
            ),
            program_account(
                &nullifiers_key,
                program_id,
                &mut nullifiers_lamports,
                &mut nullifiers_data,
                true,
            ),
        ];
        process_instruction(program_id, &accounts, &init_data(treasury)).unwrap();
    }

    (config_lamports, config_data)
}

#[test]
fn manual_merkle_root_updates_are_disabled_even_for_authority() {
    let program_id = Pubkey::new_unique();
    let authority = Pubkey::new_unique();
    let treasury = Pubkey::new_unique();
    let config_key = Pubkey::new_unique();
    let (mut config_lamports, mut config_data) =
        initialized_config(&program_id, &authority, &treasury, &config_key);
    let before = config_data.clone();
    let mut authority_lamports = 1;
    let mut authority_data = [];

    let error = {
        let accounts = vec![
            program_account(
                &authority,
                &program_id,
                &mut authority_lamports,
                &mut authority_data,
                true,
            ),
            program_account(
                &config_key,
                &program_id,
                &mut config_lamports,
                &mut config_data,
                true,
            ),
        ];
        process_instruction(&program_id, &accounts, &set_root_data([42u8; 32])).unwrap_err()
    };

    assert_eq!(
        error,
        ProgramError::Custom(WatcherError::ManualMerkleRootDisabled as u32 + 1)
    );
    assert_eq!(config_data, before, "manual root attempt must not mutate config");
}

#[test]
fn deposits_derive_and_persist_the_trusted_merkle_root() {
    let program_id = Pubkey::new_unique();
    let authority = Pubkey::new_unique();
    let treasury = Pubkey::new_unique();
    let config_key = Pubkey::new_unique();
    let commitments_key = Pubkey::new_unique();
    let nullifiers_key = Pubkey::new_unique();
    let mut authority_lamports = 1;
    let mut config_lamports = 1;
    let mut commitments_lamports = 1;
    let mut nullifiers_lamports = 1;
    let mut authority_data = [];
    let mut config_data = vec![0u8; CONFIG_ACCOUNT_LEN];
    let mut commitments_data = vec![0u8; 5 + 32 * 8];
    let mut nullifiers_data = vec![0u8; 5 + 32 * 8];

    {
        let accounts = vec![
            program_account(
                &authority,
                &program_id,
                &mut authority_lamports,
                &mut authority_data,
                true,
            ),
            program_account(
                &config_key,
                &program_id,
                &mut config_lamports,
                &mut config_data,
                true,
            ),
            program_account(
                &commitments_key,
                &program_id,
                &mut commitments_lamports,
                &mut commitments_data,
                true,
            ),
            program_account(
                &nullifiers_key,
                &program_id,
                &mut nullifiers_lamports,
                &mut nullifiers_data,
                true,
            ),
        ];
        process_instruction(&program_id, &accounts, &init_data(&treasury)).unwrap();
    }

    assert_eq!(ConfigAccount::unpack(&config_data).unwrap().merkle_root, [0u8; 32]);

    {
        let accounts = vec![
            program_account(
                &config_key,
                &program_id,
                &mut config_lamports,
                &mut config_data,
                true,
            ),
            program_account(
                &commitments_key,
                &program_id,
                &mut commitments_lamports,
                &mut commitments_data,
                true,
            ),
        ];
        process_instruction(&program_id, &accounts, &deposit_data([7u8; 32], 10_000)).unwrap();
    }

    let first_root = commitment_root(&commitments_data).unwrap();
    assert_ne!(first_root, [0u8; 32]);
    assert_eq!(ConfigAccount::unpack(&config_data).unwrap().merkle_root, first_root);

    {
        let accounts = vec![
            program_account(
                &config_key,
                &program_id,
                &mut config_lamports,
                &mut config_data,
                true,
            ),
            program_account(
                &commitments_key,
                &program_id,
                &mut commitments_lamports,
                &mut commitments_data,
                true,
            ),
        ];
        process_instruction(&program_id, &accounts, &deposit_data([8u8; 32], 20_000)).unwrap();
    }

    let second_root = commitment_root(&commitments_data).unwrap();
    assert_ne!(second_root, first_root);
    assert_eq!(ConfigAccount::unpack(&config_data).unwrap().merkle_root, second_root);
}

#[test]
fn rejected_duplicate_deposit_does_not_change_commitments_or_root() {
    let program_id = Pubkey::new_unique();
    let authority = Pubkey::new_unique();
    let treasury = Pubkey::new_unique();
    let config_key = Pubkey::new_unique();
    let commitments_key = Pubkey::new_unique();
    let nullifiers_key = Pubkey::new_unique();
    let mut authority_lamports = 1;
    let mut config_lamports = 1;
    let mut commitments_lamports = 1;
    let mut nullifiers_lamports = 1;
    let mut authority_data = [];
    let mut config_data = vec![0u8; CONFIG_ACCOUNT_LEN];
    let mut commitments_data = vec![0u8; 5 + 32 * 4];
    let mut nullifiers_data = vec![0u8; 5 + 32 * 4];
    let commitment = [13u8; 32];

    {
        let accounts = vec![
            program_account(
                &authority,
                &program_id,
                &mut authority_lamports,
                &mut authority_data,
                true,
            ),
            program_account(
                &config_key,
                &program_id,
                &mut config_lamports,
                &mut config_data,
                true,
            ),
            program_account(
                &commitments_key,
                &program_id,
                &mut commitments_lamports,
                &mut commitments_data,
                true,
            ),
            program_account(
                &nullifiers_key,
                &program_id,
                &mut nullifiers_lamports,
                &mut nullifiers_data,
                true,
            ),
        ];
        process_instruction(&program_id, &accounts, &init_data(&treasury)).unwrap();
    }

    {
        let accounts = vec![
            program_account(
                &config_key,
                &program_id,
                &mut config_lamports,
                &mut config_data,
                true,
            ),
            program_account(
                &commitments_key,
                &program_id,
                &mut commitments_lamports,
                &mut commitments_data,
                true,
            ),
        ];
        process_instruction(&program_id, &accounts, &deposit_data(commitment, 10_000)).unwrap();
    }

    let config_before = config_data.clone();
    let commitments_before = commitments_data.clone();
    let error = {
        let accounts = vec![
            program_account(
                &config_key,
                &program_id,
                &mut config_lamports,
                &mut config_data,
                true,
            ),
            program_account(
                &commitments_key,
                &program_id,
                &mut commitments_lamports,
                &mut commitments_data,
                true,
            ),
        ];
        process_instruction(&program_id, &accounts, &deposit_data(commitment, 10_000)).unwrap_err()
    };

    assert_eq!(
        error,
        ProgramError::Custom(WatcherError::DuplicateCommitment as u32 + 1)
    );
    assert_eq!(config_data, config_before);
    assert_eq!(commitments_data, commitments_before);
}

#[test]
fn initialize_deposit_and_failed_withdrawal_do_not_mutate_nullifiers() {
    let program_id = Pubkey::new_unique();
    let authority = Pubkey::new_unique();
    let config_key = Pubkey::new_unique();
    let commitments_key = Pubkey::new_unique();
    let nullifiers_key = Pubkey::new_unique();
    let treasury = Pubkey::new_unique();
    let mut authority_lamports = 1;
    let mut config_lamports = 1;
    let mut commitments_lamports = 1;
    let mut nullifiers_lamports = 1;
    let mut authority_data = [];
    let mut config_data = vec![0u8; CONFIG_ACCOUNT_LEN];
    let mut commitments_data = vec![0u8; 5 + 32 * 8];
    let mut nullifiers_data = vec![0u8; 5 + 32 * 8];

    {
        let accounts = vec![
            program_account(
                &authority,
                &program_id,
                &mut authority_lamports,
                &mut authority_data,
                true,
            ),
            program_account(
                &config_key,
                &program_id,
                &mut config_lamports,
                &mut config_data,
                true,
            ),
            program_account(
                &commitments_key,
                &program_id,
                &mut commitments_lamports,
                &mut commitments_data,
                true,
            ),
            program_account(
                &nullifiers_key,
                &program_id,
                &mut nullifiers_lamports,
                &mut nullifiers_data,
                true,
            ),
        ];
        process_instruction(&program_id, &accounts, &init_data(&treasury)).unwrap();
    }

    assert_eq!(config_data[0], STATE_VERSION);
    assert_eq!(commitments_data[0], STATE_VERSION);
    assert_eq!(nullifiers_data[0], STATE_VERSION);

    {
        let accounts = vec![
            program_account(
                &config_key,
                &program_id,
                &mut config_lamports,
                &mut config_data,
                true,
            ),
            program_account(
                &commitments_key,
                &program_id,
                &mut commitments_lamports,
                &mut commitments_data,
                true,
            ),
        ];
        process_instruction(&program_id, &accounts, &deposit_data([7u8; 32], 10_000)).unwrap();
    }

    assert!(contains_32(&commitments_data, &[7u8; 32]).unwrap());
    assert_eq!(
        ConfigAccount::unpack(&config_data).unwrap().merkle_root,
        commitment_root(&commitments_data).unwrap()
    );

    let nullifiers_before = nullifiers_data.clone();
    let commitments_before = commitments_data.clone();
    let root_before = ConfigAccount::unpack(&config_data).unwrap().merkle_root;
    let recipient = Pubkey::new_unique();

    let error = {
        let accounts = vec![
            program_account(
                &config_key,
                &program_id,
                &mut config_lamports,
                &mut config_data,
                true,
            ),
            program_account(
                &commitments_key,
                &program_id,
                &mut commitments_lamports,
                &mut commitments_data,
                true,
            ),
            program_account(
                &nullifiers_key,
                &program_id,
                &mut nullifiers_lamports,
                &mut nullifiers_data,
                true,
            ),
        ];
        process_instruction(
            &program_id,
            &accounts,
            &withdraw_data([11u8; 32], [12u8; 32], [22u8; 32], &recipient),
        )
        .unwrap_err()
    };

    assert_eq!(
        error,
        ProgramError::Custom(WatcherError::InvalidPublicInputs as u32 + 1)
    );
    assert_eq!(
        nullifiers_data, nullifiers_before,
        "failed proof must not burn nullifiers"
    );
    assert_eq!(
        commitments_data, commitments_before,
        "failed proof must not append change commitment"
    );
    assert_eq!(
        ConfigAccount::unpack(&config_data).unwrap().merkle_root,
        root_before,
        "failed proof must not change the trusted root"
    );
}

#[test]
fn initialize_requires_authority_signature() {
    let program_id = Pubkey::new_unique();
    let authority = Pubkey::new_unique();
    let config_key = Pubkey::new_unique();
    let commitments_key = Pubkey::new_unique();
    let nullifiers_key = Pubkey::new_unique();
    let treasury = Pubkey::new_unique();
    let mut authority_lamports = 1;
    let mut config_lamports = 1;
    let mut commitments_lamports = 1;
    let mut nullifiers_lamports = 1;
    let mut authority_data = [];
    let mut config_data = vec![0u8; CONFIG_ACCOUNT_LEN];
    let mut commitments_data = vec![0u8; 69];
    let mut nullifiers_data = vec![0u8; 69];

    let accounts = vec![
        program_account(
            &authority,
            &program_id,
            &mut authority_lamports,
            &mut authority_data,
            false,
        ),
        program_account(
            &config_key,
            &program_id,
            &mut config_lamports,
            &mut config_data,
            true,
        ),
        program_account(
            &commitments_key,
            &program_id,
            &mut commitments_lamports,
            &mut commitments_data,
            true,
        ),
        program_account(
            &nullifiers_key,
            &program_id,
            &mut nullifiers_lamports,
            &mut nullifiers_data,
            true,
        ),
    ];

    assert_eq!(
        process_instruction(&program_id, &accounts, &init_data(&treasury)),
        Err(ProgramError::MissingRequiredSignature)
    );
}
