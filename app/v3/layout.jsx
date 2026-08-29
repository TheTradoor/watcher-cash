'use client';

import V2WalletTransport from '../v2/V2WalletTransport';

// V3 keeps the same wallet/RPC transport hardening as V2. The foreground page
// owns prover initialization so progress is always visible to the user; the
// verified browser cache still makes repeated prover loads fast.
export default function WatcherV3Layout({ children }) {
  return <V2WalletTransport>{children}</V2WalletTransport>;
}
