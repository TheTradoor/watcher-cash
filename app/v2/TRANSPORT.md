# Watcher V2 browser transaction transport

The isolated V2 browser route binds every legacy transaction to a fresh confirmed Solana blockhash before handing it to the wallet adapter.

For each deposit or withdrawal the UI:

1. requests `getLatestBlockhash('confirmed')`;
2. sets the connected wallet as `feePayer`;
3. sets `recentBlockhash` before wallet signing;
4. sends the transaction through the wallet adapter with preflight enabled;
5. confirms with the same `blockhash` and `lastValidBlockHeight`;
6. rejects a confirmation that contains an on-chain error.

This is intentionally explicit. Browser wallets and deterministic test adapters must receive an already well-formed transaction rather than relying on adapter-specific blockhash preparation.

The browser regression also checks UI errors while a transaction is running so transport failures fail fast instead of being mistaken for a long-running Groth16 proof.
