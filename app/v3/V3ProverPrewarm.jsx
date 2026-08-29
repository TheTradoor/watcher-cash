'use client';

import { useEffect } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';

import { prewarmBrowserProverV3 } from '../../client/watcher/index.mjs';

const RUNTIME_URL = process.env.NEXT_PUBLIC_WATCHER_V3_RUNTIME_URL || '/watcher-protocol/v3-local.json';
const DEFAULT_PROVER_BASE = process.env.NEXT_PUBLIC_WATCHER_V3_PROVER_BASE || '/watcher-prover-v3';

export default function V3ProverPrewarm() {
  const wallet = useWallet();

  useEffect(() => {
    if (!wallet.connected) return undefined;
    let cancelled = false;
    const timer = setTimeout(() => {
      (async () => {
        try {
          const response = await fetch(RUNTIME_URL, { cache: 'no-store' });
          if (!response.ok) return;
          const runtime = await response.json();
          if (cancelled || Number(runtime?.version) !== 3 || runtime?.status !== 'ready') return;
          const basePath = String(runtime.proverBasePath || DEFAULT_PROVER_BASE).replace(/\/+$/, '');
          if (!basePath) return;
          // Only immutable public deposit R1CS/PK/VK bytes are loaded here.
          // No private note opening or witness exists during this prewarm.
          await prewarmBrowserProverV3({ basePath, circuit: 'deposit' });
        } catch {
          // Prewarming is a performance optimization only. The foreground flow
          // repeats all integrity checks and surfaces any real proving error.
        }
      })();
    }, 150);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [wallet.connected]);

  return null;
}
