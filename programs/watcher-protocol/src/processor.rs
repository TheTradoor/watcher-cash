use ark_bn254::Fr;
use ark_ff::{AdditiveGroup, BigInteger, Field, PrimeField};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    system_instruction, system_program,
    sysvar::{rent::Rent, Sysvar},
};

use crate::{
    codec::{
        append_unique_32, contains_32, ConfigAccount, VaultAccount, WatcherInstruction,
        CONFIG_ACCOUNT_LEN, REGISTRY_HEADER_LEN, VAULT_ACCOUNT_LEN,
    },
    public_inputs::{sol_asset_id_field_v1, withdraw_context_binding_v1, CircuitV1PublicInputs},
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
const DOMAIN_NOTE_V1: u64 = 91_001;
const DOMAIN_MERKLE_V1: u64 = 91_003;
pub const COMMITMENT_REGISTRY_ACCOUNT_LEN: usize =
    REGISTRY_HEADER_LEN + MERKLE_LEAVES_V1 * 32 + MERKLE_DEPTH_V1 * 32;
const COMMITMENT_FRONTIER_OFFSET_V1: usize = REGISTRY_HEADER_LEN + MERKLE_LEAVES_V1 * 32;
const MIMC_CONSTANTS_BN254: [Fr; 110] = include!("mimc_constants_array.in");
const ZERO_SUBTREES_V1: [Fr; MERKLE_DEPTH_V1] = [
    ark_ff::MontFp!("0"),
    ark_ff::MontFp!(
        "13944871254576092688407995039196385293275829255317419112130051225496143636462"
    ),
    ark_ff::MontFp!(
        "16343093116817376678535597198206140961913989012995557384633161644309886798874"
    ),
    ark_ff::MontFp!(
        "21733524612354527147942681386006398610659529737868531993862559850617141653616"
    ),
];

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
    if account.key != &system_program::id() {
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
    } else if *vault.owner == system_program::id() && vault.data_is_empty() && vault.lamports() == 0
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

    let mut next_config = vec![0u8; config_len];
    ConfigAccount {
        authority: *authority.key,
        treasury,
        fees_enabled: false,
        protocol_fee_bps: 0,
        merkle_root: [0u8; 32],
    }
    .pack(&mut next_config)?;

    let mut next_commitments = vec![0u8; commitments_len];
    initialize_registry(&mut next_commitments)?;
    let mut next_nullifiers = vec![0u8; nullifiers_len];
    initialize_registry(&mut next_nullifiers)?;
    let mut next_root_history = vec![0u8; root_history_len];
    initialize_root_history(&mut next_root_history)?;
    let mut next_vault = vec![0u8; vault.data_len()];
    VaultAccount {
        config: *config.key,
        bump,
        asset_id: SOL_ASSET_ID_V1,
        tracked_balance: 0,
    }
    .pack(&mut next_vault)?;

    replace_account_data(config, &next_config)?;
    replace_account_data(commitments, &next_commitments)?;
    replace_account_data(nullifiers, &next_nullifiers)?;
    replace_account_data(root_history, &next_root_history)?;
    replace_account_data(vault, &next_vault)
}

pub fn mimc_hash_v1(values: &[Fr]) -> Fr {
    let mut hash = Fr::ZERO;
    for value in values {
        let data = *value;
        let mut message = data;
        for constant in &MIMC_CONSTANTS_BN254 {
            let temporary = message + hash + *constant;
            let squared = temporary.square();
            let fourth = squared.square();
            message = fourth * temporary;
        }
        message += hash;
        hash = message + hash + data;
    }
    hash
}

fn fr_to_le32(value: Fr) -> [u8; 32] {
    let raw = value.into_bigint().to_bytes_le();
    let mut output = [0u8; 32];
    output[..raw.len()].copy_from_slice(&raw);
    output
}

fn fr_from_canonical_le32(bytes: &[u8; 32]) -> Result<Fr, WatcherError> {
    let value = Fr::from_le_bytes_mod_order(bytes);
    if fr_to_le32(value) != *bytes {
        return Err(WatcherError::InvalidCommitmentField);
    }
    Ok(value)
}

fn parent_v1(left: Fr, right: Fr) -> Fr {
    mimc_hash_v1(&[Fr::from(DOMAIN_MERKLE_V1), left, right])
}

pub fn merkle_root_from_leaves_v1(mut leaves: [Fr; MERKLE_LEAVES_V1]) -> Fr {
    let mut width = MERKLE_LEAVES_V1;
    while width > 1 {
        for index in 0..(width / 2) {
            leaves[index] = parent_v1(leaves[index * 2], leaves[index * 2 + 1]);
        }
        width /= 2;
    }
    leaves[0]
}

