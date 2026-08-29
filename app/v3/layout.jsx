'use client';

import V2WalletTransport from '../v2/V2WalletTransport';

// V3 keeps the same wallet/RPC transport hardening as V2. Only the program
// withdrawal replay-store semantics differ.
export default function WatcherV3Layout({ children }) {
  return <V2WalletTransport>{children}</V2WalletTransport>;
}
