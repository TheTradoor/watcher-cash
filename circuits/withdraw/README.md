# Watcher Withdrawal Circuit v0

This directory is a clean-room circuit workspace. It contains no Privacy Cash circuit artifacts.

## Statement

Prove that private input notes exist in an accepted Watcher Merkle root, are owned by the prover, have unique correctly derived nullifiers, and conserve value across public withdrawal, fees, and private outputs.

## Required constraints

### Membership
For every non-dummy input, recompute its Watcher note commitment and verify the Merkle authentication path reaches the public `merkle_root`.

### Ownership
Input commitments/nullifiers must depend on secret owner material known to the prover. The secret itself is never public.

### Nullifiers
Nullifier derivation must bind at least:

- Watcher nullifier domain
- protocol version
- asset id
- owner secret-derived material
- note nonce / unique note identifier

The circuit exposes nullifiers as public inputs.

### Value conservation
Using integer base units only:

`sum(inputs) = public_amount + protocol_fee + relayer_fee + sum(private_outputs)`

All amounts require explicit range constraints. No modular-field wraparound may satisfy value conservation.

### Recipient binding
The proof must bind the intended public recipient through a canonical field representation/hash. A relayer must not be able to replace the recipient after proof generation.

### Asset binding
Every input/output and public amount is bound to one `asset_id`. Cross-asset value creation is invalid.

### Output commitments
The circuit recomputes every private output commitment from its witness and exposes the commitments publicly.

## Dummy input policy

If a fixed two-input circuit is used, dummy inputs must be explicitly constrained to a canonical zero representation and must not create spendable value or ambiguous nullifiers.

## Negative tests required

- wrong Merkle path
- wrong owner secret
- changed recipient
- changed public amount
- changed protocol fee
- changed relayer fee
- input sum one unit too small
- arithmetic overflow attempt
- asset mismatch
- duplicate real input
- malformed dummy input
- altered output commitment

## Artifact policy

Development proving/verifying keys generated for this circuit are disposable. Do not commit production secrets or claim production security from development setup artifacts.
