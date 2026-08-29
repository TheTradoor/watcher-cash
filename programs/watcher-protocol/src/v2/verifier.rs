use groth16_solana::groth16::{Groth16Verifier, Groth16Verifyingkey};

use crate::WatcherError;

use super::public_inputs::{DepositPublicInputsV2, WithdrawPublicInputsV2};

pub const DEPOSIT_VK_BYTES_V2: usize = 1024;
pub const WITHDRAW_VK_BYTES_V2: usize = 1728;
pub const GROTH16_PROOF_BYTES_V2: usize = 256;

const DEV_DEPOSIT_VK_BYTES: [u8; DEPOSIT_VK_BYTES_V2] = include!("dev_deposit_vk_array.in");
const DEV_WITHDRAW_VK_BYTES: [u8; WITHDRAW_VK_BYTES_V2] = include!("dev_withdraw_vk_array.in");

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

static DEV_DEPOSIT_IC_BE: [[u8; 64]; 9] =
    g1_points_xark_le_to_gnark_be::<DEPOSIT_VK_BYTES_V2, 9>(&DEV_DEPOSIT_VK_BYTES, 448);
static DEV_WITHDRAW_IC_BE: [[u8; 64]; 20] =
    g1_points_xark_le_to_gnark_be::<WITHDRAW_VK_BYTES_V2, 20>(&DEV_WITHDRAW_VK_BYTES, 448);

static DEV_DEPOSIT_VERIFYING_KEY: Groth16Verifyingkey<'static> = Groth16Verifyingkey {
    nr_pubinputs: 8,
    vk_alpha_g1: g1_xark_le_to_gnark_be(&DEV_DEPOSIT_VK_BYTES, 0),
    vk_beta_g2: g2_xark_le_to_gnark_be(&DEV_DEPOSIT_VK_BYTES, 64),
    vk_gamma_g2: g2_xark_le_to_gnark_be(&DEV_DEPOSIT_VK_BYTES, 192),
    vk_delta_g2: g2_xark_le_to_gnark_be(&DEV_DEPOSIT_VK_BYTES, 320),
    vk_ic: &DEV_DEPOSIT_IC_BE,
    vk_commitment: None,
};

static DEV_WITHDRAW_VERIFYING_KEY: Groth16Verifyingkey<'static> = Groth16Verifyingkey {
    nr_pubinputs: 19,
    vk_alpha_g1: g1_xark_le_to_gnark_be(&DEV_WITHDRAW_VK_BYTES, 0),
    vk_beta_g2: g2_xark_le_to_gnark_be(&DEV_WITHDRAW_VK_BYTES, 64),
    vk_gamma_g2: g2_xark_le_to_gnark_be(&DEV_WITHDRAW_VK_BYTES, 192),
    vk_delta_g2: g2_xark_le_to_gnark_be(&DEV_WITHDRAW_VK_BYTES, 320),
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

