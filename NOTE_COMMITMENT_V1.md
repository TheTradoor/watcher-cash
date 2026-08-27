# Watcher Note / Merkle / Nullifier v1 Prototype

Status: development construction for circuit testing only. Not audited or mainnet-ready.

## Hash primitive

The current circuit prototype uses the BN254 MiMC implementation provided by the selected gnark stack. This choice is isolated behind Watcher domain-separated functions so it can still be replaced before the production circuit is frozen.

## Note commitment

Logical definition:

`C = H(WATCHER_NOTE_V1, asset_id, amount, owner_secret, note_nonce)`

Properties required by the protocol:

- `amount` is constrained to unsigned 64-bit base units;
- `asset_id` is non-zero and public to the withdrawal statement;
- `owner_secret` is private;
- `note_nonce` is private and non-zero;
- changing any field changes the commitment except with negligible hash-collision probability assumed by the selected primitive.

## Merkle node

Logical definition:

`parent = H(WATCHER_MERKLE_V1, left, right)`

The v1 prototype tree is intentionally only depth 4 so CI/proving tests remain cheap. Production tree depth is **not** frozen yet.

Authentication-path direction bits are Boolean-constrained inside the circuit. Both real input notes must resolve to the same public Merkle root.

## Nullifier

Logical definition:

`N = H(WATCHER_NULLIFIER_V1, owner_secret, note_nonce, commitment)`

Important invariant: the nullifier does **not** include recipient, withdrawal context, fee quote, or Merkle root. A spendable note must have one stable nullifier across every attempted spend. The Solana program will ultimately reject any nullifier already recorded as spent.

The circuit also rejects equal nullifiers for the two input slots.

## Change output

The private change note commitment uses the same note commitment construction and is exposed as a public circuit output/input to the transaction statement:

`change_commitment = H(WATCHER_NOTE_V1, asset_id, change_amount, change_owner_secret, change_nonce)`

## Current public withdrawal statement

- Merkle root
- input nullifier 0
- input nullifier 1
- private change commitment
- public withdrawal amount
- protocol fee
- relayer fee
- recipient binding
- asset id
- context binding

## Current private witness

For each of two input notes:

- amount
- owner secret
- nonce
- Merkle siblings
- Merkle direction bits

For change:

- amount
- new owner secret-derived material
- new nonce

## Production freeze gates

Before calling this construction production-ready:

1. Review hash choice and exact serialization/field encoding.
2. Increase/finalize Merkle depth based on protocol capacity requirements.
3. Define wallet-secret derivation separately from note hashing.
4. Define recipient/context canonical encoding.
5. Add zero/dummy-input policy if variable input counts are needed.
6. Benchmark browser/mobile proving architecture.
7. Complete independent cryptographic/security review.
8. Generate final circuit ID and versioned setup/verifying-key artifacts.
