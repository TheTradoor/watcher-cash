# Persistent Watcher Devnet Deployment

This workflow creates one fixed Watcher program ID, one durable development
Groth16 setup, and one published set of protocol state accounts on Solana
devnet.

It is still development infrastructure. It is **not** a mainnet deployment,
has not completed an independent audit, and must not hold meaningful funds.

## Why this workflow exists

The ordinary GitHub Pages build can attempt an ephemeral devnet deployment,
but public faucet rate limits make that unreliable. More importantly, a
privacy UI cannot regenerate its Groth16 setup on every website build while
continuing to point at an older on-chain verifier.

The persistent workflow solves that by keeping these items matched:

- the deployed Solana program;
- the Rust verifying-key constants;
- the browser proving bundle;
- the public runtime JSON;
- the protocol state accounts.

## Required repository secrets

Create two dedicated **devnet-only** Solana keypairs locally. Never paste either
keypair into an issue, commit, website form, or chat.

```bash
solana-keygen new --no-bip39-passphrase --outfile watcher-devnet-deployer.json
solana-keygen new --no-bip39-passphrase --outfile watcher-devnet-program.json
```

Fund only the deployer address with devnet SOL. The workflow currently requires
at least 5 devnet SOL so it can deploy or upgrade the program, initialize state,
and run the optional end-to-end smoke test.

Encode both JSON files without adding a newline:

```bash
base64 -w 0 watcher-devnet-deployer.json
base64 -w 0 watcher-devnet-program.json
```

On macOS, use:

```bash
base64 < watcher-devnet-deployer.json | tr -d '\n'
base64 < watcher-devnet-program.json | tr -d '\n'
```

Add the encoded values as repository Actions secrets:

- `WATCHER_DEVNET_DEPLOYER_KEYPAIR_B64`
- `WATCHER_DEVNET_PROGRAM_KEYPAIR_B64`

After saving the secrets, securely delete temporary shell history or clipboard
entries that contain them.

## Running the workflow

First run **Watcher Local Prover Sync** and wait for it to publish the synchronized `watcher-dev-prover` prerelease. Then run **Deploy Persistent Watcher Devnet**.

Inputs:

- `force_bootstrap=false`: reuse the currently published state accounts when
  they still belong to the fixed program.
- `force_bootstrap=true`: create a fresh empty 16-leaf pool and replace the
  public runtime addresses.
- `run_e2e=true`: run a separate proof-bound deposit, deposit, and withdrawal
  test against devnet before publishing.

The workflow:

1. downloads the synchronized matched setup produced by `Watcher Local Prover Sync`;
2. verifies that its digest is compatible with the published runtime, or requires a pool reset;
3. builds and deploys the exact SBF program to the fixed program ID;
4. creates or verifies the published protocol state accounts;
5. runs an optional real devnet custody smoke test;
6. publishes an immutable prover release tagged by its SHA-256 digest;
7. commits only public addresses and digests to
   `public/watcher-protocol/devnet.json`;
8. deletes temporary keypair files.

The resulting commit triggers GitHub Pages. Pages downloads the exact prover
release referenced by the runtime JSON instead of creating a new setup.

## Rotation rules

To rotate the development circuit or verifier, run `Watcher Local Prover Sync` first. If the synchronized bundle digest changes, run the persistent deployment with `force_bootstrap=true`; old notes were created under the previous verifying key and cannot safely share the new registry.

Do not manually mix proving keys, verification keys, or program binaries from
different runs.

## Recovery and operational notes

- Back up the two devnet keypair files offline. GitHub Secrets are not an export
  or recovery mechanism.
- Losing the deployer keypair loses the upgrade authority.
- Losing the program keypair makes reproducible program-ID operations harder,
  even though upgrades primarily use the upgrade authority.
- `force_bootstrap=true` invalidates the published pool's old note registry.
  Use it only when intentionally resetting development state.
- The current circuit supports 16 commitments per pool. This is appropriate
  only for a small closed alpha.
