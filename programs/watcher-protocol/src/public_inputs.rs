use solana_program::{hash::hashv, pubkey::Pubkey};

use crate::{WatcherError, WithdrawalStatement, SOL_ASSET_ID_V1};

pub const FIELD_BYTES: usize = 32;
pub const DEPOSIT_V1_PUBLIC_INPUTS: usize = 3;
pub const DEPOSIT_V1_PUBLIC_INPUT_BYTES: usize = FIELD_BYTES * DEPOSIT_V1_PUBLIC_INPUTS;
pub const CIRCUIT_V1_PUBLIC_INPUTS: usize = 10;
pub const CIRCUIT_V1_PUBLIC_INPUT_BYTES: usize = FIELD_BYTES * CIRCUIT_V1_PUBLIC_INPUTS;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DepositV1PublicInputs {
    pub commitment: [u8; 32],
    pub amount: [u8; 32],
    pub asset_id: [u8; 32],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CircuitV1PublicInputs {
    pub merkle_root: [u8; 32],
    pub nullifier_0: [u8; 32],
    pub nullifier_1: [u8; 32],
    pub change_commitment: [u8; 32],
    pub public_amount: [u8; 32],
    pub protocol_fee: [u8; 32],
    pub relayer_fee: [u8; 32],
    pub recipient_binding: [u8; 32],
    pub asset_id: [u8; 32],
    pub context_binding: [u8; 32],
}

pub fn field_from_u64_v1(value: u64) -> [u8; 32] {
    let mut output = [0u8; 32];
    output[..8].copy_from_slice(&value.to_le_bytes());
    output
}

pub fn sol_asset_id_field_v1() -> [u8; 32] {
    field_from_u64_v1(SOL_ASSET_ID_V1)
}

/// Domain-separated hash-to-field used by the program for recipient binding.
/// Masking to 253 bits guarantees the little-endian value is below the BN254
/// scalar modulus.
pub fn recipient_binding_v1(recipient: &Pubkey) -> [u8; 32] {
    let digest = hashv(&[b"watcher-recipient-v1", recipient.as_ref()]);
    let mut output = digest.to_bytes();
    output[31] &= 0x1f;
    output
}

/// Binds a withdrawal proof to one concrete Watcher deployment, vault, relayer,
/// treasury, and asset. This prevents a valid proof from being replayed with
/// substituted payout accounts or against a different protocol instance.
pub fn withdraw_context_binding_v1(
    program_id: &Pubkey,
    config: &Pubkey,
    vault: &Pubkey,
    relayer: &Pubkey,
    treasury: &Pubkey,
    asset_id: &[u8; 32],
) -> [u8; 32] {
    let digest = hashv(&[
        b"watcher-withdraw-context-v1",
        program_id.as_ref(),
        config.as_ref(),
        vault.as_ref(),
        relayer.as_ref(),
        treasury.as_ref(),
        asset_id,
    ]);
    let mut output = digest.to_bytes();
    output[31] &= 0x1f;
    output
}

pub fn validate_deposit_binding(
    commitment: &[u8; 32],
    amount: u64,
    expected_asset_id: &[u8; 32],
    inputs: &DepositV1PublicInputs,
) -> Result<(), WatcherError> {
    if inputs.commitment != *commitment
        || inputs.amount != field_from_u64_v1(amount)
        || inputs.asset_id != *expected_asset_id
    {
        return Err(WatcherError::PublicInputMismatch);
    }
    Ok(())
}

pub fn validate_statement_binding(
    statement: &WithdrawalStatement,
    trusted_merkle_root: &[u8; 32],
    expected_asset_id: &[u8; 32],
    expected_context_binding: &[u8; 32],
    inputs: &CircuitV1PublicInputs,
) -> Result<(), WatcherError> {
    if *trusted_merkle_root == [0u8; 32] || inputs.merkle_root != *trusted_merkle_root {
        return Err(WatcherError::PublicInputMismatch);
    }
    if inputs.recipient_binding != recipient_binding_v1(&statement.recipient) {
        return Err(WatcherError::PublicInputMismatch);
    }
    if inputs.asset_id != *expected_asset_id
        || inputs.context_binding != *expected_context_binding
    {
        return Err(WatcherError::PublicInputMismatch);
    }
    if inputs.nullifier_0 != statement.nullifier_0
        || inputs.nullifier_1 != statement.nullifier_1
        || inputs.change_commitment != statement.change_commitment
    {
        return Err(WatcherError::PublicInputMismatch);
    }
    if inputs.public_amount != field_from_u64_v1(statement.public_amount)
        || inputs.protocol_fee != field_from_u64_v1(statement.protocol_fee)
        || inputs.relayer_fee != field_from_u64_v1(statement.relayer_fee)
    {
        return Err(WatcherError::PublicInputMismatch);
    }
    Ok(())
}

impl DepositV1PublicInputs {
    pub fn decode(bytes: &[u8]) -> Result<Self, WatcherError> {
        if bytes.len() != DEPOSIT_V1_PUBLIC_INPUT_BYTES {
            return Err(WatcherError::InvalidPublicInputs);
        }
        let field = |index: usize| -> [u8; 32] {
            bytes[index * 32..(index + 1) * 32]
                .try_into()
                .unwrap()
        };
        Ok(Self {
            commitment: field(0),
            amount: field(1),
            asset_id: field(2),
        })
    }

    pub fn encode(&self) -> [u8; DEPOSIT_V1_PUBLIC_INPUT_BYTES] {
        let fields = [self.commitment, self.amount, self.asset_id];
        let mut output = [0u8; DEPOSIT_V1_PUBLIC_INPUT_BYTES];
        for (index, field) in fields.iter().enumerate() {
            output[index * 32..(index + 1) * 32].copy_from_slice(field);
        }
        output
    }
}

impl CircuitV1PublicInputs {
    pub fn decode(bytes: &[u8]) -> Result<Self, WatcherError> {
        if bytes.len() != CIRCUIT_V1_PUBLIC_INPUT_BYTES {
            return Err(WatcherError::InvalidPublicInputs);
        }
        let field = |index: usize| -> [u8; 32] {
            bytes[index * 32..(index + 1) * 32]
                .try_into()
                .unwrap()
        };
        Ok(Self {
            merkle_root: field(0),
            nullifier_0: field(1),
            nullifier_1: field(2),
            change_commitment: field(3),
            public_amount: field(4),
            protocol_fee: field(5),
            relayer_fee: field(6),
            recipient_binding: field(7),
            asset_id: field(8),
            context_binding: field(9),
        })
    }

    pub fn encode(&self) -> [u8; CIRCUIT_V1_PUBLIC_INPUT_BYTES] {
        let fields = [
            self.merkle_root,
            self.nullifier_0,
            self.nullifier_1,
            self.change_commitment,
            self.public_amount,
            self.protocol_fee,
            self.relayer_fee,
            self.recipient_binding,
            self.asset_id,
            self.context_binding,
        ];
        let mut output = [0u8; CIRCUIT_V1_PUBLIC_INPUT_BYTES];
        for (index, field) in fields.iter().enumerate() {
            output[index * 32..(index + 1) * 32].copy_from_slice(field);
        }
        output
    }
}

pub fn recipient_pubkey_bytes(recipient: &Pubkey) -> [u8; 32] {
    recipient.to_bytes()
}
