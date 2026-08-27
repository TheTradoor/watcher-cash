use solana_program::{pubkey::Pubkey, system_program, sysvar::rent::Rent};
use solana_program_test::{processor, ProgramTest, ProgramTestContext};
use solana_sdk::{
    account::Account,
    instruction::{AccountMeta, Instruction},
    signature::Signer,
    transaction::Transaction,
};
use watcher_protocol_program::{
    codec::{contains_32, ConfigAccount, VaultAccount, CONFIG_ACCOUNT_LEN, VAULT_ACCOUNT_LEN},
    dev_fixture::{
        DEV_DEPOSIT_PROOF_1_BYTES, DEV_DEPOSIT_PROOF_BYTES, DEV_DEPOSIT_PUBLIC_INPUT_1_BYTES,
        DEV_DEPOSIT_PUBLIC_INPUT_BYTES, DEV_PROOF_BYTES, DEV_PUBLIC_INPUT_BYTES,
    },
    process_instruction,
    processor::vault_address_v1,
    public_inputs::{CircuitV1PublicInputs, DepositV1PublicInputs},
    root_history::{root_history_contains, ROOT_HISTORY_ACCOUNT_LEN},
    WatcherError, WithdrawalStatement,
};

fn fixed_key(value: u8) -> Pubkey {
    Pubkey::new_from_array([value; 32])
}

fn program_owned_account(program_id: Pubkey, data_len: usize, rent: &Rent) -> Account {
    Account {
        lamports: rent.minimum_balance(data_len),
        data: vec![0u8; data_len],
        owner: program_id,
        executable: false,
        rent_epoch: 0,
    }
}

fn system_account(rent: &Rent) -> Account {
    Account {
        lamports: rent.minimum_balance(0),
        data: Vec::new(),
        owner: system_program::id(),
        executable: false,
        rent_epoch: 0,
    }
}

fn initialize_data(treasury: &Pubkey) -> Vec<u8> {
    let mut data = vec![0u8];
    data.extend_from_slice(treasury.as_ref());
    data
}

fn deposit_data(commitment: [u8; 32], amount: u64, proof: &[u8], public_inputs: &[u8]) -> Vec<u8> {
    let mut data = vec![1u8];
    data.extend_from_slice(&commitment);
    data.extend_from_slice(&amount.to_le_bytes());
    data.extend_from_slice(&(proof.len() as u16).to_le_bytes());
    data.extend_from_slice(proof);
    data.extend_from_slice(&(public_inputs.len() as u16).to_le_bytes());
    data.extend_from_slice(public_inputs);
    data
}

fn withdraw_data(statement: &WithdrawalStatement, proof: &[u8], public_inputs: &[u8]) -> Vec<u8> {
    let mut data = vec![2u8];
    data.extend_from_slice(&statement.nullifier_0);
    data.extend_from_slice(&statement.nullifier_1);
    data.extend_from_slice(&statement.change_commitment);
    data.extend_from_slice(statement.recipient.as_ref());
    data.extend_from_slice(&statement.public_amount.to_le_bytes());
    data.extend_from_slice(&statement.protocol_fee.to_le_bytes());
    data.extend_from_slice(&statement.relayer_fee.to_le_bytes());
    data.extend_from_slice(&(proof.len() as u16).to_le_bytes());
    data.extend_from_slice(proof);
    data.extend_from_slice(&(public_inputs.len() as u16).to_le_bytes());
    data.extend_from_slice(public_inputs);
    data
}

fn field_u64(field: &[u8; 32]) -> u64 {
    u64::from_le_bytes(field[..8].try_into().unwrap())
}

async fn send(context: &mut ProgramTestContext, instruction: Instruction) {
    let blockhash = context.banks_client.get_latest_blockhash().await.unwrap();
    let transaction = Transaction::new_signed_with_payer(
        &[instruction],
        Some(&context.payer.pubkey()),
        &[&context.payer],
        blockhash,
    );
    context
        .banks_client
        .process_transaction(transaction)
        .await
        .unwrap();
}

