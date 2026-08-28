use solana_program::{hash::hashv, pubkey::Pubkey};

use crate::{WatcherError, SOL_ASSET_ID_V1};

use super::{DepositStatementV2, WithdrawalStatementV2, MAX_INPUTS_V2};

pub const FIELD_BYTES_V2: usize = 32;
pub const DEPOSIT_PUBLIC_FIELDS_V2: usize = 8;
pub const DEPOSIT_PUBLIC_INPUT_BYTES_V2: usize = FIELD_BYTES_V2 * DEPOSIT_PUBLIC_FIELDS_V2;
pub const WITHDRAW_PUBLIC_FIELDS_V2: usize = 19;
pub const WITHDRAW_PUBLIC_INPUT_BYTES_V2: usize = FIELD_BYTES_V2 * WITHDRAW_PUBLIC_FIELDS_V2;

pub fn field_from_u64_v2(value: u64) -> [u8; 32] {
    let mut output = [0u8; 32];
    output[..8].copy_from_slice(&value.to_le_bytes());
    output
}

pub fn sol_asset_id_field_v2() -> [u8; 32] {
    field_from_u64_v2(SOL_ASSET_ID_V1)
}

fn hash_to_field_v2(parts: &[&[u8]]) -> [u8; 32] {
    let digest = hashv(parts);
    let mut output = digest.to_bytes();
    // Match the existing Watcher field convention: constrain the SHA-256 value
    // to 253 bits before treating the bytes as a little-endian BN254 scalar.
    output[31] &= 0x1f;
    output
}

pub fn recipient_binding_v2(recipient: &Pubkey) -> [u8; 32] {
    hash_to_field_v2(&[b"watcher-recipient-v2", recipient.as_ref()])
}

pub fn deposit_context_binding_v2(
    program_id: &Pubkey,
    config: &Pubkey,
    vault: &Pubkey,
    active_tree: &Pubkey,
    asset_id: &[u8; 32],
) -> [u8; 32] {
    hash_to_field_v2(&[
        b"watcher-deposit-context-v2",
        program_id.as_ref(),
        config.as_ref(),
        vault.as_ref(),
        active_tree.as_ref(),
        asset_id,
    ])
}

