# Watcher local prover and transaction builders

The Watcher client now has a Node-only adapter that keeps note secrets on the user's machine. It launches the local gnark prover, reads the matched proving key bundle, and returns the exact little-endian wire bytes expected by the Solana verifier.

> **Development only:** the published bundle comes from a single-party development Groth16 setup. It is suitable for tests and devnet only. Never use it with production funds.

## Components

- `prover.node.mjs` runs deposit and withdrawal proving locally.
- `bundle.node.mjs` downloads and checksum-verifies the current development bundle.
- `instructions.mjs` encodes Initialize, Deposit and Withdraw instructions in the exact Rust codec layout.
- `bindings.mjs` computes the recipient and withdrawal-context bindings used by Circuit V1.

## Download the matched development bundle

```js
import { ensureWatcherDevelopmentBundle } from './bundle.node.mjs';

const bundleDirectory = await ensureWatcherDevelopmentBundle({
  cacheDirectory: './.watcher-cache',
});
```

The downloaded archive contains separate proving and verifying keys for the deposit and withdrawal circuits. Every file is checked against `manifest.json` before use.

## Generate a deposit proof locally

```js
import { proveDepositLocally } from './prover.node.mjs';

const result = await proveDepositLocally({
  bundleDirectory,
  witness: {
    Owner: ownerField,
    Nonce: nonceField,
    Commitment: commitmentField,
    Amount: amountLamports,
    AssetID: 1n,
  },
});
```

`result.proof` is 256 bytes and `result.publicInputs` is 96 bytes.

## Build the funded deposit instruction

```js
import { buildDepositInstruction } from './instructions.mjs';

const instruction = buildDepositInstruction({
  programId,
  depositor: wallet.publicKey,
  config,
  commitments,
  rootHistory,
  commitment: commitmentBytes,
  amount: amountLamports,
  proof: result.proof,
  publicInputs: result.publicInputs,
});
```

The deposit instruction transfers the exact proven lamport amount into the vault PDA. A commitment cannot be registered without a matching deposit proof.

## Generate and submit a withdrawal

Use `witness.mjs` to build the Merkle witness from the append-only commitment registry. Compute the proof context with `withdrawContextBindingV1`, then call `proveWithdrawLocally`. Pass the resulting 256-byte proof and 320-byte public-input buffer to `buildWithdrawInstruction`.

The withdrawal context binds the proof to the program ID, config account, vault PDA, relayer, treasury and SOL asset ID. The recipient is bound separately. Reusing the same proof is rejected by the on-chain nullifier registry.

## Re-sync after a circuit change

Run the **Watcher Local Prover Sync** workflow manually. It performs a new development setup, proves both sample circuits locally, runs all client and Rust tests, updates the embedded verifier fixtures, and republishes the checksum-protected development bundle.
