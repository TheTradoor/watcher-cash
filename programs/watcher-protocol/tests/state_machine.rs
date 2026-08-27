use solana_program::pubkey::Pubkey;
use watcher_protocol_program::{
    verify_withdrawal_proof, DepositRecord, ProtocolConfig, ProtocolStateModel,
    WatcherError, WithdrawalStatement,
};

fn commitment(x: u8) -> [u8; 32] { [x; 32] }
fn nullifier(x: u8) -> [u8; 32] { [x; 32] }

fn withdrawal() -> WithdrawalStatement {
    WithdrawalStatement {
        nullifier_0: nullifier(11),
        nullifier_1: nullifier(12),
        change_commitment: commitment(22),
        recipient: Pubkey::new_unique(),
        public_amount: 1_000_000,
        protocol_fee: 0,
        relayer_fee: 5_000,
    }
}

#[test]
fn development_config_refuses_protocol_fee() {
    let authority = Pubkey::new_unique();
    let treasury = Pubkey::new_unique();
    let mut config = ProtocolConfig::development(authority, treasury);
    assert!(config.validate().is_ok());
    config.fees_enabled = true;
    config.protocol_fee_bps = 20;
    assert_eq!(config.validate(), Err(WatcherError::FeesDisabledDuringDevelopment));
}

#[test]
fn records_unique_deposit_commitments() {
    let mut state = ProtocolStateModel::default();
    let d = DepositRecord { commitment: commitment(1), amount: 10_000 };
    assert!(state.record_deposit(d).is_ok());
    assert_eq!(state.record_deposit(d), Err(WatcherError::DuplicateCommitment));
}

#[test]
fn rejects_zero_deposit() {
    let mut state = ProtocolStateModel::default();
    assert_eq!(
        state.record_deposit(DepositRecord { commitment: commitment(1), amount: 0 }),
        Err(WatcherError::ZeroAmount)
    );
}

#[test]
fn verified_withdrawal_marks_nullifiers_spent() {
    let mut state = ProtocolStateModel::default();
    let w = withdrawal();
    assert!(state.apply_verified_withdrawal(w).is_ok());
    assert!(state.is_spent(&w.nullifier_0));
    assert!(state.is_spent(&w.nullifier_1));
}

#[test]
fn double_spend_is_rejected() {
    let mut state = ProtocolStateModel::default();
    let w = withdrawal();
    assert!(state.apply_verified_withdrawal(w).is_ok());
    let mut second = withdrawal();
    second.change_commitment = commitment(23);
    assert_eq!(state.apply_verified_withdrawal(second), Err(WatcherError::NullifierAlreadySpent));
}

#[test]
fn duplicate_nullifiers_inside_one_withdrawal_are_rejected() {
    let mut state = ProtocolStateModel::default();
    let mut w = withdrawal();
    w.nullifier_1 = w.nullifier_0;
    assert_eq!(state.apply_verified_withdrawal(w), Err(WatcherError::DuplicateNullifier));
}

#[test]
fn development_withdrawal_cannot_charge_protocol_fee() {
    let mut state = ProtocolStateModel::default();
    let mut w = withdrawal();
    w.protocol_fee = 1;
    assert_eq!(state.apply_verified_withdrawal(w), Err(WatcherError::FeesDisabledDuringDevelopment));
}

#[test]
fn proof_boundary_fails_closed() {
    assert_eq!(
        verify_withdrawal_proof(&[1, 2, 3], &[4, 5, 6]),
        Err(WatcherError::ProofVerificationUnavailable)
    );
}
