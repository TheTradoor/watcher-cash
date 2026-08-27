use ark_bn254::Fr;
use ark_ff::{AdditiveGroup, BigInteger, Field, PrimeField};
use sha3::{Digest, Keccak256};
use solana_program::{account_info::{next_account_info,AccountInfo},entrypoint::ProgramResult,program_error::ProgramError,pubkey::Pubkey};
use crate::{codec::{append_unique_32,contains_32,ConfigAccount,WatcherInstruction,REGISTRY_HEADER_LEN},verifier::verify_circuit_v1,DepositRecord,WatcherError,WithdrawalStatement,STATE_VERSION};

const MERKLE_DEPTH_V1: usize = 4;
const MERKLE_LEAVES_V1: usize = 1 << MERKLE_DEPTH_V1;
const DOMAIN_NOTE_V1: u64 = 91_001;
const DOMAIN_MERKLE_V1: u64 = 91_003;
const MIMC_ROUNDS_BN254: usize = 110;

pub fn process_instruction(program_id:&Pubkey,accounts:&[AccountInfo],data:&[u8])->ProgramResult{match WatcherInstruction::unpack(data)?{
 WatcherInstruction::Initialize{treasury}=>initialize(program_id,accounts,treasury),
 WatcherInstruction::Deposit{commitment,amount}=>deposit(program_id,accounts,commitment,amount),
 WatcherInstruction::Withdraw{nullifier_0,nullifier_1,change_commitment,recipient,public_amount,protocol_fee,relayer_fee,proof,public_inputs}=>withdraw(program_id,accounts,WithdrawalStatement{nullifier_0,nullifier_1,change_commitment,recipient,public_amount,protocol_fee,relayer_fee},&proof,&public_inputs),
 WatcherInstruction::SetMerkleRoot{root:_}=>Err(WatcherError::ManualMerkleRootDisabled.into()),
}}
fn owned_by(account:&AccountInfo,program_id:&Pubkey)->Result<(),ProgramError>{if account.owner!=program_id{return Err(ProgramError::IncorrectProgramId)}Ok(())}
fn initialize(program_id:&Pubkey,accounts:&[AccountInfo],treasury:Pubkey)->ProgramResult{let mut it=accounts.iter();let authority=next_account_info(&mut it)?;let config=next_account_info(&mut it)?;let commitments=next_account_info(&mut it)?;let nullifiers=next_account_info(&mut it)?;if !authority.is_signer{return Err(ProgramError::MissingRequiredSignature)}owned_by(config,program_id)?;owned_by(commitments,program_id)?;owned_by(nullifiers,program_id)?;let mut cfg_data=config.try_borrow_mut_data()?;if cfg_data.first().copied().unwrap_or(0)!=0{return Err(WatcherError::AlreadyInitialized.into())}ConfigAccount{authority:*authority.key,treasury,fees_enabled:false,protocol_fee_bps:0,merkle_root:[0u8;32]}.pack(&mut cfg_data)?;for registry in[commitments,nullifiers]{let mut d=registry.try_borrow_mut_data()?;if d.len()<5{return Err(WatcherError::InvalidAccountData.into())}d.fill(0);d[0]=STATE_VERSION;}Ok(())}

fn mimc_constants_bn254() -> Vec<Fr> {
 let mut rnd=Keccak256::digest(b"seed").to_vec();
 let mut out=Vec::with_capacity(MIMC_ROUNDS_BN254);
 for _ in 0..MIMC_ROUNDS_BN254 { rnd=Keccak256::digest(&rnd).to_vec(); out.push(Fr::from_be_bytes_mod_order(&rnd)); }
 out
}

pub fn mimc_hash_v1(values:&[Fr])->Fr{
 let constants=mimc_constants_bn254();
 let mut h=Fr::ZERO;
 for value in values {
  let data=*value;
  let mut m=data;
  for c in &constants {
   let tmp=m+h+*c;
   let tmp2=tmp.square();
   let tmp4=tmp2.square();
   m=tmp4*tmp;
  }
  m+=h;
  h=m+h+data;
 }
 h
}

fn fr_to_le32(value:Fr)->[u8;32]{
 let raw=value.into_bigint().to_bytes_le();
 let mut out=[0u8;32];out[..raw.len()].copy_from_slice(&raw);out
}

fn fr_from_canonical_le32(bytes:&[u8;32])->Result<Fr,WatcherError>{
 let value=Fr::from_le_bytes_mod_order(bytes);
 if fr_to_le32(value)!=*bytes{return Err(WatcherError::InvalidCommitmentField)}
 Ok(value)
}

fn parent_v1(left:Fr,right:Fr)->Fr{mimc_hash_v1(&[Fr::from(DOMAIN_MERKLE_V1),left,right])}

pub fn merkle_root_from_leaves_v1(mut leaves:[Fr;MERKLE_LEAVES_V1])->Fr{
 let mut width=MERKLE_LEAVES_V1;
 while width>1{
  for i in 0..(width/2){leaves[i]=parent_v1(leaves[i*2],leaves[i*2+1]);}
  width/=2;
 }
 leaves[0]
}

fn commitment_count(registry:&[u8])->Result<usize,WatcherError>{
 if registry.len()<REGISTRY_HEADER_LEN||registry[0]!=STATE_VERSION{return Err(WatcherError::InvalidAccountData)}
 let count=u32::from_le_bytes(registry[1..5].try_into().unwrap())as usize;
 let end=REGISTRY_HEADER_LEN.checked_add(count.checked_mul(32).ok_or(WatcherError::InvalidAccountData)?).ok_or(WatcherError::InvalidAccountData)?;
 if end>registry.len(){return Err(WatcherError::InvalidAccountData)}
 Ok(count)
}

