use solana_program::{keccak::hashv, pubkey::Pubkey};

use crate::WatcherError;

pub const NULLIFIER_SHARD_SEED_V3: &[u8] = b"watcher-nullifier-shard-v3";
pub const NULLIFIER_BUCKET_DOMAIN_V3: &[u8] = b"watcher-nullifier-bucket-v3";
pub const NULLIFIER_SHARD_COUNT_V3: usize = 16;
pub const NULLIFIER_BUCKETS_PER_SHARD_V3: usize = 4096;
pub const NULLIFIER_HEAD_NONE_V3: u32 = u32::MAX;
pub const NULLIFIER_RECORD_BYTES_V3: usize = 36;
pub const MAX_NULLIFIERS_PER_SHARD_V3: u32 = 250_000;

const MAGIC: [u8; 8] = *b"WNULLV3\0";
const MAGIC_OFFSET: usize = 0;
const VERSION_OFFSET: usize = 8;
const SHARD_OFFSET: usize = 9;
const CONFIG_OFFSET: usize = 12;
const COUNT_OFFSET: usize = 44;
const HEADS_OFFSET: usize = 48;
pub const NULLIFIER_SHARD_HEADER_BYTES_V3: usize =
    HEADS_OFFSET + NULLIFIER_BUCKETS_PER_SHARD_V3 * 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NullifierRouteV3 {
    pub shard: u8,
    pub bucket: u16,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NullifierShardHeaderV3 {
    pub config: Pubkey,
    pub shard: u8,
    pub count: u32,
}

pub fn derive_nullifier_shard_v3(
    program_id: &Pubkey,
    config: &Pubkey,
    shard: u8,
) -> Result<(Pubkey, u8), WatcherError> {
    if shard as usize >= NULLIFIER_SHARD_COUNT_V3 {
        return Err(WatcherError::InvalidAccountData);
    }
    Ok(Pubkey::find_program_address(
        &[NULLIFIER_SHARD_SEED_V3, config.as_ref(), &[shard]],
        program_id,
    ))
}

pub fn route_nullifier_v3(
    config: &Pubkey,
    nullifier: &[u8; 32],
) -> Result<NullifierRouteV3, WatcherError> {
    if *nullifier == [0u8; 32] {
        return Err(WatcherError::ZeroNullifier);
    }
    let digest = hashv(&[NULLIFIER_BUCKET_DOMAIN_V3, config.as_ref(), nullifier]).to_bytes();
    let key = u16::from_be_bytes([digest[0], digest[1]]);
    Ok(NullifierRouteV3 {
        shard: (key >> 12) as u8,
        bucket: key & 0x0fff,
    })
}

pub fn required_nullifier_shard_len_v3(count: u32) -> Result<usize, WatcherError> {
    if count > MAX_NULLIFIERS_PER_SHARD_V3 {
        return Err(WatcherError::RegistryFull);
    }
    NULLIFIER_SHARD_HEADER_BYTES_V3
        .checked_add(
            (count as usize)
                .checked_mul(NULLIFIER_RECORD_BYTES_V3)
                .ok_or(WatcherError::ArithmeticOverflow)?,
        )
        .ok_or(WatcherError::ArithmeticOverflow)
}

fn read_u32(data: &[u8], offset: usize) -> Result<u32, WatcherError> {
    let bytes: [u8; 4] = data
        .get(offset..offset + 4)
        .and_then(|slice| slice.try_into().ok())
        .ok_or(WatcherError::InvalidAccountData)?;
    Ok(u32::from_le_bytes(bytes))
}

fn write_u32(data: &mut [u8], offset: usize, value: u32) -> Result<(), WatcherError> {
    let target = data
        .get_mut(offset..offset + 4)
        .ok_or(WatcherError::InvalidAccountData)?;
    target.copy_from_slice(&value.to_le_bytes());
    Ok(())
}

fn head_offset(bucket: u16) -> Result<usize, WatcherError> {
    let bucket = bucket as usize;
    if bucket >= NULLIFIER_BUCKETS_PER_SHARD_V3 {
        return Err(WatcherError::InvalidAccountData);
    }
    Ok(HEADS_OFFSET + bucket * 4)
}

fn record_offset(index: u32) -> Result<usize, WatcherError> {
    NULLIFIER_SHARD_HEADER_BYTES_V3
        .checked_add(
            (index as usize)
                .checked_mul(NULLIFIER_RECORD_BYTES_V3)
                .ok_or(WatcherError::ArithmeticOverflow)?,
        )
        .ok_or(WatcherError::ArithmeticOverflow)
}

pub fn initialize_nullifier_shard_v3(
    data: &mut [u8],
    config: Pubkey,
    shard: u8,
) -> Result<(), WatcherError> {
    if shard as usize >= NULLIFIER_SHARD_COUNT_V3 || data.len() != NULLIFIER_SHARD_HEADER_BYTES_V3 {
        return Err(WatcherError::InvalidAccountData);
    }
    if data.iter().any(|byte| *byte != 0) {
        return Err(WatcherError::AlreadyInitialized);
    }
    data[MAGIC_OFFSET..MAGIC_OFFSET + MAGIC.len()].copy_from_slice(&MAGIC);
    data[VERSION_OFFSET] = super::STATE_VERSION_V3;
    data[SHARD_OFFSET] = shard;
    data[CONFIG_OFFSET..CONFIG_OFFSET + 32].copy_from_slice(config.as_ref());
    write_u32(data, COUNT_OFFSET, 0)?;
    for bucket in 0..NULLIFIER_BUCKETS_PER_SHARD_V3 {
        write_u32(data, HEADS_OFFSET + bucket * 4, NULLIFIER_HEAD_NONE_V3)?;
    }
    Ok(())
}

pub fn unpack_nullifier_shard_header_v3(
    data: &[u8],
) -> Result<NullifierShardHeaderV3, WatcherError> {
    if data.len() < NULLIFIER_SHARD_HEADER_BYTES_V3
        || data[MAGIC_OFFSET..MAGIC_OFFSET + MAGIC.len()] != MAGIC
        || data[VERSION_OFFSET] != super::STATE_VERSION_V3
        || (data.len() - NULLIFIER_SHARD_HEADER_BYTES_V3) % NULLIFIER_RECORD_BYTES_V3 != 0
    {
        return Err(WatcherError::InvalidAccountData);
    }
    let config = Pubkey::new_from_array(
        data[CONFIG_OFFSET..CONFIG_OFFSET + 32]
            .try_into()
            .map_err(|_| WatcherError::InvalidAccountData)?,
    );
    let shard = data[SHARD_OFFSET];
    if shard as usize >= NULLIFIER_SHARD_COUNT_V3 {
        return Err(WatcherError::InvalidAccountData);
    }
    let count = read_u32(data, COUNT_OFFSET)?;
    let used_len = required_nullifier_shard_len_v3(count)?;
    if data.len() < used_len {
        return Err(WatcherError::InvalidAccountData);
    }
    Ok(NullifierShardHeaderV3 { config, shard, count })
}

pub fn contains_nullifier_v3(
    data: &[u8],
    config: &Pubkey,
    nullifier: &[u8; 32],
) -> Result<bool, WatcherError> {
    let route = route_nullifier_v3(config, nullifier)?;
    let header = unpack_nullifier_shard_header_v3(data)?;
    if header.config != *config || header.shard != route.shard {
        return Err(WatcherError::InvalidAccountData);
    }
    let mut index = read_u32(data, head_offset(route.bucket)?)?;
    let mut traversed = 0u32;
    while index != NULLIFIER_HEAD_NONE_V3 {
        if index >= header.count || traversed >= header.count {
            return Err(WatcherError::InvalidAccountData);
        }
        let offset = record_offset(index)?;
        let stored = data
            .get(offset..offset + 32)
            .ok_or(WatcherError::InvalidAccountData)?;
        if stored == nullifier {
            return Ok(true);
        }
        index = read_u32(data, offset + 32)?;
        traversed = traversed
            .checked_add(1)
            .ok_or(WatcherError::ArithmeticOverflow)?;
    }
    Ok(false)
}

pub fn append_nullifier_v3(
    data: &mut [u8],
    config: &Pubkey,
    nullifier: &[u8; 32],
) -> Result<(), WatcherError> {
    let route = route_nullifier_v3(config, nullifier)?;
    let header = unpack_nullifier_shard_header_v3(data)?;
    if header.config != *config || header.shard != route.shard {
        return Err(WatcherError::InvalidAccountData);
    }
    if contains_nullifier_v3(data, config, nullifier)? {
        return Err(WatcherError::NullifierAlreadySpent);
    }
    let next_count = header
        .count
        .checked_add(1)
        .ok_or(WatcherError::ArithmeticOverflow)?;
    if data.len() < required_nullifier_shard_len_v3(next_count)? {
        return Err(WatcherError::InvalidAccountData);
    }
    let head_offset = head_offset(route.bucket)?;
    let previous_head = read_u32(data, head_offset)?;
    let offset = record_offset(header.count)?;
    data[offset..offset + 32].copy_from_slice(nullifier);
    write_u32(data, offset + 32, previous_head)?;
    write_u32(data, head_offset, header.count)?;
    write_u32(data, COUNT_OFFSET, next_count)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nullifier(seed: u8) -> [u8; 32] {
        let mut value = [0u8; 32];
        value[0] = seed;
        value[31] = seed.wrapping_mul(17).wrapping_add(1);
        value
    }

    #[test]
    fn routing_is_deterministic_and_config_scoped() {
        let config_a = Pubkey::new_unique();
        let config_b = Pubkey::new_unique();
        let value = nullifier(7);
        let first = route_nullifier_v3(&config_a, &value).unwrap();
        assert_eq!(first, route_nullifier_v3(&config_a, &value).unwrap());
        assert_ne!(first, route_nullifier_v3(&config_b, &value).unwrap());
        assert!((first.shard as usize) < NULLIFIER_SHARD_COUNT_V3);
        assert!((first.bucket as usize) < NULLIFIER_BUCKETS_PER_SHARD_V3);
    }

    #[test]
    fn shard_pda_is_deterministic_and_scoped() {
        let program = Pubkey::new_unique();
        let config = Pubkey::new_unique();
        let a = derive_nullifier_shard_v3(&program, &config, 3).unwrap();
        let b = derive_nullifier_shard_v3(&program, &config, 3).unwrap();
        let c = derive_nullifier_shard_v3(&program, &config, 4).unwrap();
        assert_eq!(a, b);
        assert_ne!(a.0, c.0);
    }

    #[test]
    fn packed_set_preserves_exact_nullifiers_and_rejects_replay() {
        let config = Pubkey::new_unique();
        let value = nullifier(9);
        let route = route_nullifier_v3(&config, &value).unwrap();
        let mut data = vec![0u8; NULLIFIER_SHARD_HEADER_BYTES_V3];
        initialize_nullifier_shard_v3(&mut data, config, route.shard).unwrap();
        assert!(!contains_nullifier_v3(&data, &config, &value).unwrap());

        data.resize(required_nullifier_shard_len_v3(1).unwrap(), 0);
        append_nullifier_v3(&mut data, &config, &value).unwrap();
        assert!(contains_nullifier_v3(&data, &config, &value).unwrap());

        data.resize(required_nullifier_shard_len_v3(2).unwrap(), 0);
        assert_eq!(
            append_nullifier_v3(&mut data, &config, &value),
            Err(WatcherError::NullifierAlreadySpent)
        );
    }

    #[test]
    fn marginal_storage_is_36_bytes_per_spent_note() {
        assert_eq!(
            required_nullifier_shard_len_v3(4).unwrap() - required_nullifier_shard_len_v3(0).unwrap(),
            4 * NULLIFIER_RECORD_BYTES_V3,
        );
        assert_eq!(NULLIFIER_RECORD_BYTES_V3, 36);
    }

    #[test]
    fn zero_nullifier_is_rejected() {
        assert_eq!(
            route_nullifier_v3(&Pubkey::new_unique(), &[0u8; 32]),
            Err(WatcherError::ZeroNullifier)
        );
    }
}
