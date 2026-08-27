use solana_program::{
    account_info::AccountInfo,
    clock::Epoch,
    program_error::ProgramError,
    pubkey::Pubkey,
};
use watcher_protocol_program::{
    codec::{contains_32, ConfigAccount, CONFIG_ACCOUNT_LEN},
    dev_fixture::DEV_PROOF_BYTES,
    process_instruction,
    processor::commitment_root,
    public_inputs::{recipient_binding_v1, CircuitV1PublicInputs},
    root_history::{
        latest_root, root_history_contains, root_history_count, ROOT_HISTORY_ACCOUNT_LEN,
    },
    WatcherError, WithdrawalStatement, STATE_VERSION,
};

fn program_account<'a>(
    key: &'a Pubkey,
    owner: &'a Pubkey,
    lamports: &'a mut u64,
    data: &'a mut [u8],
    signer: bool,
    writable: bool,
) -> AccountInfo<'a> {
    AccountInfo::new(
        key,
        signer,
        writable,
        lamports,
        data,
        owner,
        false,
        Epoch::default(),
    )
}

fn init_data(treasury: &Pubkey) -> Vec<u8> {
    let mut value = vec![0];
    value.extend_from_slice(treasury.as_ref());
    value
}

fn deposit_data(commitment: [u8; 32], amount: u64) -> Vec<u8> {
    let mut value = vec![1];
    value.extend_from_slice(&commitment);
    value.extend_from_slice(&amount.to_le_bytes());
    value
}

fn set_root_data(root: [u8; 32]) -> Vec<u8> {
    let mut value = vec![3];
    value.extend_from_slice(&root);
    value
}

fn field_from_u64(value: u64) -> [u8; 32] {
    let mut output = [0u8; 32];
    output[..8].copy_from_slice(&value.to_le_bytes());
    output
}

fn matching_public_inputs(
    statement: &WithdrawalStatement,
    merkle_root: [u8; 32],
) -> [u8; 320] {
    CircuitV1PublicInputs {
        merkle_root,
        nullifier_0: statement.nullifier_0,
        nullifier_1: statement.nullifier_1,
        change_commitment: statement.change_commitment,
        public_amount: field_from_u64(statement.public_amount),
        protocol_fee: field_from_u64(statement.protocol_fee),
        relayer_fee: field_from_u64(statement.relayer_fee),
        recipient_binding: recipient_binding_v1(&statement.recipient),
        asset_id: field_from_u64(1),
        context_binding: field_from_u64(202),
    }
    .encode()
}

fn withdraw_data(
    statement: &WithdrawalStatement,
    proof: &[u8],
    public_inputs: &[u8],
) -> Vec<u8> {
    let mut value = vec![2];
    value.extend_from_slice(&statement.nullifier_0);
    value.extend_from_slice(&statement.nullifier_1);
    value.extend_from_slice(&statement.change_commitment);
    value.extend_from_slice(statement.recipient.as_ref());
    value.extend_from_slice(&statement.public_amount.to_le_bytes());
    value.extend_from_slice(&statement.protocol_fee.to_le_bytes());
    value.extend_from_slice(&statement.relayer_fee.to_le_bytes());
    value.extend_from_slice(&(proof.len() as u16).to_le_bytes());
    value.extend_from_slice(proof);
    value.extend_from_slice(&(public_inputs.len() as u16).to_le_bytes());
    value.extend_from_slice(public_inputs);
    value
}

struct TestState {
    program_id: Pubkey,
    authority: Pubkey,
    treasury: Pubkey,
    config_key: Pubkey,
    commitments_key: Pubkey,
    nullifiers_key: Pubkey,
    root_history_key: Pubkey,
    authority_lamports: u64,
    config_lamports: u64,
    commitments_lamports: u64,
    nullifiers_lamports: u64,
    root_history_lamports: u64,
    authority_data: Vec<u8>,
    config_data: Vec<u8>,
    commitments_data: Vec<u8>,
    nullifiers_data: Vec<u8>,
    root_history_data: Vec<u8>,
}