fn proof_xark_le_to_gnark_be(
    proof: &[u8],
) -> Result<[u8; GROTH16_PROOF_BYTES_V2], WatcherError> {
    if proof.len() != GROTH16_PROOF_BYTES_V2 {
        return Err(WatcherError::InvalidProofEncoding);
    }
    let mut output = [0u8; GROTH16_PROOF_BYTES_V2];
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

fn field_le_to_be(field: &[u8; 32]) -> [u8; 32] {
    let mut output = [0u8; 32];
    let mut index = 0usize;
    while index < 32 {
        output[index] = field[31 - index];
        index += 1;
    }
    output
}

fn deposit_public_inputs_be(inputs: &DepositPublicInputsV2) -> [[u8; 32]; 8] {
    [
        field_le_to_be(&inputs.commitment),
        field_le_to_be(&inputs.amount),
        field_le_to_be(&inputs.asset_id),
        field_le_to_be(&inputs.epoch),
        field_le_to_be(&inputs.context_binding),
        field_le_to_be(&inputs.old_root),
        field_le_to_be(&inputs.new_root),
        field_le_to_be(&inputs.leaf_index),
    ]
}

fn withdraw_public_inputs_be(inputs: &WithdrawPublicInputsV2) -> [[u8; 32]; 19] {
    let mut output = [[0u8; 32]; 19];
    let mut cursor = 0usize;
    for root in &inputs.input_roots {
        output[cursor] = field_le_to_be(root);
        cursor += 1;
    }
    for nullifier in &inputs.nullifiers {
        output[cursor] = field_le_to_be(nullifier);
        cursor += 1;
    }
    for field in [
        &inputs.input_count,
        &inputs.change_commitment,
        &inputs.public_amount,
        &inputs.protocol_fee,
        &inputs.relayer_fee,
        &inputs.recipient_binding,
        &inputs.asset_id,
        &inputs.context_binding,
        &inputs.current_root,
        &inputs.new_merkle_root,
        &inputs.change_leaf_index,
    ] {
        output[cursor] = field_le_to_be(field);
        cursor += 1;
    }
    debug_assert_eq!(cursor, 19);
    output
}

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
    let mut verifier = Groth16Verifier::<INPUTS>::new(
        proof_a,
        proof_b,
        proof_c,
        public_inputs_be,
        verifying_key,
    )
    .map_err(|_| WatcherError::InvalidGroth16Proof)?;
    verifier
        .verify()
        .map_err(|_| WatcherError::InvalidGroth16Proof)
}

pub fn verify_deposit_v2(
    inputs: &DepositPublicInputsV2,
    proof: &[u8],
) -> Result<(), WatcherError> {
    verify_native(
        &DEV_DEPOSIT_VERIFYING_KEY,
        proof,
        &deposit_public_inputs_be(inputs),
    )
}

pub fn verify_withdraw_v2(
    inputs: &WithdrawPublicInputsV2,
    proof: &[u8],
) -> Result<(), WatcherError> {
    verify_native(
        &DEV_WITHDRAW_VERIFYING_KEY,
        proof,
        &withdraw_public_inputs_be(inputs),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_DEPOSIT_PROOF: [u8; 256] = include!("dev_deposit_proof_array.in");
    const SAMPLE_DEPOSIT_PUBLIC: [u8; 256] = include!("dev_deposit_public_inputs_array.in");
    const SAMPLE_WITHDRAW_PROOF: [u8; 256] = include!("dev_withdraw_proof_array.in");
    const SAMPLE_WITHDRAW_PUBLIC: [u8; 608] = include!("dev_withdraw_public_inputs_array.in");

    fn public_wire_to_be<const INPUTS: usize>(wire: &[u8]) -> [[u8; 32]; INPUTS] {
        assert_eq!(wire.len(), INPUTS * 32);
        let mut output = [[0u8; 32]; INPUTS];
        for (index, field) in output.iter_mut().enumerate() {
            let start = index * 32;
            let source: &[u8; 32] = wire[start..start + 32].try_into().unwrap();
            *field = field_le_to_be(source);
        }
        output
    }

    #[test]
    fn matched_deposit_fixture_verifies_in_rust() {
        let public = public_wire_to_be::<8>(&SAMPLE_DEPOSIT_PUBLIC);
        verify_native(&DEV_DEPOSIT_VERIFYING_KEY, &SAMPLE_DEPOSIT_PROOF, &public).unwrap();
    }

    #[test]
    fn matched_withdraw_fixture_verifies_in_rust() {
        let public = public_wire_to_be::<19>(&SAMPLE_WITHDRAW_PUBLIC);
        verify_native(&DEV_WITHDRAW_VERIFYING_KEY, &SAMPLE_WITHDRAW_PROOF, &public).unwrap();
    }

    #[test]
    fn tampered_v2_public_input_is_rejected() {
        let mut public = public_wire_to_be::<19>(&SAMPLE_WITHDRAW_PUBLIC);
        public[10][31] ^= 1;
        assert_eq!(
            verify_native(&DEV_WITHDRAW_VERIFYING_KEY, &SAMPLE_WITHDRAW_PROOF, &public),
            Err(WatcherError::InvalidGroth16Proof)
        );
    }
}