fn commitment_count(registry: &[u8]) -> Result<usize, WatcherError> {
    if registry.len() < REGISTRY_HEADER_LEN || registry[0] != STATE_VERSION {
        return Err(WatcherError::InvalidAccountData);
    }
    let count = u32::from_le_bytes(registry[1..5].try_into().unwrap()) as usize;
    let end = REGISTRY_HEADER_LEN
        .checked_add(
            count
                .checked_mul(32)
                .ok_or(WatcherError::InvalidAccountData)?,
        )
        .ok_or(WatcherError::InvalidAccountData)?;
    if end > registry.len() {
        return Err(WatcherError::InvalidAccountData);
    }
    Ok(count)
}

/// Append one commitment and update the fixed-depth frontier in O(log N).
///
/// The four trailing field elements hold filled subtrees. The first count
/// commitment slots remain append-only and keep the existing client codec.
pub fn append_commitment_v1(
    registry: &mut [u8],
    commitment: [u8; 32],
) -> Result<[u8; 32], WatcherError> {
    if registry.len() < COMMITMENT_REGISTRY_ACCOUNT_LEN || registry[0] != STATE_VERSION {
        return Err(WatcherError::InvalidAccountData);
    }
    let count = commitment_count(registry)?;
    if count >= MERKLE_LEAVES_V1 {
        return Err(WatcherError::MerkleTreeFull);
    }
    if contains_32(registry, &commitment)? {
        return Err(WatcherError::DuplicateCommitment);
    }

    let mut current = fr_from_canonical_le32(&commitment)?;
    let mut position = count;
    for level in 0..MERKLE_DEPTH_V1 {
        let frontier_offset = COMMITMENT_FRONTIER_OFFSET_V1 + level * 32;
        if position & 1 == 0 {
            registry[frontier_offset..frontier_offset + 32].copy_from_slice(&fr_to_le32(current));
            current = parent_v1(current, ZERO_SUBTREES_V1[level]);
        } else {
            let left_bytes: [u8; 32] = registry[frontier_offset..frontier_offset + 32]
                .try_into()
                .unwrap();
            let left = fr_from_canonical_le32(&left_bytes)?;
            current = parent_v1(left, current);
        }
        position >>= 1;
    }

    let leaf_offset = REGISTRY_HEADER_LEN + count * 32;
    registry[leaf_offset..leaf_offset + 32].copy_from_slice(&commitment);
    registry[1..5].copy_from_slice(&((count + 1) as u32).to_le_bytes());
    Ok(fr_to_le32(current))
}

/// Circuit V1-compatible Merkle root. Commitments are canonical little-endian
/// BN254 scalar field elements, placed sequentially into a fixed 16-leaf tree.
pub fn commitment_root(registry: &[u8]) -> Result<[u8; 32], WatcherError> {
    let count = commitment_count(registry)?;
    if count == 0 {
        return Ok([0u8; 32]);
    }
    if count > MERKLE_LEAVES_V1 {
        return Err(WatcherError::MerkleTreeFull);
    }

    let mut leaves = [Fr::ZERO; MERKLE_LEAVES_V1];
    let end = REGISTRY_HEADER_LEN + count * 32;
    for (index, chunk) in registry[REGISTRY_HEADER_LEN..end]
        .chunks_exact(32)
        .enumerate()
    {
        let bytes: [u8; 32] = chunk.try_into().unwrap();
        leaves[index] = fr_from_canonical_le32(&bytes)?;
    }
    Ok(fr_to_le32(merkle_root_from_leaves_v1(leaves)))
}

fn validate_root_state(
    config: &ConfigAccount,
    root_history_data: &[u8],
) -> Result<(), WatcherError> {
    match latest_root(root_history_data)? {
        None if config.merkle_root == [0u8; 32] => Ok(()),
        Some(latest) if latest == config.merkle_root => Ok(()),
        _ => Err(WatcherError::RootHistoryMismatch),
    }
}

fn append_nullifier(registry: &mut [u8], nullifier: [u8; 32]) -> Result<(), WatcherError> {
    append_unique_32(registry, nullifier).map_err(|error| match error {
        WatcherError::DuplicateCommitment => WatcherError::NullifierAlreadySpent,
        other => other,
    })
}

