use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvar::{rent::Rent, Sysvar},
};
use solana_system_interface::{instruction as system_instruction, program as system_program};

use crate::{
    codec::{
        append_unique_32, contains_32, ConfigAccount, VaultAccount, WatcherInstruction,
        CONFIG_ACCOUNT_LEN, REGISTRY_HEADER_LEN, VAULT_ACCOUNT_LEN,
    },
    public_inputs::{
        sol_asset_id_field_v1, withdraw_context_binding_v1, CircuitV1PublicInputs,
        DepositV1PublicInputs,
    },
    root_history::{
        initialize_root_history, latest_root, push_root, require_recent_root,
        ROOT_HISTORY_ACCOUNT_LEN,
    },
    verifier::{verify_circuit_v1, verify_deposit_v1},
    DepositRecord, WatcherError, WithdrawalStatement, SOL_ASSET_ID_V1, STATE_VERSION,
};

pub const VAULT_SEED_V1: &[u8] = b"watcher-vault-v1";
const MERKLE_DEPTH_V1: usize = 4;
const MERKLE_LEAVES_V1: usize = 1 << MERKLE_DEPTH_V1;
pub const COMMITMENT_REGISTRY_ACCOUNT_LEN: usize =
    REGISTRY_HEADER_LEN + MERKLE_LEAVES_V1 * 32 + MERKLE_DEPTH_V1 * 32;
pub fn vault_address_v1(program_id: &Pubkey, config: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[VAULT_SEED_V1, config.as_ref()], program_id)
}

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    match WatcherInstruction::unpack(data)? {
        WatcherInstruction::Initialize { treasury } => initialize(program_id, accounts, treasury),
        WatcherInstruction::Deposit {
            commitment,
            amount,
            proof,
            public_inputs,
        } => deposit(
            program_id,
            accounts,
            commitment,
            amount,
            &proof,
            &public_inputs,
        ),
        WatcherInstruction::Withdraw {
            nullifier_0,
            nullifier_1,
            change_commitment,
            recipient,
            public_amount,
            protocol_fee,
            relayer_fee,
            proof,
            public_inputs,
        } => withdraw(
            program_id,
            accounts,
            WithdrawalStatement {
                nullifier_0,
                nullifier_1,
                change_commitment,
                recipient,
                public_amount,
                protocol_fee,
                relayer_fee,
            },
            &proof,
            &public_inputs,
        ),
        WatcherInstruction::SetMerkleRoot { root: _ } => {
            Err(WatcherError::ManualMerkleRootDisabled.into())
        }
    }
}

fn owned_by(account: &AccountInfo, program_id: &Pubkey) -> Result<(), ProgramError> {
    if account.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    Ok(())
}