pub fn withdraw_context_binding_v2(
    program_id: &Pubkey,
    config: &Pubkey,
    vault: &Pubkey,
    active_tree: &Pubkey,
    relayer: &Pubkey,
    treasury: &Pubkey,
    asset_id: &[u8; 32],
) -> [u8; 32] {
    hash_to_field_v2(&[
        b"watcher-withdraw-context-v2",
        program_id.as_ref(),
        config.as_ref(),
        vault.as_ref(),
        active_tree.as_ref(),
        relayer.as_ref(),
        treasury.as_ref(),
        asset_id,
    ])
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DepositPublicInputsV2 {
    pub commitment: [u8; 32],
    pub amount: [u8; 32],
    pub asset_id: [u8; 32],
    pub epoch: [u8; 32],
    pub context_binding: [u8; 32],
    pub old_root: [u8; 32],
    pub new_root: [u8; 32],
    pub leaf_index: [u8; 32],
}

impl DepositPublicInputsV2 {
    pub fn from_statement(
        statement: &DepositStatementV2,
        epoch: u64,
        old_root: [u8; 32],
        leaf_index: u32,
        asset_id: [u8; 32],
        context_binding: [u8; 32],
    ) -> Result<Self, WatcherError> {
        statement.validate()?;
        if asset_id == [0u8; 32] || context_binding == [0u8; 32] {
            return Err(WatcherError::PublicInputMismatch);
        }
        Ok(Self {
            commitment: statement.commitment,
            amount: field_from_u64_v2(statement.amount),
            asset_id,
            epoch: field_from_u64_v2(epoch),
            context_binding,
            old_root,
            new_root: statement.new_root,
            leaf_index: field_from_u64_v2(leaf_index as u64),
        })
    }

    pub fn encode(&self) -> [u8; DEPOSIT_PUBLIC_INPUT_BYTES_V2] {
        let fields = [
            self.commitment,
            self.amount,
            self.asset_id,
            self.epoch,
            self.context_binding,
            self.old_root,
            self.new_root,
            self.leaf_index,
        ];
        let mut output = [0u8; DEPOSIT_PUBLIC_INPUT_BYTES_V2];
        for (index, field) in fields.iter().enumerate() {
            output[index * FIELD_BYTES_V2..(index + 1) * FIELD_BYTES_V2]
                .copy_from_slice(field);
        }
        output
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WithdrawPublicInputsV2 {
    pub input_roots: [[u8; 32]; MAX_INPUTS_V2],
    pub nullifiers: [[u8; 32]; MAX_INPUTS_V2],
    pub input_count: [u8; 32],
    pub change_commitment: [u8; 32],
    pub public_amount: [u8; 32],
    pub protocol_fee: [u8; 32],
    pub relayer_fee: [u8; 32],
    pub recipient_binding: [u8; 32],
    pub asset_id: [u8; 32],
    pub context_binding: [u8; 32],
    pub current_root: [u8; 32],
    pub new_merkle_root: [u8; 32],
    pub change_leaf_index: [u8; 32],
}

impl WithdrawPublicInputsV2 {
    /// Reconstruct the exact 19 public fields from compact instruction data and
    /// trusted program state. The client never sends a separate 608-byte public
    /// input blob, avoiding packet-size duplication.
    pub fn from_statement(
        statement: &WithdrawalStatementV2,
        active_current_root: [u8; 32],
        active_next_index: u32,
        asset_id: [u8; 32],
        context_binding: [u8; 32],
    ) -> Result<Self, WatcherError> {
        statement.validate_development()?;
        if asset_id == [0u8; 32] || context_binding == [0u8; 32] {
            return Err(WatcherError::PublicInputMismatch);
        }

        let (current_root, new_merkle_root, change_leaf_index) = if statement.has_change() {
            (
                active_current_root,
                statement.new_root,
                field_from_u64_v2(active_next_index as u64),
            )
        } else {
            // Exact withdrawals have no append dependency. Zero sentinels keep
            // the proof valid if another user deposits while it is being built.
            ([0u8; 32], [0u8; 32], [0u8; 32])
        };

        Ok(Self {
            input_roots: statement.input_roots,
            nullifiers: statement.nullifiers,
            input_count: field_from_u64_v2(statement.input_count as u64),
            change_commitment: statement.change_commitment,
            public_amount: field_from_u64_v2(statement.public_amount),
            protocol_fee: field_from_u64_v2(statement.protocol_fee),
            relayer_fee: field_from_u64_v2(statement.relayer_fee),
            recipient_binding: recipient_binding_v2(&statement.recipient),
            asset_id,
            context_binding,
            current_root,
            new_merkle_root,
            change_leaf_index,
        })
    }

    pub fn encode(&self) -> [u8; WITHDRAW_PUBLIC_INPUT_BYTES_V2] {
        let mut output = [0u8; WITHDRAW_PUBLIC_INPUT_BYTES_V2];
        let mut cursor = 0usize;
        let mut push = |field: &[u8; 32]| {
            output[cursor..cursor + FIELD_BYTES_V2].copy_from_slice(field);
            cursor += FIELD_BYTES_V2;
        };
        for root in &self.input_roots {
            push(root);
        }
        for nullifier in &self.nullifiers {
            push(nullifier);
        }
        push(&self.input_count);
        push(&self.change_commitment);
        push(&self.public_amount);
        push(&self.protocol_fee);
        push(&self.relayer_fee);
        push(&self.recipient_binding);
        push(&self.asset_id);
        push(&self.context_binding);
        push(&self.current_root);
        push(&self.new_merkle_root);
        push(&self.change_leaf_index);
        debug_assert_eq!(cursor, WITHDRAW_PUBLIC_INPUT_BYTES_V2);
        output
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::v2::MAX_INPUTS_V2;

    fn field(value: u8) -> [u8; 32] {
        let mut output = [0u8; 32];
        output[0] = value;
        output
    }

    fn statement(has_change: bool) -> WithdrawalStatementV2 {
        let mut roots = [[0u8; 32]; MAX_INPUTS_V2];
        let mut nullifiers = [[0u8; 32]; MAX_INPUTS_V2];
        roots[0] = field(1);
        nullifiers[0] = field(2);
        WithdrawalStatementV2 {
            input_count: 1,
            input_roots: roots,
            nullifiers,
            change_commitment: if has_change { field(3) } else { [0u8; 32] },
            recipient: Pubkey::new_unique(),
            public_amount: 99,
            protocol_fee: 0,
            relayer_fee: 1,
            new_root: if has_change { field(4) } else { [0u8; 32] },
        }
    }

    #[test]
    fn withdrawal_public_wire_is_exactly_nineteen_fields() {
        let inputs = WithdrawPublicInputsV2::from_statement(
            &statement(true),
            field(5),
            7,
            sol_asset_id_field_v2(),
            field(6),
        )
        .unwrap();
        let encoded = inputs.encode();
        assert_eq!(encoded.len(), 19 * 32);
        assert_eq!(&encoded[0..32], &field(1));
        assert_eq!(&encoded[4 * 32..5 * 32], &field(2));
        assert_eq!(&encoded[8 * 32..9 * 32], &field_from_u64_v2(1));
        assert_eq!(&encoded[16 * 32..17 * 32], &field(5));
        assert_eq!(&encoded[17 * 32..18 * 32], &field(4));
        assert_eq!(&encoded[18 * 32..19 * 32], &field_from_u64_v2(7));
    }

    #[test]
    fn exact_withdrawal_reconstruction_ignores_changing_active_tree_state() {
        let first = WithdrawPublicInputsV2::from_statement(
            &statement(false),
            field(10),
            123,
            sol_asset_id_field_v2(),
            field(11),
        )
        .unwrap();
        let second = WithdrawPublicInputsV2::from_statement(
            &statement(false),
            field(99),
            456,
            sol_asset_id_field_v2(),
            field(11),
        )
        .unwrap();
        assert_eq!(first.current_root, [0u8; 32]);
        assert_eq!(first.new_merkle_root, [0u8; 32]);
        assert_eq!(first.change_leaf_index, [0u8; 32]);
        assert_eq!(first.encode(), second.encode());
    }

    #[test]
    fn change_withdrawal_reconstruction_binds_current_root_and_index() {
        let inputs = WithdrawPublicInputsV2::from_statement(
            &statement(true),
            field(10),
            123,
            sol_asset_id_field_v2(),
            field(11),
        )
        .unwrap();
        assert_eq!(inputs.current_root, field(10));
        assert_eq!(inputs.new_merkle_root, field(4));
        assert_eq!(inputs.change_leaf_index, field_from_u64_v2(123));
    }

    #[test]
    fn deposit_public_wire_includes_epoch_and_context() {
        let inputs = DepositPublicInputsV2::from_statement(
            &DepositStatementV2 {
                commitment: field(12),
                amount: 55,
                new_root: field(13),
            },
            9,
            field(14),
            23,
            sol_asset_id_field_v2(),
            field(15),
        )
        .unwrap();
        let encoded = inputs.encode();
        assert_eq!(encoded.len(), 8 * 32);
        assert_eq!(&encoded[3 * 32..4 * 32], &field_from_u64_v2(9));
        assert_eq!(&encoded[4 * 32..5 * 32], &field(15));
        assert_eq!(&encoded[7 * 32..8 * 32], &field_from_u64_v2(23));
    }

    #[test]
    fn v2_context_domains_are_deployment_bound_and_distinct() {
        let program = Pubkey::new_unique();
        let config = Pubkey::new_unique();
        let vault = Pubkey::new_unique();
        let active = Pubkey::new_unique();
        let relayer = Pubkey::new_unique();
        let treasury = Pubkey::new_unique();
        let asset = sol_asset_id_field_v2();
        let deposit = deposit_context_binding_v2(&program, &config, &vault, &active, &asset);
        let withdraw = withdraw_context_binding_v2(
            &program,
            &config,
            &vault,
            &active,
            &relayer,
            &treasury,
            &asset,
        );
        assert_ne!(deposit, [0u8; 32]);
        assert_ne!(withdraw, [0u8; 32]);
        assert_ne!(deposit, withdraw);
    }
}
