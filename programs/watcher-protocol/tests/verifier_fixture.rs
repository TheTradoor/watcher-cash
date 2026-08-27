use solana_program::pubkey::Pubkey;
use watcher_protocol_program::{dev_fixture::{DEV_PROOF_BYTES,DEV_PUBLIC_INPUT_BYTES,DEV_VK_BYTES},public_inputs::CircuitV1PublicInputs,verifier::verify_circuit_v1,WatcherError,WithdrawalStatement};
use xark_verifier::{Proof,Verifier};
fn u64_from_field_le(f:&[u8;32])->u64{u64::from_le_bytes(f[..8].try_into().unwrap())}
fn statement_for_fixture()->WithdrawalStatement{let i=CircuitV1PublicInputs::decode(&DEV_PUBLIC_INPUT_BYTES).unwrap();WithdrawalStatement{nullifier_0:i.nullifier_0,nullifier_1:i.nullifier_1,change_commitment:i.change_commitment,recipient:Pubkey::new_unique(),public_amount:u64_from_field_le(&i.public_amount),protocol_fee:u64_from_field_le(&i.protocol_fee),relayer_fee:u64_from_field_le(&i.relayer_fee)}}
fn public_fields()->[[u8;32];10]{let i=CircuitV1PublicInputs::decode(&DEV_PUBLIC_INPUT_BYTES).unwrap();[i.merkle_root,i.nullifier_0,i.nullifier_1,i.change_commitment,i.public_amount,i.protocol_fee,i.relayer_fee,i.recipient_binding,i.asset_id,i.context_binding]}
fn swap_g2_components(b:&mut[u8],off:usize){for k in 0..32{b.swap(off+k,off+32+k);b.swap(off+64+k,off+96+k)}}
fn swap_proof_b(mut p:[u8;256])->[u8;256]{swap_g2_components(&mut p,64);p}
fn swap_vk_g2(mut v:[u8;1152])->[u8;1152]{swap_g2_components(&mut v,64);swap_g2_components(&mut v,192);swap_g2_components(&mut v,320);v}
#[test]
fn watcher_groth16_fixture_verifies(){
 let pi=public_fields();let p0=DEV_PROOF_BYTES;let p1=swap_proof_b(p0);let v0=DEV_VK_BYTES;let v1=swap_vk_g2(v0);
 let cases=[("native",v0,p0),("proof_g2_swapped",v0,p1),("vk_g2_swapped",v1,p0),("both_g2_swapped",v1,p1)];
 let mut wins=Vec::new();for(name,v,p)in cases{let vv:Verifier<10>=Verifier::from_le_bytes(&v);let pp=Proof::from_le_bytes(&p);if vv.verify(&pp,&pi){wins.push(name)}}
 assert!(!wins.is_empty(),"no G2 ordering variant verifies");panic!("verifying variants: {wins:?}");
}
#[test]fn mutated_proof_is_rejected(){let s=statement_for_fixture();let mut p=DEV_PROOF_BYTES;p[17]^=1;assert!(matches!(verify_circuit_v1(&s,&p,&DEV_PUBLIC_INPUT_BYTES),Err(WatcherError::InvalidGroth16Proof)))}
#[test]fn mutated_bound_public_input_is_rejected(){let s=statement_for_fixture();let mut i=DEV_PUBLIC_INPUT_BYTES;i[128]^=1;assert_eq!(verify_circuit_v1(&s,&DEV_PROOF_BYTES,&i),Err(WatcherError::PublicInputMismatch))}
#[test]fn malformed_proof_length_is_rejected(){let s=statement_for_fixture();assert_eq!(verify_circuit_v1(&s,&DEV_PROOF_BYTES[..255],&DEV_PUBLIC_INPUT_BYTES),Err(WatcherError::InvalidProofEncoding))}
