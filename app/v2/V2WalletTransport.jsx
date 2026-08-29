'use client';

import { useEffect } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { normalizeWatcherFailure } from '../../client/watcher/failure-errors.mjs';
import { reconcileSignatureStatusV2 } from '../../client/watcher/v2-confirmation.mjs';
import { watcherE2EEnabled } from '../e2e-wallet';

const WATCHER_V2_DIRECT_SEND_PATCH = '__watcherV2DirectDevnetSendV1';
const WATCHER_V2_CONFIRM_PATCH = '__watcherV2ReconciledConfirmV1';

export default function V2WalletTransport({ children }) {
  const { connection } = useConnection();
  const { wallet, connected } = useWallet();

  useEffect(() => {
    if (!connection || connection[WATCHER_V2_CONFIRM_PATCH]) return undefined;
    if (typeof connection.confirmTransaction !== 'function') return undefined;

    const originalConfirmTransaction = connection.confirmTransaction.bind(connection);

    const patchedConfirmTransaction = async (...args) => {
      try {
        return await originalConfirmTransaction(...args);
      } catch (error) {
        const strategy = args[0];
        const signature = typeof strategy === 'string' ? strategy : strategy?.signature;

        if (signature) {
          const reconciled = await reconcileSignatureStatusV2({
            connection,
            signature,
          });
          if (reconciled) return reconciled;
        }

        throw normalizeWatcherFailure(error);
      }
    };

    try {
      Object.defineProperty(connection, WATCHER_V2_CONFIRM_PATCH, {
        value: true,
        configurable: true,
        enumerable: false,
        writable: false,
      });
      Object.defineProperty(connection, 'confirmTransaction', {
        configurable: true,
        writable: true,
        value: patchedConfirmTransaction,
      });
    } catch {
      return undefined;
    }

    return () => {
      try {
        if (connection.confirmTransaction === patchedConfirmTransaction) {
          Object.defineProperty(connection, 'confirmTransaction', {
            configurable: true,
            writable: true,
            value: originalConfirmTransaction,
          });
        }
        delete connection[WATCHER_V2_CONFIRM_PATCH];
      } catch {
        // Route cleanup is best-effort; a page reload recreates the connection.
      }
    };
  }, [connection]);

  useEffect(() => {
    const adapter = wallet?.adapter;
    if (!connected || !adapter) return undefined;
    if (adapter[WATCHER_V2_DIRECT_SEND_PATCH]) return undefined;
    if (typeof adapter.sendTransaction !== 'function' || typeof adapter.signTransaction !== 'function') return undefined;

    const originalSendTransaction = adapter.sendTransaction.bind(adapter);

    const patchedSendTransaction = async (transaction, targetConnection = connection, options = {}) => {
      try {
        const rpc = targetConnection || connection;
        const endpoint = String(rpc?.rpcEndpoint || '').toLowerCase();
        const useDirectTransport = endpoint.includes('devnet') || watcherE2EEnabled();

        if (!useDirectTransport) {
          return await originalSendTransaction(transaction, rpc, options);
        }

        // V2 transactions already carry a fresh fee payer + confirmed blockhash.
        // Ask the wallet to sign exactly once, then submit the exact signed bytes
        // through the app RPC. Connection.sendRawTransaction is rebroadcast-hardened
        // by the root provider on devnet, so temporary RPC/wallet broadcaster stalls
        // cannot silently burn the whole blockhash validity window.
        const signed = await adapter.signTransaction(transaction);
        const raw = signed.serialize();
        const requestedRetries = Number(options?.maxRetries || 0);

        return await rpc.sendRawTransaction(raw, {
          ...options,
          skipPreflight: options?.skipPreflight ?? false,
          preflightCommitment: options?.preflightCommitment || 'confirmed',
          maxRetries: Math.max(Number.isFinite(requestedRetries) ? requestedRetries : 0, 25),
        });
      } catch (error) {
        throw normalizeWatcherFailure(error);
      }
    };

    try {
      Object.defineProperty(adapter, WATCHER_V2_DIRECT_SEND_PATCH, {
        value: true,
        configurable: true,
        enumerable: false,
        writable: false,
      });
      Object.defineProperty(adapter, 'sendTransaction', {
        configurable: true,
        writable: true,
        value: patchedSendTransaction,
      });
    } catch {
      // Some injected adapters expose non-configurable methods. In that case the
      // V2 page falls back to the adapter's native transport rather than failing
      // wallet connection entirely.
      return undefined;
    }

    return () => {
      try {
        if (adapter.sendTransaction === patchedSendTransaction) {
          Object.defineProperty(adapter, 'sendTransaction', {
            configurable: true,
            writable: true,
            value: originalSendTransaction,
          });
        }
        delete adapter[WATCHER_V2_DIRECT_SEND_PATCH];
      } catch {
        // Route cleanup is best-effort; a page reload recreates the adapter.
      }
    };
  }, [connected, connection, wallet]);

  return children;
}
