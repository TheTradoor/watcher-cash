# Watcher Protocol V2

Status: **isolated development branch**. V1 remains the live devnet implementation.

V2 removes two prototype limits without pretending that changing one constant is scalability:

1. V1 has a fixed 16-leaf Merkle tree plus flat commitment/nullifier registries.
2. V1 withdrawals require exactly two confirmed notes and always create private change.

## Circuit baseline

V2 currently targets:

- BN254 / Groth16
- V1-compatible MiMC note/nullifier/Merkle primitives
- Merkle depth `16`
- `65,536` commitments per tree epoch
- `1..4` withdrawal inputs
- one accepted membership root per active input
- optional private change

Keeping the V1 note primitive is intentional. A V1 note opening can be inserted into a V2 migration tree without changing the user's owner/nonce secrets. V2 changes the spend statement and state architecture, not the private note opening itself.

## Epochs instead of one giant registry

A 65,536-leaf tree must **not** mean a Solana account containing 65,536 raw commitments. That would only move the prototype limit into account size and rent.

V2 uses bounded epochs:

- one active depth-16 tree accepts new commitments;
- after 65,536 leaves, its final root is sealed;
- the next active epoch starts again at leaf `0`;
- sealed roots remain spendable;
- one withdrawal may consume notes from different accepted roots/epochs.

The circuit exposes four independent `InputRoots` instead of one shared spend root.

## Compact active-tree state

The current Rust V2 state model stores:

- state version
- config pubkey
- epoch
- next leaf index
- current root
- a 16-entry recent-root ring

Total serialized size: **591 bytes**.

There is no 65,536-element commitment array and no on-chain Merkle frontier. The Groth16 append proof already binds old root, new root and leaf index. The program only needs to check that the proof's old root/index equal the exact active state before accepting the new root.

Clients/indexers reconstruct membership paths from the public commitment stream. The browser/client V2 implementation uses a sparse tree, so memory grows with observed commitments rather than theoretical capacity.

## Root lifetime

V2 has two root classes.

### Recent active roots

The active account retains a bounded ring of recent roots. This gives normal proof-generation race tolerance when another append lands just before a spend proof.

### Sealed roots

A completed epoch gets a permanent compact sealed-root record. The current serialized record is **77 bytes** and contains config, epoch, final root and leaf count.

A spend root is accepted when it is either:

- the current/recent active root; or
- present in a valid sealed-root record for the same protocol config.

This prevents old notes from becoming stranded when the recent-root ring rotates.

## Variable-input withdrawals

`CircuitV2` has four bounded input slots with private `enabled` bits.

Rules:

- enabled inputs form a compact prefix;
- `InputCount` is public and equals the enabled count;
- inactive roots/nullifiers are canonical zero sentinels;
- every active note proves membership in its own public root;
- every active note exposes one public nullifier;
- active nullifiers must be unique inside one proof;
- value conservation covers public amount, protocol fee, relayer fee and optional private change.

This supports one-note exact withdrawals, the existing two-note case, three/four-note aggregation and notes from different sealed epochs.

Four is intentionally bounded so browser proving, verifier public-input size and transaction accounts remain predictable.

## Exact withdrawal vs change withdrawal

V1 forces positive change. V2 does not.

### Exact / no-change

When `ChangeCommitment == 0`:

- change amount is zero;
- `CurrentRoot == 0`;
- `NewMerkleRoot == 0`;
- `ChangeLeafIndex == 0`;
- no active-tree state is mutated.

The zero append-state is deliberate. An exact withdrawal is therefore **not invalidated by a concurrent deposit**, because it has no dependency on the active append root.

### Change-producing withdrawal

When private change exists:

- change amount/owner/nonce are positive;
- `ChangeCommitment != 0`;
- the proof binds the exact current active root;
- the change leaf index equals the current `next_index`;
- the proof binds the resulting new root;
- successful verification advances the active tree by one leaf.

