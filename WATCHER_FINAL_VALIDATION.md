# Final Watcher Browser Validation

Status: FAILED
Branch: watcher-protocol
Source commit: 314bc400a8d203b51e4084ce218d3874fc2046cf
Workflow run: 33125061496
Failed step: remove legacy runtime

Last validation output:

```text
===== harden devnet route =====
===== fix direct imports =====
===== remove legacy runtime =====
file:///home/runner/work/watcher-cash/watcher-cash/scripts/remove-legacy-privacycash-runtime.mjs:23
    audit += `\n\n${marker}\n\nThe live Watcher Protocol browser application no longer imports or ships the \\`privacycash\\` package or the legacy Light Protocol browser hasher runtime. The active UI uses Watcher-owned client codecs, circuits, proof adapters, and Solana instructions. Historical migration notes remain documentation only.\n`;
                                                                                                               ^^^^^^^^^^^^

SyntaxError: Invalid or unexpected token
    at compileSourceTextModule (node:internal/modules/esm/utils:318:16)
    at ModuleLoader.moduleStrategy (node:internal/modules/esm/translators:89:18)
    at #translate (node:internal/modules/esm/loader:434:20)
    at afterLoad (node:internal/modules/esm/loader:502:29)
    at ModuleLoader.loadAndTranslate (node:internal/modules/esm/loader:507:12)
    at #getOrCreateModuleJobAfterResolve (node:internal/modules/esm/loader:560:36)
    at afterResolve (node:internal/modules/esm/loader:607:52)
    at ModuleLoader.getOrCreateModuleJob (node:internal/modules/esm/loader:613:12)
    at node:internal/modules/esm/loader:632:32
    at TracingChannel.tracePromise (node:diagnostics_channel:362:14)

Node.js v24.19.0
```
