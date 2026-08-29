'use client';

import V2WalletTransport from '../v2/V2WalletTransport';
import V3ProverPrewarm from './V3ProverPrewarm';

// V3 keeps the same wallet/RPC transport hardening as V2. The prover prewarm
// only downloads and integrity-checks immutable public proving assets; private
// witnesses are created later by the foreground deposit/withdraw flow.
export default function WatcherV3Layout({ children }) {
  return (
    <V2WalletTransport>
      <V3ProverPrewarm />
      {children}
    </V2WalletTransport>
  );
}