impl TestState {
    fn new() -> Self {
        Self {
            program_id: Pubkey::new_unique(),
            authority: Pubkey::new_unique(),
            treasury: Pubkey::new_unique(),
            config_key: Pubkey::new_unique(),
            commitments_key: Pubkey::new_unique(),
            nullifiers_key: Pubkey::new_unique(),
            root_history_key: Pubkey::new_unique(),
            authority_lamports: 1,
            config_lamports: 1,
            commitments_lamports: 1,
            nullifiers_lamports: 1,
            root_history_lamports: 1,
            authority_data: Vec::new(),
            config_data: vec![0u8; CONFIG_ACCOUNT_LEN],
            commitments_data: vec![0u8; 5 + 32 * 16],
            nullifiers_data: vec![0u8; 5 + 32 * 64],
            root_history_data: vec![0u8; ROOT_HISTORY_ACCOUNT_LEN],
        }
    }

    fn initialize(&mut self, authority_signer: bool) -> Result<(), ProgramError> {
        let program_id = self.program_id;
        let authority = self.authority;
        let treasury = self.treasury;
        let config_key = self.config_key;
        let commitments_key = self.commitments_key;
        let nullifiers_key = self.nullifiers_key;
        let root_history_key = self.root_history_key;
        let accounts = vec![
            program_account(
                &authority,
                &program_id,
                &mut self.authority_lamports,
                &mut self.authority_data,
                authority_signer,
                false,
            ),
            program_account(
                &config_key,
                &program_id,
                &mut self.config_lamports,
                &mut self.config_data,
                false,
                true,
            ),
            program_account(
                &commitments_key,
                &program_id,
                &mut self.commitments_lamports,
                &mut self.commitments_data,
                false,
                true,
            ),
            program_account(
                &nullifiers_key,
                &program_id,
                &mut self.nullifiers_lamports,
                &mut self.nullifiers_data,
                false,
                true,
            ),
            program_account(
                &root_history_key,
                &program_id,
                &mut self.root_history_lamports,
                &mut self.root_history_data,
                false,
                true,
            ),
        ];
        process_instruction(&program_id, &accounts, &init_data(&treasury))
    }

    fn deposit(&mut self, commitment: [u8; 32], amount: u64) -> Result<(), ProgramError> {
        let program_id = self.program_id;
        let config_key = self.config_key;
        let commitments_key = self.commitments_key;
        let root_history_key = self.root_history_key;
        let accounts = vec![
            program_account(
                &config_key,
                &program_id,
                &mut self.config_lamports,
                &mut self.config_data,
                false,
                true,
            ),
            program_account(
                &commitments_key,
                &program_id,
                &mut self.commitments_lamports,
                &mut self.commitments_data,
                false,
                true,
            ),
            program_account(
                &root_history_key,
                &program_id,
                &mut self.root_history_lamports,
                &mut self.root_history_data,
                false,
                true,
            ),
        ];
        process_instruction(
            &program_id,
            &accounts,
            &deposit_data(commitment, amount),
        )
    }

    fn withdraw(
        &mut self,
        statement: &WithdrawalStatement,
        proof: &[u8],
        public_inputs: &[u8],
    ) -> Result<(), ProgramError> {
        let program_id = self.program_id;
        let config_key = self.config_key;
        let commitments_key = self.commitments_key;
        let nullifiers_key = self.nullifiers_key;
        let root_history_key = self.root_history_key;
        let accounts = vec![
            program_account(
                &config_key,
                &program_id,
                &mut self.config_lamports,
                &mut self.config_data,
                false,
                true,
            ),
            program_account(
                &commitments_key,
                &program_id,
                &mut self.commitments_lamports,
                &mut self.commitments_data,
                false,
                true,
            ),
            program_account(
                &nullifiers_key,
                &program_id,
                &mut self.nullifiers_lamports,
                &mut self.nullifiers_data,
                false,
                true,
            ),
            program_account(
                &root_history_key,
                &program_id,
                &mut self.root_history_lamports,
                &mut self.root_history_data,
                false,
                true,
            ),
        ];
        process_instruction(
            &program_id,
            &accounts,
            &withdraw_data(statement, proof, public_inputs),
        )
    }

