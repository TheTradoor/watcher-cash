use solana_program::{account_info::AccountInfo, entrypoint::ProgramResult, pubkey::Pubkey};

solana_program::entrypoint!(process_entrypoint);

fn process_entrypoint(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    match data.first().copied() {
        // V3 keeps the proven V2 initialize/deposit path and replaces only the
        // withdrawal replay store. The legacy V2 withdrawal tag is deliberately
        // disabled in this isolated build so notes cannot be spent once through
        // V3 shards and again through V2 marker PDAs.
        Some(0x20 | 0x22) => crate::v2::processor::process_instruction_v2(program_id, accounts, data),
        Some(0x21) => Err(crate::WatcherError::InvalidInstruction.into()),
        Some(0x31 | 0x33) => crate::v3::processor::process_instruction_v3(program_id, accounts, data),
        _ => crate::processor::process_instruction(program_id, accounts, data),
    }
}
