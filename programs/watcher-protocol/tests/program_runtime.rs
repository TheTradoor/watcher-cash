use solana_program::pubkey::Pubkey;
use watcher_protocol_program::processor::vault_address_v1;

#[test]
fn vault_pda_is_scoped_to_program_and_config() {
    let program = Pubkey::new_unique();
    let other_program = Pubkey::new_unique();
    let config = Pubkey::new_unique();
    let other_config = Pubkey::new_unique();

    let (vault, _) = vault_address_v1(&program, &config);
    assert_ne!(vault, vault_address_v1(&program, &other_config).0);
    assert_ne!(vault, vault_address_v1(&other_program, &config).0);
}
