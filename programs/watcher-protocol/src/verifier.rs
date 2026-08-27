use crate::{
    dev_fixture::{DEV_DEPOSIT_VK_BYTES, DEV_VK_BYTES},
    public_inputs::{
        validate_deposit_binding, validate_statement_binding, CircuitV1PublicInputs,
        DepositV1PublicInputs, CIRCUIT_V1_PUBLIC_INPUTS, DEPOSIT_V1_PUBLIC_INPUTS,
    },
    WatcherError, WithdrawalStatement,
};
use xark_verifier::{Proof, Verifier};

pub const GROTH16_BN254_PROOF_BYTES: usize = 256;

const CIRCUIT_V1_DEV_VERIFIER: Verifier<CIRCUIT_V1_PUBLIC_INPUTS> =
    Verifier::from_le_bytes(&DEV_VK_BYTES);
const DEPOSIT_V1_DEV_VERIFIER: Verifier<DEPOSIT_V1_PUBLIC_INPUTS> =
    Verifier::from_le_bytes(&DEV_DEPOSIT_VK_BYTES);

fn parse_proof(proof: &[u8]) -> Result<Proof, WatcherError> {
    if proof.len() != GROTH16_BN254_PROOF_BYTES {
        return Err(WatcherError::InvalidProofEncoding);
    }
    let proof_array: &[u8; GROTH16_BN254_PROOF_BYTES] = proof
        .try_into()
        .map_err(|_| WatcherError::InvalidProofEncoding)?;
    Ok(Proof::from_le_bytes(proof_array))
}

fn to_le_deposit_inputs(
    inputs: &DepositV1PublicInputs,
) -> [[u8; 32]; DEPOSIT_V1_PUBLIC_INPUTS] {
    [inputs.commitment, inputs.amount, inputs.asset_id]
}

fn to_le_withdraw_inputs(
    inputs: &CircuitV1PublicInputs,
) -> [[u8; 32]; CIRCUIT_V1_PUBLIC_INPUTS] {
    [
        inputs.merkle_root,
        inputs.nullifier_0,
        inputs.nullifier_1,
        inputs.change_commitment,
        inputs.public_amount,
        inputs.protocol_fee,
        inputs.relayer_fee,
        inputs.recipient_binding,
        inputs.asset_id,
        inputs.context_binding,
    ]
}

pub fn verify_deposit_v1(
    commitment: &[u8; 32],
    amount: u64,
    expected_asset_id: &[u8; 32],
    proof: &[u8],
    public_input_bytes: &[u8],
) -> Result<(), WatcherError> {
    let inputs = DepositV1PublicInputs::decode(public_input_bytes)?;
    validate_deposit_binding(commitment, amount, expected_asset_id, &inputs)?;
    let parsed = parse_proof(proof)?;
    let public_inputs = to_le_deposit_inputs(&inputs);
    if DEPOSIT_V1_DEV_VERIFIER.verify(&parsed, &public_inputs) {
        Ok(())
    } else {
        Err(WatcherError::InvalidGroth16Proof)
    }
}

pub fn verify_circuit_v1(
    statement: &WithdrawalStatement,
    trusted_merkle_root: &[u8; 32],
    expected_asset_id: &[u8; 32],
    expected_context_binding: &[u8; 32],
    proof: &[u8],
    public_input_bytes: &[u8],
) -> Result<(), WatcherError> {
    let inputs = CircuitV1PublicInputs::decode(public_input_bytes)?;
    validate_statement_binding(
        statement,
        trusted_merkle_root,
        expected_asset_id,
        expected_context_binding,
        &inputs,
    )?;
    let parsed = parse_proof(proof)?;
    let public_inputs = to_le_withdraw_inputs(&inputs);
    if CIRCUIT_V1_DEV_VERIFIER.verify(&parsed, &public_inputs) {
        Ok(())
    } else {
        Err(WatcherError::InvalidGroth16Proof)
    }
}
