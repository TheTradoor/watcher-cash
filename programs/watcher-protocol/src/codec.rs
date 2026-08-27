use solana_program::pubkey::Pubkey;

use crate::{WatcherError, COMMITMENT_BYTES, NULLIFIER_BYTES, STATE_VERSION};

pub const CONFIG_ACCOUNT_LEN: usize = 1 + 32 + 32 + 1 + 2 + 32;
pub const VAULT_ACCOUNT_LEN: usize = 1 + 32 + 1 + 8 + 8;
pub const REGISTRY_HEADER_LEN: usize = 1 + 4;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WatcherInstruction {
    Initialize {
        treasury: Pubkey,
    },
    Deposit {
        commitment: [u8; COMMITMENT_BYTES],
        amount: u64,
        proof: Vec<u8>,
        public_inputs: Vec<u8>,
    },
    Withdraw {
        nullifier_0: [u8; NULLIFIER_BYTES],
        nullifier_1: [u8; NULLIFIER_BYTES],
        change_commitment: [u8; COMMITMENT_BYTES],
        recipient: Pubkey,
        public_amount: u64,
        protocol_fee: u64,
        relayer_fee: u64,
        proof: Vec<u8>,
        public_inputs: Vec<u8>,
    },
    SetMerkleRoot {
        root: [u8; 32],
    },
}

fn take_u16_prefixed(rest: &mut &[u8]) -> Result<Vec<u8>, WatcherError> {
    if rest.len() < 2 {
        return Err(WatcherError::InvalidInstruction);
    }
    let length = u16::from_le_bytes(rest[..2].try_into().unwrap()) as usize;
    *rest = &rest[2..];
    if rest.len() < length {
        return Err(WatcherError::InvalidInstruction);
    }
    let value = rest[..length].to_vec();
    *rest = &rest[length..];
    Ok(value)
}

fn unpack_deposit(mut rest: &[u8]) -> Result<WatcherInstruction, WatcherError> {
    if rest.len() < 32 + 8 + 2 + 2 {
        return Err(WatcherError::InvalidInstruction);
    }
    let commitment = rest[..32].try_into().unwrap();
    rest = &rest[32..];
    let amount = u64::from_le_bytes(rest[..8].try_into().unwrap());
    rest = &rest[8..];
    let proof = take_u16_prefixed(&mut rest)?;
    let public_inputs = take_u16_prefixed(&mut rest)?;
    if !rest.is_empty() {
        return Err(WatcherError::InvalidInstruction);
    }
    Ok(WatcherInstruction::Deposit {
        commitment,
        amount,
        proof,
        public_inputs,
    })
}

fn take_32(rest: &mut &[u8]) -> Result<[u8; 32], WatcherError> {
    if rest.len() < 32 {
        return Err(WatcherError::InvalidInstruction);
    }
    let value = rest[..32].try_into().unwrap();
    *rest = &rest[32..];
    Ok(value)
}

fn take_u64(rest: &mut &[u8]) -> Result<u64, WatcherError> {
    if rest.len() < 8 {
        return Err(WatcherError::InvalidInstruction);
    }
    let value = u64::from_le_bytes(rest[..8].try_into().unwrap());
    *rest = &rest[8..];
    Ok(value)
}

fn unpack_withdraw(mut rest: &[u8]) -> Result<WatcherInstruction, WatcherError> {
    if rest.len() < 32 * 4 + 8 * 3 + 2 + 2 {
        return Err(WatcherError::InvalidInstruction);
    }
    let nullifier_0 = take_32(&mut rest)?;
    let nullifier_1 = take_32(&mut rest)?;
    let change_commitment = take_32(&mut rest)?;
    let recipient = Pubkey::new_from_array(take_32(&mut rest)?);
    let public_amount = take_u64(&mut rest)?;
    let protocol_fee = take_u64(&mut rest)?;
    let relayer_fee = take_u64(&mut rest)?;
    let proof = take_u16_prefixed(&mut rest)?;
    let public_inputs = take_u16_prefixed(&mut rest)?;
    if !rest.is_empty() {
        return Err(WatcherError::InvalidInstruction);
    }
    Ok(WatcherInstruction::Withdraw {
        nullifier_0,
        nullifier_1,
        change_commitment,
        recipient,
        public_amount,
        protocol_fee,
        relayer_fee,
        proof,
        public_inputs,
    })
}

