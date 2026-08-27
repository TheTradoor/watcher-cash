use solana_program::{account_info::AccountInfo, entrypoint::ProgramResult, pubkey::Pubkey};

solana_program::entrypoint!(process_entrypoint);

fn process_entrypoint(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    crate::processor::process_instruction(program_id, accounts, data)
}
