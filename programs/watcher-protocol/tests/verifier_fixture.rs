use solana_program::pubkey::Pubkey;
use watcher_protocol_program::{
    dev_fixture::{DEV_PROOF_BYTES, DEV_PUBLIC_INPUT_BYTES},
    public_inputs::CircuitV1PublicInputs,
    verifier::verify_circuit_v1,
    WatcherError, WithdrawalStatement,
};

fn u64_from_field_le(field: &[u8;32]) -> u64 { u64::from_le_bytes(field[..8].try_into().unwrap()) }

fn statement_for_fixture() -> WithdrawalStatement {
    let inputs = CircuitV1PublicInputs::decode(&DEV_PUBLIC_INPUT_BYTES).unwrap();
    WithdrawalStatement { nullifier_0: inputs.nullifier_0, nullifier_1: inputs.nullifier_1, change_commitment: inputs.change_commitment, recipient: Pubkey::new_unique(), public_amount: u64_from_field_le(&inputs.public_amount), protocol_fee: u64_from_field_le(&inputs.protocol_fee), relayer_fee: u64_from_field_le(&inputs.relayer_fee) }
}

// BN254 base-field modulus q in little endian. xark expects proof A already negated.
const FQ_MODULUS_LE:[u8;32]=[0x47,0xfd,0x7c,0xd8,0x16,0x8c,0x20,0x3c,0x8d,0xca,0x71,0x68,0x91,0x6a,0x81,0x97,0x5d,0x58,0x81,0x81,0xb6,0x45,0x50,0xb8,0x29,0xa0,0x31,0xe1,0x72,0x4e,0x64,0x30];
fn negate_a_y(mut proof:[u8;256])->[u8;256]{
    let y=&proof[32..64]; if y.iter().all(|b|*b==0){return proof}
    let mut out=[0u8;32]; let mut borrow=0u16;
    for i in 0..32 { let q=FQ_MODULUS_LE[i] as u16; let sub=y[i] as u16+borrow; if q>=sub {out[i]=(q-sub) as u8;borrow=0}else{out[i]=(q+256-sub) as u8;borrow=1} }
    proof[32..64].copy_from_slice(&out); proof
}

#[test]
fn watcher_groth16_fixture_verifies() {
    let statement=statement_for_fixture();
    let direct=verify_circuit_v1(&statement,&DEV_PROOF_BYTES,&DEV_PUBLIC_INPUT_BYTES);
    if direct.is_ok(){return}
    let renegated=negate_a_y(DEV_PROOF_BYTES);
    let alt=verify_circuit_v1(&statement,&renegated,&DEV_PUBLIC_INPUT_BYTES);
    panic!("fixture direct={direct:?}; after toggling A negation={alt:?}");
}
#[test]
fn mutated_proof_is_rejected(){let s=statement_for_fixture();let mut p=DEV_PROOF_BYTES;p[17]^=1;assert!(matches!(verify_circuit_v1(&s,&p,&DEV_PUBLIC_INPUT_BYTES),Err(WatcherError::InvalidGroth16Proof)))}
#[test]
fn mutated_bound_public_input_is_rejected(){let s=statement_for_fixture();let mut i=DEV_PUBLIC_INPUT_BYTES;i[4*32]^=1;assert_eq!(verify_circuit_v1(&s,&DEV_PROOF_BYTES,&i),Err(WatcherError::PublicInputMismatch))}
#[test]
fn malformed_proof_length_is_rejected(){let s=statement_for_fixture();assert_eq!(verify_circuit_v1(&s,&DEV_PROOF_BYTES[..255],&DEV_PUBLIC_INPUT_BYTES),Err(WatcherError::InvalidProofEncoding))}
