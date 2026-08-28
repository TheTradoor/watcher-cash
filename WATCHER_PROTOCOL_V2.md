# Watcher Protocol V2

Status: **isolated development branch**. V1 remains the live devnet implementation.

V2 exists to remove two prototype constraints without pretending that increasing a constant alone is scalability:

1. V1 has a fixed 16-leaf Merkle tree and a flat commitment registry.
2. V1 withdrawals require exactly two confirmed input notes and always create private change.

## Circuit baseline

V2 currently targets:

- BN254 / Groth16
- MiMC note, nullifier and Merkle hashing compatible with V1 note openings
- Merkle depth: `16`
- commitments per tree epoch: `65,536`
- withdrawal input slots: `1..4`
- one accepted membership root per active input
- optional private change

Keeping the V1 note commitment/nullifier primitive is intentional. A V1 private opening can be inserted into a V2 migration tree without changing the user's owner/nonce secrets. V2 changes the spend statement and tree architecture, not the existing note primitive.

## Why epochs instead of one giant registry

A 65,536-leaf tree must **not** be represented by a Solana account containing 65,536 raw commitments. That would simply replace the old capacity limit with an account-size/rent problem.

V2 is designed around bounded tree epochs:

- one active depth-16 tree accepts new commitments;
- when it reaches 65,536 leaves, its final root is sealed;
- a new active epoch begins at leaf `0`;
- sealed roots remain valid spend roots;
- a withdrawal may consume notes from different accepted roots/epochs.

The circuit therefore exposes four independent `InputRoots` rather than one shared spend root.

### Active-tree state

The intended on-chain active-tree account is compact:

- state version
- epoch number
- next leaf index
- current root
- depth
- incremental Merkle frontier / zero-node metadata

It does **not** need the full leaf set in one account.

Clients or indexers reconstruct membership paths from the public commitment stream. The browser implementation already has a sparse V2 tree that stores populated nodes only, so memory scales with observed commitments instead of the theoretical 65,536-leaf capacity.

## Root acceptance

V2 needs two root classes:

### Active roots

A small bounded ring of recent active-tree roots remains useful for race tolerance. A proof generated immediately before another deposit should not become invalid just because one new leaf landed first.

### Sealed roots

The final root of a completed epoch must remain spendable beyond the active-root ring. A sealed-root account or directory entry is therefore permanent protocol state until an explicit migration mechanism exists.

This prevents old private notes from becoming stranded when the active root history rotates.

## Variable input withdrawals

`CircuitV2` has four bounded input slots. Each slot has a private `enabled` bit.

Rules:

- enabled slots form a compact prefix;
- `InputCount` is public and equals the number of enabled slots;
- inactive slots expose zero public roots/nullifiers and carry zero value;
- each active note proves membership in its own public root;
- each active note produces one public nullifier;
- active nullifiers must be unique inside the proof;
- value conservation covers public amount, protocol fee, relayer fee and optional private change.

This supports:

- one-note withdrawals;
- the existing two-note pattern;
- three/four-note aggregation;
- notes originating in different sealed epochs.

The maximum remains bounded at four so proving time, public-input size and Solana transaction size remain predictable.

## Optional change

V1 always requires positive private change, which creates awkward cases where an exact-value note cannot be withdrawn by itself.

V2 adds a private `ChangeEnabled` bit:

- enabled: `ChangeCommitment != 0`, value must be positive, and the proof binds an append transition into the exact current active root;
- disabled: `ChangeCommitment == 0`, change amount is zero, `NewMerkleRoot == CurrentRoot`, and no new leaf is consumed.

The client selector prefers an exact combination by default because it avoids another commitment and saves tree capacity. A caller can instead prefer fewer inputs and accept a change note.

## Deposit V2

`DepositCircuitV2` uses the same depth-16 append transition and adds public:

- `Epoch`
- `ContextBinding`

The program will compute the expected active epoch/context and reject a proof whose public statement does not match current protocol state.

The zero-root sentinel is retained for the first append of a fresh epoch. The circuit binds that first append to the deterministic empty-tree path.

## Nullifier scalability

The V1 flat nullifier registry also cannot grow indefinitely.

The V2 program should not ship until nullifier persistence is moved out of one flat account. The current preferred design is a bounded bucket/page layout derived from nullifier prefix bits:

- deterministic bucket PDA from a nullifier prefix;
- bounded entries per page;
- chained overflow pages only when required;
- permanent membership once a nullifier is spent;
- at most four nullifier lookups/inserts per V2 withdrawal.

A one-PDA-per-nullifier design is simpler but has poor rent overhead, so it is not the default production direction.

## Concurrency boundary

Epochs solve capacity, not global append contention. Deposits and change-producing withdrawals still transition one active root and can race with each other.

V2 phase 1 intentionally keeps this serial append model because it is easier to reason about and audit. Parallel tree shards are a later protocol change and should not be mixed into the first migration.

## Migration strategy

V1 stays untouched while V2 is developed.

Proposed migration sequence:

1. Freeze the V1 commitment snapshot at an announced devnet migration point.
2. Insert the same V1 commitment values into a V2 migration epoch in the same order.
3. Publish the resulting V2 root and reproducible migration manifest.
4. Wallets retain their existing owner/nonce note openings.
5. V2 clients resolve the migrated commitment index and build a depth-16 membership path.
6. Only after circuit, program, browser prover and real-wallet devnet tests pass should the V1 interface be pointed at V2.

No V1 deployment/account is overwritten during development.

## Current implementation boundary

Implemented on `watcher-protocol-v2`:

- depth-16 deposit circuit;
- 1..4 input withdrawal circuit;
- per-input roots;
- optional change;
- sparse browser/client Merkle tree;
- bounded deterministic note selection.

Not yet wired into the live program:

- V2 instruction codec/public-input decoder;
- compact active-tree account/frontier;
- sealed epoch root accounts;
- scalable nullifier buckets;
- V2 setup/proving bundle and browser WASM;
- V2 devnet deployment/migration.

V1 remains the current working devnet implementation until those boundaries are complete and independently regression-tested.
