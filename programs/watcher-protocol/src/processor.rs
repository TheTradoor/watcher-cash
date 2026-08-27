use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    program_error::ProgramError,
    pubkey::Pubkey,
};
use crate::{
    codec::{append_unique_32, contains_32, ConfigAccount, WatcherInstruction},
    verifier::verify_circuit_v1,
    DepositRecord, WatcherError, WithdrawalStatement, STATE_VERSION,
};

pub fn process_instruction(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    match WatcherInstruction::unpack(data)? {
        WatcherInstruction::Initialize { treasury } => initialize(program_id, accounts, treasury),
        WatcherInstruction::Deposit { commitment, amount } => deposit(program_id, accounts, commitment, amount),
        WatcherInstruction::Withdraw { nullifier_0, nullifier_1, change_commitment, recipient, public_amount, protocol_fee, relayer_fee, proof, public_inputs } => {
            withdraw(program_id, accounts, WithdrawalStatement { nullifier_0, nullifier_1, change_commitment, recipient, public_amount, protocol_fee, relayer_fee }, &proof, &public_inputs)
        }
    }
}

fn owned_by(account: &AccountInfo, program_id: &Pubkey) -> Result<(), ProgramError> {
    if account.owner != program_id { return Err(ProgramError::IncorrectProgramId); }
    Ok(())
}

fn initialize(program_id: &Pubkey, accounts: &[AccountInfo], treasury: Pubkey) -> ProgramResult {
    let mut it = accounts.iter();
    let authority = next_account_info(&mut it)?;
    let config = next_account_info(&mut it)?;
    let commitments = next_account_info(&mut it)?;
    let nullifiers = next_account_info(&mut it)?;
    if !authority.is_signer { return Err(ProgramError::MissingRequiredSignature); }
    owned_by(config, program_id)?; owned_by(commitments, program_id)?; owned_by(nullifiers, program_id)?;
    let mut cfg_data = config.try_borrow_mut_data()?;
    if cfg_data.first().copied().unwrap_or(0) != 0 { return Err(WatcherError::AlreadyInitialized.into()); }
    ConfigAccount { authority: *authority.key, treasury, fees_enabled: false, protocol_fee_bps: 0 }.pack(&mut cfg_data)?;
    for registry in [commitments, nullifiers] {
        let mut d = registry.try_borrow_mut_data()?;
        if d.len() < 5 { return Err(WatcherError::InvalidAccountData.into()); }
        d.fill(0); d[0] = STATE_VERSION;
    }
    Ok(())
}

fn deposit(program_id: &Pubkey, accounts: &[AccountInfo], commitment: [u8; 32], amount: u64) -> ProgramResult {
    DepositRecord { commitment, amount }.validate()?;
    let mut it = accounts.iter();
    let config = next_account_info(&mut it)?;
    let commitments = next_account_info(&mut it)?;
    owned_by(config, program_id)?; owned_by(commitments, program_id)?;
    ConfigAccount::unpack(&config.try_borrow_data()?)?;
    append_unique_32(&mut commitments.try_borrow_mut_data()?, commitment)?;
    Ok(())
}

fn withdraw(program_id: &Pubkey, accounts: &[AccountInfo], statement: WithdrawalStatement, proof: &[u8], public_inputs: &[u8]) -> ProgramResult {
    statement.validate_development()?;
    let mut it = accounts.iter();
    let config = next_account_info(&mut it)?;
    let commitments = next_account_info(&mut it)?;
    let nullifiers = next_account_info(&mut it)?;
    owned_by(config, program_id)?; owned_by(commitments, program_id)?; owned_by(nullifiers, program_id)?;
    let cfg = ConfigAccount::unpack(&config.try_borrow_data()?)?;
    if cfg.fees_enabled || cfg.protocol_fee_bps != 0 { return Err(WatcherError::FeesDisabledDuringDevelopment.into()); }
    {
        let d = nullifiers.try_borrow_data()?;
        if contains_32(&d, &statement.nullifier_0)? || contains_32(&d, &statement.nullifier_1)? {
            return Err(WatcherError::NullifierAlreadySpent.into());
        }
    }
    // Critical ordering: proof + public statement binding MUST pass before spent-state mutation.
    verify_circuit_v1(&statement, proof, public_inputs)?;
    let mut n = nullifiers.try_borrow_mut_data()?;
    append_unique_32(&mut n, statement.nullifier_0).map_err(|e| match e { WatcherError::DuplicateCommitment => WatcherError::NullifierAlreadySpent, other => other })?;
    append_unique_32(&mut n, statement.nullifier_1).map_err(|e| match e { WatcherError::DuplicateCommitment => WatcherError::NullifierAlreadySpent, other => other })?;
    drop(n);
    if statement.change_commitment != [0u8; 32] { append_unique_32(&mut commitments.try_borrow_mut_data()?, statement.change_commitment)?; }
    // SOL custody transfer is deliberately still disabled until the verifier path
    // and vault accounting are both validated together in program-test/devnet.
    Ok(())
}
