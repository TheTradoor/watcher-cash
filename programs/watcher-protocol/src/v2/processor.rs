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
    codec::{ConfigAccount, VaultAccount, CONFIG_ACCOUNT_LEN, VAULT_ACCOUNT_LEN},
    WatcherError, SOL_ASSET_ID_V1,
};

use super::{
    codec::{
        DepositStatementV2, WithdrawalStatementV2, DEPOSIT_INSTRUCTION_BYTES_V2, DEPOSIT_TAG_V2,
        WITHDRAW_INSTRUCTION_BYTES_V2, WITHDRAW_TAG_V2,
    },
    nullifier::{validate_nullifier_marker_v2, NULLIFIER_MARKER_SEED_V2, NULLIFIER_MARKER_SPACE_V2},
    public_inputs::{
        deposit_context_binding_v2, sol_asset_id_field_v2, withdraw_context_binding_v2,
        DepositPublicInputsV2, WithdrawPublicInputsV2,
    },
    state::{validate_spend_roots_v2, ActiveTreeV2, SealedRootV2, ACTIVE_TREE_ACCOUNT_LEN_V2},
    verifier::{verify_deposit_v2, verify_withdraw_v2},
    GROTH16_PROOF_BYTES_V2, MAX_INPUTS_V2,
};

pub const INITIALIZE_TAG_V2: u8 = 0x22;
pub const VAULT_SEED_V2: &[u8] = b"watcher-vault-v2";

pub fn vault_address_v2(program_id: &Pubkey, config: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[VAULT_SEED_V2, config.as_ref()], program_id)
}

fn owned_by(account: &AccountInfo, program_id: &Pubkey) -> Result<(), ProgramError> {
    if account.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    Ok(())
}

