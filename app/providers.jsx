'use client';

import { useEffect, useMemo } from 'react';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { Connection, clusterApiUrl } from '@solana/web3.js';

const WATCHER_RELIABLE_SEND_PATCH = '__watcherReliableDevnetSendV1';

function installReliableDevnetSend() {
  const prototype = Connection.prototype;
  if (prototype[WATCHER_RELIABLE_SEND_PATCH]) return;

  const originalSendRawTransaction = prototype.sendRawTransaction;

  Object.defineProperty(prototype, WATCHER_RELIABLE_SEND_PATCH, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });

  prototype.sendRawTransaction = async function sendRawTransactionWithRebroadcast(rawTransaction, options = {}) {
    const requestedRetries = Number(options?.maxRetries || 0);
    const sendOptions = {
      ...options,
      maxRetries: Math.max(Number.isFinite(requestedRetries) ? requestedRetries : 0, 25),
    };

    const signature = await originalSendRawTransaction.call(this, rawTransaction, sendOptions);
    const endpoint = String(this.rpcEndpoint || '');

    if (!endpoint.toLowerCase().includes('devnet')) return signature;

    const rawCopy = rawTransaction instanceof Uint8Array
      ? rawTransaction.slice()
      : new Uint8Array(rawTransaction);

    void (async () => {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        try {
          const statuses = await this.getSignatureStatuses(
            [signature],
            { searchTransactionHistory: true },
          );
          const status = statuses?.value?.[0];

          if (status?.err) return;
          if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
            return;
          }

          await originalSendRawTransaction.call(this, rawCopy, {
            ...sendOptions,
            skipPreflight: true,
            maxRetries: 0,
          });
        } catch {
          // The public devnet RPC can intermittently rate-limit reads or sends.
          // Keep rebroadcasting the already signed transaction while its blockhash is live.
        }
      }
    })();

    return signature;
  };
}

export default function Providers({ children }) {
  const endpoint = useMemo(
    () => process.env.NEXT_PUBLIC_RPC_URL || clusterApiUrl('devnet'),
    [],
  );

  useEffect(() => {
    installReliableDevnetSend();
  }, []);

  return (
    <ConnectionProvider endpoint={endpoint} config={{ commitment: 'confirmed' }}>
      <WalletProvider wallets={[]} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
