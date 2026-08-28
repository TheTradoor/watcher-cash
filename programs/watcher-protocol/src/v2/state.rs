use solana_program::pubkey::Pubkey;

use crate::WatcherError;

use super::{RECENT_ROOT_CAPACITY_V2, STATE_VERSION_V2, TREE_CAPACITY_V2};

pub const ACTIVE_TREE_ACCOUNT_LEN_V2: usize =
    1 + 32 + 8 + 4 + 32 + 1 + 1 + (32 * RECENT_ROOT_CAPACITY_V2);
pub const SEALED_ROOT_ACCOUNT_LEN_V2: usize = 1 + 32 + 8 + 32 + 4;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActiveTreeV2 {
    pub config: Pubkey,
    pub epoch: u64,
    pub next_index: u32,
    pub current_root: [u8; 32],
    /// Number of populated entries in `recent_roots`.
    pub recent_root_count: u8,
    /// Next ring position to overwrite once a new old-root is retained.
    pub recent_root_cursor: u8,
    pub recent_roots: [[u8; 32]; RECENT_ROOT_CAPACITY_V2],
}

impl ActiveTreeV2 {
    pub fn new(config: Pubkey) -> Self {
        Self {
            config,
            epoch: 0,
            next_index: 0,
            current_root: [0u8; 32],
            recent_root_count: 0,
            recent_root_cursor: 0,
            recent_roots: [[0u8; 32]; RECENT_ROOT_CAPACITY_V2],
        }
    }

    pub fn validate(&self) -> Result<(), WatcherError> {
        if self.next_index > TREE_CAPACITY_V2 {
            return Err(WatcherError::InvalidAccountData);
        }
        if self.recent_root_count as usize > RECENT_ROOT_CAPACITY_V2
            || self.recent_root_cursor as usize >= RECENT_ROOT_CAPACITY_V2
        {
            return Err(WatcherError::InvalidAccountData);
        }
        if self.next_index == 0 {
            if self.current_root != [0u8; 32]
                || self.recent_root_count != 0
                || self.recent_root_cursor != 0
                || self.recent_roots.iter().any(|root| *root != [0u8; 32])
            {
                return Err(WatcherError::InvalidAccountData);
            }
            return Ok(());
        }
        if self.current_root == [0u8; 32] {
            return Err(WatcherError::InvalidAccountData);
        }

        let count = self.recent_root_count as usize;
        if count < RECENT_ROOT_CAPACITY_V2 {
            if self.recent_root_cursor as usize != count {
                return Err(WatcherError::InvalidAccountData);
            }
            if self.recent_roots[..count]
                .iter()
                .any(|root| *root == [0u8; 32])
                || self.recent_roots[count..]
                    .iter()
                    .any(|root| *root != [0u8; 32])
            {
                return Err(WatcherError::InvalidAccountData);
            }
        } else if self
            .recent_roots
            .iter()
            .any(|root| *root == [0u8; 32])
        {
            return Err(WatcherError::InvalidAccountData);
        }
        Ok(())
    }

    pub fn is_full(&self) -> bool {
        self.next_index == TREE_CAPACITY_V2
    }

    pub fn accepts_recent_root(&self, root: &[u8; 32]) -> bool {
        if *root == [0u8; 32] {
            return false;
        }
        if self.current_root == *root {
            return true;
        }
        let count = self.recent_root_count as usize;
        self.recent_roots[..count.min(RECENT_ROOT_CAPACITY_V2)]
            .iter()
            .any(|candidate| candidate == root)
    }

    fn retain_old_root(&mut self, root: [u8; 32]) {
        if root == [0u8; 32] {
            return;
        }
        let count = self.recent_root_count as usize;
        if self.recent_roots[..count.min(RECENT_ROOT_CAPACITY_V2)]
            .iter()
            .any(|candidate| *candidate == root)
        {
            return;
        }
        let cursor = self.recent_root_cursor as usize;
        self.recent_roots[cursor] = root;
        self.recent_root_cursor = ((cursor + 1) % RECENT_ROOT_CAPACITY_V2) as u8;
        if (self.recent_root_count as usize) < RECENT_ROOT_CAPACITY_V2 {
            self.recent_root_count += 1;
        }
    }

