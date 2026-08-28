# Watcher browser status

Status: VALIDATED DEVELOPMENT BUILD

The browser deposit flow uses the six-field, 192-byte deposit public-input wire format and derives the append transition from the live commitment registry before local proving.

The permanent `.github/workflows/watcher-full-validation.yml` workflow enforces client tests, browser worker syntax, static export, native Go prover tests, Go WebAssembly compilation, and Solana program tests.

Do not use production funds. The current proving setup is development-only and the protocol has not completed an independent audit or production ceremony.
