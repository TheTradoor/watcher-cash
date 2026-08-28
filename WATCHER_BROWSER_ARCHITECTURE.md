# Watcher Browser Architecture

The live Watcher Cash interface is a clean-room Watcher Protocol client.

## Private proving boundary

Deposit and withdrawal witnesses are generated in the browser. Groth16 proving runs inside an isolated Web Worker backed by a Go WebAssembly prover. The worker loads one matched development bundle containing deposit and withdrawal R1CS files, proving keys, and verifying keys. Returned public inputs must match the statement built by the browser byte-for-byte before an instruction can be constructed.

Deposit proofs carry the append-only transition fields `OldRoot`, `NewRoot`, and `LeafIndex`. The browser reads the current on-chain commitment registry immediately before proving, derives the append path from that state, and encodes six public fields totaling 192 bytes.

Withdrawal proofs carry thirteen public fields totaling 416 bytes. They bind note membership, nullifiers, value conservation, recipient, deployment context, current root, new root, and change-leaf index.

## Solana boundary

The interface is hard-locked to the Solana devnet genesis hash. It can create fresh program-owned config, commitment, nullifier, and root-history accounts, derive the vault PDA, submit proof-bound deposits, rebuild Merkle paths from live state, and submit recipient-bound withdrawals.

## Recovery boundary

Private note owner and nonce values are not placed in persistent application storage. The interface downloads a recovery JSON before broadcasting a deposit or change-producing withdrawal. Session notes are kept only in `sessionStorage` and can be imported or exported explicitly by the user.

## Deployment boundary

GitHub Pages generates a matched circuit, prover, and verifier bundle, compiles the browser prover to WebAssembly, tests JavaScript, Go, Rust, and SBF surfaces, bootstraps a fresh devnet deployment, and performs a static Next.js production build before deployment.

## Security status

This remains development infrastructure. The current setup is not a production ceremony, the tree is intentionally small, and the system has not received an independent production security audit. Do not use production funds.