fn writable(account: &AccountInfo) -> Result<(), ProgramError> {
    if !account.is_writable {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(())
}

fn require_system(account: &AccountInfo) -> Result<(), ProgramError> {
    if account.key != &system_program::id() {
        return Err(WatcherError::InvalidSystemProgram.into());
    }
    Ok(())
}

fn replace_data(account: &AccountInfo, value: &[u8]) -> ProgramResult {
    writable(account)?;
    let mut data = account.try_borrow_mut_data()?;
    if data.len() != value.len() {
        return Err(WatcherError::InvalidAccountData.into());
    }
    data.copy_from_slice(value);
    Ok(())
}

fn set_lamports(account: &AccountInfo, value: u64) -> ProgramResult {
    let mut lamports = account.try_borrow_mut_lamports()?;
    **lamports = value;
    Ok(())
}

fn add_lamports(account: &AccountInfo, value: u64) -> ProgramResult {
    if value == 0 {
        return Ok(());
    }
    let next = account
        .lamports()
        .checked_add(value)
        .ok_or(WatcherError::ArithmeticOverflow)?;
    set_lamports(account, next)
}

fn vault_state_v2(
    program_id: &Pubkey,
    config: &Pubkey,
    vault: &AccountInfo,
) -> Result<VaultAccount, ProgramError> {
    let (expected, bump) = vault_address_v2(program_id, config);
    if vault.key != &expected {
        return Err(WatcherError::InvalidVaultAddress.into());
    }
    owned_by(vault, program_id)?;
    let state = VaultAccount::unpack(&vault.try_borrow_data()?)?;
    if state.config != *config || state.bump != bump || state.asset_id != SOL_ASSET_ID_V1 {
        return Err(WatcherError::InvalidVaultState.into());
    }
    Ok(state)
}

fn validate_vault_liability(vault: &AccountInfo, state: &VaultAccount) -> Result<u64, ProgramError> {
    let reserve = Rent::get()?.minimum_balance(VAULT_ACCOUNT_LEN);
    let required = reserve
        .checked_add(state.tracked_balance)
        .ok_or(WatcherError::ArithmeticOverflow)?;
    if vault.lamports() < required {
        return Err(WatcherError::VaultBalanceInvariant.into());
    }
    Ok(reserve)
}

#[inline(never)]
fn initialize_v2(program_id: &Pubkey, accounts: &[AccountInfo], treasury: Pubkey) -> ProgramResult {
    let mut iterator = accounts.iter();
    let authority = next_account_info(&mut iterator)?;
    let config = next_account_info(&mut iterator)?;
    let active_tree = next_account_info(&mut iterator)?;
    let vault = next_account_info(&mut iterator)?;
    let system = next_account_info(&mut iterator)?;
    if iterator.next().is_some() {
        return Err(WatcherError::InvalidInstruction.into());
    }
    if !authority.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    writable(authority)?;
    writable(config)?;
    writable(active_tree)?;
    writable(vault)?;
    require_system(system)?;
    owned_by(config, program_id)?;
    owned_by(active_tree, program_id)?;
    if config.data_len() != CONFIG_ACCOUNT_LEN || active_tree.data_len() != ACTIVE_TREE_ACCOUNT_LEN_V2 {
        return Err(WatcherError::InvalidAccountData.into());
    }
    if config.try_borrow_data()?.iter().any(|byte| *byte != 0)
        || active_tree.try_borrow_data()?.iter().any(|byte| *byte != 0)
    {
        return Err(WatcherError::AlreadyInitialized.into());
    }

    let (expected_vault, bump) = vault_address_v2(program_id, config.key);
    if vault.key != &expected_vault {
        return Err(WatcherError::InvalidVaultAddress.into());
    }
    let reserve = Rent::get()?.minimum_balance(VAULT_ACCOUNT_LEN);
    if vault.owner == program_id {
        if vault.data_len() != VAULT_ACCOUNT_LEN || vault.try_borrow_data()?.iter().any(|byte| *byte != 0) {
            return Err(WatcherError::AlreadyInitialized.into());
        }
        if vault.lamports() < reserve {
            return Err(WatcherError::VaultBalanceInvariant.into());
        }
    } else if *vault.owner == system_program::id() && vault.data_is_empty() && vault.lamports() == 0 {
        let bump_seed = [bump];
        let signer_seeds: &[&[u8]] = &[VAULT_SEED_V2, config.key.as_ref(), &bump_seed];
        invoke_signed(
            &system_instruction::create_account(
                authority.key,
                vault.key,
                reserve,
                VAULT_ACCOUNT_LEN as u64,
                program_id,
            ),
            &[authority.clone(), vault.clone(), system.clone()],
            &[signer_seeds],
        )?;
    } else {
        return Err(WatcherError::InvalidVaultState.into());
    }

    let mut config_data = vec![0u8; CONFIG_ACCOUNT_LEN];
    ConfigAccount {
        authority: *authority.key,
        treasury,
        fees_enabled: false,
        protocol_fee_bps: 0,
        merkle_root: [0u8; 32],
    }
    .pack(&mut config_data)?;
    let mut active_data = vec![0u8; ACTIVE_TREE_ACCOUNT_LEN_V2];
    ActiveTreeV2::new(*config.key).pack(&mut active_data)?;
    let mut vault_data = vec![0u8; VAULT_ACCOUNT_LEN];
    VaultAccount {
        config: *config.key,
        bump,
        asset_id: SOL_ASSET_ID_V1,
        tracked_balance: 0,
    }
    .pack(&mut vault_data)?;

    replace_data(config, &config_data)?;
    replace_data(active_tree, &active_data)?;
    replace_data(vault, &vault_data)
}

#[inline(never)]
fn deposit_v2(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    statement: DepositStatementV2,
    proof: &[u8],
) -> ProgramResult {
    statement.validate()?;
    let mut iterator = accounts.iter();
    let depositor = next_account_info(&mut iterator)?;
    let config = next_account_info(&mut iterator)?;
    let active_tree = next_account_info(&mut iterator)?;
    let vault = next_account_info(&mut iterator)?;
    let system = next_account_info(&mut iterator)?;
    if iterator.next().is_some() {
        return Err(WatcherError::InvalidInstruction.into());
    }
    if !depositor.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    writable(depositor)?;
    writable(active_tree)?;
    writable(vault)?;
    require_system(system)?;
    owned_by(config, program_id)?;
    owned_by(active_tree, program_id)?;

    let config_state = ConfigAccount::unpack(&config.try_borrow_data()?)?;
    if config_state.fees_enabled || config_state.protocol_fee_bps != 0 {
        return Err(WatcherError::FeesDisabledDuringDevelopment.into());
    }
    let mut tree = ActiveTreeV2::unpack(&active_tree.try_borrow_data()?)?;
    if tree.config != *config.key || tree.is_full() {
        return Err(WatcherError::MerkleTreeFull.into());
    }
    let mut vault_state = vault_state_v2(program_id, config.key, vault)?;
    let reserve = validate_vault_liability(vault, &vault_state)?;
    let asset = sol_asset_id_field_v2();
    let context = deposit_context_binding_v2(program_id, config.key, vault.key, active_tree.key, &asset);
    let public_inputs = DepositPublicInputsV2::from_statement(
        &statement,
        tree.epoch,
        tree.current_root,
        tree.next_index,
        asset,
        context,
    )?;
    verify_deposit_v2(&public_inputs, proof)?;

    let old_root = tree.current_root;
    let leaf_index = tree.next_index;
    tree.apply_verified_append(old_root, statement.new_root, leaf_index)?;
    vault_state.tracked_balance = vault_state
        .tracked_balance
        .checked_add(statement.amount)
        .ok_or(WatcherError::ArithmeticOverflow)?;
    let minimum_after = reserve
        .checked_add(vault_state.tracked_balance)
        .ok_or(WatcherError::ArithmeticOverflow)?;

    invoke(
        &system_instruction::transfer(depositor.key, vault.key, statement.amount),
        &[depositor.clone(), vault.clone(), system.clone()],
    )?;
    if vault.lamports() < minimum_after {
        return Err(WatcherError::VaultBalanceInvariant.into());
    }

    let mut tree_data = vec![0u8; ACTIVE_TREE_ACCOUNT_LEN_V2];
    tree.pack(&mut tree_data)?;
    let mut vault_data = vec![0u8; VAULT_ACCOUNT_LEN];
    vault_state.pack(&mut vault_data)?;
    replace_data(active_tree, &tree_data)?;
    replace_data(vault, &vault_data)
}

fn create_nullifier_marker_v2<'a>(
    program_id: &Pubkey,
    config: &Pubkey,
    nullifier: &[u8; 32],
    marker: &AccountInfo<'a>,
    payer: &AccountInfo<'a>,
    system: &AccountInfo<'a>,
) -> ProgramResult {
    let bump = validate_nullifier_marker_v2(program_id, config, nullifier, marker.key)?;
    if marker.lamports() != 0 || *marker.owner != system_program::id() || !marker.data_is_empty() {
        return Err(WatcherError::NullifierAlreadySpent.into());
    }
    writable(marker)?;
    let rent = Rent::get()?.minimum_balance(NULLIFIER_MARKER_SPACE_V2);
    let bump_seed = [bump];
    let seeds: &[&[u8]] = &[NULLIFIER_MARKER_SEED_V2, config.as_ref(), nullifier, &bump_seed];
    invoke_signed(
        &system_instruction::create_account(
            payer.key,
            marker.key,
            rent,
            NULLIFIER_MARKER_SPACE_V2 as u64,
            program_id,
        ),
        &[payer.clone(), marker.clone(), system.clone()],
        &[seeds],
    )
}

