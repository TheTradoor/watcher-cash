use solana_program::pubkey::Pubkey;

use crate::WatcherError;

use super::{GROTH16_PROOF_BYTES_V2, MAX_INPUTS_V2};

pub const DEPOSIT_TAG_V2: u8 = 0x20;
pub const WITHDRAW_TAG_V2: u8 = 0x21;

pub const DEPOSIT_INSTRUCTION_BYTES_V2: usize =
    1 + 32 + 8 + 32 + GROTH16_PROOF_BYTES_V2;
pub const WITHDRAW_INSTRUCTION_BYTES_V2: usize =
    1 + 1 + (32 * MAX_INPUTS_V2) + (32 * MAX_INPUTS_V2) + 32 + 32 + (8 * 3) + 32
        + GROTH16_PROOF_BYTES_V2;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DepositStatementV2 {
    pub commitment: [u8; 32],
    pub amount: u64,
    pub new_root: [u8; 32],
}

impl DepositStatementV2 {
    pub fn validate(&self) -> Result<(), WatcherError> {
        if self.amount == 0 {
            return Err(WatcherError::ZeroAmount);
        }
        if self.commitment == [0u8; 32] || self.new_root == [0u8; 32] {
            return Err(WatcherError::ZeroCommitment);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WithdrawalStatementV2 {
    pub input_count: u8,
    pub input_roots: [[u8; 32]; MAX_INPUTS_V2],
    pub nullifiers: [[u8; 32]; MAX_INPUTS_V2],
    pub change_commitment: [u8; 32],
    pub recipient: Pubkey,
    pub public_amount: u64,
    pub protocol_fee: u64,
    pub relayer_fee: u64,
    /// Proof-bound root after appending private change. Exact withdrawals use
    /// the zero sentinel because they do not touch the active tree.
    pub new_root: [u8; 32],
}

impl WithdrawalStatementV2 {
    pub fn validate_development(&self) -> Result<(), WatcherError> {
        let input_count = self.input_count as usize;
        if input_count == 0 || input_count > MAX_INPUTS_V2 {
            return Err(WatcherError::InvalidInstruction);
        }
        if self.public_amount == 0 {
            return Err(WatcherError::ZeroAmount);
        }
        if self.protocol_fee != 0 {
            return Err(WatcherError::FeesDisabledDuringDevelopment);
        }

        for index in 0..MAX_INPUTS_V2 {
            let active = index < input_count;
            let root = self.input_roots[index];
            let nullifier = self.nullifiers[index];
            if active {
                if root == [0u8; 32] {
                    return Err(WatcherError::UnknownMerkleRoot);
                }
                if nullifier == [0u8; 32] {
                    return Err(WatcherError::ZeroNullifier);
                }
            } else if root != [0u8; 32] || nullifier != [0u8; 32] {
                // Disabled proof slots must use one canonical zero encoding.
                return Err(WatcherError::InvalidInstruction);
            }
        }

        for left in 0..input_count {
            for right in left + 1..input_count {
                if self.nullifiers[left] == self.nullifiers[right] {
                    return Err(WatcherError::DuplicateNullifier);
                }
            }
        }

        if self.change_commitment == [0u8; 32] {
            if self.new_root != [0u8; 32] {
                return Err(WatcherError::PublicInputMismatch);
            }
        } else if self.new_root == [0u8; 32] {
            return Err(WatcherError::PublicInputMismatch);
        }

        Ok(())
    }

    pub fn has_change(&self) -> bool {
        self.change_commitment != [0u8; 32]
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WatcherInstructionV2 {
    Deposit {
        statement: DepositStatementV2,
        proof: [u8; GROTH16_PROOF_BYTES_V2],
    },
    Withdraw {
        statement: WithdrawalStatementV2,
        proof: [u8; GROTH16_PROOF_BYTES_V2],
    },
}

fn take<const N: usize>(rest: &mut &[u8]) -> Result<[u8; N], WatcherError> {
    if rest.len() < N {
        return Err(WatcherError::InvalidInstruction);
    }
    let value = rest[..N].try_into().unwrap();
    *rest = &rest[N..];
    Ok(value)
}

fn take_u64(rest: &mut &[u8]) -> Result<u64, WatcherError> {
    Ok(u64::from_le_bytes(take::<8>(rest)?))
}

impl WatcherInstructionV2 {
    pub fn pack(&self) -> Result<Vec<u8>, WatcherError> {
        match self {
            Self::Deposit { statement, proof } => {
                statement.validate()?;
                let mut output = Vec::with_capacity(DEPOSIT_INSTRUCTION_BYTES_V2);
                output.push(DEPOSIT_TAG_V2);
                output.extend_from_slice(&statement.commitment);
                output.extend_from_slice(&statement.amount.to_le_bytes());
                output.extend_from_slice(&statement.new_root);
                output.extend_from_slice(proof);
                debug_assert_eq!(output.len(), DEPOSIT_INSTRUCTION_BYTES_V2);
                Ok(output)
            }
            Self::Withdraw { statement, proof } => {
                statement.validate_development()?;
                let mut output = Vec::with_capacity(WITHDRAW_INSTRUCTION_BYTES_V2);
                output.push(WITHDRAW_TAG_V2);
                output.push(statement.input_count);
                for root in &statement.input_roots {
                    output.extend_from_slice(root);
                }
                for nullifier in &statement.nullifiers {
                    output.extend_from_slice(nullifier);
                }
                output.extend_from_slice(&statement.change_commitment);
                output.extend_from_slice(statement.recipient.as_ref());
                output.extend_from_slice(&statement.public_amount.to_le_bytes());
                output.extend_from_slice(&statement.protocol_fee.to_le_bytes());
                output.extend_from_slice(&statement.relayer_fee.to_le_bytes());
                output.extend_from_slice(&statement.new_root);
                output.extend_from_slice(proof);
                debug_assert_eq!(output.len(), WITHDRAW_INSTRUCTION_BYTES_V2);
                Ok(output)
            }
        }
    }

    pub fn unpack(input: &[u8]) -> Result<Self, WatcherError> {
        let (&tag, mut rest) = input
            .split_first()
            .ok_or(WatcherError::InvalidInstruction)?;
        match tag {
            DEPOSIT_TAG_V2 => {
                if input.len() != DEPOSIT_INSTRUCTION_BYTES_V2 {
                    return Err(WatcherError::InvalidInstruction);
                }
                let statement = DepositStatementV2 {
                    commitment: take::<32>(&mut rest)?,
                    amount: take_u64(&mut rest)?,
                    new_root: take::<32>(&mut rest)?,
                };
                let proof = take::<GROTH16_PROOF_BYTES_V2>(&mut rest)?;
                if !rest.is_empty() {
                    return Err(WatcherError::InvalidInstruction);
                }
                statement.validate()?;
                Ok(Self::Deposit { statement, proof })
            }
            WITHDRAW_TAG_V2 => {
                if input.len() != WITHDRAW_INSTRUCTION_BYTES_V2 {
                    return Err(WatcherError::InvalidInstruction);
                }
                let input_count = take::<1>(&mut rest)?[0];
                let mut input_roots = [[0u8; 32]; MAX_INPUTS_V2];
                let mut nullifiers = [[0u8; 32]; MAX_INPUTS_V2];
                for root in &mut input_roots {
                    *root = take::<32>(&mut rest)?;
                }
                for nullifier in &mut nullifiers {
                    *nullifier = take::<32>(&mut rest)?;
                }
                let statement = WithdrawalStatementV2 {
                    input_count,
                    input_roots,
                    nullifiers,
                    change_commitment: take::<32>(&mut rest)?,
                    recipient: Pubkey::new_from_array(take::<32>(&mut rest)?),
                    public_amount: take_u64(&mut rest)?,
                    protocol_fee: take_u64(&mut rest)?,
                    relayer_fee: take_u64(&mut rest)?,
                    new_root: take::<32>(&mut rest)?,
                };
                let proof = take::<GROTH16_PROOF_BYTES_V2>(&mut rest)?;
                if !rest.is_empty() {
                    return Err(WatcherError::InvalidInstruction);
                }
                statement.validate_development()?;
                Ok(Self::Withdraw { statement, proof })
            }
            _ => Err(WatcherError::InvalidInstruction),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn field(value: u8) -> [u8; 32] {
        let mut output = [0u8; 32];
        output[0] = value;
        output
    }

    fn withdrawal(input_count: u8, has_change: bool) -> WithdrawalStatementV2 {
        let mut roots = [[0u8; 32]; MAX_INPUTS_V2];
        let mut nullifiers = [[0u8; 32]; MAX_INPUTS_V2];
        for index in 0..input_count as usize {
            roots[index] = field(10 + index as u8);
            nullifiers[index] = field(20 + index as u8);
        }
        WithdrawalStatementV2 {
            input_count,
            input_roots: roots,
            nullifiers,
            change_commitment: if has_change { field(50) } else { [0u8; 32] },
            recipient: Pubkey::new_unique(),
            public_amount: 5_000_000,
            protocol_fee: 0,
            relayer_fee: 1000,
            new_root: if has_change { field(51) } else { [0u8; 32] },
        }
    }

    #[test]
    fn deposit_round_trip_is_fixed_and_compact() {
        let instruction = WatcherInstructionV2::Deposit {
            statement: DepositStatementV2 {
                commitment: field(1),
                amount: 1_000_000,
                new_root: field(2),
            },
            proof: [7u8; GROTH16_PROOF_BYTES_V2],
        };
        let encoded = instruction.pack().unwrap();
        assert_eq!(encoded.len(), DEPOSIT_INSTRUCTION_BYTES_V2);
        assert_eq!(encoded.len(), 329);
        assert_eq!(WatcherInstructionV2::unpack(&encoded).unwrap(), instruction);
    }

    #[test]
    fn four_input_withdraw_round_trip_stays_below_seven_hundred_bytes() {
        let instruction = WatcherInstructionV2::Withdraw {
            statement: withdrawal(4, true),
            proof: [9u8; GROTH16_PROOF_BYTES_V2],
        };
        let encoded = instruction.pack().unwrap();
        assert_eq!(encoded.len(), WITHDRAW_INSTRUCTION_BYTES_V2);
        assert_eq!(encoded.len(), 634);
        assert!(encoded.len() < 700);
        assert_eq!(WatcherInstructionV2::unpack(&encoded).unwrap(), instruction);
    }

    #[test]
    fn one_input_exact_withdraw_uses_zero_inactive_slots_and_zero_new_root() {
        let statement = withdrawal(1, false);
        statement.validate_development().unwrap();
        assert!(!statement.has_change());
        assert_eq!(statement.input_roots[1], [0u8; 32]);
        assert_eq!(statement.nullifiers[1], [0u8; 32]);
        assert_eq!(statement.new_root, [0u8; 32]);
    }

    #[test]
    fn inactive_slots_must_be_canonical_zeroes() {
        let mut statement = withdrawal(1, false);
        statement.input_roots[2] = field(99);
        assert_eq!(
            statement.validate_development(),
            Err(WatcherError::InvalidInstruction)
        );
    }

    #[test]
    fn duplicate_active_nullifiers_are_rejected() {
        let mut statement = withdrawal(2, true);
        statement.nullifiers[1] = statement.nullifiers[0];
        assert_eq!(
            statement.validate_development(),
            Err(WatcherError::DuplicateNullifier)
        );
    }

    #[test]
    fn exact_withdraw_cannot_smuggle_a_tree_transition() {
        let mut statement = withdrawal(1, false);
        statement.new_root = field(77);
        assert_eq!(
            statement.validate_development(),
            Err(WatcherError::PublicInputMismatch)
        );
    }
}
