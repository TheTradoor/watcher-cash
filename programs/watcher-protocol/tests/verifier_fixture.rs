use solana_program::pubkey::Pubkey;
use watcher_protocol_program::{dev_fixture::{DEV_PROOF_BYTES,DEV_PUBLIC_INPUT_BYTES},public_inputs::CircuitV1PublicInputs,verifier::verify_circuit_v1,WatcherError,WithdrawalStatement};

fn u64_from_field_le(f:&[u8;32])->u64{u64::from_le_bytes(f[..8].try_into().unwrap())}
fn statement_for_fixture()->WithdrawalStatement{let i=CircuitV1PublicInputs::decode(&DEV_PUBLIC_INPUT_BYTES).unwrap();WithdrawalStatement{nullifier_0:i.nullifier_0,nullifier_1:i.nullifier_1,change_commitment:i.change_commitment,recipient:Pubkey::new_unique(),public_amount:u64_from_field_le(&i.public_amount),protocol_fee:u64_from_field_le(&i.protocol_fee),relayer_fee:u64_from_field_le(&i.relayer_fee)}}

#[test]
fn watcher_groth16_fixture_verifies(){let s=statement_for_fixture();assert_eq!(verify_circuit_v1(&s,&DEV_PROOF_BYTES,&DEV_PUBLIC_INPUT_BYTES),Ok(()));}
#[test]
fn mutated_proof_is_rejected(){let s=statement_for_fixture();let mut p=DEV_PROOF_BYTES;p[17]^=1;assert!(matches!(verify_circuit_v1(&s,&p,&DEV_PUBLIC_INPUT_BYTES),Err(WatcherError::InvalidGroth16Proof)))}
#[test]
fn mutated_bound_public_input_is_rejected(){let s=statement_for_fixture();let mut i=DEV_PUBLIC_INPUT_BYTES;i[128]^=1;assert_eq!(verify_circuit_v1(&s,&DEV_PROOF_BYTES,&i),Err(WatcherError::PublicInputMismatch))}
#[test]
fn malformed_proof_length_is_rejected(){let s=statement_for_fixture();assert_eq!(verify_circuit_v1(&s,&DEV_PROOF_BYTES[..255],&DEV_PUBLIC_INPUT_BYTES),Err(WatcherError::InvalidProofEncoding))}
