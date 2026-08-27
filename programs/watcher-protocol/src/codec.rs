use solana_program::pubkey::Pubkey;
use crate::{WatcherError, COMMITMENT_BYTES, NULLIFIER_BYTES, STATE_VERSION};

pub const CONFIG_ACCOUNT_LEN: usize = 1 + 32 + 32 + 1 + 2 + 32;
pub const REGISTRY_HEADER_LEN: usize = 1 + 4;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WatcherInstruction {
    Initialize { treasury: Pubkey },
    Deposit { commitment: [u8; COMMITMENT_BYTES], amount: u64 },
    Withdraw { nullifier_0:[u8;NULLIFIER_BYTES],nullifier_1:[u8;NULLIFIER_BYTES],change_commitment:[u8;COMMITMENT_BYTES],recipient:Pubkey,public_amount:u64,protocol_fee:u64,relayer_fee:u64,proof:Vec<u8>,public_inputs:Vec<u8> },
    SetMerkleRoot { root: [u8;32] },
}

impl WatcherInstruction { pub fn unpack(input:&[u8])->Result<Self,WatcherError>{let(&tag,rest)=input.split_first().ok_or(WatcherError::InvalidInstruction)?;match tag{0=>{if rest.len()!=32{return Err(WatcherError::InvalidInstruction)}Ok(Self::Initialize{treasury:Pubkey::new_from_array(rest.try_into().unwrap())})},1=>{if rest.len()!=40{return Err(WatcherError::InvalidInstruction)}Ok(Self::Deposit{commitment:rest[..32].try_into().unwrap(),amount:u64::from_le_bytes(rest[32..40].try_into().unwrap())})},2=>unpack_withdraw(rest),3=>{if rest.len()!=32{return Err(WatcherError::InvalidInstruction)}Ok(Self::SetMerkleRoot{root:rest.try_into().unwrap()})},_=>Err(WatcherError::InvalidInstruction)}}}

fn unpack_withdraw(mut rest:&[u8])->Result<WatcherInstruction,WatcherError>{const FIXED:usize=32+32+32+32+8+8+8+2+2;if rest.len()<FIXED{return Err(WatcherError::InvalidInstruction)}let take32=|s:&mut &[u8]|{let out:[u8;32]=s[..32].try_into().unwrap();*s=&s[32..];out};let n0=take32(&mut rest);let n1=take32(&mut rest);let change=take32(&mut rest);let recipient=Pubkey::new_from_array(take32(&mut rest));let take_u64=|s:&mut &[u8]|{let out=u64::from_le_bytes(s[..8].try_into().unwrap());*s=&s[8..];out};let public_amount=take_u64(&mut rest);let protocol_fee=take_u64(&mut rest);let relayer_fee=take_u64(&mut rest);let proof_len=u16::from_le_bytes(rest[..2].try_into().unwrap())as usize;rest=&rest[2..];if rest.len()<proof_len+2{return Err(WatcherError::InvalidInstruction)}let proof=rest[..proof_len].to_vec();rest=&rest[proof_len..];let input_len=u16::from_le_bytes(rest[..2].try_into().unwrap())as usize;rest=&rest[2..];if rest.len()!=input_len{return Err(WatcherError::InvalidInstruction)}Ok(WatcherInstruction::Withdraw{nullifier_0:n0,nullifier_1:n1,change_commitment:change,recipient,public_amount,protocol_fee,relayer_fee,proof,public_inputs:rest.to_vec()})}

#[derive(Clone,Copy,Debug,PartialEq,Eq)]pub struct ConfigAccount{pub authority:Pubkey,pub treasury:Pubkey,pub fees_enabled:bool,pub protocol_fee_bps:u16,pub merkle_root:[u8;32]}
impl ConfigAccount{
 pub fn pack(&self,dst:&mut[u8])->Result<(),WatcherError>{if dst.len()<CONFIG_ACCOUNT_LEN{return Err(WatcherError::InvalidAccountData)}dst[..CONFIG_ACCOUNT_LEN].fill(0);dst[0]=STATE_VERSION;dst[1..33].copy_from_slice(self.authority.as_ref());dst[33..65].copy_from_slice(self.treasury.as_ref());dst[65]=u8::from(self.fees_enabled);dst[66..68].copy_from_slice(&self.protocol_fee_bps.to_le_bytes());dst[68..100].copy_from_slice(&self.merkle_root);Ok(())}
 pub fn unpack(src:&[u8])->Result<Self,WatcherError>{if src.len()<CONFIG_ACCOUNT_LEN||src[0]!=STATE_VERSION{return Err(WatcherError::InvalidAccountData)}Ok(Self{authority:Pubkey::new_from_array(src[1..33].try_into().unwrap()),treasury:Pubkey::new_from_array(src[33..65].try_into().unwrap()),fees_enabled:src[65]!=0,protocol_fee_bps:u16::from_le_bytes(src[66..68].try_into().unwrap()),merkle_root:src[68..100].try_into().unwrap()})}
}

pub fn append_unique_32(registry:&mut[u8],value:[u8;32])->Result<(),WatcherError>{if registry.len()<REGISTRY_HEADER_LEN||registry[0]!=STATE_VERSION{return Err(WatcherError::InvalidAccountData)}let count=u32::from_le_bytes(registry[1..5].try_into().unwrap())as usize;let start=REGISTRY_HEADER_LEN;let end=start.checked_add(count.checked_mul(32).ok_or(WatcherError::RegistryFull)?).ok_or(WatcherError::RegistryFull)?;if end>registry.len(){return Err(WatcherError::InvalidAccountData)}for chunk in registry[start..end].chunks_exact(32){if chunk==value{return Err(WatcherError::DuplicateCommitment)}}if end+32>registry.len(){return Err(WatcherError::RegistryFull)}registry[end..end+32].copy_from_slice(&value);registry[1..5].copy_from_slice(&((count+1)as u32).to_le_bytes());Ok(())}
pub fn contains_32(registry:&[u8],value:&[u8;32])->Result<bool,WatcherError>{if registry.len()<REGISTRY_HEADER_LEN||registry[0]!=STATE_VERSION{return Err(WatcherError::InvalidAccountData)}let count=u32::from_le_bytes(registry[1..5].try_into().unwrap())as usize;let end=REGISTRY_HEADER_LEN+count.checked_mul(32).ok_or(WatcherError::InvalidAccountData)?;if end>registry.len(){return Err(WatcherError::InvalidAccountData)}Ok(registry[REGISTRY_HEADER_LEN..end].chunks_exact(32).any(|x|x==value))}
