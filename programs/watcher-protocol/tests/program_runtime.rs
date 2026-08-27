use solana_program::{account_info::AccountInfo, clock::Epoch, program_error::ProgramError, pubkey::Pubkey};
use watcher_protocol_program::{codec::{contains_32, CONFIG_ACCOUNT_LEN}, process_instruction, WatcherError, STATE_VERSION};

fn program_account<'a>(key: &'a Pubkey, owner: &'a Pubkey, lamports: &'a mut u64, data: &'a mut [u8], signer: bool) -> AccountInfo<'a> {
    AccountInfo::new(key, signer, true, lamports, data, owner, false, Epoch::default())
}
fn init_data(treasury:&Pubkey)->Vec<u8>{let mut v=vec![0];v.extend_from_slice(treasury.as_ref());v}
fn deposit_data(c:[u8;32],amount:u64)->Vec<u8>{let mut v=vec![1];v.extend_from_slice(&c);v.extend_from_slice(&amount.to_le_bytes());v}
fn withdraw_data(n0:[u8;32],n1:[u8;32],change:[u8;32],recipient:&Pubkey)->Vec<u8>{
 let mut v=vec![2];v.extend_from_slice(&n0);v.extend_from_slice(&n1);v.extend_from_slice(&change);v.extend_from_slice(recipient.as_ref());
 v.extend_from_slice(&1_000u64.to_le_bytes());v.extend_from_slice(&0u64.to_le_bytes());v.extend_from_slice(&5u64.to_le_bytes());
 let proof=[9u8;8];v.extend_from_slice(&(proof.len() as u16).to_le_bytes());v.extend_from_slice(&proof);
 let inputs=[8u8;8];v.extend_from_slice(&(inputs.len() as u16).to_le_bytes());v.extend_from_slice(&inputs);v
}

#[test]
fn initialize_deposit_and_failed_withdrawal_do_not_mutate_nullifiers(){
 let program_id=Pubkey::new_unique();let authority=Pubkey::new_unique();let config_key=Pubkey::new_unique();let commitments_key=Pubkey::new_unique();let nullifiers_key=Pubkey::new_unique();let treasury=Pubkey::new_unique();
 let mut la=1;let mut lc=1;let mut lcm=1;let mut ln=1;let mut authority_data=[];let mut config_data=vec![0u8;CONFIG_ACCOUNT_LEN];let mut commitments_data=vec![0u8;5+32*8];let mut nullifiers_data=vec![0u8;5+32*8];
 {let accounts=vec![program_account(&authority,&program_id,&mut la,&mut authority_data,true),program_account(&config_key,&program_id,&mut lc,&mut config_data,true),program_account(&commitments_key,&program_id,&mut lcm,&mut commitments_data,true),program_account(&nullifiers_key,&program_id,&mut ln,&mut nullifiers_data,true)];process_instruction(&program_id,&accounts,&init_data(&treasury)).unwrap();}
 assert_eq!(config_data[0],STATE_VERSION);assert_eq!(commitments_data[0],STATE_VERSION);assert_eq!(nullifiers_data[0],STATE_VERSION);
 {let accounts=vec![program_account(&config_key,&program_id,&mut lc,&mut config_data,true),program_account(&commitments_key,&program_id,&mut lcm,&mut commitments_data,true)];process_instruction(&program_id,&accounts,&deposit_data([7u8;32],10_000)).unwrap();}
 assert!(contains_32(&commitments_data,&[7u8;32]).unwrap());let before=nullifiers_data.clone();let recipient=Pubkey::new_unique();
 let err={let accounts=vec![program_account(&config_key,&program_id,&mut lc,&mut config_data,true),program_account(&commitments_key,&program_id,&mut lcm,&mut commitments_data,true),program_account(&nullifiers_key,&program_id,&mut ln,&mut nullifiers_data,true)];process_instruction(&program_id,&accounts,&withdraw_data([11u8;32],[12u8;32],[22u8;32],&recipient)).unwrap_err()};
 // Real verifier now rejects malformed 8-byte public input payload before pairing.
 assert_eq!(err,ProgramError::Custom(WatcherError::InvalidPublicInputs as u32+1));
 assert_eq!(nullifiers_data,before,"failed proof must not burn nullifiers");assert!(!contains_32(&commitments_data,&[22u8;32]).unwrap(),"failed proof must not append change commitment");
}

#[test]
fn initialize_requires_authority_signature(){
 let program_id=Pubkey::new_unique();let authority=Pubkey::new_unique();let config_key=Pubkey::new_unique();let commitments_key=Pubkey::new_unique();let nullifiers_key=Pubkey::new_unique();let treasury=Pubkey::new_unique();
 let mut la=1;let mut lc=1;let mut lcm=1;let mut ln=1;let mut ad=[];let mut cd=vec![0u8;CONFIG_ACCOUNT_LEN];let mut cmd=vec![0u8;69];let mut nd=vec![0u8;69];
 let accounts=vec![program_account(&authority,&program_id,&mut la,&mut ad,false),program_account(&config_key,&program_id,&mut lc,&mut cd,true),program_account(&commitments_key,&program_id,&mut lcm,&mut cmd,true),program_account(&nullifiers_key,&program_id,&mut ln,&mut nd,true)];
 assert_eq!(process_instruction(&program_id,&accounts,&init_data(&treasury)),Err(ProgramError::MissingRequiredSignature));
}
