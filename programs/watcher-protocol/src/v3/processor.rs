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
    codec::{ConfigAccount, VaultAccount, VAULT_ACCOUNT_LEN},
    v2::{
        codec::{WithdrawalStatementV2, WITHDRAW_INSTRUCTION_BYTES_V2},
        processor::vault_address_v2,
        public_inputs::{sol_asset_id_field_v2, withdraw_context_binding_v2, WithdrawPublicInputsV2},
        state::{validate_spend_roots_v2, ActiveTreeV2, SealedRootV2, ACTIVE_TREE_ACCOUNT_LEN_V2},
        verifier::verify_withdraw_v2,
        GROTH16_PROOF_BYTES_V2, MAX_INPUTS_V2,
    },
    WatcherError, SOL_ASSET_ID_V1,
};

use super::{
    nullifier_set::{
        append_nullifier_v3, contains_nullifier_v3, derive_nullifier_shard_v3,
        initialize_nullifier_shard_v3, required_nullifier_shard_len_v3, route_nullifier_v3,
        unpack_nullifier_shard_header_v3, NULLIFIER_SHARD_HEADER_BYTES_V3,
        NULLIFIER_SHARD_SEED_V3,
    },
    INITIALIZE_NULLIFIER_SHARD_TAG_V3, WITHDRAW_TAG_V3,
};

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

fn vault_state_v3(
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

fn top_up_rent<'a>(
    payer: &AccountInfo<'a>,
    target: &AccountInfo<'a>,
    system: &AccountInfo<'a>,
    required_lamports: u64,
) -> ProgramResult {
    if target.lamports() >= required_lamports {
        return Ok(());
    }
    let difference = required_lamports
        .checked_sub(target.lamports())
        .ok_or(WatcherError::ArithmeticOverflow)?;
    invoke(
        &system_instruction::transfer(payer.key, target.key, difference),
        &[payer.clone(), target.clone(), system.clone()],
    )
}

#[inline(never)]
fn initialize_nullifier_shard_account_v3(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    shard_index: u8,
) -> ProgramResult {
    let mut iterator = accounts.iter();
    let authority = next_account_info(&mut iterator)?;
    let config = next_account_info(&mut iterator)?;
    let shard = next_account_info(&mut iterator)?;
    let system = next_account_info(&mut iterator)?;
    if iterator.next().is_some() {
        return Err(WatcherError::InvalidInstruction.into());
    }
    if !authority.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    writable(authority)?;
    writable(shard)?;
    require_system(system)?;
    owned_by(config, program_id)?;

    let config_state = ConfigAccount::unpack(&config.try_borrow_data()?)?;
    if config_state.authority != *authority.key {
        return Err(WatcherError::InvalidAccountData.into());
    }

    let (expected, bump) = derive_nullifier_shard_v3(program_id, config.key, shard_index)?;
    if shard.key != &expected {
        return Err(WatcherError::InvalidAccountData.into());
    }

    let rent = Rent::get()?.minimum_balance(NULLIFIER_SHARD_HEADER_BYTES_V3);
    if shard.owner == program_id {
        if shard.data_len() != NULLIFIER_SHARD_HEADER_BYTES_V3 {
            return Err(WatcherError::InvalidAccountData.into());
        }
        if shard.try_borrow_data()?.iter().any(|byte| *byte != 0) {
            return Err(WatcherError::AlreadyInitialized.into());
        }
        top_up_rent(authority, shard, system, rent)?;
    } else if *shard.owner == system_program::id() && shard.data_is_empty() {
        // Allocate/assign instead of create_account so a harmless pre-funded PDA
        // cannot grief initialization by making the account non-zero first.
        top_up_rent(authority, shard, system, rent)?;
        let bump_seed = [bump];
        let shard_seed = [shard_index];
        let seeds: &[&[u8]] = &[
            NULLIFIER_SHARD_SEED_V3,
            config.key.as_ref(),
            &shard_seed,
            &bump_seed,
        ];
        invoke_signed(
            &system_instruction::allocate(shard.key, NULLIFIER_SHARD_HEADER_BYTES_V3 as u64),
            &[shard.clone(), system.clone()],
            &[seeds],
        )?;
        invoke_signed(
            &system_instruction::assign(shard.key, program_id),
            &[shard.clone(), system.clone()],
            &[seeds],
        )?;
    } else {
        return Err(WatcherError::InvalidAccountData.into());
    }

    let mut data = vec![0u8; NULLIFIER_SHARD_HEADER_BYTES_V3];
    initialize_nullifier_shard_v3(&mut data, *config.key, shard_index)?;
    replace_data(shard, &data)
}