/// Circuit V1-compatible Merkle root. Commitments are canonical little-endian
/// BN254 scalar field elements, placed sequentially into a fixed 16-leaf tree.
/// Unused leaves are zero, and each parent is MiMC(domainMerkleV1,left,right),
/// exactly matching circuits/withdraw/circuit_v1.go.
pub fn commitment_root(registry:&[u8])->Result<[u8;32],WatcherError>{
 let count=commitment_count(registry)?;
 if count==0{return Ok([0u8;32])}
 if count>MERKLE_LEAVES_V1{return Err(WatcherError::MerkleTreeFull)}
 let mut leaves=[Fr::ZERO;MERKLE_LEAVES_V1];
 let end=REGISTRY_HEADER_LEN+count*32;
 for (i,chunk) in registry[REGISTRY_HEADER_LEN..end].chunks_exact(32).enumerate(){let bytes:[u8;32]=chunk.try_into().unwrap();leaves[i]=fr_from_canonical_le32(&bytes)?;}
 Ok(fr_to_le32(merkle_root_from_leaves_v1(leaves)))
}
fn sync_root(config:&AccountInfo,commitments:&AccountInfo)->ProgramResult{let root=commitment_root(&commitments.try_borrow_data()?)?;let mut data=config.try_borrow_mut_data()?;let mut cfg=ConfigAccount::unpack(&data)?;cfg.merkle_root=root;cfg.pack(&mut data)?;Ok(())}
fn deposit(program_id:&Pubkey,accounts:&[AccountInfo],commitment:[u8;32],amount:u64)->ProgramResult{DepositRecord{commitment,amount}.validate()?;fr_from_canonical_le32(&commitment)?;let mut it=accounts.iter();let config=next_account_info(&mut it)?;let commitments=next_account_info(&mut it)?;owned_by(config,program_id)?;owned_by(commitments,program_id)?;ConfigAccount::unpack(&config.try_borrow_data()?)?;{let d=commitments.try_borrow_data()?;if commitment_count(&d)? >= MERKLE_LEAVES_V1{return Err(WatcherError::MerkleTreeFull.into())}}append_unique_32(&mut commitments.try_borrow_mut_data()?,commitment)?;sync_root(config,commitments)}
fn withdraw(program_id:&Pubkey,accounts:&[AccountInfo],statement:WithdrawalStatement,proof:&[u8],public_inputs:&[u8])->ProgramResult{statement.validate_development()?;if statement.change_commitment!=[0u8;32]{fr_from_canonical_le32(&statement.change_commitment)?;}let mut it=accounts.iter();let config=next_account_info(&mut it)?;let commitments=next_account_info(&mut it)?;let nullifiers=next_account_info(&mut it)?;owned_by(config,program_id)?;owned_by(commitments,program_id)?;owned_by(nullifiers,program_id)?;let cfg=ConfigAccount::unpack(&config.try_borrow_data()?)?;if cfg.fees_enabled||cfg.protocol_fee_bps!=0{return Err(WatcherError::FeesDisabledDuringDevelopment.into())}{let d=nullifiers.try_borrow_data()?;if contains_32(&d,&statement.nullifier_0)?||contains_32(&d,&statement.nullifier_1)?{return Err(WatcherError::NullifierAlreadySpent.into())}}
 if statement.change_commitment!=[0u8;32]{let d=commitments.try_borrow_data()?;if commitment_count(&d)? >= MERKLE_LEAVES_V1{return Err(WatcherError::MerkleTreeFull.into())}}
 verify_circuit_v1(&statement,&cfg.merkle_root,proof,public_inputs)?;
 let mut n=nullifiers.try_borrow_mut_data()?;append_unique_32(&mut n,statement.nullifier_0).map_err(|e|match e{WatcherError::DuplicateCommitment=>WatcherError::NullifierAlreadySpent,other=>other})?;append_unique_32(&mut n,statement.nullifier_1).map_err(|e|match e{WatcherError::DuplicateCommitment=>WatcherError::NullifierAlreadySpent,other=>other})?;drop(n);if statement.change_commitment!=[0u8;32]{append_unique_32(&mut commitments.try_borrow_mut_data()?,statement.change_commitment)?;sync_root(config,commitments)?;}Ok(())}

#[cfg(test)]
mod tests{
 use super::*;
 use crate::dev_fixture::DEV_PUBLIC_INPUT_BYTES;
 #[test]
 fn rust_mimc_tree_matches_circuit_v1_fixture_root(){
  let c0=mimc_hash_v1(&[Fr::from(DOMAIN_NOTE_V1),Fr::from(1u64),Fr::from(8_000_000u64),Fr::from(1111u64),Fr::from(2222u64)]);
  let c1=mimc_hash_v1(&[Fr::from(DOMAIN_NOTE_V1),Fr::from(1u64),Fr::from(3_000_000u64),Fr::from(3333u64),Fr::from(4444u64)]);
  let mut leaves=[Fr::ZERO;MERKLE_LEAVES_V1];leaves[2]=c0;leaves[7]=c1;
  let root=fr_to_le32(merkle_root_from_leaves_v1(leaves));
  assert_eq!(root,DEV_PUBLIC_INPUT_BYTES[..32]);
 }
}
