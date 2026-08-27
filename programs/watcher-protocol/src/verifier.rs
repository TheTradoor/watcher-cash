use crate::{public_inputs::{validate_statement_binding, CircuitV1PublicInputs}, WatcherError, WithdrawalStatement};

/// gnark BN254 Groth16 proof serialization is frozen only after a Watcher-generated
/// proof fixture is exported and round-tripped. We intentionally reject every proof
/// until alpha/beta/gamma/delta/IC verifying-key coordinates and proof byte order are
/// committed as Watcher-owned artifacts.
pub const GROTH16_BN254_PROOF_BYTES: usize = 256; // envelope limit; final serialization may be narrower

pub fn verify_circuit_v1(statement: &WithdrawalStatement, proof: &[u8], public_input_bytes: &[u8]) -> Result<(), WatcherError> {
    let inputs = CircuitV1PublicInputs::decode(public_input_bytes)?;
    validate_statement_binding(statement, &inputs)?;
    if proof.is_empty() || proof.len() > GROTH16_BN254_PROOF_BYTES { return Err(WatcherError::InvalidProofEncoding); }

    // IMPORTANT: no success path yet. The next checkpoint wires Solana's alt_bn128
    // operations only after a real gnark-generated Watcher fixture + verifying key
    // are available. Returning Ok here before that would be a critical bypass.
    Err(WatcherError::ProofVerificationUnavailable)
}
