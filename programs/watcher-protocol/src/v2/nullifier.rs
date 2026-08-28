use solana_program::pubkey::Pubkey;

use crate::WatcherError;

/// Phase-1 V2 uses one zero-data PDA marker per spent nullifier. This removes
/// the unbounded flat V1 registry immediately and gives O(1) double-spend
/// lookup. The rent tradeoff is explicit and can later be replaced by a
/// compressed nullifier-set implementation without changing the circuit.
pub const NULLIFIER_MARKER_SEED_V2: &[u8] = b"watcher-nullifier-v2";
pub const NULLIFIER_MARKER_SPACE_V2: usize = 0;

pub fn derive_nullifier_marker_v2(
    program_id: &Pubkey,
    config: &Pubkey,
    nullifier: &[u8; 32],
) -> Result<(Pubkey, u8), WatcherError> {
    if *nullifier == [0u8; 32] {
        return Err(WatcherError::ZeroNullifier);
    }
    Ok(Pubkey::find_program_address(
        &[NULLIFIER_MARKER_SEED_V2, config.as_ref(), nullifier],
        program_id,
    ))
}

pub fn validate_nullifier_marker_v2(
    program_id: &Pubkey,
    config: &Pubkey,
    nullifier: &[u8; 32],
    marker: &Pubkey,
) -> Result<u8, WatcherError> {
    let (expected, bump) = derive_nullifier_marker_v2(program_id, config, nullifier)?;
    if expected != *marker {
        return Err(WatcherError::InvalidAccountData);
    }
    Ok(bump)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nullifier(value: u8) -> [u8; 32] {
        let mut output = [0u8; 32];
        output[0] = value;
        output
    }

    #[test]
    fn marker_is_deterministic_and_scoped_to_config() {
        let program = Pubkey::new_unique();
        let config_a = Pubkey::new_unique();
        let config_b = Pubkey::new_unique();
        let value = nullifier(7);
        let first = derive_nullifier_marker_v2(&program, &config_a, &value).unwrap();
        let second = derive_nullifier_marker_v2(&program, &config_a, &value).unwrap();
        let other_config = derive_nullifier_marker_v2(&program, &config_b, &value).unwrap();
        assert_eq!(first, second);
        assert_ne!(first.0, other_config.0);
        assert_eq!(NULLIFIER_MARKER_SPACE_V2, 0);
    }

    #[test]
    fn different_nullifiers_have_different_markers() {
        let program = Pubkey::new_unique();
        let config = Pubkey::new_unique();
        let left = derive_nullifier_marker_v2(&program, &config, &nullifier(1)).unwrap();
        let right = derive_nullifier_marker_v2(&program, &config, &nullifier(2)).unwrap();
        assert_ne!(left.0, right.0);
    }

    #[test]
    fn zero_nullifier_has_no_marker() {
        assert_eq!(
            derive_nullifier_marker_v2(
                &Pubkey::new_unique(),
                &Pubkey::new_unique(),
                &[0u8; 32],
            ),
            Err(WatcherError::ZeroNullifier)
        );
    }

    #[test]
    fn wrong_marker_address_is_rejected() {
        let program = Pubkey::new_unique();
        let config = Pubkey::new_unique();
        assert_eq!(
            validate_nullifier_marker_v2(
                &program,
                &config,
                &nullifier(3),
                &Pubkey::new_unique(),
            ),
            Err(WatcherError::InvalidAccountData)
        );
    }
}
