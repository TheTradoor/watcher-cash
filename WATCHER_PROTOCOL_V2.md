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

V2 is designed around bounded epochs:

- one active depth-16 tree accepts new commitments;
- after 65,536 leaves, its final root is sealed;
- the next active epoch starts again at leaf `0`;
- sealed roots remain spendable;
- one withdrawal may consume notes from different accepted roots/epochs.

The circuit exposes four independent `InputRoots` instead of one shared spend root.

Epoch sealing/rotation is still a later processor milestone. The currently deployed isolated test runtime exercises the active epoch only.

## Compact active-tree state

The Rust V2 state model stores:

- state version
- config pubkey
- epoch
- next leaf index
- current root
- a 16-entry recent-root ring

Total serialized size: **591 bytes**.

There is no 65,536-element commitment array and no on-chain Merkle frontier. The Groth16 append proof binds old root, new root and leaf index. The program checks that the proof's old root/index match the exact active state before accepting the new root.

Clients reconstruct membership paths from the public commitment stream. The browser/client uses a sparse tree, so memory grows with observed commitments rather than theoretical capacity.

### Public commitment recovery

The browser's local public-tree store is only a cache, never the source of truth.

When the cache is missing or behind the active tree, the V2 client can:

1. read the active-tree account and derive the owning Watcher program;
2. scan confirmed transactions mentioning the active-tree account;
3. extract only successful Watcher V2 deposit and change-withdraw append instructions;
4. replay the commitments chronologically into a sparse depth-16 tree;
5. verify every instruction's claimed `new_root` against the locally reconstructed transition;
6. verify the final count/root against the active-tree account;
7. only then persist the rebuilt cache and allow proof generation.

Exact withdrawals are ignored because they use the zero change sentinel and do not append a commitment.

This means losing the **public** tree cache does not strand notes. Losing private encrypted note openings is a separate recovery problem and is never repaired from public chain data.

## Root lifetime

V2 has two root classes.

### Recent active roots

The active account retains a bounded ring of recent roots. This gives normal proof-generation race tolerance when another append lands just before a spend proof.

### Sealed roots

A completed epoch gets a permanent compact sealed-root record. The serialized record is **77 bytes** and contains config, epoch, final root and leaf count.

A spend root is accepted when it is either:

- the current/recent active root; or
- present in a valid sealed-root record for the same protocol config.

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

This supports one-note exact withdrawals, the existing two-note case, three/four-note aggregation and eventually notes from different sealed epochs.

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

An exact withdrawal is therefore not invalidated by a concurrent deposit because it has no append-state dependency.

### Change-producing withdrawal

When private change exists:

- change amount/owner/nonce are positive;
- `ChangeCommitment != 0`;
- the proof binds the exact current active root;
- the change leaf index equals the current `next_index`;
- the proof binds the resulting new root;
- successful verification advances the active tree by one leaf.

The client selector prefers exact combinations when possible to avoid an extra commitment and append contention.

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

The first append of a fresh epoch keeps the zero-root sentinel and is bound to the deterministic empty-tree sibling path.

## Compact Solana instruction wire

V2 does **not** send a second raw public-input blob in the transaction.

A V2 withdrawal has 19 Groth16 public fields, which would be `608` bytes by itself. Sending those bytes in addition to statement data and a 256-byte proof would waste packet budget; Address Lookup Tables only compress account keys, not instruction data.

Instead, the instruction sends the compact statement once and the program reconstructs the exact public-input array from trusted state.

Current fixed sizes:

- V2 deposit instruction: **329 bytes**
- V2 four-input withdrawal instruction: **634 bytes**
- reconstructed deposit public inputs: `8 × 32 = 256` bytes internally
- reconstructed withdrawal public inputs: `19 × 32 = 608` bytes internally

## Nullifier scalability

V1 keeps spent nullifiers in one flat bounded registry. V2 uses a deterministic **zero-data PDA marker per spent nullifier**:

- PDA seeds include protocol config + full nullifier;
- a zero nullifier has no valid marker;
- existence of the program-created PDA means spent;
- lookup is O(1);
- there is no fixed global registry capacity;
- one withdrawal needs at most four markers.

This is correctness-first. The tradeoff is rent/account overhead per spent nullifier; a compressed nullifier set can replace marker persistence later without changing the circuit statement.

## Browser proving

The isolated `/v2/` route uses a dedicated browser-local prover:

- exact V2 R1CS/PK/VK bundle generated together;
- Go WebAssembly prover runs in a dedicated worker;
- proving-key assets are SHA-256 checked against the generated manifest;
- private witness JSON stays inside the browser worker;
- returned proof public inputs are byte-compared against the client-reconstructed statement before transaction construction.

The browser route supports:

- V2 deposits;
- one-input exact withdrawal;
- change-producing withdrawal;
- 1–4 input selection;
- encrypted V2 note metadata;
- O(1) nullifier-marker sync;
- public-tree cache verification and chain-history rebuild.

## Verified isolated E2E

The branch has two independent validator gates.

### Protocol validator E2E

Fresh Groth16 setup -> matched Rust verifier -> SBF build -> isolated validator deploy -> V2 deposit -> one-input exact withdrawal -> nullifier replay rejection.

Verified properties include:

- tree depth `16`;
- exact withdrawal does not append;
- vault tracked liability reaches the expected balance;
- replayed nullifier is rejected.

### Browser validator E2E

Fresh setup and browser WASM bundle -> same matched verifier compiled into SBF -> isolated validator -> static `/v2/` browser route -> deterministic wallet.

The regression covers:

- browser-local deposit proof;
- one-input exact withdrawal;
- private-change withdrawal;
- two-input exact withdrawal;
- encrypted note metadata after reload;
- public-tree reconstruction after deliberately deleting only the local public-tree cache.

No V1 live deployment/account is mutated by these tests.

## Concurrency boundary

Epochs solve capacity; they do not magically parallelize append state.

- deposits serialize on the active tree;
- change-producing withdrawals serialize on the active tree;
- exact withdrawals do **not** touch the active tree and can proceed independently.

Parallel tree shards are a later protocol change.

## Migration strategy

V1 stays untouched while V2 is developed.

The intended migration path is commitment-preserving rather than silently re-labeling V1 notes as V2 notes:

1. freeze a reproducible V1 commitment snapshot;
2. insert the same commitment values into a V2 migration epoch in the same order;
3. publish its V2 root, leaf mapping and migration manifest;
4. wallets keep existing owner/nonce note openings;
5. V2 clients resolve each migrated commitment index and build a depth-16 path;
6. deploy V2 to separate devnet state;
7. run isolated-validator browser E2E and then real Phantom/public-devnet acceptance tests;
8. only then point the user-facing interface at V2.

A V1 encrypted note record must never be treated as spendable V2 state unless its commitment is actually present in an accepted V2 migration root.

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
- matched V2 Groth16 setup and Rust verifier;
- isolated V2 initialization/deposit/withdraw processor path;
- 591-byte active-tree state + recent-root ring;
- 77-byte sealed-root state model;
- scalable phase-1 nullifier marker creation and replay rejection;
- dedicated V2 browser WASM prover + worker;
- encrypted V2 note storage with epoch/leaf/root metadata;
- browser-local 1–4 input transaction flow;
- public commitment history verification + on-chain reconstruction;
- isolated local-validator protocol E2E;
- isolated full browser/validator E2E;
- separate V2 runtime/bootstrap tooling.

Still not production-ready:

- epoch sealing/rotation processor instruction and full cross-epoch live E2E;
- published V1 -> V2 migration snapshot/manifest;
- encrypted portable backup/import UI for the V2 route;
- real Phantom/Solflare public-devnet compatibility pass;
- independent circuit/program/client security audit;
- production ceremony / trusted-setup policy;
- mainnet deployment.

V1 remains the current live devnet implementation until those boundaries are complete and independently reviewed.