The client selector prefers an exact note combination by default to avoid another commitment and avoid append contention. Callers can instead prefer fewer inputs and accept a change note.

## Deposit V2

`DepositCircuitV2` uses the same depth-16 append transition and publicly binds:

- commitment
- amount
- asset
- epoch
- context
- old root
- new root
- leaf index

The first append of a fresh epoch keeps the V1 zero-root sentinel and is bound to the deterministic empty-tree sibling path.

## Compact Solana instruction wire

V2 does **not** send a second raw public-input blob in the transaction.

A V2 withdrawal has 19 Groth16 public fields, which would be `608` bytes by itself. Sending those bytes in addition to statement data and a 256-byte proof would waste packet budget; Address Lookup Tables only compress account keys, not instruction data.

Instead, the instruction sends the compact statement once and the program reconstructs the exact public-input array from trusted state.

Current fixed sizes:

- V2 deposit instruction: **329 bytes**
- V2 four-input withdrawal instruction: **634 bytes**
- reconstructed deposit public inputs: `8 × 32 = 256` bytes internally
- reconstructed withdrawal public inputs: `19 × 32 = 608` bytes internally

The reconstructed values include active epoch/root/index, V2 context binding, recipient binding and asset ID, so those values cannot be client-substituted without invalidating verification.

## Nullifier scalability

V1 keeps spent nullifiers in one flat bounded registry. V2 cannot retain that design.

The current phase-1 V2 Rust model uses a deterministic **zero-data PDA marker per spent nullifier**:

- PDA seeds include protocol config + full nullifier;
- a zero nullifier has no valid marker;
- existence of the program-created PDA means spent;
- lookup is O(1);
- there is no fixed global registry capacity;
- one withdrawal needs at most four markers.

This is correctness-first and removes the V1 capacity ceiling immediately. The tradeoff is rent/account overhead per spent nullifier. A compressed nullifier-set design can replace marker persistence later without changing the circuit statement.

## Concurrency boundary

Epochs solve capacity; they do not magically parallelize append state.

- deposits serialize on the active tree;
- change-producing withdrawals serialize on the active tree;
- exact withdrawals do **not** touch the active tree and can proceed independently.

Parallel tree shards are a later protocol change and are intentionally not mixed into the first V2 migration.

## Migration strategy

V1 stays untouched while V2 is developed.

Proposed devnet migration sequence:

1. Freeze a reproducible V1 commitment snapshot.
2. Insert the same commitment values into a V2 migration epoch in the same order.
3. Publish its V2 root, leaf mapping and migration manifest.
4. Wallets keep existing owner/nonce note openings.
5. V2 clients resolve the migrated commitment index and build a depth-16 path.
6. Deploy V2 to separate devnet accounts/program state.
7. Run local-validator E2E and then real Phantom/public-devnet acceptance tests.
8. Only then point the user-facing interface at V2.

No V1 deployment/account is overwritten during V2 development.

## Current implementation boundary

Implemented on `watcher-protocol-v2`:

- depth-16 deposit circuit;
- 1..4-input withdrawal circuit;
- per-input roots;
- exact withdrawals without private change;
- exact withdrawals decoupled from active append races;
- sparse browser/client Merkle tree;
- bounded deterministic note selection;
- compact V2 Rust instruction codec;
- program-side public-input reconstruction;
- 591-byte active-tree state + recent-root ring;
- 77-byte sealed-root records;
- scalable phase-1 nullifier marker addressing;
- isolated V2 CI.

Not yet wired into a V2 processor/deployment:

- V2 Groth16 setup/verifier key bundle;
- V2 verifier functions;
- V2 account initialization / processor instructions;
- nullifier-marker creation CPI;
- epoch sealing/rotation instruction;
- browser prover/WASM V2 bundle;
- isolated V2 local-validator E2E;
- V2 devnet deployment/migration.

V1 remains the current working devnet implementation until those boundaries are complete and independently regression-tested.
