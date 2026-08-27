//! Watcher Protocol Solana program prototype.
//! Clean-room implementation. No Privacy Cash program code is used here.
//!
//! M3 intentionally starts with the protocol state machine and fail-closed proof
//! boundary. Real Groth16 verification and asset custody are wired only after the
//! statement format/verifier path is tested independently.

use solana_program::{program_error::ProgramError, pubkey::Pubkey};
use thiserror::Error;

pub const STATE_VERSION: u8 = 1;
pub const NULLIFIER_BYTES: usize = 32;
pub const COMMITMENT_BYTES: usize = 32;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProtocolConfig {
    pub authority: Pubkey,
    pub treasury: Pubkey,
    /// Fee collection is deliberately disabled during M3.
    pub fees_enabled: bool,
    pub protocol_fee_bps: u16,
}

impl ProtocolConfig {
    pub fn development(authority: Pubkey, treasury: Pubkey) -> Self {
        Self { authority, treasury, fees_enabled: false, protocol_fee_bps: 0 }
    }

    pub fn validate(&self) -> Result<(), WatcherError> {
        if self.fees_enabled || self.protocol_fee_bps != 0 {
            return Err(WatcherError::FeesDisabledDuringDevelopment);
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DepositRecord {
    pub commitment: [u8; COMMITMENT_BYTES],
    pub amount: u64,
}

impl DepositRecord {
    pub fn validate(&self) -> Result<(), WatcherError> {
        if self.amount == 0 { return Err(WatcherError::ZeroAmount); }
        if self.commitment == [0u8; COMMITMENT_BYTES] { return Err(WatcherError::ZeroCommitment); }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WithdrawalStatement {
    pub nullifier_0: [u8; NULLIFIER_BYTES],
    pub nullifier_1: [u8; NULLIFIER_BYTES],
    pub change_commitment: [u8; COMMITMENT_BYTES],
    pub recipient: Pubkey,
    pub public_amount: u64,
    pub protocol_fee: u64,
    pub relayer_fee: u64,
}

impl WithdrawalStatement {
    pub fn validate_development(&self) -> Result<(), WatcherError> {
        if self.public_amount == 0 { return Err(WatcherError::ZeroAmount); }
        if self.protocol_fee != 0 { return Err(WatcherError::FeesDisabledDuringDevelopment); }
        if self.nullifier_0 == [0u8; NULLIFIER_BYTES] || self.nullifier_1 == [0u8; NULLIFIER_BYTES] {
            return Err(WatcherError::ZeroNullifier);
        }
        if self.nullifier_0 == self.nullifier_1 { return Err(WatcherError::DuplicateNullifier); }
        Ok(())
    }
}

/// Small deterministic state-machine model used by program tests before account
/// serialization is frozen. This lets us test protocol invariants without pretending
/// the on-chain verifier/custody layer is finished.
#[derive(Debug, Default)]
pub struct ProtocolStateModel {
    commitments: Vec<[u8; COMMITMENT_BYTES]>,
    spent_nullifiers: Vec<[u8; NULLIFIER_BYTES]>,
}

impl ProtocolStateModel {
    pub fn record_deposit(&mut self, deposit: DepositRecord) -> Result<(), WatcherError> {
        deposit.validate()?;
        if self.commitments.contains(&deposit.commitment) { return Err(WatcherError::DuplicateCommitment); }
        self.commitments.push(deposit.commitment);
        Ok(())
    }

    pub fn apply_verified_withdrawal(&mut self, statement: WithdrawalStatement) -> Result<(), WatcherError> {
        statement.validate_development()?;
        if self.spent_nullifiers.contains(&statement.nullifier_0)
            || self.spent_nullifiers.contains(&statement.nullifier_1)
        {
            return Err(WatcherError::NullifierAlreadySpent);
        }
        self.spent_nullifiers.push(statement.nullifier_0);
        self.spent_nullifiers.push(statement.nullifier_1);
        if statement.change_commitment != [0u8; COMMITMENT_BYTES] {
            if self.commitments.contains(&statement.change_commitment) {
                return Err(WatcherError::DuplicateCommitment);
            }
            self.commitments.push(statement.change_commitment);
        }
        Ok(())
    }

    pub fn is_spent(&self, nullifier: &[u8; NULLIFIER_BYTES]) -> bool {
        self.spent_nullifiers.contains(nullifier)
    }
}

#[derive(Error, Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatcherError {
    #[error("amount must be non-zero")]
    ZeroAmount,
    #[error("commitment must be non-zero")]
    ZeroCommitment,
    #[error("nullifier must be non-zero")]
    ZeroNullifier,
    #[error("duplicate nullifier in withdrawal")]
    DuplicateNullifier,
    #[error("nullifier has already been spent")]
    NullifierAlreadySpent,
    #[error("commitment already exists")]
    DuplicateCommitment,
    #[error("protocol fees are disabled during development")]
    FeesDisabledDuringDevelopment,
    #[error("proof verification is not wired yet")]
    ProofVerificationUnavailable,
}

impl From<WatcherError> for ProgramError {
    fn from(value: WatcherError) -> Self { ProgramError::Custom(value as u32 + 1) }
}

/// Fail-closed verifier boundary. The Solana instruction processor must not call
/// `apply_verified_withdrawal` until this returns Ok after real BN254 Groth16 verification.
pub fn verify_withdrawal_proof(_proof: &[u8], _public_inputs: &[u8]) -> Result<(), WatcherError> {
    Err(WatcherError::ProofVerificationUnavailable)
}
