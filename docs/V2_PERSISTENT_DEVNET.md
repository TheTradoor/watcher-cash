# Watcher V2 persistent devnet

Status: **prepared, not yet the live Watcher deployment**. V1 remains untouched.

The V2 public-devnet path is intentionally split into two trust boundaries:

1. `Watcher V2 Devnet Prover Pin` creates one content-addressed development Groth16 setup, commits the matched Rust verifier fixtures, and publishes a non-overwritable browser bundle release.
2. `Deploy Persistent Watcher V2 Devnet` is forbidden from generating proving keys. It consumes the committed pin, checks SHA-256 and VK hashes, builds SBF against those exact verifier fixtures, then deploys a separate fixed V2 program ID.

## Required repository secrets

The deployment workflow requires:

- `WATCHER_DEVNET_DEPLOYER_KEYPAIR_B64` — existing funded devnet deployment wallet. This may be the same deployment authority used for V1; using it does not modify the V1 program.
- `WATCHER_V2_DEVNET_PROGRAM_KEYPAIR_B64` — a **separate** Solana program keypair dedicated to Watcher V2.

The V2 program keypair must never be the V1 program keypair.

Both values are base64-encoded Solana 64-byte keypair JSON arrays. The workflow validates the decoded structure before doing any network write.

## First deployment

Before the first deployment:

1. Finish the V2 prover-pin workflow and verify `public/watcher-protocol/v2-prover-pin.json` is committed.
2. Add the separate V2 program keypair repository secret.
3. Ensure the devnet deployer has at least 5 SOL.
4. Run `Deploy Persistent Watcher V2 Devnet` with:
   - `force_bootstrap: false`
   - `run_e2e: true`

With no existing `v2-devnet.json`, the workflow creates fresh V2 config, active-tree and vault state after deploying the separate program.

## Upgrade behavior

Normal upgrades reuse all of the following:

- fixed V2 program ID;
- published V2 config/tree/vault when still valid;
- the exact content-addressed prover pin;
- the same Groth16 verifying keys.

The deploy workflow refuses to silently move a runtime from one prover-bundle SHA to another. If a different pinned setup is intentionally selected, `force_bootstrap=true` is required because notes produced under the previous VK must not be presented as compatible with the new setup.

## Evidence before publication

Before `public/watcher-protocol/v2-devnet.json` is committed, the workflow requires:

- pinned bundle SHA-256 verification;
- deposit/withdraw VK hash equality with the committed Rust verifier manifest;
- V2 client/circuit/Rust tests;
- SBF build against the pinned VK;
- successful fixed-program deployment/upgrade;
- config/tree/vault runtime verification against public devnet;
- optional but default real-devnet V2 deposit + exact-withdraw smoke test.

Only after those gates pass is the runtime sealed with program SHA, prover release tag, prover bundle SHA and source commit.

## User-facing rollout

Publishing a V2 runtime does **not** automatically replace V1 or point the main GitHub Pages interface at V2. Real Phantom/Solflare public-devnet compatibility is a separate acceptance phase. V1 should remain the public default until that pass is complete.

This remains a development, single-party trusted setup and has not been independently audited.
