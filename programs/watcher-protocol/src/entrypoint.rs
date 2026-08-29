use solana_program::{account_info::AccountInfo, entrypoint::ProgramResult, pubkey::Pubkey};

solana_program::entrypoint!(process_entrypoint);

fn process_entrypoint(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    match data.first().copied() {
        // V3 deliberately reuses only the proven V2 initialize/deposit path.
        // Every legacy withdrawal path is disabled so there is exactly one
        // replay source of truth: the packed V3 exact-nullifier shards.
        Some(0x20 | 0x22) => crate::v2::processor::process_instruction_v2(program_id, accounts, data),
        Some(0x31 | 0x33) => crate::v3::processor::process_instruction_v3(program_id, accounts, data),
        _ => Err(crate::WatcherError::InvalidInstruction.into()),
    }
}