    /// Apply a proof-verified append transition. No MiMC work is repeated in the
    /// Solana VM: the proof binds old root, new root and leaf index, while this
    /// state machine checks that the old root/index were exactly current.
    pub fn apply_verified_append(
        &mut self,
        expected_old_root: [u8; 32],
        new_root: [u8; 32],
        leaf_index: u32,
    ) -> Result<(), WatcherError> {
        self.validate()?;
        if self.is_full() {
            return Err(WatcherError::MerkleTreeFull);
        }
        if leaf_index != self.next_index || expected_old_root != self.current_root {
            return Err(WatcherError::RootHistoryMismatch);
        }
        if new_root == [0u8; 32] {
            return Err(WatcherError::PublicInputMismatch);
        }
        let old_root = self.current_root;
        self.retain_old_root(old_root);
        self.current_root = new_root;
        self.next_index = self
            .next_index
            .checked_add(1)
            .ok_or(WatcherError::ArithmeticOverflow)?;
        self.validate()?;
        Ok(())
    }

    /// Seal a completely full epoch and reset the active tree to the next epoch.
    /// Partial migration roots use an explicitly created `SealedRootV2` record
    /// instead; normal automatic rotation never silently seals a partial epoch.
    pub fn seal_full_epoch(&mut self) -> Result<SealedRootV2, WatcherError> {
        self.validate()?;
        if !self.is_full() || self.current_root == [0u8; 32] {
            return Err(WatcherError::InvalidInstruction);
        }
        let sealed = SealedRootV2 {
            config: self.config,
            epoch: self.epoch,
            root: self.current_root,
            leaf_count: self.next_index,
        };
        self.epoch = self
            .epoch
            .checked_add(1)
            .ok_or(WatcherError::ArithmeticOverflow)?;
        self.next_index = 0;
        self.current_root = [0u8; 32];
        self.recent_root_count = 0;
        self.recent_root_cursor = 0;
        self.recent_roots = [[0u8; 32]; RECENT_ROOT_CAPACITY_V2];
        self.validate()?;
        Ok(sealed)
    }

    pub fn pack(&self, destination: &mut [u8]) -> Result<(), WatcherError> {
        self.validate()?;
        if destination.len() < ACTIVE_TREE_ACCOUNT_LEN_V2 {
            return Err(WatcherError::InvalidAccountData);
        }
        destination[..ACTIVE_TREE_ACCOUNT_LEN_V2].fill(0);
        destination[0] = STATE_VERSION_V2;
        destination[1..33].copy_from_slice(self.config.as_ref());
        destination[33..41].copy_from_slice(&self.epoch.to_le_bytes());
        destination[41..45].copy_from_slice(&self.next_index.to_le_bytes());
        destination[45..77].copy_from_slice(&self.current_root);
        destination[77] = self.recent_root_count;
        destination[78] = self.recent_root_cursor;
        for (index, root) in self.recent_roots.iter().enumerate() {
            let start = 79 + index * 32;
            destination[start..start + 32].copy_from_slice(root);
        }
        Ok(())
    }