#[inline(never)]
fn withdraw_v2(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    statement: WithdrawalStatementV2,
    proof: &[u8],
) -> ProgramResult {
    statement.validate_development()?;
    let mut iterator = accounts.iter();
    let config = next_account_info(&mut iterator)?;
    let active_tree = next_account_info(&mut iterator)?;
    let vault = next_account_info(&mut iterator)?;
    let recipient = next_account_info(&mut iterator)?;
    let relayer = next_account_info(&mut iterator)?;
    let treasury = next_account_info(&mut iterator)?;
    let system = next_account_info(&mut iterator)?;

    if !relayer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if recipient.key != &statement.recipient {
        return Err(WatcherError::InvalidPayoutAccount.into());
    }
    for account in [active_tree, vault, recipient, relayer, treasury] {
        writable(account)?;
    }
    require_system(system)?;
    owned_by(config, program_id)?;
    owned_by(active_tree, program_id)?;

    let config_state = ConfigAccount::unpack(&config.try_borrow_data()?)?;
    if config_state.fees_enabled || config_state.protocol_fee_bps != 0 {
        return Err(WatcherError::FeesDisabledDuringDevelopment.into());
    }
    if treasury.key != &config_state.treasury {
        return Err(WatcherError::InvalidPayoutAccount.into());
    }
    if vault.key == recipient.key || vault.key == relayer.key || vault.key == treasury.key {
        return Err(WatcherError::InvalidPayoutAccount.into());
    }

    let mut tree = ActiveTreeV2::unpack(&active_tree.try_borrow_data()?)?;
    if tree.config != *config.key {
        return Err(WatcherError::InvalidAccountData.into());
    }
    let mut vault_state = vault_state_v2(program_id, config.key, vault)?;
    let reserve = validate_vault_liability(vault, &vault_state)?;

    let input_count = statement.input_count as usize;
    let mut marker_accounts: Vec<&AccountInfo> = Vec::with_capacity(input_count);
    for index in 0..input_count {
        let marker = next_account_info(&mut iterator)?;
        validate_nullifier_marker_v2(program_id, config.key, &statement.nullifiers[index], marker.key)?;
        if marker.lamports() != 0 || *marker.owner != system_program::id() || !marker.data_is_empty() {
            return Err(WatcherError::NullifierAlreadySpent.into());
        }
        marker_accounts.push(marker);
    }

    let mut sealed_roots = Vec::new();
    for account in iterator {
        owned_by(account, program_id)?;
        sealed_roots.push(SealedRootV2::unpack(&account.try_borrow_data()?)?);
    }
    validate_spend_roots_v2(&statement.input_roots, statement.input_count, &tree, &sealed_roots)?;

    let asset = sol_asset_id_field_v2();
    let context = withdraw_context_binding_v2(
        program_id,
        config.key,
        vault.key,
        active_tree.key,
        relayer.key,
        treasury.key,
        &asset,
    );
    let public_inputs = WithdrawPublicInputsV2::from_statement(
        &statement,
        tree.current_root,
        tree.next_index,
        asset,
        context,
    )?;
    verify_withdraw_v2(&public_inputs, proof)?;

    if statement.has_change() {
        let old_root = tree.current_root;
        let leaf_index = tree.next_index;
        tree.apply_verified_append(old_root, statement.new_root, leaf_index)?;
    }

    let payout = statement
        .public_amount
        .checked_add(statement.protocol_fee)
        .and_then(|value| value.checked_add(statement.relayer_fee))
        .ok_or(WatcherError::ArithmeticOverflow)?;
    if vault_state.tracked_balance < payout {
        return Err(WatcherError::InsufficientVaultBalance.into());
    }
    let remaining_liability = vault_state.tracked_balance - payout;
    let minimum_after = reserve
        .checked_add(remaining_liability)
        .ok_or(WatcherError::ArithmeticOverflow)?;
    let vault_after = vault
        .lamports()
        .checked_sub(payout)
        .ok_or(WatcherError::InsufficientVaultBalance)?;
    if vault_after < minimum_after {
        return Err(WatcherError::VaultBalanceInvariant.into());
    }

    for index in 0..input_count {
        create_nullifier_marker_v2(
            program_id,
            config.key,
            &statement.nullifiers[index],
            marker_accounts[index],
            relayer,
            system,
        )?;
    }

    set_lamports(vault, vault_after)?;
    add_lamports(recipient, statement.public_amount)?;
    add_lamports(relayer, statement.relayer_fee)?;
    add_lamports(treasury, statement.protocol_fee)?;
    vault_state.tracked_balance = remaining_liability;

    let mut tree_data = vec![0u8; ACTIVE_TREE_ACCOUNT_LEN_V2];
    tree.pack(&mut tree_data)?;
    let mut vault_data = vec![0u8; VAULT_ACCOUNT_LEN];
    vault_state.pack(&mut vault_data)?;
    replace_data(active_tree, &tree_data)?;
    replace_data(vault, &vault_data)
}