fn validate_unspent_shard_v3(
    program_id: &Pubkey,
    config: &Pubkey,
    nullifier: &[u8; 32],
    shard: &AccountInfo,
) -> ProgramResult {
    let route = route_nullifier_v3(config, nullifier)?;
    let (expected, _) = derive_nullifier_shard_v3(program_id, config, route.shard)?;
    if shard.key != &expected {
        return Err(WatcherError::InvalidAccountData.into());
    }
    writable(shard)?;
    owned_by(shard, program_id)?;
    let data = shard.try_borrow_data()?;
    let header = unpack_nullifier_shard_header_v3(&data)?;
    if header.config != *config || header.shard != route.shard {
        return Err(WatcherError::InvalidAccountData.into());
    }
    if contains_nullifier_v3(&data, config, nullifier)? {
        return Err(WatcherError::NullifierAlreadySpent.into());
    }
    Ok(())
}

fn grow_and_append_nullifier_v3<'a>(
    config: &Pubkey,
    nullifier: &[u8; 32],
    shard: &AccountInfo<'a>,
    payer: &AccountInfo<'a>,
    system: &AccountInfo<'a>,
) -> ProgramResult {
    let header = {
        let data = shard.try_borrow_data()?;
        unpack_nullifier_shard_header_v3(&data)?
    };
    if header.config != *config {
        return Err(WatcherError::InvalidAccountData.into());
    }
    let next_count = header
        .count
        .checked_add(1)
        .ok_or(WatcherError::ArithmeticOverflow)?;
    let next_len = required_nullifier_shard_len_v3(next_count)?;
    let rent = Rent::get()?.minimum_balance(next_len);
    top_up_rent(payer, shard, system, rent)?;
    if shard.data_len() < next_len {
        shard.realloc(next_len, false)?;
    }
    let mut data = shard.try_borrow_mut_data()?;
    append_nullifier_v3(&mut data, config, nullifier)?;
    Ok(())
}

#[inline(never)]
fn withdraw_v3(
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
    let mut vault_state = vault_state_v3(program_id, config.key, vault)?;
    let reserve = validate_vault_liability(vault, &vault_state)?;

    let input_count = statement.input_count as usize;
    let mut shard_accounts: Vec<&AccountInfo> = Vec::with_capacity(input_count);
    for index in 0..input_count {
        let shard = next_account_info(&mut iterator)?;
        validate_unspent_shard_v3(
            program_id,
            config.key,
            &statement.nullifiers[index],
            shard,
        )?;
        shard_accounts.push(shard);
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

    // Persist exact nullifiers only after proof verification and payout checks.
    // Solana transaction atomicity rolls all shard growth back if any later
    // mutation fails.
    for index in 0..input_count {
        grow_and_append_nullifier_v3(
            config.key,
            &statement.nullifiers[index],
            shard_accounts[index],
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
fn process_withdraw_encoded_v3(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if data.len() != WITHDRAW_INSTRUCTION_BYTES_V2 || data.first().copied() != Some(WITHDRAW_TAG_V3) {
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
    withdraw_v3(program_id, accounts, statement, proof)
}

pub fn process_instruction_v3(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    match data.first().copied() {
        Some(INITIALIZE_NULLIFIER_SHARD_TAG_V3) => {
            if data.len() != 2 {
                return Err(WatcherError::InvalidInstruction.into());
            }
            initialize_nullifier_shard_account_v3(program_id, accounts, data[1])
        }
        Some(WITHDRAW_TAG_V3) => process_withdraw_encoded_v3(program_id, accounts, data),
        _ => Err(WatcherError::InvalidInstruction.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v3_tags_are_distinct_from_v2() {
        assert_ne!(WITHDRAW_TAG_V3, crate::v2::codec::WITHDRAW_TAG_V2);
        assert_ne!(INITIALIZE_NULLIFIER_SHARD_TAG_V3, crate::v2::processor::INITIALIZE_TAG_V2);
    }

    #[test]
    fn v3_withdraw_wire_keeps_v2_statement_and_proof_size() {
        assert_eq!(WITHDRAW_INSTRUCTION_BYTES_V2, 475 + GROTH16_PROOF_BYTES_V2 - 256);
        // The V3 tag replaces only byte zero; circuit public inputs remain V2-compatible.
        assert_eq!(WITHDRAW_INSTRUCTION_BYTES_V2, crate::v2::codec::WITHDRAW_INSTRUCTION_BYTES_V2);
    }
}
