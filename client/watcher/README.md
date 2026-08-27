# Watcher Protocol V1 client

Clean-room browser and Node utilities for building proof-bound Watcher Protocol deposit and withdrawal transactions.

## Included modules

- `field.mjs`: canonical BN254 field encoding, MiMC, note commitments, nullifiers, recipient binding, and deployment-context binding
- `merkle.mjs`: versioned commitment-registry decoding and fixed 16-leaf Circuit V1 Merkle paths
- `witness.mjs`: deposit and withdrawal witnesses plus exact verifier public-input bytes
- `prover.mjs`: fail-closed client for the loopback-only Watcher Groth16 prover
- `instructions.mjs`: exact Rust-compatible instruction encoding, account ordering, sizes, and vault PDA derivation
- `flows.mjs`: high-level witness → local proof → instruction preparation

The cryptographic and codec modules have no runtime package dependency. Solana submission can wrap an instruction descriptor with `new TransactionInstruction(descriptor)` from `@solana/web3.js`.

## Local proof generation

The proving key is intentionally not sent to a hosted API. The Go prover runs locally and is the only process that receives private owner, nonce, amount, and Merkle-path witness values.

Download the `watcher-local-prover-v1-dev` artifact from the matching Circuit CI run, extract it, then start:

```bash
chmod +x watcher-prover-linux-amd64
./watcher-prover-linux-amd64 \
  -assets . \
  -listen 127.0.0.1:8090 \
  -origins http://localhost:3000,http://127.0.0.1:3000
```

Health check:

```bash
curl http://127.0.0.1:8090/healthz
```

The artifact contains one matched development bundle:

```text
deposit.r1cs
deposit.pk
deposit.vk
withdraw.r1cs
withdraw.pk
withdraw.vk
watcher-prover-linux-amd64
prover-manifest.json
```

Every proof is self-verified locally before being returned. The JS adapter also rejects a proof response unless the public inputs match the client-built statement byte-for-byte.

## Prepare a deposit

```js
import { prepareDepositV1 } from './client/watcher/index.mjs';

const result = await prepareDepositV1({
  accounts: {
    programId,
    depositor: wallet.publicKey,
    config,
    commitments,
    rootHistory,
    vault,
    systemProgram: SystemProgram.programId,
  },
  owner,
  nonce,
  amount: 8_000_000n,
  assetId: 1n,
  proverEndpoint: 'http://127.0.0.1:8090',
});

const instruction = new TransactionInstruction(result.instruction);
```

The deposit proof binds the private note secret to the exact public commitment, SOL amount, and asset ID transferred into the vault.

## Prepare a withdrawal

```js
import { prepareWithdrawV1 } from './client/watcher/index.mjs';

const result = await prepareWithdrawV1({
  connection,
  accounts: {
    programId,
    config,
    commitments,
    nullifiers,
    rootHistory,
    vault,
    recipient,
    relayer,
    treasury,
  },
  input0: { amount: 8_000_000n, owner: 1111n, nonce: 2222n },
  input1: { amount: 3_000_000n, owner: 3333n, nonce: 4444n },
  change: { amount: 6_000_000n, owner: 5555n, nonce: 6666n },
  publicAmount: 4_000_000n,
  protocolFee: 0n,
  relayerFee: 1_000_000n,
  assetId: 1n,
  proverEndpoint: 'http://127.0.0.1:8090',
});

const instruction = new TransactionInstruction(result.instruction);
```

The client derives both Merkle paths from actual append indices and derives the context binding from the concrete program, config, vault, recipient, relayer, treasury, and asset accounts. Callers cannot substitute a manual context value.

## Account sizes and order

```text
config registry:      100 bytes
commitment registry:  517 bytes
nullifier registry:   2,053 bytes
root history:         1,033 bytes
vault:                 50 bytes
```

```text
Initialize:
[authority, config, commitments, nullifiers, root_history, vault, system_program]

Deposit:
[depositor, config, commitments, root_history, vault, system_program]

Withdraw:
[config, commitments, nullifiers, root_history, vault, recipient, relayer, treasury]
```

## Devnet end-to-end harness

After deploying the current Rust program to devnet and extracting the matching prover artifact:

```bash
WATCHER_PROGRAM_ID=<DEPLOYED_PROGRAM_ID> \
WATCHER_PAYER_KEYPAIR=$HOME/.config/solana/id.json \
WATCHER_PROVER_URL=http://127.0.0.1:8090 \
npm run e2e:watcher-devnet
```

The harness creates fresh protocol accounts, deposits 8,000,000 and 3,000,000 lamports, produces a withdrawal proof, pays 4,000,000 to the recipient and 1,000,000 to the relayer, then verifies that 6,000,000 remains as private change in the vault. A mode-`0600` recovery file is written before funds move so interrupted devnet runs retain the note secrets.

## Tests

```bash
npm run test:watcher-client
```

The suite checks cross-language MiMC roots and SHA-256 bindings, actual deposit-index paths, deposit and withdrawal witness construction, exact Rust codec byte offsets, account ordering, local-prover response binding, and high-level proof-to-instruction flows.

## Security boundary

Everything in this directory and the exported prover bundle is **development-only**. The current Groth16 keys come from a randomized CI setup rather than a production ceremony, Circuit V1 has a 16-leaf capacity, and the program has not received an independent security audit. Do not use production funds.