async fn send_failing(
    context: &mut ProgramTestContext,
    instruction: Instruction,
) -> solana_program_test::BanksClientError {
    let blockhash = context.banks_client.get_latest_blockhash().await.unwrap();
    let transaction = Transaction::new_signed_with_payer(
        &[instruction],
        Some(&context.payer.pubkey()),
        &[&context.payer],
        blockhash,
    );
    context
        .banks_client
        .process_transaction(transaction)
        .await
        .unwrap_err()
}

async fn account_lamports(context: &mut ProgramTestContext, key: Pubkey) -> u64 {
    context
        .banks_client
        .get_account(key)
        .await
        .unwrap()
        .unwrap()
        .lamports
}

#[tokio::test]
async fn funded_deposits_and_verified_withdrawal_move_real_lamports() {
    let program_id = fixed_key(42);
    let config = fixed_key(43);
    let relayer = fixed_key(44);
    let treasury = fixed_key(45);
    let recipient = fixed_key(7);
    let commitments = Pubkey::new_unique();
    let nullifiers = Pubkey::new_unique();
    let root_history = Pubkey::new_unique();
    let (vault, bump) = vault_address_v1(&program_id, &config);
    assert_eq!(bump, 255);

    let rent = Rent::default();
    let mut test = ProgramTest::new(
        "watcher_protocol_program",
        program_id,
        processor!(process_instruction),
    );
    test.add_account(
        config,
        program_owned_account(program_id, CONFIG_ACCOUNT_LEN, &rent),
    );
    test.add_account(
        commitments,
        program_owned_account(program_id, 5 + 32 * 16 + 32 * 4, &rent),
    );
    test.add_account(
        nullifiers,
        program_owned_account(program_id, 5 + 32 * 64, &rent),
    );
    test.add_account(
        root_history,
        program_owned_account(program_id, ROOT_HISTORY_ACCOUNT_LEN, &rent),
    );
    for key in [recipient, relayer, treasury] {
        test.add_account(key, system_account(&rent));
    }

    let mut context = test.start_with_context().await;
    let initialize = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(context.payer.pubkey(), true),
            AccountMeta::new(config, false),
            AccountMeta::new(commitments, false),
            AccountMeta::new(nullifiers, false),
            AccountMeta::new(root_history, false),
            AccountMeta::new(vault, false),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        data: initialize_data(&treasury),
    };
    send(&mut context, initialize).await;

    let vault_account = context
        .banks_client
        .get_account(vault)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(vault_account.owner, program_id);
    assert_eq!(vault_account.data.len(), VAULT_ACCOUNT_LEN);
    let initial_vault = VaultAccount::unpack(&vault_account.data).unwrap();
    assert_eq!(initial_vault.config, config);
    assert_eq!(initial_vault.bump, bump);
    assert_eq!(initial_vault.tracked_balance, 0);

    let deposit_fixtures = [
        (
            &DEV_DEPOSIT_PROOF_BYTES[..],
            &DEV_DEPOSIT_PUBLIC_INPUT_BYTES[..],
        ),
        (
            &DEV_DEPOSIT_PROOF_1_BYTES[..],
            &DEV_DEPOSIT_PUBLIC_INPUT_1_BYTES[..],
        ),
    ];
    for (proof, public_inputs) in deposit_fixtures {
        let inputs = DepositV1PublicInputs::decode(public_inputs).unwrap();
        let deposit = Instruction {
            program_id,
            accounts: vec![
                AccountMeta::new(context.payer.pubkey(), true),
                AccountMeta::new(config, false),
                AccountMeta::new(commitments, false),
                AccountMeta::new(root_history, false),
                AccountMeta::new(vault, false),
                AccountMeta::new_readonly(system_program::id(), false),
            ],
            data: deposit_data(
                inputs.commitment,
                field_u64(&inputs.amount),
                proof,
                public_inputs,
            ),
        };
        send(&mut context, deposit).await;
    }

    let withdrawal_inputs = CircuitV1PublicInputs::decode(&DEV_PUBLIC_INPUT_BYTES).unwrap();
    let config_account = context
        .banks_client
        .get_account(config)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        ConfigAccount::unpack(&config_account.data)
            .unwrap()
            .merkle_root,
        withdrawal_inputs.merkle_root,
        "the verifier fixture must be reachable from the two append-only deposits"
    );

    let vault_before_withdrawal = context
        .banks_client
        .get_account(vault)
        .await
        .unwrap()
        .unwrap();
    let vault_state_before = VaultAccount::unpack(&vault_before_withdrawal.data).unwrap();
    assert_eq!(vault_state_before.tracked_balance, 11_000_000);
    assert_eq!(
        vault_before_withdrawal.lamports,
        rent.minimum_balance(VAULT_ACCOUNT_LEN) + 11_000_000
    );

    let recipient_before = account_lamports(&mut context, recipient).await;
    let relayer_before = account_lamports(&mut context, relayer).await;
    let treasury_before = account_lamports(&mut context, treasury).await;
    let statement = WithdrawalStatement {
        nullifier_0: withdrawal_inputs.nullifier_0,
        nullifier_1: withdrawal_inputs.nullifier_1,
        change_commitment: withdrawal_inputs.change_commitment,
        recipient,
        public_amount: field_u64(&withdrawal_inputs.public_amount),
        protocol_fee: field_u64(&withdrawal_inputs.protocol_fee),
        relayer_fee: field_u64(&withdrawal_inputs.relayer_fee),
    };
    let withdrawal = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(config, false),
            AccountMeta::new(commitments, false),
            AccountMeta::new(nullifiers, false),
            AccountMeta::new(root_history, false),
            AccountMeta::new(vault, false),
            AccountMeta::new(recipient, false),
            AccountMeta::new(relayer, false),
            AccountMeta::new(treasury, false),
        ],
        data: withdraw_data(&statement, &DEV_PROOF_BYTES, &DEV_PUBLIC_INPUT_BYTES),
    };
    send(&mut context, withdrawal.clone()).await;

    assert_eq!(
        account_lamports(&mut context, recipient).await,
        recipient_before + statement.public_amount
    );
    assert_eq!(
        account_lamports(&mut context, relayer).await,
        relayer_before + statement.relayer_fee
    );
    assert_eq!(
        account_lamports(&mut context, treasury).await,
        treasury_before + statement.protocol_fee
    );

    let vault_after_withdrawal = context
        .banks_client
        .get_account(vault)
        .await
        .unwrap()
        .unwrap();
    let vault_state_after = VaultAccount::unpack(&vault_after_withdrawal.data).unwrap();
    assert_eq!(vault_state_after.tracked_balance, 6_000_000);
    assert_eq!(
        vault_after_withdrawal.lamports,
        rent.minimum_balance(VAULT_ACCOUNT_LEN) + 6_000_000
    );

    let nullifier_account = context
        .banks_client
        .get_account(nullifiers)
        .await
        .unwrap()
        .unwrap();
    assert!(contains_32(&nullifier_account.data, &statement.nullifier_0).unwrap());
    assert!(contains_32(&nullifier_account.data, &statement.nullifier_1).unwrap());
    let root_history_account = context
        .banks_client
        .get_account(root_history)
        .await
        .unwrap()
        .unwrap();
    assert!(
        root_history_contains(&root_history_account.data, &withdrawal_inputs.merkle_root).unwrap()
    );

    let balances_before_replay = (
        account_lamports(&mut context, vault).await,
        account_lamports(&mut context, recipient).await,
        account_lamports(&mut context, relayer).await,
    );
    let replay_error = send_failing(&mut context, withdrawal).await;
    let replay_message = replay_error.to_string();
    let expected_error = format!(
        "custom program error: 0x{:x}",
        WatcherError::NullifierAlreadySpent as u32 + 1
    );
    assert!(
        replay_message.contains(&expected_error),
        "unexpected replay error: {replay_message}"
    );
    assert_eq!(
        (
            account_lamports(&mut context, vault).await,
            account_lamports(&mut context, recipient).await,
            account_lamports(&mut context, relayer).await,
        ),
        balances_before_replay
    );
}
