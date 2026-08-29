//! Watcher Protocol V3 experimental storage path.
//!
//! V3 reuses the V2 circuit and statement semantics but replaces one-PDA-per-
//! nullifier markers with packed exact nullifier shards. It is isolated from
//! the public V2 deployment until its own validator and browser regressions are
//! complete.

pub mod nullifier_set;
pub mod processor;

pub const STATE_VERSION_V3: u8 = 3;
pub const INITIALIZE_TAG_V3: u8 = 0x32;
pub const INITIALIZE_NULLIFIER_SHARD_TAG_V3: u8 = 0x33;
pub const DEPOSIT_TAG_V3: u8 = 0x30;
pub const WITHDRAW_TAG_V3: u8 = 0x31;
