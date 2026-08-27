# Watcher Protocol License Audit

Status: engineering inventory, not legal advice.

## Goal

Build an independently implementable Watcher Protocol that can eventually replace all Privacy Cash-specific runtime dependencies before any Watcher protocol fee is enabled.

## Current direct dependencies

| Component | Current use | Migration decision |
|---|---|---|
| `privacycash` | Deposits, UTXO discovery, balance, withdrawals, encryption helpers, token metadata | **REMOVE before independent commercial protocol launch.** Treat current implementation only as an interoperability/reference boundary; do not copy protected implementation into Watcher Protocol. |
| `@lightprotocol/hasher.rs` | Browser hashing/WASM | Audit upstream license and API suitability before retaining. No assumption of commercial permission is made in this document. |
| `@solana/web3.js` | Solana client primitives | Candidate infrastructure dependency; verify license/NOTICE in final dependency audit. |
| Solana wallet adapters | Wallet connectivity/signing | Candidate UI dependency; verify license/NOTICE in final dependency audit. |
| Next.js / React | Web application | Candidate UI dependencies; verify license/NOTICE in final dependency audit. |

## Privacy Cash coupling in current MVP

The current `main` implementation depends on Privacy Cash-specific behavior in at least these places:

1. `import('privacycash/utils')`
2. `EncryptionService`
3. `getUtxos` / `getUtxosSPL`
4. `getBalanceFromUtxos` / SPL equivalent
5. `deposit` / `depositSPL`
6. `withdraw` / `withdrawSPL`
7. SDK token registry
8. Privacy Cash relayer endpoints
9. Privacy Cash Merkle root/index API
10. Privacy Cash circuit artifacts configured by `NEXT_PUBLIC_CIRCUIT_BASE_PATH`

All ten must be absent from the independent protocol runtime before Watcher Protocol is described as independent.

## Clean-room rule

Watcher Protocol implementation must be written from Watcher-owned specifications and permissively usable public standards/libraries. Do not transplant protected Privacy Cash source, circuits, relayer implementation, program code, private constants, or implementation-specific data structures.

Functional concepts such as commitments, Merkle trees, nullifiers, zero-knowledge proofs, relayers, and Solana programs are general concepts; the Watcher implementation must define its own formats, domain separators, interfaces, state layout, circuit constraints, API contracts, and tests.

## Monetization gate

Do **not** enable a Watcher protocol fee until all of the following are true:

- `privacycash` package removed from production dependency graph.
- No Privacy Cash relayer endpoint is used.
- No Privacy Cash circuit artifact is used.
- No Privacy Cash program is required for Watcher transactions.
- Watcher-owned protocol/SDK tests pass independently.
- Remaining dependencies have a completed license/NOTICE inventory.
- Security review is complete.
- Appropriate legal/compliance review for the intended launch jurisdictions is complete.

## Next audit work

- Resolve exact licenses/NOTICE obligations for every retained direct and transitive dependency.
- Produce an SBOM for the independent branch.
- Record source URLs, versions, license texts, and attribution requirements.
- Add CI that fails if `privacycash` or `api3.privacycash.org` is reintroduced after migration is complete.