fn read_32(data: &[u8], start: usize) -> Result<[u8; 32], WatcherError> {
    data.get(start..start + 32)
        .and_then(|slice| slice.try_into().ok())
        .ok_or(WatcherError::InvalidInstruction)
}

fn read_u64(data: &[u8], start: usize) -> Result<u64, WatcherError> {
    let bytes: [u8; 8] = data
        .get(start..start + 8)
        .and_then(|slice| slice.try_into().ok())
        .ok_or(WatcherError::InvalidInstruction)?;
    Ok(u64::from_le_bytes(bytes))
}

#[inline(never)]
fn process_deposit_encoded_v2(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if data.len() != DEPOSIT_INSTRUCTION_BYTES_V2 || data.first().copied() != Some(DEPOSIT_TAG_V2) {
        return Err(WatcherError::InvalidInstruction.into());
    }
    let statement = DepositStatementV2 {
        commitment: read_32(data, 1)?,
        amount: read_u64(data, 33)?,
        new_root: read_32(data, 41)?,
    };
    statement.validate()?;
    let proof = data
        .get(73..73 + GROTH16_PROOF_BYTES_V2)
        .ok_or(WatcherError::InvalidInstruction)?;
    deposit_v2(program_id, accounts, statement, proof)
}

#[inline(never)]
fn process_withdraw_encoded_v2(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if data.len() != WITHDRAW_INSTRUCTION_BYTES_V2 || data.first().copied() != Some(WITHDRAW_TAG_V2) {
        return Err(WatcherError::InvalidInstruction.into());
    }
    let input_count = data[1];
    let mut input_roots = [[0u8; 32]; MAX_INPUTS_V2];
    let mut nullifiers = [[0u8; 32]; MAX_INPUTS_V2];
    let mut cursor = 2usize;
    for root in &mut input_roots {
        *root = read_32(data, cursor)?;
        cursor += 32;
    }
    for nullifier in &mut nullifiers {
        *nullifier = read_32(data, cursor)?;
        cursor += 32;
    }
    let change_commitment = read_32(data, cursor)?;
    cursor += 32;
    let recipient = Pubkey::new_from_array(read_32(data, cursor)?);
    cursor += 32;
    let public_amount = read_u64(data, cursor)?;
    cursor += 8;
    let protocol_fee = read_u64(data, cursor)?;
    cursor += 8;
    let relayer_fee = read_u64(data, cursor)?;
    cursor += 8;
    let new_root = read_32(data, cursor)?;
    cursor += 32;
    let statement = WithdrawalStatementV2 {
        input_count,
        input_roots,
        nullifiers,
        change_commitment,
        recipient,
        public_amount,
        protocol_fee,
        relayer_fee,
        new_root,
    };
    statement.validate_development()?;
    let proof = data
        .get(cursor..cursor + GROTH16_PROOF_BYTES_V2)
        .ok_or(WatcherError::InvalidInstruction)?;
    withdraw_v2(program_id, accounts, statement, proof)
}

