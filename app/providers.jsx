'use client';

import { useEffect, useMemo } from 'react';
import {
  ConnectionProvider,
  WalletProvider,
  useConnection,
  useWallet,
} from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { Connection, clusterApiUrl } from '@solana/web3.js';

const WATCHER_RELIABLE_SEND_PATCH = '__watcherReliableDevnetSendV1';
const WATCHER_WALLET_SEND_PATCH = '__watcherWalletDirectRpcSendV1';

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
      for (let attempt = 0; attempt < 45; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1200));
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
          // Public devnet RPC reads/sends can be rate-limited. Keep rebroadcasting
          // the exact signed bytes while the transaction's blockhash is still live.
        }
      }
    })();

    return signature;
  };
}

function ReliableWalletTransport({ children }) {
  const { connection } = useConnection();
  const { wallet, connected } = useWallet();

  useEffect(() => {
    const adapter = wallet?.adapter;
    if (!connected || !adapter || adapter[WATCHER_WALLET_SEND_PATCH]) return;
    if (typeof adapter.sendTransaction !== 'function' || typeof adapter.signTransaction !== 'function') return;

    const originalSendTransaction = adapter.sendTransaction.bind(adapter);

    Object.defineProperty(adapter, WATCHER_WALLET_SEND_PATCH, {
      value: true,
      configurable: false,
      enumerable: false,
      writable: false,
    });

    Object.defineProperty(adapter, 'sendTransaction', {
      configurable: true,
      writable: true,
      value: async (transaction, targetConnection = connection, options = {}) => {
        const rpc = targetConnection || connection;
        const endpoint = String(rpc?.rpcEndpoint || '').toLowerCase();

        // Wallet Standard wallets such as Phantom prefer signAndSendTransaction.
        // For this devnet app we deliberately ask the wallet to sign only, then
        // submit the exact signed bytes through the RPC that the dapp verified.
        // That keeps signing and confirmation on the same Solana cluster and also
        // lets the reliable send/rebroadcast layer above do its job.
        if (!endpoint.includes('devnet') || typeof adapter.signTransaction !== 'function') {
          return originalSendTransaction(transaction, rpc, options);
        }

        const signedTransaction = await adapter.signTransaction(transaction);
        const rawTransaction = signedTransaction.serialize();
        const requestedRetries = Number(options?.maxRetries || 0);

        return rpc.sendRawTransaction(rawTransaction, {
          ...options,
          skipPreflight: options?.skipPreflight ?? false,
          preflightCommitment: options?.preflightCommitment || 'confirmed',
          maxRetries: Math.max(Number.isFinite(requestedRetries) ? requestedRetries : 0, 25),
        });
      },
    });
  }, [connected, connection, wallet]);

  return children;
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
        <ReliableWalletTransport>
          <WalletModalProvider>{children}</WalletModalProvider>
        </ReliableWalletTransport>
      </WalletProvider>
    </ConnectionProvider>
  );
}
