//! Watcher Protocol Solana program prototype.
//! Clean-room implementation. No Privacy Cash program code is used here.

use solana_program::{program_error::ProgramError, pubkey::Pubkey};
use thiserror::Error;

pub mod codec;
pub mod dev_fixture;
#[cfg(not(feature = "no-entrypoint"))]
pub mod entrypoint;
pub mod processor;
pub mod public_inputs;
pub mod root_history;
pub mod v2;
pub mod verifier;

pub use processor::process_instruction;

pub const STATE_VERSION: u8 = 1;
pub const NULLIFIER_BYTES: usize = 32;
pub const COMMITMENT_BYTES: usize = 32;
pub const SOL_ASSET_ID_V1: u64 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProtocolConfig {
    pub authority: Pubkey,
    pub treasury: Pubkey,
    pub fees_enabled: bool,
    pub protocol_fee_bps: u16,
}

impl ProtocolConfig {
    pub fn development(authority: Pubkey, treasury: Pubkey) -> Self {
        Self {
            authority,
            treasury,
            fees_enabled: false,
            protocol_fee_bps: 0,
        }
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
    pub commitment: [u8; 32],
    pub amount: u64,
}

impl DepositRecord {
    pub fn validate(&self) -> Result<(), WatcherError> {
        if self.amount == 0 {
            return Err(WatcherError::ZeroAmount);
        }
        if self.commitment == [0u8; 32] {
            return Err(WatcherError::ZeroCommitment);
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WithdrawalStatement {
    pub nullifier_0: [u8; 32],
    pub nullifier_1: [u8; 32],
    pub change_commitment: [u8; 32],
    pub recipient: Pubkey,
    pub public_amount: u64,
    pub protocol_fee: u64,
    pub relayer_fee: u64,
}

impl WithdrawalStatement {
    pub fn validate_development(&self) -> Result<(), WatcherError> {
        if self.public_amount == 0 {
            return Err(WatcherError::ZeroAmount);
        }
        if self.protocol_fee != 0 {
            return Err(WatcherError::FeesDisabledDuringDevelopment);
        }
        if self.nullifier_0 == [0u8; 32] || self.nullifier_1 == [0u8; 32] {
            return Err(WatcherError::ZeroNullifier);
        }
        if self.nullifier_0 == self.nullifier_1 {
            return Err(WatcherError::DuplicateNullifier);
        }
        Ok(())
    }
}

#[derive(Debug, Default)]
pub struct ProtocolStateModel {
    commitments: Vec<[u8; 32]>,
    spent_nullifiers: Vec<[u8; 32]>,
}

impl ProtocolStateModel {
    pub fn record_deposit(&mut self, deposit: DepositRecord) -> Result<(), WatcherError> {
        deposit.validate()?;
        if self.commitments.contains(&deposit.commitment) {
            return Err(WatcherError::DuplicateCommitment);
        }
        self.commitments.push(deposit.commitment);
        Ok(())
    }

    pub fn apply_verified_withdrawal(
        &mut self,
        statement: WithdrawalStatement,
    ) -> Result<(), WatcherError> {
        statement.validate_development()?;
        if self.spent_nullifiers.contains(&statement.nullifier_0)
            || self.spent_nullifiers.contains(&statement.nullifier_1)
        {
            return Err(WatcherError::NullifierAlreadySpent);
        }
        self.spent_nullifiers.push(statement.nullifier_0);
        self.spent_nullifiers.push(statement.nullifier_1);
        if statement.change_commitment != [0u8; 32] {
            if self.commitments.contains(&statement.change_commitment) {
                return Err(WatcherError::DuplicateCommitment);
            }
            self.commitments.push(statement.change_commitment);
        }
        Ok(())
    }

    pub fn is_spent(&self, nullifier: &[u8; 32]) -> bool {
        self.spent_nullifiers.contains(nullifier)
    }
}

#[derive(Error, Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum WatcherError {
    #[error("amount must be non-zero")]
    ZeroAmount = 0,
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
    #[error("invalid instruction data")]
    InvalidInstruction,
    #[error("invalid protocol account data")]
    InvalidAccountData,
    #[error("protocol account is already initialized")]
    AlreadyInitialized,
    #[error("registry capacity exhausted")]
    RegistryFull,
    #[error("invalid circuit public inputs")]
    InvalidPublicInputs,
    #[error("statement does not match proof public inputs")]
    PublicInputMismatch,
    #[error("invalid Groth16 proof encoding")]
    InvalidProofEncoding,
    #[error("Groth16 proof verification failed")]
    InvalidGroth16Proof,
    #[error("manual Merkle root updates are disabled; root is derived from commitments")]
    ManualMerkleRootDisabled,
    #[error("commitment is not a canonical little-endian BN254 scalar field element")]
    InvalidCommitmentField,
    #[error("Circuit V1 Merkle tree capacity exhausted")]
    MerkleTreeFull,
    #[error("Merkle root is not present in the recent-root history")]
    UnknownMerkleRoot,
    #[error("current Merkle root does not match the latest root-history entry")]
    RootHistoryMismatch,
    #[error("vault PDA does not match this protocol configuration")]
    InvalidVaultAddress,
    #[error("vault account state is invalid")]
    InvalidVaultState,
    #[error("vault lamports do not cover rent reserve plus tracked liabilities")]
    VaultBalanceInvariant,
    #[error("vault tracked balance is too low for this withdrawal")]
    InsufficientVaultBalance,
    #[error("arithmetic overflow")]
    ArithmeticOverflow,
    #[error("invalid system program account")]
    InvalidSystemProgram,
    #[error("invalid payout account")]
    InvalidPayoutAccount,
    #[error("unsupported asset")]
    UnsupportedAsset,
}

impl From<WatcherError> for ProgramError {
    fn from(value: WatcherError) -> Self {
        ProgramError::Custom(value as u32 + 1)
    }
}

/// Legacy helper retained only for old tests. New processor code uses the
/// circuit-specific verifier functions.
pub fn verify_withdrawal_proof(_proof: &[u8], _inputs: &[u8]) -> Result<(), WatcherError> {
    Err(WatcherError::ProofVerificationUnavailable)
}
