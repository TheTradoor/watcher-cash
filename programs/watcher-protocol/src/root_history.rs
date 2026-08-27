use crate::{WatcherError, STATE_VERSION};

pub const ROOT_HISTORY_CAPACITY: usize = 32;
pub const ROOT_HISTORY_HEADER_LEN: usize = 1 + 4 + 4;
pub const ROOT_HISTORY_ACCOUNT_LEN: usize =
    ROOT_HISTORY_HEADER_LEN + ROOT_HISTORY_CAPACITY * 32;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct RootHistoryHeader {
    count: usize,
    next_index: usize,
}

fn root_range(index: usize) -> core::ops::Range<usize> {
    let start = ROOT_HISTORY_HEADER_LEN + index * 32;
    start..start + 32
}

fn read_root(data: &[u8], index: usize) -> [u8; 32] {
    data[root_range(index)].try_into().unwrap()
}

fn write_root(data: &mut [u8], index: usize, root: [u8; 32]) {
    data[root_range(index)].copy_from_slice(&root);
}

fn read_header(data: &[u8]) -> Result<RootHistoryHeader, WatcherError> {
    if data.len() < ROOT_HISTORY_ACCOUNT_LEN || data[0] != STATE_VERSION {
        return Err(WatcherError::InvalidAccountData);
    }

    let count = u32::from_le_bytes(data[1..5].try_into().unwrap()) as usize;
    let next_index = u32::from_le_bytes(data[5..9].try_into().unwrap()) as usize;

    if count > ROOT_HISTORY_CAPACITY || next_index >= ROOT_HISTORY_CAPACITY {
        return Err(WatcherError::InvalidAccountData);
    }
    if count < ROOT_HISTORY_CAPACITY && next_index != count {
        return Err(WatcherError::InvalidAccountData);
    }

    let valid_slots = if count < ROOT_HISTORY_CAPACITY {
        0..count
    } else {
        0..ROOT_HISTORY_CAPACITY
    };
    for index in valid_slots {
        if read_root(data, index) == [0u8; 32] {
            return Err(WatcherError::InvalidAccountData);
        }
    }

    Ok(RootHistoryHeader { count, next_index })
}

fn write_header(data: &mut [u8], header: RootHistoryHeader) {
    data[1..5].copy_from_slice(&(header.count as u32).to_le_bytes());
    data[5..9].copy_from_slice(&(header.next_index as u32).to_le_bytes());
}

pub fn initialize_root_history(data: &mut [u8]) -> Result<(), WatcherError> {
    if data.len() < ROOT_HISTORY_ACCOUNT_LEN {
        return Err(WatcherError::InvalidAccountData);
    }
    data.fill(0);
    data[0] = STATE_VERSION;
    Ok(())
}

pub fn root_history_count(data: &[u8]) -> Result<usize, WatcherError> {
    Ok(read_header(data)?.count)
}

pub fn root_history_contains(data: &[u8], root: &[u8; 32]) -> Result<bool, WatcherError> {
    if *root == [0u8; 32] {
        return Ok(false);
    }
    let header = read_header(data)?;
    let slots = if header.count < ROOT_HISTORY_CAPACITY {
        0..header.count
    } else {
        0..ROOT_HISTORY_CAPACITY
    };
    Ok(slots.into_iter().any(|index| read_root(data, index) == *root))
}

pub fn latest_root(data: &[u8]) -> Result<Option<[u8; 32]>, WatcherError> {
    let header = read_header(data)?;
    if header.count == 0 {
        return Ok(None);
    }
    let latest_index =
        (header.next_index + ROOT_HISTORY_CAPACITY - 1) % ROOT_HISTORY_CAPACITY;
    Ok(Some(read_root(data, latest_index)))
}

/// Pushes a new root into the bounded ring. Re-publishing the current root is a
/// no-op so retries cannot consume history slots. Once full, the oldest root is
/// overwritten and therefore expires.
pub fn push_root(data: &mut [u8], root: [u8; 32]) -> Result<bool, WatcherError> {
    if root == [0u8; 32] {
        return Err(WatcherError::InvalidPublicInputs);
    }

    let mut header = read_header(data)?;
    if latest_root(data)? == Some(root) {
        return Ok(false);
    }

    write_root(data, header.next_index, root);
    header.next_index = (header.next_index + 1) % ROOT_HISTORY_CAPACITY;
    header.count = core::cmp::min(header.count + 1, ROOT_HISTORY_CAPACITY);
    write_header(data, header);
    Ok(true)
}

pub fn require_recent_root(data: &[u8], root: &[u8; 32]) -> Result<(), WatcherError> {
    if root_history_contains(data, root)? {
        Ok(())
    } else {
        Err(WatcherError::UnknownMerkleRoot)
    }
}

pub fn roots_oldest_to_newest(data: &[u8]) -> Result<Vec<[u8; 32]>, WatcherError> {
    let header = read_header(data)?;
    let start = if header.count == ROOT_HISTORY_CAPACITY {
        header.next_index
    } else {
        0
    };
    Ok((0..header.count)
        .map(|offset| read_root(data, (start + offset) % ROOT_HISTORY_CAPACITY))
        .collect())
}
