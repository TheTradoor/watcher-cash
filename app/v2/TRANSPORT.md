# Watcher V2 browser transaction transport

The isolated V2 browser route binds every transaction to a fresh confirmed Solana blockhash before wallet signing.

For each V2 deposit or withdrawal the UI:

1. requests `getLatestBlockhash('confirmed')`;
2. sets the connected wallet as `feePayer`;
3. sets `recentBlockhash` before wallet signing;
4. asks the connected wallet to `signTransaction` exactly once;
5. serializes the exact signed transaction bytes;
6. submits those bytes through the app's Solana RPC with preflight enabled and a minimum retry budget;
7. relies on the devnet `Connection.sendRawTransaction` rebroadcast layer to resend the same signed bytes while the blockhash remains live;
8. confirms with the same `blockhash` and `lastValidBlockHeight`;
9. rejects a confirmation that contains an on-chain error.

The direct transport is scoped to `/v2/`. Leaving the V2 route restores the wallet adapter transport that was active before V2 mounted, so the live V1 route is not modified.

This avoids depending on injected-wallet broadcaster behavior after a potentially long browser-local Groth16 proof. Browser wallets and deterministic test adapters receive an already well-formed transaction, but the dapp owns delivery and rebroadcast of the signed bytes.

The browser regression also checks UI errors while a transaction is running so transport failures fail fast instead of being mistaken for a long-running Groth16 proof.

## Public Pages isolation

The public `/v2/` route is published as an overlay on top of the immutable V1 Pages artifact. The overlay deployment must preserve the byte hash of the V1 root page and V1 runtime while adding only the V2 route, V2 runtime, and pinned V2 prover assets.