impl WatcherInstruction {
    pub fn unpack(input: &[u8]) -> Result<Self, WatcherError> {
        let (&tag, rest) = input
            .split_first()
            .ok_or(WatcherError::InvalidInstruction)?;
        match tag {
            0 => {
                if rest.len() != 32 {
                    return Err(WatcherError::InvalidInstruction);
                }
                Ok(Self::Initialize {
                    treasury: Pubkey::new_from_array(rest.try_into().unwrap()),
                })
            }
            1 => unpack_deposit(rest),
            2 => unpack_withdraw(rest),
            3 => {
                if rest.len() != 32 {
                    return Err(WatcherError::InvalidInstruction);
                }
                Ok(Self::SetMerkleRoot {
                    root: rest.try_into().unwrap(),
                })
            }
            _ => Err(WatcherError::InvalidInstruction),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ConfigAccount {
    pub authority: Pubkey,
    pub treasury: Pubkey,
    pub fees_enabled: bool,
    pub protocol_fee_bps: u16,
    pub merkle_root: [u8; 32],
}

impl ConfigAccount {
    pub fn pack(&self, destination: &mut [u8]) -> Result<(), WatcherError> {
        if destination.len() < CONFIG_ACCOUNT_LEN {
            return Err(WatcherError::InvalidAccountData);
        }
        destination[..CONFIG_ACCOUNT_LEN].fill(0);
        destination[0] = STATE_VERSION;
        destination[1..33].copy_from_slice(self.authority.as_ref());
        destination[33..65].copy_from_slice(self.treasury.as_ref());
        destination[65] = u8::from(self.fees_enabled);
        destination[66..68].copy_from_slice(&self.protocol_fee_bps.to_le_bytes());
        destination[68..100].copy_from_slice(&self.merkle_root);
        Ok(())
    }

    pub fn unpack(source: &[u8]) -> Result<Self, WatcherError> {
        if source.len() < CONFIG_ACCOUNT_LEN || source[0] != STATE_VERSION {
            return Err(WatcherError::InvalidAccountData);
        }
        Ok(Self {
            authority: Pubkey::new_from_array(source[1..33].try_into().unwrap()),
            treasury: Pubkey::new_from_array(source[33..65].try_into().unwrap()),
            fees_enabled: source[65] != 0,
            protocol_fee_bps: u16::from_le_bytes(source[66..68].try_into().unwrap()),
            merkle_root: source[68..100].try_into().unwrap(),
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VaultAccount {
    pub config: Pubkey,
    pub bump: u8,
    pub asset_id: u64,
    pub tracked_balance: u64,
}

impl VaultAccount {
    pub fn pack(&self, destination: &mut [u8]) -> Result<(), WatcherError> {
        if destination.len() < VAULT_ACCOUNT_LEN {
            return Err(WatcherError::InvalidAccountData);
        }
        destination[..VAULT_ACCOUNT_LEN].fill(0);
        destination[0] = STATE_VERSION;
        destination[1..33].copy_from_slice(self.config.as_ref());
        destination[33] = self.bump;
        destination[34..42].copy_from_slice(&self.asset_id.to_le_bytes());
        destination[42..50].copy_from_slice(&self.tracked_balance.to_le_bytes());
        Ok(())
    }

    pub fn unpack(source: &[u8]) -> Result<Self, WatcherError> {
        if source.len() < VAULT_ACCOUNT_LEN || source[0] != STATE_VERSION {
            return Err(WatcherError::InvalidAccountData);
        }
        Ok(Self {
            config: Pubkey::new_from_array(source[1..33].try_into().unwrap()),
            bump: source[33],
            asset_id: u64::from_le_bytes(source[34..42].try_into().unwrap()),
            tracked_balance: u64::from_le_bytes(source[42..50].try_into().unwrap()),
        })
    }
}

pub fn append_unique_32(registry: &mut [u8], value: [u8; 32]) -> Result<(), WatcherError> {
    if registry.len() < REGISTRY_HEADER_LEN || registry[0] != STATE_VERSION {
        return Err(WatcherError::InvalidAccountData);
    }
    let count = u32::from_le_bytes(registry[1..5].try_into().unwrap()) as usize;
    let end = REGISTRY_HEADER_LEN
        .checked_add(
            count
                .checked_mul(32)
                .ok_or(WatcherError::RegistryFull)?,
        )
        .ok_or(WatcherError::RegistryFull)?;
    if end > registry.len() {
        return Err(WatcherError::InvalidAccountData);
    }
    if registry[REGISTRY_HEADER_LEN..end]
        .chunks_exact(32)
        .any(|chunk| chunk == value)
    {
        return Err(WatcherError::DuplicateCommitment);
    }
    if end + 32 > registry.len() {
        return Err(WatcherError::RegistryFull);
    }
    registry[end..end + 32].copy_from_slice(&value);
    registry[1..5].copy_from_slice(&((count + 1) as u32).to_le_bytes());
    Ok(())
}

pub fn contains_32(registry: &[u8], value: &[u8; 32]) -> Result<bool, WatcherError> {
    if registry.len() < REGISTRY_HEADER_LEN || registry[0] != STATE_VERSION {
        return Err(WatcherError::InvalidAccountData);
    }
    let count = u32::from_le_bytes(registry[1..5].try_into().unwrap()) as usize;
    let end = REGISTRY_HEADER_LEN
        .checked_add(
            count
                .checked_mul(32)
                .ok_or(WatcherError::InvalidAccountData)?,
        )
        .ok_or(WatcherError::InvalidAccountData)?;
    if end > registry.len() {
        return Err(WatcherError::InvalidAccountData);
    }
    Ok(registry[REGISTRY_HEADER_LEN..end]
        .chunks_exact(32)
        .any(|chunk| chunk == value))
}