fn deposit(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    commitment: [u8; 32],
    amount: u64,
    proof: &[u8],
    public_inputs: &[u8],
) -> ProgramResult {
    DepositRecord { commitment, amount }.validate()?;
    fr_from_canonical_le32(&commitment)?;

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
    require_distinct(&[depositor, config, commitments, root_history, vault])?;
    require_writable(depositor)?;
    for account in [config, commitments, root_history] {
        owned_by(account, program_id)?;
        require_writable(account)?;
    }
    require_writable(vault)?;

    let config_data = config.try_borrow_data()?.to_vec();
    let commitments_data = commitments.try_borrow_data()?.to_vec();
    let root_history_data = root_history.try_borrow_data()?.to_vec();
    let mut parsed_config = ConfigAccount::unpack(&config_data)?;
    validate_root_state(&parsed_config, &root_history_data)?;

    let rent_reserve = rent_reserve_v1()?;
    let mut vault_state = validate_vault_state(program_id, config.key, vault)?;
    validate_vault_balance(vault, &vault_state, rent_reserve)?;

    let asset_id = sol_asset_id_field_v1();
    verify_deposit_v1(&commitment, amount, &asset_id, proof, public_inputs)?;

    if commitment_count(&commitments_data)? >= MERKLE_LEAVES_V1 {
        return Err(WatcherError::MerkleTreeFull.into());
    }

    let mut next_commitments = commitments_data;
    let new_root = append_commitment_v1(&mut next_commitments, commitment)?;

    let mut next_root_history = root_history_data;
    push_root(&mut next_root_history, new_root)?;

    parsed_config.merkle_root = new_root;
    let mut next_config = config_data;
    parsed_config.pack(&mut next_config)?;

    vault_state.tracked_balance = vault_state
        .tracked_balance
        .checked_add(amount)
        .ok_or(WatcherError::ArithmeticOverflow)?;
    let mut next_vault = vault.try_borrow_data()?.to_vec();
    vault_state.pack(&mut next_vault)?;
    let minimum_after = rent_reserve
        .checked_add(vault_state.tracked_balance)
        .ok_or(WatcherError::ArithmeticOverflow)?;

    invoke(
        &system_instruction::transfer(depositor.key, vault.key, amount),
        &[
            depositor.clone(),
            vault.clone(),
            system_program_account.clone(),
        ],
    )?;
    if vault.lamports() < minimum_after {
        return Err(WatcherError::VaultBalanceInvariant.into());
    }

    replace_account_data(commitments, &next_commitments)?;
    replace_account_data(root_history, &next_root_history)?;
    replace_account_data(config, &next_config)?;
    replace_account_data(vault, &next_vault)
}

