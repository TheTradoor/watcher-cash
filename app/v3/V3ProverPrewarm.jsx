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
    let basePath = '';

    const prewarm = (circuit) => {
      if (!basePath || cancelled) return;
      // Prewarm handles only immutable public R1CS/PK/VK bytes. Private note
      // openings and witnesses are created later by the foreground flow.
      prewarmBrowserProverV3({ basePath, circuit }).catch(() => {});
    };

    const onClick = (event) => {
      if (event.target?.closest?.('[data-v3-tab="withdraw"]')) prewarm('withdraw');
    };
    document.addEventListener('click', onClick, { passive: true });

    const timer = setTimeout(() => {
      (async () => {
        try {
          const response = await fetch(RUNTIME_URL, { cache: 'no-store' });
          if (!response.ok) return;
          const runtime = await response.json();
          if (cancelled || Number(runtime?.version) !== 3 || runtime?.status !== 'ready') return;
          basePath = String(runtime.proverBasePath || DEFAULT_PROVER_BASE).replace(/\/+$/, '');
          if (!basePath) return;
          prewarm('deposit');
        } catch {
          // Prewarming is performance-only. Foreground proving repeats all
          // integrity checks and surfaces any real error.
        }
      })();
    }, 150);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener('click', onClick);
    };
  }, [wallet.connected]);

  return null;
}