    fn manual_root_update(&mut self, root: [u8; 32]) -> Result<(), ProgramError> {
        let program_id = self.program_id;
        let authority = self.authority;
        let config_key = self.config_key;
        let accounts = vec![
            program_account(
                &authority,
                &program_id,
                &mut self.authority_lamports,
                &mut self.authority_data,
                true,
                false,
            ),
            program_account(
                &config_key,
                &program_id,
                &mut self.config_lamports,
                &mut self.config_data,
                false,
                true,
            ),
        ];
        process_instruction(&program_id, &accounts, &set_root_data(root))
    }

    fn current_root(&self) -> [u8; 32] {
        ConfigAccount::unpack(&self.config_data)
            .unwrap()
            .merkle_root
    }
}

fn sample_statement() -> WithdrawalStatement {
    WithdrawalStatement {
        nullifier_0: [11u8; 32],
        nullifier_1: [12u8; 32],
        change_commitment: [14u8; 32],
        recipient: Pubkey::new_unique(),
        public_amount: 1_000,
        protocol_fee: 0,
        relayer_fee: 5,
    }
}

#[test]
fn initialize_requires_authority_signature() {
    let mut state = TestState::new();
    assert_eq!(
        state.initialize(false),
        Err(ProgramError::MissingRequiredSignature)
    );
    assert_eq!(state.config_data[0], 0);
    assert_eq!(state.root_history_data[0], 0);
}

#[test]
fn initialize_creates_an_empty_versioned_root_history() {
    let mut state = TestState::new();
    state.initialize(true).unwrap();

    assert_eq!(state.config_data[0], STATE_VERSION);
    assert_eq!(state.commitments_data[0], STATE_VERSION);
    assert_eq!(state.nullifiers_data[0], STATE_VERSION);
    assert_eq!(state.root_history_data[0], STATE_VERSION);
    assert_eq!(state.current_root(), [0u8; 32]);
    assert_eq!(root_history_count(&state.root_history_data).unwrap(), 0);
    assert_eq!(latest_root(&state.root_history_data).unwrap(), None);
}

#[test]
fn manual_merkle_root_updates_are_disabled_even_for_authority() {
    let mut state = TestState::new();
    state.initialize(true).unwrap();
    let config_before = state.config_data.clone();
    let history_before = state.root_history_data.clone();

    assert_eq!(
        state.manual_root_update([42u8; 32]),
        Err(ProgramError::Custom(
            WatcherError::ManualMerkleRootDisabled as u32 + 1
        ))
    );
    assert_eq!(state.config_data, config_before);
    assert_eq!(state.root_history_data, history_before);
}

#[test]
fn deposits_update_current_root_and_preserve_recent_roots() {
    let mut state = TestState::new();
    state.initialize(true).unwrap();

    state.deposit([7u8; 32], 10_000).unwrap();
    let first_root = commitment_root(&state.commitments_data).unwrap();
    assert_eq!(state.current_root(), first_root);
    assert_eq!(latest_root(&state.root_history_data).unwrap(), Some(first_root));
    assert!(root_history_contains(&state.root_history_data, &first_root).unwrap());

    state.deposit([8u8; 32], 20_000).unwrap();
    let second_root = commitment_root(&state.commitments_data).unwrap();
    assert_ne!(second_root, first_root);
    assert_eq!(state.current_root(), second_root);
    assert_eq!(latest_root(&state.root_history_data).unwrap(), Some(second_root));
    assert_eq!(root_history_count(&state.root_history_data).unwrap(), 2);
    assert!(root_history_contains(&state.root_history_data, &first_root).unwrap());
    assert!(root_history_contains(&state.root_history_data, &second_root).unwrap());
}

