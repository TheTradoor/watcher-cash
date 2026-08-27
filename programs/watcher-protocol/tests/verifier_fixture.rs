use solana_program::pubkey::Pubkey;
use watcher_protocol_program::{
    dev_fixture::{
        DEV_DEPOSIT_PROOF_1_BYTES, DEV_DEPOSIT_PROOF_BYTES,
        DEV_DEPOSIT_PUBLIC_INPUT_1_BYTES, DEV_DEPOSIT_PUBLIC_INPUT_BYTES, DEV_PROOF_BYTES,
        DEV_PUBLIC_INPUT_BYTES,
    },
    processor::vault_address_v1,
    public_inputs::{
        sol_asset_id_field_v1, withdraw_context_binding_v1, CircuitV1PublicInputs,
        DepositV1PublicInputs,
    },
    verifier::{verify_circuit_v1, verify_deposit_v1},
    WatcherError, WithdrawalStatement,
};

fn u64_from_field_le(field: &[u8; 32]) -> u64 {
    u64::from_le_bytes(field[..8].try_into().unwrap())
}

fn custody_context() -> (Pubkey, Pubkey, Pubkey, Pubkey, Pubkey) {
    let program_id = Pubkey::new_from_array([42u8; 32]);
    let config = Pubkey::new_from_array([43u8; 32]);
    let relayer = Pubkey::new_from_array([44u8; 32]);
    let treasury = Pubkey::new_from_array([45u8; 32]);
    let (vault, _) = vault_address_v1(&program_id, &config);
    (program_id, config, vault, relayer, treasury)
}

fn withdrawal_fixture() -> (WithdrawalStatement, [u8; 32], [u8; 32], [u8; 32]) {
    let inputs = CircuitV1PublicInputs::decode(&DEV_PUBLIC_INPUT_BYTES).unwrap();
    let (program_id, config, vault, relayer, treasury) = custody_context();
    let asset_id = sol_asset_id_field_v1();
    let context_binding = withdraw_context_binding_v1(
        &program_id,
        &config,
        &vault,
        &relayer,
        &treasury,
        &asset_id,
    );
    (
        WithdrawalStatement {
            nullifier_0: inputs.nullifier_0,
            nullifier_1: inputs.nullifier_1,
            change_commitment: inputs.change_commitment,
            recipient: Pubkey::new_from_array([7u8; 32]),
            public_amount: u64_from_field_le(&inputs.public_amount),
            protocol_fee: u64_from_field_le(&inputs.protocol_fee),
            relayer_fee: u64_from_field_le(&inputs.relayer_fee),
        },
        inputs.merkle_root,
        asset_id,
        context_binding,
    )
}

#[test]
fn watcher_groth16_fixture_verifies() {
    let (statement, root, asset_id, context_binding) = withdrawal_fixture();
    assert_eq!(
        verify_circuit_v1(
            &statement,
            &root,
            &asset_id,
            &context_binding,
            &DEV_PROOF_BYTES,
            &DEV_PUBLIC_INPUT_BYTES,
        ),
        Ok(())
    );
}

#[test]
fn both_deposit_fixtures_verify_against_one_key() {
    for (proof, public_inputs) in [
        (&DEV_DEPOSIT_PROOF_BYTES[..], &DEV_DEPOSIT_PUBLIC_INPUT_BYTES[..]),
        (
            &DEV_DEPOSIT_PROOF_1_BYTES[..],
            &DEV_DEPOSIT_PUBLIC_INPUT_1_BYTES[..],
        ),
    ] {
        let inputs = DepositV1PublicInputs::decode(public_inputs).unwrap();
        assert_eq!(
            verify_deposit_v1(
                &inputs.commitment,
                u64_from_field_le(&inputs.amount),
                &sol_asset_id_field_v1(),
                proof,
                public_inputs,
            ),
            Ok(())
        );
    }
}

#[test]
fn deposit_amount_substitution_is_rejected() {
    let inputs = DepositV1PublicInputs::decode(&DEV_DEPOSIT_PUBLIC_INPUT_BYTES).unwrap();
    assert_eq!(
        verify_deposit_v1(
            &inputs.commitment,
            u64_from_field_le(&inputs.amount) - 1,
            &sol_asset_id_field_v1(),
            &DEV_DEPOSIT_PROOF_BYTES,
            &DEV_DEPOSIT_PUBLIC_INPUT_BYTES,
        ),
        Err(WatcherError::PublicInputMismatch)
    );
}

