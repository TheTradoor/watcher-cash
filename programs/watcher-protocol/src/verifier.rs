use crate::{
    dev_fixture::{DEV_DEPOSIT_VK_BYTES, DEV_VK_BYTES},
    public_inputs::{
        validate_deposit_binding, validate_statement_binding, CircuitV1PublicInputs,
        DepositV1PublicInputs,
    },
    WatcherError, WithdrawalStatement,
};
use groth16_solana::groth16::verify_groth16_strict;

pub const GROTH16_BN254_PROOF_BYTES: usize = 256;
const DEPOSIT_PUBLIC_INPUT_BYTES: usize = 3 * 32;
const WITHDRAW_PUBLIC_INPUT_BYTES: usize = 10 * 32;

// The existing circuit/exporter wire format is little-endian per 32-byte field.
// groth16-solana consumes the same point/component order in big-endian form.
// Converting the static VKs in const-eval keeps the on-chain hot path limited to
// the proof/public-input conversion plus the native alt_bn128 syscalls.
const fn field_chunks_le_to_be<const N: usize>(input: [u8; N]) -> [u8; N] {
    let mut output = [0u8; N];
    let mut chunk = 0usize;
    while chunk < N {
        let mut offset = 0usize;
        while offset < 32 {
            output[chunk + offset] = input[chunk + 31 - offset];
            offset += 1;
        }
        chunk += 32;
    }
    output
}

const DEV_DEPOSIT_VK_BE_BYTES: [u8; 704] = field_chunks_le_to_be(DEV_DEPOSIT_VK_BYTES);
const DEV_WITHDRAW_VK_BE_BYTES: [u8; 1152] = field_chunks_le_to_be(DEV_VK_BYTES);

fn proof_le_to_be(proof: &[u8]) -> Result<[u8; GROTH16_BN254_PROOF_BYTES], WatcherError> {
    if proof.len() != GROTH16_BN254_PROOF_BYTES {
        return Err(WatcherError::InvalidProofEncoding);
    }
    let mut output = [0u8; GROTH16_BN254_PROOF_BYTES];
    let mut chunk = 0usize;
    while chunk < GROTH16_BN254_PROOF_BYTES {
        let mut offset = 0usize;
        while offset < 32 {
            output[chunk + offset] = proof[chunk + 31 - offset];
            offset += 1;
        }
        chunk += 32;
    }
    Ok(output)
}

fn write_be_field(output: &mut [u8], index: usize, field_le: &[u8; 32]) {
    let start = index * 32;
    let mut offset = 0usize;
    while offset < 32 {
        output[start + offset] = field_le[31 - offset];
        offset += 1;
    }
}

fn deposit_public_inputs_be(inputs: &DepositV1PublicInputs) -> [u8; DEPOSIT_PUBLIC_INPUT_BYTES] {
    let mut output = [0u8; DEPOSIT_PUBLIC_INPUT_BYTES];
    write_be_field(&mut output, 0, &inputs.commitment);
    write_be_field(&mut output, 1, &inputs.amount);
    write_be_field(&mut output, 2, &inputs.asset_id);
    output
}

fn withdraw_public_inputs_be(inputs: &CircuitV1PublicInputs) -> [u8; WITHDRAW_PUBLIC_INPUT_BYTES] {
    let mut output = [0u8; WITHDRAW_PUBLIC_INPUT_BYTES];
    let fields = [
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
    ];
    let mut index = 0usize;
    while index < fields.len() {
        write_be_field(&mut output, index, &fields[index]);
        index += 1;
    }
    output
}

fn verify_native(
    verifying_key: &[u8],
    proof_le: &[u8],
    public_inputs_be: &[u8],
) -> Result<(), WatcherError> {
    let proof_be = proof_le_to_be(proof_le)?;
    match verify_groth16_strict(verifying_key, &proof_be, public_inputs_be) {
        Ok(true) => Ok(()),
        Ok(false) | Err(_) => Err(WatcherError::InvalidGroth16Proof),
    }
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
    let public_inputs_be = deposit_public_inputs_be(&inputs);
    verify_native(&DEV_DEPOSIT_VK_BE_BYTES, proof, &public_inputs_be)
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
    let public_inputs_be = withdraw_public_inputs_be(&inputs);
    verify_native(&DEV_WITHDRAW_VK_BE_BYTES, proof, &public_inputs_be)
}
