# Watcher Cash → Watcher Protocol Migration Map

## Working baseline

`main` remains the currently proven Privacy Cash-powered MVP. Do not add Watcher revenue logic to that baseline.

`watcher-protocol` is the independent implementation branch.

## Current frontend coupling and replacements

| Current behavior | Current dependency | Watcher replacement |
|---|---|---|
| Dynamic SDK import | `privacycash/utils` | `src/watcher-sdk/index.ts` |
| Private account key derivation | Privacy Cash `EncryptionService` | Watcher account/key module with independently specified derivation |
| SOL note discovery | `getUtxos` | `WatcherClient.scanNotes()` |
| Private balance | `getBalanceFromUtxos` | `WatcherClient.getPrivateBalance()` |
| SOL deposit | `deposit` | `WatcherClient.buildDeposit()` + program instruction |
| SOL withdrawal | `withdraw` | `WatcherClient.proveWithdrawal()` + Watcher relayer |
| SPL deposit/withdraw | Privacy Cash SPL methods | Deferred until Watcher SOL v1 passes tests |
| Token registry | Privacy Cash token list | Watcher asset registry |
| Merkle offset/root | Privacy Cash relayer API | Watcher indexer `/v1/tree/*` |
| Fee quote | Privacy Cash `/config` | Watcher relayer `/v1/config` |
| Circuit path | Privacy Cash CDN artifacts | Watcher-owned versioned circuit artifacts |

## Frontend migration strategy

Keep visual components and wallet UX where they are generic. Replace transaction internals behind a stable adapter so the page does not directly know which protocol implementation is underneath.

Planned interface:

```ts
interface PrivateAssetClient {
  unlock(signature: Uint8Array): Promise<void>;
  getPrivateBalance(asset: string): Promise<bigint>;
  quoteWithdrawal(asset: string, amount: bigint): Promise<WithdrawalQuote>;
  deposit(asset: string, amount: bigint): Promise<TransactionReceipt>;
  withdraw(asset: string, amount: bigint, recipient: string): Promise<TransactionReceipt>;
}
```

During development, Privacy Cash adapter and Watcher adapter must remain clearly separated. Production Watcher Protocol must not silently fall back to Privacy Cash.

## Milestones

### M0 — Boundary
- [x] Create `watcher-protocol` branch.
- [x] Add license boundary document.
- [x] Add clean-room protocol spec.
- [x] Map current coupling.

### M1 — SDK skeleton
- [ ] Add Watcher-owned types and interfaces.
- [ ] Add deterministic unit tests for amount/value conservation.
- [ ] Add domain-separated commitment/nullifier API placeholders.
- [ ] No real cryptographic security claims yet.

### M2 — Circuit prototype
- [ ] Select audited/permissively usable proof stack.
- [ ] Freeze field encodings/hash choices.
- [ ] Implement membership/value/nullifier constraints.
- [ ] Add negative/adversarial tests.

### M3 — Solana program
- [ ] Local validator only.
- [ ] Deposit state transition.
- [ ] Nullifier rejection.
- [ ] Withdrawal verification path.
- [ ] Fee accounting disabled initially.

### M4 — Indexer + relayer
- [ ] Commitment index.
- [ ] Merkle path API.
- [ ] Relayer health/config.
- [ ] Proof-bound withdrawal submission.

### M5 — Web integration
- [ ] Replace Privacy Cash adapter with Watcher adapter.
- [ ] Remove `privacycash` dependency.
- [ ] Remove Privacy Cash endpoints/artifacts.
- [ ] CI guard against reintroduction.

### M6 — Launch gates
- [ ] Devnet soak testing.
- [ ] External security review.
- [ ] Complete dependency/SBOM license review.
- [ ] Legal/compliance review for launch jurisdictions.
- [ ] Mainnet limited-value test.
- [ ] Only after all gates: consider protocol fee activation.
