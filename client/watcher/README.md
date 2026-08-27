# Watcher Circuit V1 client

Clean-room browser/Node utilities for rebuilding the Watcher commitment tree from the actual Solana commitment-registry account and producing a Circuit V1 withdrawal witness.

## What it does

- decodes the versioned on-chain commitment registry
- preserves the real append index of every deposit
- rebuilds the fixed 16-leaf BN254 MiMC tree used by Circuit V1
- generates sibling paths and little-endian index bits for both input notes
- derives note commitments, stable nullifiers, change commitment, and recipient binding
- validates canonical field encoding, tree capacity, duplicate commitments, and value conservation
- emits the exact 10 little-endian public inputs expected by the Solana verifier
- returns a gnark-compatible witness object with decimal field strings

There are no runtime package dependencies. Keccak-256, BN254 field arithmetic, and MiMC are implemented locally and cross-checked against the Go circuit fixture.

## Build from a Solana account

```js
import { buildWithdrawWitnessFromChainV1 } from './client/watcher/index.mjs';

const result = await buildWithdrawWitnessFromChainV1({
  connection,
  commitmentsAccount,
  input0: {
    amount: 8_000_000n,
    owner: 1111n,
    nonce: 2222n,
  },
  input1: {
    amount: 3_000_000n,
    owner: 3333n,
    nonce: 4444n,
  },
  change: {
    amount: 6_000_000n,
    owner: 5555n,
    nonce: 6666n,
  },
  publicAmount: 4_000_000n,
  protocolFee: 0n,
  relayerFee: 1_000_000n,
  recipient: recipientPublicKey.toBytes(),
  assetId: 1n,
  contextBinding: 202n,
});

console.log(result.depositIndices);
console.log(result.witness);

// 320 bytes in Circuit V1 order, ready for the Withdraw instruction.
const publicInputs = result.publicInputs;
```

`result.witness` uses the exact gnark field names from `circuits/withdraw/circuit_v1.go`. `Input0Path`, `Input1Path`, `Input0Index`, and `Input1Index` are derived from the registry. Callers do not supply Merkle paths manually.

## Lower-level proof lookup

```js
import {
  fetchCommitmentRegistryV1,
  getMerkleProofV1,
  noteCommitmentV1,
} from './client/watcher/index.mjs';

const registry = await fetchCommitmentRegistryV1(connection, commitmentsAccount);
const commitment = noteCommitmentV1({ assetId, amount, owner, nonce });
const index = registry.commitments.indexOf(commitment);
const proof = getMerkleProofV1(registry.tree, index);
```

Use `getMerkleProofForCommitmentV1(accountData, commitment)` when raw account bytes are already available.

## Tests

```bash
npm run test:watcher-client
```

The suite checks:

- the standard Keccak-256 empty-input vector
- JS MiMC/tree output against the real Circuit V1 Go fixture root
- actual append-index preservation
- positive membership proofs for multiple indices
- recipient binding against the verifier fixture
- complete witness and public-input construction
- fail-closed behavior for malformed registries and missing notes

## Current boundary

This module builds the witness and verifier input bytes. It does **not** yet generate the Groth16 proof in the browser. The proving layer must consume `result.witness`, produce the matching 256-byte proof, and submit it before the trusted root changes. Circuit V1 currently stores only the latest root, so clients should refetch state and rebuild the witness immediately before proving/submission.
