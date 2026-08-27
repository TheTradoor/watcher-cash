use solana_program::pubkey::Pubkey;
use watcher_protocol_program::{
    dev_fixture::{DEV_PROOF_BYTES, DEV_PUBLIC_INPUT_BYTES},
    public_inputs::CircuitV1PublicInputs,
    verifier::verify_circuit_v1,
    WatcherError, WithdrawalStatement,
};

fn u64_from_field_be(field: &[u8;32]) -> u64 {
    u64::from_be_bytes(field[24..32].try_into().unwrap())
}

fn statement_for_fixture() -> WithdrawalStatement {
    let inputs = CircuitV1PublicInputs::decode(&DEV_PUBLIC_INPUT_BYTES).unwrap();
    WithdrawalStatement {
        nullifier_0: inputs.nullifier_0,
        nullifier_1: inputs.nullifier_1,
        change_commitment: inputs.change_commitment,
        // Recipient binding is intentionally not derived from Pubkey yet.
        recipient: Pubkey::new_unique(),
        public_amount: u64_from_field_be(&inputs.public_amount),
        protocol_fee: u64_from_field_be(&inputs.protocol_fee),
        relayer_fee: u64_from_field_be(&inputs.relayer_fee),
    }
}

#[test]
fn watcher_groth16_fixture_verifies() {
    let statement = statement_for_fixture();
    assert_eq!(verify_circuit_v1(&statement, &DEV_PROOF_BYTES, &DEV_PUBLIC_INPUT_BYTES), Ok(()));
}

#[test]
fn mutated_proof_is_rejected() {
    let statement = statement_for_fixture();
    let mut proof = DEV_PROOF_BYTES;
    proof[17] ^= 1;
    assert!(matches!(
        verify_circuit_v1(&statement, &proof, &DEV_PUBLIC_INPUT_BYTES),
        Err(WatcherError::InvalidGroth16Proof)
    ));
}

#[test]
fn mutated_bound_public_input_is_rejected() {
    let statement = statement_for_fixture();
    let mut inputs = DEV_PUBLIC_INPUT_BYTES;
    // PublicAmount is field #4. Mutating it must fail statement binding before pairing.
    inputs[4*32 + 31] ^= 1;
    assert_eq!(
        verify_circuit_v1(&statement, &DEV_PROOF_BYTES, &inputs),
        Err(WatcherError::PublicInputMismatch)
    );
}

#[test]
fn malformed_proof_length_is_rejected() {
    let statement = statement_for_fixture();
    assert_eq!(
        verify_circuit_v1(&statement, &DEV_PROOF_BYTES[..255], &DEV_PUBLIC_INPUT_BYTES),
        Err(WatcherError::InvalidProofEncoding)
    );
}
