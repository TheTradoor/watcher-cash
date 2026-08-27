# Watcher Protocol Solana program

Clean-room development implementation of proof-bound SOL custody for Watcher Protocol.

## Current V1 path

- Deposit requires a 256-byte BN254 Groth16 proof binding the private note opening to the exact public commitment, lamport amount, and SOL asset ID.
- Commitments are appended to a fixed 16-leaf MiMC tree and recent roots are retained in a bounded ring buffer.
- Withdraw verifies two note memberships, stable nullifiers, value conservation, recipient binding, deployment-context binding, and the recent Merkle root.
- The vault PDA is derived from `watcher-vault-v1` plus the config account, preserves its rent reserve, and tracks private liabilities separately from raw lamports.
- Replayed nullifiers are rejected before any payout or state mutation.

## Account order

```text
Initialize:
[authority, config, commitments, nullifiers, root_history, vault, system_program]

Deposit:
[depositor, config, commitments, root_history, vault, system_program]

Withdraw:
[config, commitments, nullifiers, root_history, vault, recipient, relayer, treasury]
```

## Development fixture lifecycle

Circuit CI performs one randomized development setup per circuit, exports the proving assets and verifier coordinates from that same setup, converts the verifier fixture to the xark wire format, and commits only the matched verifier arrays back to this program. Program CI must be green after each fixture refresh.

The setup and keys are for development only. Do not use production funds before an independent audit and production-grade setup ceremony.
