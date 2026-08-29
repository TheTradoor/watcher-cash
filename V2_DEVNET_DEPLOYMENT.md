# Watcher Protocol V2 — persistent devnet deployment

V2 is intentionally isolated from the working V1 deployment.

## Required repository secrets

The deployment gate expects two secrets:

- `WATCHER_DEVNET_DEPLOYER_KEYPAIR_B64` — the already-funded deployment authority/payer.
- `WATCHER_V2_DEVNET_PROGRAM_KEYPAIR_B64` — a dedicated persistent program keypair used only for V2.

`WATCHER_V2_DEVNET_PROGRAM_KEYPAIR_B64` must **not** resolve to the V1 program id. The readiness workflow rejects a shared program identity.

## Generate the V2 program key locally

Do this on a trusted machine. Never paste the secret keypair into an issue, commit, chat log, or public terminal transcript.

```bash
solana-keygen new \
  --no-bip39-passphrase \
  --force \
  -o watcher-v2-devnet-program-keypair.json

solana address -k watcher-v2-devnet-program-keypair.json
base64 -w0 watcher-v2-devnet-program-keypair.json > watcher-v2-devnet-program-keypair.b64
```

On macOS, use:

```bash
base64 < watcher-v2-devnet-program-keypair.json | tr -d '\n' > watcher-v2-devnet-program-keypair.b64
```

The two recommended local filenames are ignored by this branch's `.gitignore`.

Copy the contents of `watcher-v2-devnet-program-keypair.b64` into the GitHub Actions repository secret named exactly:

`WATCHER_V2_DEVNET_PROGRAM_KEYPAIR_B64`

After confirming the secret exists, remove the `.b64` helper file. Keep the JSON program keypair offline if future upgrades must preserve the same V2 program id.

## What the deployment gate verifies

Before mutating public devnet, the V2 workflows require:

- the content-addressed V2 browser prover release and whole-bundle SHA-256;
- the pinned canonical verifying-key hashes to match the Rust verifier fixtures;
- a dedicated V2 program id different from V1;
- at least 5 SOL on the configured devnet deployer;
- existing V2 runtime ownership/genesis/vault liability checks when a runtime already exists;
- an explicit acknowledgement before any development-state reset with non-zero tracked private liability.

The optional real-devnet custody smoke is faucet-free by default on non-local RPCs. It uses the pre-funded deployer and funds disposable recipient/treasury accounts from that payer.

## Current proof setup warning

The pinned V2 Groth16 bundle is a **development single-party setup**. Passing these deployment gates does not make V2 audited or production/mainnet ready.