fn withdraw(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    statement: WithdrawalStatement,
    proof: &[u8],
    public_inputs: &[u8],
) -> ProgramResult {
    statement.validate_development()?;
    if statement.change_commitment != [0u8; 32] {
        fr_from_canonical_le32(&statement.change_commitment)?;
    }

    let decoded_inputs = CircuitV1PublicInputs::decode(public_inputs)?;

    let mut iterator = accounts.iter();
    let config = next_account_info(&mut iterator)?;
    let commitments = next_account_info(&mut iterator)?;
    let nullifiers = next_account_info(&mut iterator)?;
    let root_history = next_account_info(&mut iterator)?;
    let vault = next_account_info(&mut iterator)?;
    let recipient = next_account_info(&mut iterator)?;
    let relayer = next_account_info(&mut iterator)?;
    let treasury = next_account_info(&mut iterator)?;

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
    for account in [config, commitments, nullifiers, root_history] {
        owned_by(account, program_id)?;
        require_writable(account)?;
    }
    for account in [vault, recipient, relayer, treasury] {
        require_writable(account)?;
    }
    if recipient.key != &statement.recipient {
        return Err(WatcherError::InvalidPayoutAccount.into());
    }

    let config_data = config.try_borrow_data()?.to_vec();
    let commitments_data = commitments.try_borrow_data()?.to_vec();
    let nullifiers_data = nullifiers.try_borrow_data()?.to_vec();
    let root_history_data = root_history.try_borrow_data()?.to_vec();
    let mut parsed_config = ConfigAccount::unpack(&config_data)?;
    if treasury.key != &parsed_config.treasury {
        return Err(WatcherError::InvalidPayoutAccount.into());
    }
    validate_root_state(&parsed_config, &root_history_data)?;
    require_recent_root(&root_history_data, &decoded_inputs.merkle_root)?;

    let rent_reserve = rent_reserve_v1()?;
    let mut vault_state = validate_vault_state(program_id, config.key, vault)?;
    validate_vault_balance(vault, &vault_state, rent_reserve)?;

    if parsed_config.fees_enabled || parsed_config.protocol_fee_bps != 0 {
        return Err(WatcherError::FeesDisabledDuringDevelopment.into());
    }
    if contains_32(&nullifiers_data, &statement.nullifier_0)?
        || contains_32(&nullifiers_data, &statement.nullifier_1)?
    {
        return Err(WatcherError::NullifierAlreadySpent.into());
    }
    if statement.change_commitment != [0u8; 32]
        && commitment_count(&commitments_data)? >= MERKLE_LEAVES_V1
    {
        return Err(WatcherError::MerkleTreeFull.into());
    }

    let asset_id = sol_asset_id_field_v1();
    let context_binding = withdraw_context_binding_v1(
        program_id,
        config.key,
        vault.key,
        relayer.key,
        treasury.key,
        &asset_id,
    );
    verify_circuit_v1(
        &statement,
        &decoded_inputs.merkle_root,
        &asset_id,
        &context_binding,
        proof,
        public_inputs,
    )?;

    let payout = statement
        .public_amount
        .checked_add(statement.protocol_fee)
        .and_then(|value| value.checked_add(statement.relayer_fee))
        .ok_or(WatcherError::ArithmeticOverflow)?;
    if vault_state.tracked_balance < payout {
        return Err(WatcherError::InsufficientVaultBalance.into());
    }

    let mut next_nullifiers = nullifiers_data;
    append_nullifier(&mut next_nullifiers, statement.nullifier_0)?;
    append_nullifier(&mut next_nullifiers, statement.nullifier_1)?;

    let mut next_commitments = commitments_data;
    let mut next_root_history = root_history_data;
    let mut next_config = config_data;
    if statement.change_commitment != [0u8; 32] {
        let new_root = append_commitment_v1(&mut next_commitments, statement.change_commitment)?;
        push_root(&mut next_root_history, new_root)?;
        parsed_config.merkle_root = new_root;
        parsed_config.pack(&mut next_config)?;
    }

    vault_state.tracked_balance -= payout;
    let mut next_vault = vault.try_borrow_data()?.to_vec();
    vault_state.pack(&mut next_vault)?;

    let vault_after = vault
        .lamports()
        .checked_sub(payout)
        .ok_or(WatcherError::InsufficientVaultBalance)?;
    let required_after = rent_reserve
        .checked_add(vault_state.tracked_balance)
        .ok_or(WatcherError::ArithmeticOverflow)?;
    if vault_after < required_after {
        return Err(WatcherError::VaultBalanceInvariant.into());
    }
    let recipient_after = recipient
        .lamports()
        .checked_add(statement.public_amount)
        .ok_or(WatcherError::ArithmeticOverflow)?;
    let relayer_after = relayer
        .lamports()
        .checked_add(statement.relayer_fee)
        .ok_or(WatcherError::ArithmeticOverflow)?;
    let treasury_after = treasury
        .lamports()
        .checked_add(statement.protocol_fee)
        .ok_or(WatcherError::ArithmeticOverflow)?;

    replace_account_data(nullifiers, &next_nullifiers)?;
    if statement.change_commitment != [0u8; 32] {
        replace_account_data(commitments, &next_commitments)?;
        replace_account_data(root_history, &next_root_history)?;
        replace_account_data(config, &next_config)?;
    }
    replace_account_data(vault, &next_vault)?;

    set_lamports(vault, vault_after)?;
    set_lamports(recipient, recipient_after)?;
    set_lamports(relayer, relayer_after)?;
    set_lamports(treasury, treasury_after)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dev_fixture::DEV_PUBLIC_INPUT_BYTES;

    #[test]
    fn rust_mimc_tree_matches_sequential_circuit_v1_fixture_root() {
        let commitment_0 = mimc_hash_v1(&[
            Fr::from(DOMAIN_NOTE_V1),
            Fr::from(1u64),
            Fr::from(8_000_000u64),
            Fr::from(1111u64),
            Fr::from(2222u64),
        ]);
        let commitment_1 = mimc_hash_v1(&[
            Fr::from(DOMAIN_NOTE_V1),
            Fr::from(1u64),
            Fr::from(3_000_000u64),
            Fr::from(3333u64),
            Fr::from(4444u64),
        ]);
        let mut leaves = [Fr::ZERO; MERKLE_LEAVES_V1];
        leaves[0] = commitment_0;
        leaves[1] = commitment_1;
        let root = fr_to_le32(merkle_root_from_leaves_v1(leaves));
        assert_eq!(root, DEV_PUBLIC_INPUT_BYTES[..32]);
    }

    #[test]
    fn fixed_custody_fixture_uses_the_real_vault_pda() {
        let program_id = Pubkey::new_from_array([42u8; 32]);
        let config = Pubkey::new_from_array([43u8; 32]);
        let (vault, bump) = vault_address_v1(&program_id, &config);
        assert_eq!(bump, 255);
        assert_eq!(
            vault.to_bytes(),
            [
                0x53, 0x00, 0x97, 0x5d, 0xd0, 0xc0, 0x7b, 0x8b, 0xc9, 0x07, 0x1d, 0x94, 0xad, 0x6f,
                0xcd, 0x4d, 0x6e, 0x87, 0xb5, 0xf1, 0xef, 0x54, 0xe1, 0x8d, 0xd9, 0x6f, 0x65, 0x42,
                0xba, 0x55, 0x31, 0xf1,
            ]
        );
    }
}