#[test]
fn mutated_withdrawal_proof_is_rejected() {
    let (statement, root, asset_id, context_binding) = withdrawal_fixture();
    let mut proof = DEV_PROOF_BYTES;
    proof[17] ^= 1;
    assert!(matches!(
        verify_circuit_v1(
            &statement,
            &root,
            &asset_id,
            &context_binding,
            &proof,
            &DEV_PUBLIC_INPUT_BYTES,
        ),
        Err(WatcherError::InvalidGroth16Proof)
    ));
}

#[test]
fn mutated_bound_public_input_is_rejected() {
    let (statement, root, asset_id, context_binding) = withdrawal_fixture();
    let mut inputs = DEV_PUBLIC_INPUT_BYTES;
    inputs[128] ^= 1;
    assert_eq!(
        verify_circuit_v1(
            &statement,
            &root,
            &asset_id,
            &context_binding,
            &DEV_PROOF_BYTES,
            &inputs,
        ),
        Err(WatcherError::PublicInputMismatch)
    );
}

#[test]
fn malformed_proof_length_is_rejected() {
    let (statement, root, asset_id, context_binding) = withdrawal_fixture();
    assert_eq!(
        verify_circuit_v1(
            &statement,
            &root,
            &asset_id,
            &context_binding,
            &DEV_PROOF_BYTES[..255],
            &DEV_PUBLIC_INPUT_BYTES,
        ),
        Err(WatcherError::InvalidProofEncoding)
    );
}

#[test]
fn wrong_recipient_is_rejected() {
    let (mut statement, root, asset_id, context_binding) = withdrawal_fixture();
    statement.recipient = Pubkey::new_from_array([8u8; 32]);
    assert_eq!(
        verify_circuit_v1(
            &statement,
            &root,
            &asset_id,
            &context_binding,
            &DEV_PROOF_BYTES,
            &DEV_PUBLIC_INPUT_BYTES,
        ),
        Err(WatcherError::PublicInputMismatch)
    );
}

#[test]
fn wrong_context_is_rejected() {
    let (statement, root, asset_id, mut context_binding) = withdrawal_fixture();
    context_binding[0] ^= 1;
    assert_eq!(
        verify_circuit_v1(
            &statement,
            &root,
            &asset_id,
            &context_binding,
            &DEV_PROOF_BYTES,
            &DEV_PUBLIC_INPUT_BYTES,
        ),
        Err(WatcherError::PublicInputMismatch)
    );
}

#[test]
fn wrong_asset_is_rejected() {
    let (statement, root, mut asset_id, context_binding) = withdrawal_fixture();
    asset_id[0] = 2;
    assert_eq!(
        verify_circuit_v1(
            &statement,
            &root,
            &asset_id,
            &context_binding,
            &DEV_PROOF_BYTES,
            &DEV_PUBLIC_INPUT_BYTES,
        ),
        Err(WatcherError::PublicInputMismatch)
    );
}

#[test]
fn wrong_trusted_merkle_root_is_rejected() {
    let (statement, mut root, asset_id, context_binding) = withdrawal_fixture();
    root[0] ^= 1;
    assert_eq!(
        verify_circuit_v1(
            &statement,
            &root,
            &asset_id,
            &context_binding,
            &DEV_PROOF_BYTES,
            &DEV_PUBLIC_INPUT_BYTES,
        ),
        Err(WatcherError::PublicInputMismatch)
    );
}

#[test]
fn unset_trusted_merkle_root_is_rejected() {
    let (statement, _, asset_id, context_binding) = withdrawal_fixture();
    assert_eq!(
        verify_circuit_v1(
            &statement,
            &[0u8; 32],
            &asset_id,
            &context_binding,
            &DEV_PROOF_BYTES,
            &DEV_PUBLIC_INPUT_BYTES,
        ),
        Err(WatcherError::PublicInputMismatch)
    );
}
