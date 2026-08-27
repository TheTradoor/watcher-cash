use ark_bn254::Fr;
use ark_ff::{AdditiveGroup, BigInteger, Field, PrimeField};
use sha3::{Digest, Keccak256};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    program_error::ProgramError,
    pubkey::Pubkey,
};

use crate::{
    codec::{
        append_unique_32, contains_32, ConfigAccount, WatcherInstruction, CONFIG_ACCOUNT_LEN,
        REGISTRY_HEADER_LEN,
    },
    public_inputs::CircuitV1PublicInputs,
    root_history::{
        initialize_root_history, latest_root, push_root, require_recent_root,
        ROOT_HISTORY_ACCOUNT_LEN,
    },
    verifier::verify_circuit_v1,
    DepositRecord, WatcherError, WithdrawalStatement, STATE_VERSION,
};

const MERKLE_DEPTH_V1: usize = 4;
const MERKLE_LEAVES_V1: usize = 1 << MERKLE_DEPTH_V1;
const DOMAIN_NOTE_V1: u64 = 91_001;
const DOMAIN_MERKLE_V1: u64 = 91_003;
const MIMC_ROUNDS_BN254: usize = 110;

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    match WatcherInstruction::unpack(data)? {
        WatcherInstruction::Initialize { treasury } => initialize(program_id, accounts, treasury),
        WatcherInstruction::Deposit { commitment, amount } => {
            deposit(program_id, accounts, commitment, amount)
        }
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

fn initialize_registry(data: &mut [u8]) -> Result<(), WatcherError> {
    if data.len() < REGISTRY_HEADER_LEN {
        return Err(WatcherError::InvalidAccountData);
    }
    data.fill(0);
    data[0] = STATE_VERSION;
    Ok(())
}

fn initialize(program_id: &Pubkey, accounts: &[AccountInfo], treasury: Pubkey) -> ProgramResult {
    let mut iterator = accounts.iter();
    let authority = next_account_info(&mut iterator)?;
    let config = next_account_info(&mut iterator)?;
    let commitments = next_account_info(&mut iterator)?;
    let nullifiers = next_account_info(&mut iterator)?;
    let root_history = next_account_info(&mut iterator)?;

    if !authority.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    require_distinct(&[config, commitments, nullifiers, root_history])?;
    for account in [config, commitments, nullifiers, root_history] {
        owned_by(account, program_id)?;
        require_writable(account)?;
    }

    let config_len = require_uninitialized(config, CONFIG_ACCOUNT_LEN)?;
    let commitments_len = require_uninitialized(commitments, REGISTRY_HEADER_LEN)?;
    let nullifiers_len = require_uninitialized(nullifiers, REGISTRY_HEADER_LEN)?;
    let root_history_len = require_uninitialized(root_history, ROOT_HISTORY_ACCOUNT_LEN)?;

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

    replace_account_data(config, &next_config)?;
    replace_account_data(commitments, &next_commitments)?;
    replace_account_data(nullifiers, &next_nullifiers)?;
    replace_account_data(root_history, &next_root_history)
}

fn mimc_constants_bn254() -> Vec<Fr> {
    let mut random = Keccak256::digest(b"seed").to_vec();
    let mut constants = Vec::with_capacity(MIMC_ROUNDS_BN254);
    for _ in 0..MIMC_ROUNDS_BN254 {
        random = Keccak256::digest(&random).to_vec();
        constants.push(Fr::from_be_bytes_mod_order(&random));
    }
    constants
}

pub fn mimc_hash_v1(values: &[Fr]) -> Fr {
    let constants = mimc_constants_bn254();
    let mut hash = Fr::ZERO;
    for value in values {
        let data = *value;
        let mut message = data;
        for constant in &constants {
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

/// Circuit V1-compatible Merkle root. Commitments are canonical little-endian
/// BN254 scalar field elements, placed sequentially into a fixed 16-leaf tree.
/// Unused leaves are zero, and each parent is MiMC(domainMerkleV1,left,right),
/// exactly matching circuits/withdraw/circuit_v1.go.
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
) -> ProgramResult {
    DepositRecord { commitment, amount }.validate()?;
    fr_from_canonical_le32(&commitment)?;

    let mut iterator = accounts.iter();
    let config = next_account_info(&mut iterator)?;
    let commitments = next_account_info(&mut iterator)?;
    let root_history = next_account_info(&mut iterator)?;

    require_distinct(&[config, commitments, root_history])?;
    for account in [config, commitments, root_history] {
        owned_by(account, program_id)?;
        require_writable(account)?;
    }

    let config_data = config.try_borrow_data()?.to_vec();
    let commitments_data = commitments.try_borrow_data()?.to_vec();
    let root_history_data = root_history.try_borrow_data()?.to_vec();
    let mut parsed_config = ConfigAccount::unpack(&config_data)?;
    validate_root_state(&parsed_config, &root_history_data)?;

    if commitment_count(&commitments_data)? >= MERKLE_LEAVES_V1 {
        return Err(WatcherError::MerkleTreeFull.into());
    }

    let mut next_commitments = commitments_data;
    append_unique_32(&mut next_commitments, commitment)?;
    let new_root = commitment_root(&next_commitments)?;

    let mut next_root_history = root_history_data;
    push_root(&mut next_root_history, new_root)?;

    parsed_config.merkle_root = new_root;
    let mut next_config = config_data;
    parsed_config.pack(&mut next_config)?;

    replace_account_data(commitments, &next_commitments)?;
    replace_account_data(root_history, &next_root_history)?;
    replace_account_data(config, &next_config)
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

    require_distinct(&[config, commitments, nullifiers, root_history])?;
    for account in [config, commitments, nullifiers, root_history] {
        owned_by(account, program_id)?;
        require_writable(account)?;
    }

    let config_data = config.try_borrow_data()?.to_vec();
    let commitments_data = commitments.try_borrow_data()?.to_vec();
    let nullifiers_data = nullifiers.try_borrow_data()?.to_vec();
    let root_history_data = root_history.try_borrow_data()?.to_vec();
    let mut parsed_config = ConfigAccount::unpack(&config_data)?;
    validate_root_state(&parsed_config, &root_history_data)?;
    require_recent_root(&root_history_data, &decoded_inputs.merkle_root)?;

    if parsed_config.fees_enabled || parsed_config.protocol_fee_bps != 0 {
        return Err(WatcherError::FeesDisabledDuringDevelopment.into());
    }
    if contains_32(&nullifiers_data, &statement.nullifier_0)?
        || contains_32(&nullifiers_data, &statement.nullifier_1)?
    {
        return Err(WatcherError::NullifierAlreadySpent.into());
    }

    let mut next_nullifiers = nullifiers_data;
    append_nullifier(&mut next_nullifiers, statement.nullifier_0)?;
    append_nullifier(&mut next_nullifiers, statement.nullifier_1)?;

    let mut next_commitments = commitments_data;
    let mut next_root_history = root_history_data;
    let mut next_config = config_data;

    if statement.change_commitment != [0u8; 32] {
        if commitment_count(&next_commitments)? >= MERKLE_LEAVES_V1 {
            return Err(WatcherError::MerkleTreeFull.into());
        }
        append_unique_32(&mut next_commitments, statement.change_commitment)?;
        let new_root = commitment_root(&next_commitments)?;
        push_root(&mut next_root_history, new_root)?;
        parsed_config.merkle_root = new_root;
        parsed_config.pack(&mut next_config)?;
    }

    verify_circuit_v1(
        &statement,
        &decoded_inputs.merkle_root,
        proof,
        public_inputs,
    )?;

    replace_account_data(nullifiers, &next_nullifiers)?;
    if statement.change_commitment != [0u8; 32] {
        replace_account_data(commitments, &next_commitments)?;
        replace_account_data(root_history, &next_root_history)?;
        replace_account_data(config, &next_config)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dev_fixture::DEV_PUBLIC_INPUT_BYTES;

    #[test]
    fn rust_mimc_tree_matches_circuit_v1_fixture_root() {
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
        leaves[2] = commitment_0;
        leaves[7] = commitment_1;
        let root = fr_to_le32(merkle_root_from_leaves_v1(leaves));
        assert_eq!(root, DEV_PUBLIC_INPUT_BYTES[..32]);
    }
}
