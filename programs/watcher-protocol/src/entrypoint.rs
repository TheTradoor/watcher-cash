use solana_program::{account_info::AccountInfo, entrypoint::ProgramResult, pubkey::Pubkey};

solana_program::entrypoint!(process_entrypoint);

fn process_entrypoint(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    match data.first().copied() {
        Some(0x20 | 0x21 | 0x22) => {
            crate::v2::processor::process_instruction_v2(program_id, accounts, data)
        }
        _ => crate::processor::process_instruction(program_id, accounts, data),
    }
}