    pub fn unpack(source: &[u8]) -> Result<Self, WatcherError> {
        if source.len() < ACTIVE_TREE_ACCOUNT_LEN_V2 || source[0] != STATE_VERSION_V2 {
            return Err(WatcherError::InvalidAccountData);
        }
        let mut recent_roots = [[0u8; 32]; RECENT_ROOT_CAPACITY_V2];
        for (index, root) in recent_roots.iter_mut().enumerate() {
            let start = 79 + index * 32;
            *root = source[start..start + 32].try_into().unwrap();
        }
        let value = Self {
            config: Pubkey::new_from_array(source[1..33].try_into().unwrap()),
            epoch: u64::from_le_bytes(source[33..41].try_into().unwrap()),
            next_index: u32::from_le_bytes(source[41..45].try_into().unwrap()),
            current_root: source[45..77].try_into().unwrap(),
            recent_root_count: source[77],
            recent_root_cursor: source[78],
            recent_roots,
        };
        value.validate()?;
        Ok(value)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SealedRootV2 {
    pub config: Pubkey,
    pub epoch: u64,
    pub root: [u8; 32],
    pub leaf_count: u32,
}

impl SealedRootV2 {
    pub fn validate(&self) -> Result<(), WatcherError> {
        if self.root == [0u8; 32]
            || self.leaf_count == 0
            || self.leaf_count > TREE_CAPACITY_V2
        {
            return Err(WatcherError::InvalidAccountData);
        }
        Ok(())
    }

    pub fn accepts(&self, config: &Pubkey, root: &[u8; 32]) -> bool {
        &self.config == config && &self.root == root && self.validate().is_ok()
    }

    pub fn pack(&self, destination: &mut [u8]) -> Result<(), WatcherError> {
        self.validate()?;
        if destination.len() < SEALED_ROOT_ACCOUNT_LEN_V2 {
            return Err(WatcherError::InvalidAccountData);
        }
        destination[..SEALED_ROOT_ACCOUNT_LEN_V2].fill(0);
        destination[0] = STATE_VERSION_V2;
        destination[1..33].copy_from_slice(self.config.as_ref());
        destination[33..41].copy_from_slice(&self.epoch.to_le_bytes());
        destination[41..73].copy_from_slice(&self.root);
        destination[73..77].copy_from_slice(&self.leaf_count.to_le_bytes());
        Ok(())
    }

    pub fn unpack(source: &[u8]) -> Result<Self, WatcherError> {
        if source.len() < SEALED_ROOT_ACCOUNT_LEN_V2 || source[0] != STATE_VERSION_V2 {
            return Err(WatcherError::InvalidAccountData);
        }
        let value = Self {
            config: Pubkey::new_from_array(source[1..33].try_into().unwrap()),
            epoch: u64::from_le_bytes(source[33..41].try_into().unwrap()),
            root: source[41..73].try_into().unwrap(),
            leaf_count: u32::from_le_bytes(source[73..77].try_into().unwrap()),
        };
        value.validate()?;
        Ok(value)
    }
}

pub fn validate_spend_roots_v2(
    input_roots: &[[u8; 32]; super::MAX_INPUTS_V2],
    input_count: u8,
    active_tree: &ActiveTreeV2,
    sealed_roots: &[SealedRootV2],
) -> Result<(), WatcherError> {
    active_tree.validate()?;
    let count = input_count as usize;
    if count == 0 || count > super::MAX_INPUTS_V2 {
        return Err(WatcherError::InvalidInstruction);
    }
    for (index, root) in input_roots.iter().enumerate() {
        if index >= count {
            if *root != [0u8; 32] {
                return Err(WatcherError::InvalidInstruction);
            }
            continue;
        }
        if active_tree.accepts_recent_root(root) {
            continue;
        }
        if sealed_roots
            .iter()
            .any(|sealed| sealed.accepts(&active_tree.config, root))
        {
            continue;
        }
        return Err(WatcherError::UnknownMerkleRoot);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root(value: u8) -> [u8; 32] {
        let mut output = [0u8; 32];
        output[0] = value;
        output
    }

    #[test]
    fn active_tree_round_trip_is_compact() {
        let config = Pubkey::new_unique();
        let mut tree = ActiveTreeV2::new(config);
        tree.apply_verified_append([0u8; 32], root(1), 0).unwrap();
        tree.apply_verified_append(root(1), root(2), 1).unwrap();
        let mut bytes = vec![0u8; ACTIVE_TREE_ACCOUNT_LEN_V2];
        tree.pack(&mut bytes).unwrap();
        assert_eq!(bytes.len(), 591);
        assert_eq!(ActiveTreeV2::unpack(&bytes).unwrap(), tree);
    }

    #[test]
    fn append_requires_exact_current_root_and_next_index() {
        let config = Pubkey::new_unique();
        let mut tree = ActiveTreeV2::new(config);
        assert_eq!(
            tree.apply_verified_append(root(9), root(1), 0),
            Err(WatcherError::RootHistoryMismatch)
        );
        tree.apply_verified_append([0u8; 32], root(1), 0).unwrap();
        assert_eq!(
            tree.apply_verified_append(root(1), root(2), 7),
            Err(WatcherError::RootHistoryMismatch)
        );
    }

    #[test]
    fn old_roots_remain_temporarily_accepted() {
        let config = Pubkey::new_unique();
        let mut tree = ActiveTreeV2::new(config);
        tree.apply_verified_append([0u8; 32], root(1), 0).unwrap();
        tree.apply_verified_append(root(1), root(2), 1).unwrap();
        tree.apply_verified_append(root(2), root(3), 2).unwrap();
        assert!(tree.accepts_recent_root(&root(1)));
        assert!(tree.accepts_recent_root(&root(2)));
        assert!(tree.accepts_recent_root(&root(3)));
        assert!(!tree.accepts_recent_root(&root(99)));
    }

    #[test]
    fn root_ring_is_bounded() {
        let config = Pubkey::new_unique();
        let mut tree = ActiveTreeV2::new(config);
        let mut previous = [0u8; 32];
        for index in 0..20u32 {
            let next = root((index + 1) as u8);
            tree.apply_verified_append(previous, next, index).unwrap();
            previous = next;
        }
        assert_eq!(tree.recent_root_count as usize, RECENT_ROOT_CAPACITY_V2);
        assert!(tree.accepts_recent_root(&root(20)));
        assert!(tree.accepts_recent_root(&root(19)));
        assert!(!tree.accepts_recent_root(&root(1)));
    }

    #[test]
    fn sealed_roots_extend_spend_lifetime_beyond_recent_ring() {
        let config = Pubkey::new_unique();
        let mut active = ActiveTreeV2::new(config);
        active.apply_verified_append([0u8; 32], root(90), 0).unwrap();
        let sealed = SealedRootV2 {
            config,
            epoch: 41,
            root: root(7),
            leaf_count: 123,
        };
        let roots = [root(90), root(7), [0u8; 32], [0u8; 32]];
        validate_spend_roots_v2(&roots, 2, &active, &[sealed]).unwrap();
        assert_eq!(
            validate_spend_roots_v2(&[root(8), [0u8; 32], [0u8; 32], [0u8; 32]], 1, &active, &[sealed]),
            Err(WatcherError::UnknownMerkleRoot)
        );
    }

    #[test]
    fn full_epoch_seals_and_rotates_without_carrying_recent_roots() {
        let config = Pubkey::new_unique();
        let mut tree = ActiveTreeV2::new(config);
        tree.next_index = TREE_CAPACITY_V2;
        tree.current_root = root(44);
        tree.recent_root_count = 1;
        tree.recent_root_cursor = 1;
        tree.recent_roots[0] = root(43);
        tree.validate().unwrap();
        let sealed = tree.seal_full_epoch().unwrap();
        assert_eq!(sealed.epoch, 0);
        assert_eq!(sealed.root, root(44));
        assert_eq!(sealed.leaf_count, TREE_CAPACITY_V2);
        assert_eq!(tree.epoch, 1);
        assert_eq!(tree.next_index, 0);
        assert_eq!(tree.current_root, [0u8; 32]);
        assert_eq!(tree.recent_root_count, 0);
        tree.validate().unwrap();
    }

    #[test]
    fn sealed_root_round_trip_allows_partial_migration_epoch() {
        let sealed = SealedRootV2 {
            config: Pubkey::new_unique(),
            epoch: 99,
            root: root(5),
            leaf_count: 16,
        };
        let mut bytes = vec![0u8; SEALED_ROOT_ACCOUNT_LEN_V2];
        sealed.pack(&mut bytes).unwrap();
        assert_eq!(bytes.len(), 77);
        assert_eq!(SealedRootV2::unpack(&bytes).unwrap(), sealed);
    }
}
