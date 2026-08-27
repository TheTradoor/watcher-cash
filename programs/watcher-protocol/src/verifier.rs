use crate::{
    dev_fixture::{DEV_DEPOSIT_VK_BYTES, DEV_VK_BYTES},
    public_inputs::{
        validate_deposit_binding, validate_statement_binding, CircuitV1PublicInputs,
        DepositV1PublicInputs,
    },
    WatcherError, WithdrawalStatement,
};
use groth16_solana::groth16::{Groth16Verifier, Groth16Verifyingkey};

pub const GROTH16_BN254_PROOF_BYTES: usize = 256;

const fn reverse_field_from<const SOURCE: usize>(source: &[u8; SOURCE], start: usize) -> [u8; 32] {
    let mut output = [0u8; 32];
    let mut index = 0usize;
    while index < 32 {
        output[index] = source[start + 31 - index];
        index += 1;
    }
    output
}

const fn copy_field<const OUTPUT: usize>(
    output: &mut [u8; OUTPUT],
    output_start: usize,
    field: &[u8; 32],
) {
    let mut index = 0usize;
    while index < 32 {
        output[output_start + index] = field[index];
        index += 1;
    }
}

const fn g1_xark_le_to_gnark_be<const SOURCE: usize>(
    source: &[u8; SOURCE],
    start: usize,
) -> [u8; 64] {
    let mut output = [0u8; 64];
    let x = reverse_field_from(source, start);
    let y = reverse_field_from(source, start + 32);
    copy_field(&mut output, 0, &x);
    copy_field(&mut output, 32, &y);
    output
}

const fn g2_xark_le_to_gnark_be<const SOURCE: usize>(
    source: &[u8; SOURCE],
    start: usize,
) -> [u8; 128] {
    let mut output = [0u8; 128];
    let x_a1 = reverse_field_from(source, start + 32);
    let x_a0 = reverse_field_from(source, start);
    let y_a1 = reverse_field_from(source, start + 96);
    let y_a0 = reverse_field_from(source, start + 64);
    copy_field(&mut output, 0, &x_a1);
    copy_field(&mut output, 32, &x_a0);
    copy_field(&mut output, 64, &y_a1);
    copy_field(&mut output, 96, &y_a0);
    output
}

const fn g1_points_xark_le_to_gnark_be<const SOURCE: usize, const POINTS: usize>(
    source: &[u8; SOURCE],
    start: usize,
) -> [[u8; 64]; POINTS] {
    let mut output = [[0u8; 64]; POINTS];
    let mut point = 0usize;
    while point < POINTS {
        output[point] = g1_xark_le_to_gnark_be(source, start + point * 64);
        point += 1;
    }
    output
}

static DEV_DEPOSIT_IC_BE: [[u8; 64]; 7] =
    g1_points_xark_le_to_gnark_be::<896, 7>(&DEV_DEPOSIT_VK_BYTES, 448);
static DEV_WITHDRAW_IC_BE: [[u8; 64]; 14] =
    g1_points_xark_le_to_gnark_be::<1344, 14>(&DEV_VK_BYTES, 448);

static DEV_DEPOSIT_VERIFYING_KEY: Groth16Verifyingkey<'static> = Groth16Verifyingkey {
    nr_pubinputs: 6,
    vk_alpha_g1: g1_xark_le_to_gnark_be(&DEV_DEPOSIT_VK_BYTES, 0),
    vk_beta_g2: g2_xark_le_to_gnark_be(&DEV_DEPOSIT_VK_BYTES, 64),
    vk_gamma_g2: g2_xark_le_to_gnark_be(&DEV_DEPOSIT_VK_BYTES, 192),
    vk_delta_g2: g2_xark_le_to_gnark_be(&DEV_DEPOSIT_VK_BYTES, 320),
    vk_ic: &DEV_DEPOSIT_IC_BE,
    vk_commitment: None,
};

static DEV_WITHDRAW_VERIFYING_KEY: Groth16Verifyingkey<'static> = Groth16Verifyingkey {
    nr_pubinputs: 13,
    vk_alpha_g1: g1_xark_le_to_gnark_be(&DEV_VK_BYTES, 0),
    vk_beta_g2: g2_xark_le_to_gnark_be(&DEV_VK_BYTES, 64),
    vk_gamma_g2: g2_xark_le_to_gnark_be(&DEV_VK_BYTES, 192),
    vk_delta_g2: g2_xark_le_to_gnark_be(&DEV_VK_BYTES, 320),
    vk_ic: &DEV_WITHDRAW_IC_BE,
    vk_commitment: None,
};

fn reverse_field_into(output: &mut [u8], output_start: usize, source: &[u8], source_start: usize) {
    let mut index = 0usize;
    while index < 32 {
        output[output_start + index] = source[source_start + 31 - index];
        index += 1;
    }
}

