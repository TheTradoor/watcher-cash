# Watcher Protocol Proof Stack Decision — M2 Draft

Status: engineering decision for prototype, not a production security approval.

## Direction

Prototype Watcher Protocol around **Groth16 over BN254**, with circuit/prover tooling implemented independently using **gnark / gnark-crypto** where appropriate.

Why this direction:

- gnark supports Groth16 and BN254.
- gnark and gnark-crypto are Apache-2.0 licensed.
- The ecosystem has published audits, but Watcher still requires its own review.
- BN254/Groth16 is a practical target for compact proofs and blockchain verification research.

## Important boundary

This decision does **not** authorize copying any Privacy Cash circuit, proving key, verification key, hash constants, Merkle format, note format, or proof serialization.

Watcher defines those independently.

## Frozen v0 logical public inputs

The withdrawal statement will bind these logical values:

1. `protocol_version`
2. `asset_id`
3. `merkle_root`
4. `nullifier_0`
5. `nullifier_1`
6. `output_commitment_0` (private change)
7. `output_commitment_1` (optional second private output / zero policy)
8. `recipient_binding`
9. `public_amount`
10. `protocol_fee`
11. `relayer_fee`
12. `transition_nonce`

Exact field packing is intentionally not frozen until the circuit prototype proves all encodings are canonical and range constrained.

## Frozen v0 private witness model

For each input note:

- amount
- owner secret-derived material
- blinding
- note nonce
- Merkle path elements
- Merkle path direction bits

For output notes:

- amount
- destination private key material
- blinding
- note nonce

## Hash strategy

Do not finalize a hash primitive merely because another privacy protocol uses it. M2 will benchmark and constrain candidates that are:

- suitable inside BN254 circuits;
- available from permissively usable/audited libraries;
- deterministic across Go/Rust/JS boundaries;
- domain-separated by Watcher-specific constants;
- practical for Merkle membership and note commitments.

Until selected, `commitment()` and `nullifier()` remain unavailable in the web SDK.

## Verification strategy

Prototype sequence:

1. Native circuit compile/prove/verify tests.
2. Deterministic test vectors committed to the Watcher repo.
3. Independent verifier integration on local Solana validator/devnet.
4. Reject malformed proof/public-input encodings.
5. Measure compute cost and transaction size.
6. Only then freeze verifier/proving artifacts for a versioned test deployment.

## Trusted setup

Groth16 requires circuit-specific setup material. Watcher must not reuse third-party proving keys. For development, generate Watcher-specific disposable setup artifacts. Before any production launch, define and document a production ceremony/process appropriate to the final circuit and threat model.

## Security gates

No mainnet and no protocol fee until:

- circuit constraints reviewed;
- setup provenance documented;
- verifier tested against invalid proofs;
- nullifier double-spend tests pass;
- value conservation and range constraints pass adversarial tests;
- proof/public-input serialization is canonical;
- external security review completed.
