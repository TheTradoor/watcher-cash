# Watcher Protocol V3 — packed exact nullifiers

Status: **experimental / isolated / not audited / not deployed to public devnet**.

V3 keeps the proven V2 depth-16 tree, note format, Groth16 circuits, deposit path, vault accounting, and exact-withdrawal semantics. Its only protocol-level goal in this branch is to replace V2's one-PDA-per-nullifier replay store with a substantially cheaper exact set.

## Why V3 exists

V2 creates a zero-data PDA for every spent nullifier. That is simple and gives O(1) replay checks, but every input locks the rent-exempt minimum for a new account. A real two-note Phantom withdrawal showed that this is a meaningful portion of the user's cost.

V3 moves replay state into protocol-funded packed shards while preserving the full 32-byte nullifier. It does **not** use a Bloom filter or truncated bitmap, so there are no probabilistic false positives.

## Layout

The exact set is split into:

- 32 deterministic PDA shards scoped by program + config;
- 2,048 hash buckets in each shard;
- 65,536 buckets total;
- an 8,240-byte header per shard, below Solana's 10,240-byte inner-instruction data-growth limit;
- a 36-byte record for every spent note:
  - 32-byte exact nullifier;
  - 4-byte linked-list index.

Routing is deterministic:

1. `keccak256(domain || config || nullifier)`;
2. first 16 hash bits are interpreted as one key;
3. high 5 bits select one of 32 shards;
4. low 11 bits select one of 2,048 buckets.

Each bucket points to a linked list of exact records. Replay detection always compares the complete 32-byte nullifier.

## Security boundaries

The isolated V3 binary accepts only:

- V2 initialize (`0x22`);
- V2 deposit (`0x20`);
- V3 exact/changed withdrawal (`0x31`);
- V3 nullifier-shard initialize (`0x33`).

Legacy V1 instructions and the V2 marker-PDA withdrawal tag are fail-closed in the V3 entrypoint. This prevents a note from being spent through the packed V3 store and then replayed through an older nullifier store in the same deployment.

Nullifier shard mutation occurs only after:

- account ownership/address checks;
- root validation;
- Groth16 verification;
- vault-liability and payout checks.

The transaction then grows each affected shard by 36 bytes and appends the exact nullifier. Solana transaction atomicity rolls back both the payout and shard mutations on failure.

## Measured isolated-validator result

The two-note regression performs:

`V2 deposit ×2 → V3 exact 2-input withdrawal → replay attempt → legacy V2-withdraw-tag attempt`

Measured on the isolated Agave validator:

| Metric | V3 packed set | V2 marker PDAs |
| --- | ---: | ---: |
| Nullifiers spent | 2 | 2 |
| Marginal storage | 72 bytes | 2 accounts |
| Marginal rent | 501,120 lamports | 1,781,760 lamports |
| Marginal rent / nullifier | 250,560 lamports | 890,880 lamports |
| Marginal rent reduction | **71.87%** | — |

The same run also verified:

- depth-16 tree remained at index 2 after the exact withdrawal;
- vault tracked liability returned to zero;
- both exact nullifiers were persisted;
- direct replay was rejected;
- the old V2 withdrawal tag was rejected.

## Fixed protocol cost

The savings above are **marginal user-side storage savings**. V3 moves part of the rent burden to protocol bootstrap because shard headers must exist before spending.

With current Solana rent parameters, 32 × 8,240-byte headers lock roughly 1.86 SOL in protocol-owned shard accounts. That is fixed infrastructure state, not a per-withdrawal charge. At the current measured marginal rates, total locked rent becomes lower than V2's per-nullifier PDA model after roughly 2.9k spent nullifiers.

This trade-off is intentional for the experiment, but it should be reviewed again before any public V3 deployment. A future design could reduce fixed header rent further if it preserves exact replay checks and bounded lookup cost.

## Acceptance gates before public deployment

V3 must remain isolated until all of these are green:

- Rust unit/serialization tests;
- JS routing/PDA parity tests;
- SBF build;
- isolated-validator deposit and two-note withdrawal;
- exact 36-byte growth per nullifier;
- measured rent regression versus V2;
- direct replay rejection;
- legacy withdrawal-store bypass rejection;
- browser/Phantom integration on a separate route/deployment;
- independent security review before production use.