#[inline(never)]
fn proof_xark_le_to_gnark_be(
    proof: &[u8],
) -> Result<[u8; GROTH16_BN254_PROOF_BYTES], WatcherError> {
    if proof.len() != GROTH16_BN254_PROOF_BYTES {
        return Err(WatcherError::InvalidProofEncoding);
    }
    let mut output = [0u8; GROTH16_BN254_PROOF_BYTES];
    reverse_field_into(&mut output, 0, proof, 0);
    reverse_field_into(&mut output, 32, proof, 32);
    reverse_field_into(&mut output, 64, proof, 96);
    reverse_field_into(&mut output, 96, proof, 64);
    reverse_field_into(&mut output, 128, proof, 160);
    reverse_field_into(&mut output, 160, proof, 128);
    reverse_field_into(&mut output, 192, proof, 192);
    reverse_field_into(&mut output, 224, proof, 224);
    Ok(output)
}

fn field_le_to_be(field_le: &[u8; 32]) -> [u8; 32] {
    let mut output = [0u8; 32];
    let mut index = 0usize;
    while index < 32 {
        output[index] = field_le[31 - index];
        index += 1;
    }
    output
}

#[inline(never)]
fn deposit_public_inputs_be(inputs: &DepositV1PublicInputs) -> [[u8; 32]; 6] {
    [
        field_le_to_be(&inputs.commitment),
        field_le_to_be(&inputs.amount),
        field_le_to_be(&inputs.asset_id),
        field_le_to_be(&inputs.old_root),
        field_le_to_be(&inputs.new_root),
        field_le_to_be(&inputs.leaf_index),
    ]
}

#[inline(never)]
fn withdraw_public_inputs_be(inputs: &CircuitV1PublicInputs) -> [[u8; 32]; 13] {
    [
        field_le_to_be(&inputs.merkle_root),
        field_le_to_be(&inputs.nullifier_0),
        field_le_to_be(&inputs.nullifier_1),
        field_le_to_be(&inputs.change_commitment),
        field_le_to_be(&inputs.public_amount),
        field_le_to_be(&inputs.protocol_fee),
        field_le_to_be(&inputs.relayer_fee),
        field_le_to_be(&inputs.recipient_binding),
        field_le_to_be(&inputs.asset_id),
        field_le_to_be(&inputs.context_binding),
        field_le_to_be(&inputs.current_root),
        field_le_to_be(&inputs.new_merkle_root),
        field_le_to_be(&inputs.change_leaf_index),
    ]
}

#[inline(never)]
fn verify_native<const INPUTS: usize>(
    verifying_key: &'static Groth16Verifyingkey<'static>,
    proof_le: &[u8],
    public_inputs_be: &[[u8; 32]; INPUTS],
) -> Result<(), WatcherError> {
    let proof_be = proof_xark_le_to_gnark_be(proof_le)?;
    let proof_a: &[u8; 64] = proof_be[0..64]
        .try_into()
        .map_err(|_| WatcherError::InvalidProofEncoding)?;
    let proof_b: &[u8; 128] = proof_be[64..192]
        .try_into()
        .map_err(|_| WatcherError::InvalidProofEncoding)?;
    let proof_c: &[u8; 64] = proof_be[192..256]
        .try_into()
        .map_err(|_| WatcherError::InvalidProofEncoding)?;
    let mut verifier =
        Groth16Verifier::<INPUTS>::new(proof_a, proof_b, proof_c, public_inputs_be, verifying_key)
            .map_err(|_| WatcherError::InvalidGroth16Proof)?;
    verifier
        .verify()
        .map_err(|_| WatcherError::InvalidGroth16Proof)
}

#[inline(never)]
pub fn verify_deposit_v1(
    commitment: &[u8; 32],
    amount: u64,
    expected_asset_id: &[u8; 32],
    expected_old_root: &[u8; 32],
    expected_leaf_index: u64,
    proof: &[u8],
    public_input_bytes: &[u8],
) -> Result<(), WatcherError> {
    let inputs = DepositV1PublicInputs::decode(public_input_bytes)?;
    validate_deposit_binding(
        commitment,
        amount,
        expected_asset_id,
        expected_old_root,
        expected_leaf_index,
        &inputs,
    )?;
    let public_inputs_be = deposit_public_inputs_be(&inputs);
    verify_native(&DEV_DEPOSIT_VERIFYING_KEY, proof, &public_inputs_be)
}

#[inline(never)]
pub fn verify_circuit_v1(
    statement: &WithdrawalStatement,
    trusted_spend_root: &[u8; 32],
    expected_current_root: &[u8; 32],
    expected_change_leaf_index: u64,
    expected_asset_id: &[u8; 32],
    expected_context_binding: &[u8; 32],
    proof: &[u8],
    public_input_bytes: &[u8],
) -> Result<(), WatcherError> {
    let inputs = CircuitV1PublicInputs::decode(public_input_bytes)?;
    validate_statement_binding(
        statement,
        trusted_spend_root,
        expected_current_root,
        expected_change_leaf_index,
        expected_asset_id,
        expected_context_binding,
        &inputs,
    )?;
    let public_inputs_be = withdraw_public_inputs_be(&inputs);
    verify_native(&DEV_WITHDRAW_VERIFYING_KEY, proof, &public_inputs_be)
}