fn require_writable(account: &AccountInfo) -> Result<(), ProgramError> {
    if !account.is_writable {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(())
}

fn require_distinct(accounts: &[&AccountInfo]) -> Result<(), ProgramError> {
    for left in 0..accounts.len() {
        for right in (left + 1)..accounts.len() {
            if accounts[left].key == accounts[right].key {
                return Err(WatcherError::InvalidAccountData.into());
            }
        }
    }
    Ok(())
}

fn require_uninitialized(account: &AccountInfo, minimum_len: usize) -> Result<usize, ProgramError> {
    let data = account.try_borrow_data()?;
    if data.len() < minimum_len {
        return Err(WatcherError::InvalidAccountData.into());
    }
    if data[0] != 0 {
        return Err(WatcherError::AlreadyInitialized.into());
    }
    Ok(data.len())
}

fn replace_account_data(account: &AccountInfo, replacement: &[u8]) -> ProgramResult {
    require_writable(account)?;
    let mut data = account.try_borrow_mut_data()?;
    if data.len() != replacement.len() {
        return Err(WatcherError::InvalidAccountData.into());
    }
    data.copy_from_slice(replacement);
    Ok(())
}

fn set_lamports(account: &AccountInfo, value: u64) -> ProgramResult {
    let mut lamports = account.try_borrow_mut_lamports()?;
    **lamports = value;
    Ok(())
}

fn initialize_registry(data: &mut [u8]) -> Result<(), WatcherError> {
    if data.len() < REGISTRY_HEADER_LEN {
        return Err(WatcherError::InvalidAccountData);
    }
    data.fill(0);
    data[0] = STATE_VERSION;
    Ok(())
}

fn require_system_program(account: &AccountInfo) -> Result<(), ProgramError> {
    if account.key != &system_program::ID {
        return Err(WatcherError::InvalidSystemProgram.into());
    }
    Ok(())
}

fn rent_reserve_v1() -> Result<u64, ProgramError> {
    Ok(Rent::get()?.minimum_balance(VAULT_ACCOUNT_LEN))
}

fn validate_vault_state(
    program_id: &Pubkey,
    config_key: &Pubkey,
    vault: &AccountInfo,
) -> Result<VaultAccount, ProgramError> {
    let (expected_vault, expected_bump) = vault_address_v1(program_id, config_key);
    if vault.key != &expected_vault {
        return Err(WatcherError::InvalidVaultAddress.into());
    }
    owned_by(vault, program_id)?;
    let state = VaultAccount::unpack(&vault.try_borrow_data()?)?;
    if state.config != *config_key
        || state.bump != expected_bump
        || state.asset_id != SOL_ASSET_ID_V1
    {
        return Err(WatcherError::InvalidVaultState.into());
    }
    Ok(state)
}

fn validate_vault_balance(
    vault: &AccountInfo,
    state: &VaultAccount,
    rent_reserve: u64,
) -> Result<(), ProgramError> {
    let required = rent_reserve
        .checked_add(state.tracked_balance)
        .ok_or(WatcherError::ArithmeticOverflow)?;
    if vault.lamports() < required {
        return Err(WatcherError::VaultBalanceInvariant.into());
    }
    Ok(())
}

fn initialize(program_id: &Pubkey, accounts: &[AccountInfo], treasury: Pubkey) -> ProgramResult {
    let mut iterator = accounts.iter();
    let authority = next_account_info(&mut iterator)?;
    let config = next_account_info(&mut iterator)?;
    let commitments = next_account_info(&mut iterator)?;
    let nullifiers = next_account_info(&mut iterator)?;
    let root_history = next_account_info(&mut iterator)?;
    let vault = next_account_info(&mut iterator)?;
    let system_program_account = next_account_info(&mut iterator)?;

    if !authority.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    require_system_program(system_program_account)?;
    require_distinct(&[
        authority,
        config,
        commitments,
        nullifiers,
        root_history,
        vault,
    ])?;
    for account in [config, commitments, nullifiers, root_history] {
        owned_by(account, program_id)?;
        require_writable(account)?;
    }
    require_writable(authority)?;
    require_writable(vault)?;

    let config_len = require_uninitialized(config, CONFIG_ACCOUNT_LEN)?;
    let commitments_len = require_uninitialized(commitments, COMMITMENT_REGISTRY_ACCOUNT_LEN)?;
    let nullifiers_len = require_uninitialized(nullifiers, REGISTRY_HEADER_LEN)?;
    let root_history_len = require_uninitialized(root_history, ROOT_HISTORY_ACCOUNT_LEN)?;

    let (expected_vault, bump) = vault_address_v1(program_id, config.key);
    if vault.key != &expected_vault {
        return Err(WatcherError::InvalidVaultAddress.into());
    }

    let rent_reserve = rent_reserve_v1()?;
    if vault.owner == program_id {
        require_uninitialized(vault, VAULT_ACCOUNT_LEN)?;
        if vault.lamports() < rent_reserve {
            return Err(WatcherError::VaultBalanceInvariant.into());
        }
    } else if *vault.owner == system_program::ID && vault.data_is_empty() && vault.lamports() == 0
    {
        let bump_seed = [bump];
        let signer_seeds: &[&[u8]] = &[VAULT_SEED_V1, config.key.as_ref(), &bump_seed];
        invoke_signed(
            &system_instruction::create_account(
                authority.key,
                vault.key,
                rent_reserve,
                VAULT_ACCOUNT_LEN as u64,
                program_id,
            ),
            &[
                authority.clone(),
                vault.clone(),
                system_program_account.clone(),
            ],
            &[signer_seeds],
        )?;
        owned_by(vault, program_id)?;
        if vault.data_len() < VAULT_ACCOUNT_LEN {
            return Err(WatcherError::InvalidVaultState.into());
        }
    } else {
        return Err(WatcherError::InvalidVaultState.into());
    }

    let config_state = ConfigAccount {
        version: STATE_VERSION,
        authority: *authority.key,
        treasury,
        protocol_fee_lamports: 0,
        relayer_fee_lamports: 0,
    };
    replace_account_data(config, &config_state.pack_to_vec(config_len)?)?;

    let mut commitment_data = commitments.try_borrow_mut_data()?;
    initialize_registry(&mut commitment_data)?;
    drop(commitment_data);

    let mut nullifier_data = nullifiers.try_borrow_mut_data()?;
    initialize_registry(&mut nullifier_data)?;
    drop(nullifier_data);

    let mut root_data = root_history.try_borrow_mut_data()?;
    initialize_root_history(&mut root_data)?;
    drop(root_data);

    let vault_state = VaultAccount {
        version: STATE_VERSION,
        bump,
        asset_id: SOL_ASSET_ID_V1,
        config: *config.key,
        tracked_balance: 0,
    };
    replace_account_data(vault, &vault_state.pack_to_vec(VAULT_ACCOUNT_LEN)?)?;
    validate_vault_balance(vault, &vault_state, rent_reserve)?;
    Ok(())
}

fn deposit(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    commitment: [u8; 32],
    amount: u64,
    proof: &[u8; 256],
    public_inputs: &DepositV1PublicInputs,
) -> ProgramResult {
    let mut iterator = accounts.iter();
    let depositor = next_account_info(&mut iterator)?;
    let config = next_account_info(&mut iterator)?;
    let commitments = next_account_info(&mut iterator)?;
    let root_history = next_account_info(&mut iterator)?;
    let vault = next_account_info(&mut iterator)?;
    let system_program_account = next_account_info(&mut iterator)?;

    if !depositor.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    require_system_program(system_program_account)?;
    require_writable(depositor)?;
    require_writable(commitments)?;
    require_writable(root_history)?;
    require_writable(vault)?;
    require_distinct(&[depositor, config, commitments, root_history, vault])?;
    owned_by(config, program_id)?;
    owned_by(commitments, program_id)?;
    owned_by(root_history, program_id)?;
    let config_state = ConfigAccount::unpack(&config.try_borrow_data()?)?;
    let mut vault_state = validate_vault_state(program_id, config.key, vault)?;
    let rent_reserve = rent_reserve_v1()?;
    validate_vault_balance(vault, &vault_state, rent_reserve)?;

    if amount == 0 {
        return Err(WatcherError::InvalidAmount.into());
    }
    if commitment == [0u8; 32] {
        return Err(WatcherError::InvalidCommitment.into());
    }
    if public_inputs.commitment != commitment
        || public_inputs.amount != amount
        || public_inputs.asset_id != sol_asset_id_field_v1()
        || public_inputs.config_binding != config_state.binding_v1()
    {
        return Err(WatcherError::PublicInputMismatch.into());
    }
    verify_deposit_v1(proof, public_inputs)?;

    invoke(
        &system_instruction::transfer(depositor.key, vault.key, amount),
        &[
            depositor.clone(),
            vault.clone(),
            system_program_account.clone(),
        ],
    )?;

    let mut registry = commitments.try_borrow_mut_data()?;
    append_unique_32(&mut registry, commitment)?;
    let new_root = latest_root(&registry)?;
    drop(registry);
    let mut root_data = root_history.try_borrow_mut_data()?;
    push_root(&mut root_data, new_root)?;
    drop(root_data);

    vault_state.tracked_balance = vault_state
        .tracked_balance
        .checked_add(amount)
        .ok_or(WatcherError::ArithmeticOverflow)?;
    replace_account_data(vault, &vault_state.pack_to_vec(VAULT_ACCOUNT_LEN)?)?;
    validate_vault_balance(vault, &vault_state, rent_reserve)?;
    Ok(())
}

fn withdraw(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    statement: WithdrawalStatement,
    proof: &[u8; 256],
    public_inputs: &CircuitV1PublicInputs,
) -> ProgramResult {
    let mut iterator = accounts.iter();
    let config = next_account_info(&mut iterator)?;
    let commitments = next_account_info(&mut iterator)?;
    let nullifiers = next_account_info(&mut iterator)?;
    let root_history = next_account_info(&mut iterator)?;
    let vault = next_account_info(&mut iterator)?;
    let recipient = next_account_info(&mut iterator)?;
    let relayer = next_account_info(&mut iterator)?;
    let treasury = next_account_info(&mut iterator)?;

    require_writable(commitments)?;
    require_writable(nullifiers)?;
    require_writable(root_history)?;
    require_writable(vault)?;
    require_writable(recipient)?;
    require_writable(relayer)?;
    require_writable(treasury)?;
    require_distinct(&[
        config,
        commitments,
        nullifiers,
        root_history,
        vault,
        recipient,
        relayer,
        treasury,
    ])?;
    owned_by(config, program_id)?;
    owned_by(commitments, program_id)?;
    owned_by(nullifiers, program_id)?;
    owned_by(root_history, program_id)?;

    if statement.public_amount == 0 {
        return Err(WatcherError::InvalidAmount.into());
    }
    if statement.nullifier_0 == [0u8; 32]
        || statement.nullifier_1 == [0u8; 32]
        || statement.nullifier_0 == statement.nullifier_1
    {
        return Err(WatcherError::InvalidNullifier.into());
    }
    if statement.change_commitment == [0u8; 32] {
        return Err(WatcherError::InvalidCommitment.into());
    }
    if statement.recipient != *recipient.key {
        return Err(WatcherError::InvalidRecipient.into());
    }

    let config_state = ConfigAccount::unpack(&config.try_borrow_data()?)?;
    if treasury.key != &config_state.treasury {
        return Err(WatcherError::InvalidTreasury.into());
    }
    let mut vault_state = validate_vault_state(program_id, config.key, vault)?;
    let rent_reserve = rent_reserve_v1()?;
    validate_vault_balance(vault, &vault_state, rent_reserve)?;

    let context_binding = withdraw_context_binding_v1(
        program_id,
        config.key,
        recipient.key,
        relayer.key,
        treasury.key,
    );
    if public_inputs.asset_id != sol_asset_id_field_v1()
        || public_inputs.context_binding != context_binding
        || public_inputs.public_amount != statement.public_amount
        || public_inputs.protocol_fee != statement.protocol_fee
        || public_inputs.relayer_fee != statement.relayer_fee
        || public_inputs.nullifier_0 != statement.nullifier_0
        || public_inputs.nullifier_1 != statement.nullifier_1
        || public_inputs.change_commitment != statement.change_commitment
    {
        return Err(WatcherError::PublicInputMismatch.into());
    }
    if public_inputs.protocol_fee != config_state.protocol_fee_lamports
        || public_inputs.relayer_fee != config_state.relayer_fee_lamports
    {
        return Err(WatcherError::FeeMismatch.into());
    }

    {
        let root_data = root_history.try_borrow_data()?;
        require_recent_root(&root_data, public_inputs.merkle_root)?;
    }
    {
        let nullifier_data = nullifiers.try_borrow_data()?;
        if contains_32(&nullifier_data, statement.nullifier_0)?
            || contains_32(&nullifier_data, statement.nullifier_1)?
        {
            return Err(WatcherError::NullifierAlreadySpent.into());
        }
    }

    verify_circuit_v1(proof, public_inputs)?;

    let total_debit = statement
        .public_amount
        .checked_add(statement.protocol_fee)
        .and_then(|value| value.checked_add(statement.relayer_fee))
        .ok_or(WatcherError::ArithmeticOverflow)?;
    if vault_state.tracked_balance < total_debit {
        return Err(WatcherError::InsufficientVaultBalance.into());
    }

    {
        let mut nullifier_data = nullifiers.try_borrow_mut_data()?;
        append_unique_32(&mut nullifier_data, statement.nullifier_0)?;
        append_unique_32(&mut nullifier_data, statement.nullifier_1)?;
    }
    {
        let mut registry = commitments.try_borrow_mut_data()?;
        append_unique_32(&mut registry, statement.change_commitment)?;
        let new_root = latest_root(&registry)?;
        drop(registry);
        let mut root_data = root_history.try_borrow_mut_data()?;
        push_root(&mut root_data, new_root)?;
    }

    let recipient_lamports = recipient
        .lamports()
        .checked_add(statement.public_amount)
        .ok_or(WatcherError::ArithmeticOverflow)?;
    let relayer_lamports = relayer
        .lamports()
        .checked_add(statement.relayer_fee)
        .ok_or(WatcherError::ArithmeticOverflow)?;
    let treasury_lamports = treasury
        .lamports()
        .checked_add(statement.protocol_fee)
        .ok_or(WatcherError::ArithmeticOverflow)?;
    let vault_lamports = vault
        .lamports()
        .checked_sub(total_debit)
        .ok_or(WatcherError::InsufficientVaultBalance)?;

    set_lamports(vault, vault_lamports)?;
    set_lamports(recipient, recipient_lamports)?;
    set_lamports(relayer, relayer_lamports)?;
    set_lamports(treasury, treasury_lamports)?;

    vault_state.tracked_balance = vault_state
        .tracked_balance
        .checked_sub(total_debit)
        .ok_or(WatcherError::InsufficientVaultBalance)?;
    replace_account_data(vault, &vault_state.pack_to_vec(VAULT_ACCOUNT_LEN)?)?;
    validate_vault_balance(vault, &vault_state, rent_reserve)?;
    Ok(())
}
