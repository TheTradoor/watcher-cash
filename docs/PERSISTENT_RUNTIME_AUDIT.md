# Persistent Watcher runtime audit

- Audited commit: `e09711c1f98b737903f8b2b026b72f51be4ddefe`
- Immutable prover tag: `watcher-persistent-devnet-v1`
- Deployer secret present: `false`
- Program keypair secret present: `false`
- Deployment credential status: `BLOCKED_MISSING_GITHUB_SECRETS`
- Overall status: `BLOCKED`

## Checks

| Check | Result | Exit code |
|---|---:|---:|
| `immutable_release` | **FAIL** | 1 |
| `persistent_workflow` | **PASS** | 0 |
| `pages_persistent` | **FAIL** | 1 |
| `runtime_file` | **FAIL** | 1 |
| `runtime_ready` | **FAIL** | 2 |
| `npm_install` | **PASS** | 0 |
| `client_tests` | **PASS** | 0 |
| `worker_syntax` | **PASS** | 0 |
| `next_build` | **PASS** | 0 |
| `go_tests` | **PASS** | 0 |
| `wasm_build` | **PASS** | 0 |
| `rust_tests` | **PASS** | 0 |
| `clean_diff` | **PASS** | 0 |

## Required user action

Create the two documented **devnet-only** GitHub Actions secrets, then manually run the persistent deployment workflow. Do not paste private keys into chat.

- `WATCHER_DEVNET_DEPLOYER_KEYPAIR_JSON`
- `WATCHER_DEVNET_PROGRAM_KEYPAIR_JSON`

## Safety

Development infrastructure only: Solana devnet, development Groth16 setup, fixed Circuit V1 capacity, and no independent production audit.
