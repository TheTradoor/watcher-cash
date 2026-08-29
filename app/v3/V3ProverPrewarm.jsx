'use client';

import { useEffect } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';

import { checkBrowserProverV2 } from '../../client/watcher/index.mjs';

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
          await checkBrowserProverV2({ basePath });
        } catch {
          // Prewarming is a performance optimization only. The foreground flow
          // performs the same initialization again and surfaces any real error.
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
