//! Watcher Protocol V2 state and statement primitives.
//!
//! This module is intentionally not wired into the V1 processor yet. V1 stays
//! the live devnet path while V2 is developed and regression-tested in isolation.

pub mod codec;
pub mod nullifier;
pub mod public_inputs;
pub mod state;

pub const STATE_VERSION_V2: u8 = 2;
pub const MERKLE_DEPTH_V2: u8 = 16;
pub const TREE_CAPACITY_V2: u32 = 1u32 << MERKLE_DEPTH_V2;
pub const MAX_INPUTS_V2: usize = 4;
pub const GROTH16_PROOF_BYTES_V2: usize = 256;
pub const RECENT_ROOT_CAPACITY_V2: usize = 16;

pub use codec::{DepositStatementV2, WatcherInstructionV2, WithdrawalStatementV2};
pub use state::{ActiveTreeV2, SealedRootV2};
