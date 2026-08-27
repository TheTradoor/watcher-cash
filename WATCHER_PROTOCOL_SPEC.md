# Watcher Protocol — Clean-Room Specification v0

Status: design draft. Not production-ready. No real funds should use this protocol until implementation, tests, audit, and launch review are complete.

## 1. Objectives

Watcher Protocol is intended to provide a Watcher-owned privacy transaction stack for Solana without requiring Privacy Cash SDK, circuits, relayer, or program infrastructure.

Initial asset target: SOL only. SPL assets come after the SOL protocol is stable.

## 2. Components

1. **Watcher Web** — wallet connection, local account unlock, proof UX.
2. **Watcher SDK** — note generation, encryption, commitment/nullifier derivation, transaction builders.
3. **Watcher Circuit** — proves ownership of valid unspent private notes and correct value conservation without revealing private note data.
4. **Watcher Solana Program** — stores/updates protocol state, verifies permitted transitions, prevents nullifier reuse, accounts for protocol fees.
5. **Watcher Indexer** — indexes commitments/nullifiers and publishes Merkle data required by clients.
6. **Watcher Relayer** — submits withdrawal transactions without requiring the recipient to be the fee payer.
7. **Watcher Treasury** — receives an explicitly configured protocol fee only after the independent stack is launch-approved.

## 3. Cryptographic domain separation

Watcher-owned derivations must use explicit Watcher domain tags. Exact hash primitive and field encoding are implementation decisions that must be frozen before circuit implementation.

Draft logical domains:

- `WATCHER_NOTE_V1`
- `WATCHER_COMMITMENT_V1`
- `WATCHER_NULLIFIER_V1`
- `WATCHER_MERKLE_V1`

These labels describe the specification namespace; they are not a claim that a secure construction has already been finalized.

## 4. Private note model

Logical note fields:

- version
- asset identifier
- amount
- owner secret-derived key material
- random blinding material
- creation nonce

A commitment binds the complete note. The plaintext note is never written on-chain.

The client must encrypt recoverable note metadata locally so the same wallet/account secret can rescan protocol history.

## 5. Deposit transition

Draft flow:

1. Client creates fresh note randomness locally.
2. SDK constructs a note and commitment.
3. User signs a Solana deposit transaction.
4. Program transfers the public asset into protocol custody and appends/records the commitment according to the finalized state design.
5. Indexer observes finalized state and exposes commitment/Merkle synchronization data.
6. Client stores only non-secret recovery/cache metadata locally; protocol recovery must not depend solely on browser storage.

## 6. Withdrawal transition

A withdrawal proof must establish, at minimum:

- the prover controls one or more committed notes;
- included notes are members of an accepted Merkle root/state commitment;
- input value is sufficient for public output plus protocol/relayer fees and private change;
- nullifiers are correctly derived;
- change commitments are correctly formed;
- no private amount/owner secret is unnecessarily disclosed.

On-chain state must reject previously spent nullifiers.

## 7. Value conservation

For a withdrawal transition:

`sum(private inputs) = public recipient output + private change + protocol fee + relayer/network allocation`

No implementation may mint value through rounding or unit conversion.

## 8. Fee model

Fee logic is protocol configuration, not hard-coded UI math.

Draft fields:

- percentage protocol fee in basis points
- optional minimum protocol fee
- relayer reimbursement policy
- minimum withdrawal
- treasury address

The UI must query authoritative Watcher configuration and show the complete quote before proof generation.

**Fee activation remains disabled during development.**

## 9. Relayer API v0

Planned endpoints:

- `GET /health`
- `GET /v1/config`
- `GET /v1/tree/root`
- `GET /v1/tree/path/:commitment`
- `POST /v1/withdrawals`
- `GET /v1/withdrawals/:id`

Request/response schemas will be versioned and documented before implementation.

## 10. Security invariants

Tests must demonstrate:

- cannot spend a note without its secret;
- cannot spend the same note twice;
- cannot withdraw more than inputs;
- cannot forge change value;
- cannot redirect protocol fee;
- cannot use an unsupported/stale root outside policy;
- malformed proofs fail closed;
- integer overflow/underflow and decimal conversion are rejected;
- relayer cannot alter recipient, amount, fee, or proof-bound fields;
- loss of browser cache does not automatically destroy recoverability when account recovery material is available.

## 11. Migration boundary

The existing Privacy Cash-powered MVP remains a reference deployment on `main`. `watcher-protocol` is the clean-room development branch.

Replacement order:

1. Define Watcher types/interfaces and SDK boundary.
2. Implement cryptographic primitives using audited/permissively usable libraries.
3. Implement circuit + local proof tests.
4. Implement Solana program on local validator/devnet.
5. Implement indexer.
6. Implement relayer.
7. Integrate Watcher Web against Watcher SDK.
8. Remove `privacycash` and Privacy Cash URLs/artifacts.
9. Run adversarial/security test suite.
10. Independent security + legal/compliance review.
11. Only then consider mainnet and protocol fee activation.

## 12. Explicit non-goals for v0

- No anonymity-set marketing claims before measurement.
- No custom cryptography invented casually.
- No mainnet custody before audit.
- No USDC/USDT until SOL implementation is stable.
- No Watcher fee revenue while production still depends on Privacy Cash protected infrastructure.