pub fn process_instruction_v2(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    match data.first().copied() {
        Some(INITIALIZE_TAG_V2) => {
            if data.len() != 33 {
                return Err(WatcherError::InvalidInstruction.into());
            }
            let treasury = Pubkey::new_from_array(data[1..33].try_into().unwrap());
            initialize_v2(program_id, accounts, treasury)
        }
        Some(DEPOSIT_TAG_V2) => process_deposit_encoded_v2(program_id, accounts, data),
        Some(WITHDRAW_TAG_V2) => process_withdraw_encoded_v2(program_id, accounts, data),
        _ => Err(WatcherError::InvalidInstruction.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v2_vault_seed_is_distinct_from_v1() {
        assert_ne!(VAULT_SEED_V2, crate::processor::VAULT_SEED_V1);
    }

    #[test]
    fn v2_initialize_tag_does_not_overlap_v1() {
        assert!(INITIALIZE_TAG_V2 > 3);
    }

    #[test]
    fn borrowed_deposit_dispatch_offsets_match_codec() {
        let statement = DepositStatementV2 {
            commitment: [1u8; 32],
            amount: 5,
            new_root: [2u8; 32],
        };
        let encoded = super::super::codec::WatcherInstructionV2::Deposit {
            statement: statement.clone(),
            proof: [7u8; GROTH16_PROOF_BYTES_V2],
        }
        .pack()
        .unwrap();
        assert_eq!(read_32(&encoded, 1).unwrap(), statement.commitment);
        assert_eq!(read_u64(&encoded, 33).unwrap(), statement.amount);
        assert_eq!(read_32(&encoded, 41).unwrap(), statement.new_root);
        assert_eq!(&encoded[73..], &[7u8; GROTH16_PROOF_BYTES_V2]);
    }

    #[test]
    fn borrowed_withdraw_dispatch_reaches_proof_without_copying_it() {
        let mut roots = [[0u8; 32]; MAX_INPUTS_V2];
        let mut nullifiers = [[0u8; 32]; MAX_INPUTS_V2];
        roots[0][0] = 1;
        nullifiers[0][0] = 2;
        let statement = WithdrawalStatementV2 {
            input_count: 1,
            input_roots: roots,
            nullifiers,
            change_commitment: [0u8; 32],
            recipient: Pubkey::new_unique(),
            public_amount: 5,
            protocol_fee: 0,
            relayer_fee: 0,
            new_root: [0u8; 32],
        };
        let encoded = super::super::codec::WatcherInstructionV2::Withdraw {
            statement,
            proof: [9u8; GROTH16_PROOF_BYTES_V2],
        }
        .pack()
        .unwrap();
        assert_eq!(encoded.len(), WITHDRAW_INSTRUCTION_BYTES_V2);
        assert_eq!(&encoded[WITHDRAW_INSTRUCTION_BYTES_V2 - GROTH16_PROOF_BYTES_V2..], &[9u8; GROTH16_PROOF_BYTES_V2]);
    }
}
