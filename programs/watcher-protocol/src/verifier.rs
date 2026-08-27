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

// The existing circuit/exporter wire format is little-endian per 32-byte field.
// groth16-solana consumes the same point/component order in big-endian form.
// Converting the static VKs in const-eval keeps the on-chain hot path limited to
// proof/public-input conversion plus the native alt_bn128 syscalls.
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

const fn take_bytes<const SOURCE: usize, const OUTPUT: usize>(
    source: &[u8; SOURCE],
    start: usize,
) -> [u8; OUTPUT] {
    let mut output = [0u8; OUTPUT];
    let mut index = 0usize;
    while index < OUTPUT {
        output[index] = source[start + index];
        index += 1;
    }
    output
}

const fn take_g1_points<const SOURCE: usize, const POINTS: usize>(
    source: &[u8; SOURCE],
    start: usize,
) -> [[u8; 64]; POINTS] {
    let mut output = [[0u8; 64]; POINTS];
    let mut point = 0usize;
    while point < POINTS {
        let mut byte = 0usize;
        while byte < 64 {
            output[point][byte] = source[start + point * 64 + byte];
            byte += 1;
        }
        point += 1;
    }
    output
}

const DEV_DEPOSIT_VK_BE_BYTES: [u8; 704] = field_chunks_le_to_be(DEV_DEPOSIT_VK_BYTES);
const DEV_WITHDRAW_VK_BE_BYTES: [u8; 1152] = field_chunks_le_to_be(DEV_VK_BYTES);

static DEV_DEPOSIT_IC_BE: [[u8; 64]; 4] =
    take_g1_points::<704, 4>(&DEV_DEPOSIT_VK_BE_BYTES, 448);
static DEV_WITHDRAW_IC_BE: [[u8; 64]; 11] =
    take_g1_points::<1152, 11>(&DEV_WITHDRAW_VK_BE_BYTES, 448);

static DEV_DEPOSIT_VERIFYING_KEY: Groth16Verifyingkey<'static> = Groth16Verifyingkey {
    nr_pubinputs: 3,
    vk_alpha_g1: take_bytes::<704, 64>(&DEV_DEPOSIT_VK_BE_BYTES, 0),
    vk_beta_g2: take_bytes::<704, 128>(&DEV_DEPOSIT_VK_BE_BYTES, 64),
    vk_gamma_g2: take_bytes::<704, 128>(&DEV_DEPOSIT_VK_BE_BYTES, 192),
    vk_delta_g2: take_bytes::<704, 128>(&DEV_DEPOSIT_VK_BE_BYTES, 320),
    vk_ic: &DEV_DEPOSIT_IC_BE,
    vk_commitment: None,
};

static DEV_WITHDRAW_VERIFYING_KEY: Groth16Verifyingkey<'static> = Groth16Verifyingkey {
    nr_pubinputs: 10,
    vk_alpha_g1: take_bytes::<1152, 64>(&DEV_WITHDRAW_VK_BE_BYTES, 0),
    vk_beta_g2: take_bytes::<1152, 128>(&DEV_WITHDRAW_VK_BE_BYTES, 64),
    vk_gamma_g2: take_bytes::<1152, 128>(&DEV_WITHDRAW_VK_BE_BYTES, 192),
    vk_delta_g2: take_bytes::<1152, 128>(&DEV_WITHDRAW_VK_BE_BYTES, 320),
    vk_ic: &DEV_WITHDRAW_IC_BE,
    vk_commitment: None,
};

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

fn field_le_to_be(field_le: &[u8; 32]) -> [u8; 32] {
    let mut output = [0u8; 32];
    let mut index = 0usize;
    while index < 32 {
        output[index] = field_le[31 - index];
        index += 1;
    }
    output
}

fn deposit_public_inputs_be(inputs: &DepositV1PublicInputs) -> [[u8; 32]; 3] {
    [
        field_le_to_be(&inputs.commitment),
        field_le_to_be(&inputs.amount),
        field_le_to_be(&inputs.asset_id),
    ]
}

fn withdraw_public_inputs_be(inputs: &CircuitV1PublicInputs) -> [[u8; 32]; 10] {
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
    ]
}

fn verify_native<const INPUTS: usize>(
    verifying_key: &'static Groth16Verifyingkey<'static>,
    proof_le: &[u8],
    public_inputs_be: &[[u8; 32]; INPUTS],
) -> Result<(), WatcherError> {
    let proof_be = proof_le_to_be(proof_le)?;
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
    verify_native(&DEV_DEPOSIT_VERIFYING_KEY, proof, &public_inputs_be)
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
    verify_native(&DEV_WITHDRAW_VERIFYING_KEY, proof, &public_inputs_be)
}