#[test]
fn current_and_previous_recent_roots_reach_the_groth16_verifier() {
    let mut state = TestState::new();
    state.initialize(true).unwrap();
    state.deposit([7u8; 32], 10_000).unwrap();
    let previous_root = state.current_root();
    state.deposit([8u8; 32], 20_000).unwrap();
    let current_root = state.current_root();
    let statement = sample_statement();

    for root in [current_root, previous_root] {
        let public_inputs = matching_public_inputs(&statement, root);
        assert_eq!(
            state.withdraw(&statement, &DEV_PROOF_BYTES, &public_inputs),
            Err(ProgramError::Custom(
                WatcherError::InvalidGroth16Proof as u32 + 1
            )),
            "a recent root must pass admission and reach Groth16 verification"
        );
    }
}

#[test]
fn unknown_root_is_rejected_before_groth16_verification() {
    let mut state = TestState::new();
    state.initialize(true).unwrap();
    state.deposit([7u8; 32], 10_000).unwrap();
    let statement = sample_statement();
    let public_inputs = matching_public_inputs(&statement, [29u8; 32]);

    assert_eq!(
        state.withdraw(&statement, &DEV_PROOF_BYTES, &public_inputs),
        Err(ProgramError::Custom(
            WatcherError::UnknownMerkleRoot as u32 + 1
        ))
    );
}

#[test]
fn duplicate_deposit_does_not_change_commitments_config_or_history() {
    let mut state = TestState::new();
    state.initialize(true).unwrap();
    let commitment = [13u8; 32];
    state.deposit(commitment, 10_000).unwrap();

    let config_before = state.config_data.clone();
    let commitments_before = state.commitments_data.clone();
    let history_before = state.root_history_data.clone();
    assert_eq!(
        state.deposit(commitment, 10_000),
        Err(ProgramError::Custom(
            WatcherError::DuplicateCommitment as u32 + 1
        ))
    );
    assert_eq!(state.config_data, config_before);
    assert_eq!(state.commitments_data, commitments_before);
    assert_eq!(state.root_history_data, history_before);
}

#[test]
fn failed_withdrawal_does_not_mutate_any_protocol_state() {
    let mut state = TestState::new();
    state.initialize(true).unwrap();
    state.deposit([7u8; 32], 10_000).unwrap();
    let statement = sample_statement();
    let public_inputs = matching_public_inputs(&statement, state.current_root());

    let config_before = state.config_data.clone();
    let commitments_before = state.commitments_data.clone();
    let nullifiers_before = state.nullifiers_data.clone();
    let history_before = state.root_history_data.clone();

    assert_eq!(
        state.withdraw(&statement, &DEV_PROOF_BYTES, &public_inputs),
        Err(ProgramError::Custom(
            WatcherError::InvalidGroth16Proof as u32 + 1
        ))
    );
    assert_eq!(state.config_data, config_before);
    assert_eq!(state.commitments_data, commitments_before);
    assert_eq!(state.nullifiers_data, nullifiers_before);
    assert_eq!(state.root_history_data, history_before);
    assert!(!contains_32(&state.nullifiers_data, &statement.nullifier_0).unwrap());
    assert!(!contains_32(&state.commitments_data, &statement.change_commitment).unwrap());
}

#[test]
fn config_and_root_history_mismatch_fails_closed() {
    let mut state = TestState::new();
    state.initialize(true).unwrap();
    state.deposit([7u8; 32], 10_000).unwrap();

    let mut config = ConfigAccount::unpack(&state.config_data).unwrap();
    config.merkle_root = [30u8; 32];
    config.pack(&mut state.config_data).unwrap();
    let commitments_before = state.commitments_data.clone();
    let history_before = state.root_history_data.clone();

    assert_eq!(
        state.deposit([8u8; 32], 20_000),
        Err(ProgramError::Custom(
            WatcherError::RootHistoryMismatch as u32 + 1
        ))
    );
    assert_eq!(state.commitments_data, commitments_before);
    assert_eq!(state.root_history_data, history_before);
}
