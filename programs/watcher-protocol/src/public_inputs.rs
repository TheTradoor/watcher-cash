use solana_program::pubkey::Pubkey;
use crate::{WatcherError, WithdrawalStatement};

pub const FIELD_BYTES: usize = 32;
pub const CIRCUIT_V1_PUBLIC_INPUTS: usize = 10;
pub const CIRCUIT_V1_PUBLIC_INPUT_BYTES: usize = FIELD_BYTES * CIRCUIT_V1_PUBLIC_INPUTS;

/// Canonical CircuitV1 public-input order. This MUST match gnark's public field order:
/// MerkleRoot, Nullifier0, Nullifier1, ChangeCommitment, PublicAmount, ProtocolFee,
/// RelayerFee, RecipientBinding, AssetID, ContextBinding.
///
/// Wire encoding is little-endian 32-byte BN254 scalar limbs, matching the
/// coordinate/public-witness fixture exported for the Solana verifier.
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

fn field_from_u64(value: u64) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[..8].copy_from_slice(&value.to_le_bytes());
    out
}

/// RecipientBinding is intentionally not checked yet. It must be derived with the
/// exact circuit-side hash-to-field construction before custody is enabled.
pub fn validate_statement_binding(statement: &WithdrawalStatement, inputs: &CircuitV1PublicInputs) -> Result<(), WatcherError> {
    if inputs.nullifier_0 != statement.nullifier_0 || inputs.nullifier_1 != statement.nullifier_1 {
        return Err(WatcherError::PublicInputMismatch);
    }
    if inputs.change_commitment != statement.change_commitment { return Err(WatcherError::PublicInputMismatch); }
    if inputs.public_amount != field_from_u64(statement.public_amount)
        || inputs.protocol_fee != field_from_u64(statement.protocol_fee)
        || inputs.relayer_fee != field_from_u64(statement.relayer_fee)
    { return Err(WatcherError::PublicInputMismatch); }
    Ok(())
}

impl CircuitV1PublicInputs {
    pub fn decode(bytes: &[u8]) -> Result<Self, WatcherError> {
        if bytes.len() != CIRCUIT_V1_PUBLIC_INPUT_BYTES { return Err(WatcherError::InvalidPublicInputs); }
        let f = |i: usize| -> [u8; 32] { bytes[i*32..(i+1)*32].try_into().unwrap() };
        Ok(Self { merkle_root:f(0),nullifier_0:f(1),nullifier_1:f(2),change_commitment:f(3),public_amount:f(4),protocol_fee:f(5),relayer_fee:f(6),recipient_binding:f(7),asset_id:f(8),context_binding:f(9) })
    }

    pub fn encode(&self) -> [u8; CIRCUIT_V1_PUBLIC_INPUT_BYTES] {
        let fields=[self.merkle_root,self.nullifier_0,self.nullifier_1,self.change_commitment,self.public_amount,self.protocol_fee,self.relayer_fee,self.recipient_binding,self.asset_id,self.context_binding];
        let mut out=[0u8;CIRCUIT_V1_PUBLIC_INPUT_BYTES];
        for (i,f) in fields.iter().enumerate(){out[i*32..(i+1)*32].copy_from_slice(f);}
        out
    }
}

pub fn recipient_pubkey_bytes(recipient: &Pubkey) -> [u8;32] { recipient.to_bytes() }
