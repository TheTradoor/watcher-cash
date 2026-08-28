'use client';

import { useEffect, useMemo } from 'react';
import {
  ConnectionProvider,
  WalletProvider,
  useConnection,
  useWallet,
} from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import {
  AddressLookupTableProgram,
  Connection,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  clusterApiUrl,
} from '@solana/web3.js';
import { createWatcherE2EWallet, watcherE2EEnabled } from './e2e-wallet';

const WATCHER_RELIABLE_SEND_PATCH = '__watcherReliableDevnetSendV1';
const WATCHER_WALLET_SEND_PATCH = '__watcherWalletOversizedSendV3';
const MAX_TRANSACTION_BYTES = 1232;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

    if (!endpoint.toLowerCase().includes('devnet') && !watcherE2EEnabled()) return signature;

    const rawCopy = rawTransaction instanceof Uint8Array
      ? rawTransaction.slice()
      : new Uint8Array(rawTransaction);

    void (async () => {
      for (let attempt = 0; attempt < 45; attempt += 1) {
        await sleep(1200);
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

function legacyTransactionFits(transaction) {
  if (!(transaction instanceof Transaction)) return true;
  try {
    transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });
    return true;
  } catch (error) {
    if (/transaction too large/i.test(error?.message || String(error))) return false;
    throw error;
  }
}

function lookupAddressesFor(transaction, payer) {
  const payerAddress = payer.toBase58();
  const addresses = new Map();

  for (const instruction of transaction.instructions || []) {
    for (const key of instruction.keys || []) {
      if (key.isSigner) continue;
      const address = key.pubkey.toBase58();
      if (address === payerAddress) continue;
      addresses.set(address, key.pubkey);
    }
  }

  return [...addresses.values()];
}

async function signAndSend(adapter, rpc, transaction, options = {}) {
  const signed = await adapter.signTransaction(transaction);
  const raw = signed.serialize();
  return rpc.sendRawTransaction(raw, {
    ...options,
    skipPreflight: options?.skipPreflight ?? false,
    preflightCommitment: options?.preflightCommitment || 'confirmed',
    maxRetries: Math.max(Number(options?.maxRetries || 0), 25),
  });
}

async function waitForLookupTable(rpc, address, expectedAddresses) {
  const expected = new Set(expectedAddresses.map((value) => value.toBase58()));

  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const [{ value: table }, currentSlot] = await Promise.all([
        rpc.getAddressLookupTable(address, { commitment: 'confirmed' }),
        rpc.getSlot('confirmed'),
      ]);

      if (table) {
        const present = new Set(table.state.addresses.map((value) => value.toBase58()));
        const complete = [...expected].every((value) => present.has(value));
        const active = currentSlot > Number(table.state.lastExtendedSlot);
        if (complete && active) return table;
      }
    } catch {
      // Public devnet RPC can rate-limit reads. Retry until the table is visible and active.
    }
    await sleep(500);
  }

  throw new Error('Withdrawal lookup table did not become active on devnet');
}

async function createLookupTable(adapter, rpc, addresses) {
  const payer = adapter.publicKey;
  if (!payer) throw new Error('Wallet public key is unavailable');

  const recentSlot = await rpc.getSlot('finalized');
  const [createInstruction, lookupTableAddress] = AddressLookupTableProgram.createLookupTable({
    authority: payer,
    payer,
    recentSlot,
  });
  const extendInstruction = AddressLookupTableProgram.extendLookupTable({
    authority: payer,
    payer,
    lookupTable: lookupTableAddress,
    addresses,
  });
  const latest = await rpc.getLatestBlockhash('confirmed');
  const setup = new Transaction({
    feePayer: payer,
    recentBlockhash: latest.blockhash,
  }).add(createInstruction, extendInstruction);

  const signature = await signAndSend(adapter, rpc, setup, {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
    maxRetries: 40,
  });
  await rpc.confirmTransaction({
    signature,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  }, 'confirmed');

  const table = await waitForLookupTable(rpc, lookupTableAddress, addresses);
  try {
    const key = `watcher-withdraw-alt:${rpc.rpcEndpoint}:${payer.toBase58()}`;
    window.localStorage.setItem(key, lookupTableAddress.toBase58());
  } catch {
    // Reuse is only an optimization; the withdrawal can continue without local storage.
  }
  return table;
}

async function getOrCreateLookupTable(adapter, rpc, transaction) {
  const payer = adapter.publicKey;
  if (!payer) throw new Error('Wallet public key is unavailable');
  const addresses = lookupAddressesFor(transaction, payer);
  if (addresses.length === 0) throw new Error('No eligible lookup-table addresses were found');

  try {
    const key = `watcher-withdraw-alt:${rpc.rpcEndpoint}:${payer.toBase58()}`;
    const cached = window.localStorage.getItem(key);
    if (cached) {
      const { value: table } = await rpc.getAddressLookupTable(
        new (payer.constructor)(cached),
        { commitment: 'confirmed' },
      );
      if (table) {
        const present = new Set(table.state.addresses.map((value) => value.toBase58()));
        if (addresses.every((value) => present.has(value.toBase58()))) return table;
      }
      window.localStorage.removeItem(key);
    }
  } catch {
    // If cached lookup-table state is unavailable, create a fresh devnet table below.
  }

  return createLookupTable(adapter, rpc, addresses);
}

async function ensureWithdrawalBlockhashIsValid(rpc, blockhash) {
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const validity = await rpc.isBlockhashValid(blockhash, { commitment: 'confirmed' });
      if (!validity?.value) {
        throw new Error(
          'Withdrawal blockhash expired while preparing its lookup table. The table is cached; retry withdrawal to use a fresh blockhash.',
        );
      }
      return;
    } catch (error) {
      if (/blockhash expired while preparing/i.test(error?.message || String(error))) throw error;
      lastError = error;
      await sleep(400);
    }
  }

  throw new Error(
    `Could not verify the withdrawal blockhash after lookup-table setup. Retry withdrawal; the cached table will be reused.${lastError?.message ? ` RPC: ${lastError.message}` : ''}`,
  );
}

async function convertOversizedLegacyTransaction(adapter, rpc, transaction) {
  const payer = transaction.feePayer || adapter.publicKey;
  if (!payer || !transaction.recentBlockhash) {
    throw new Error('Oversized transaction is missing payer or recent blockhash');
  }

  const lookupTable = await getOrCreateLookupTable(adapter, rpc, transaction);
  await ensureWithdrawalBlockhashIsValid(rpc, transaction.recentBlockhash);
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: transaction.recentBlockhash,
    instructions: transaction.instructions,
  }).compileToV0Message([lookupTable]);
  const versioned = new VersionedTransaction(message);
  const serializedLength = versioned.serialize().length;
  if (serializedLength > MAX_TRANSACTION_BYTES) {
    throw new Error(`v0 withdrawal transaction too large: ${serializedLength} > ${MAX_TRANSACTION_BYTES}`);
  }
  return versioned;
}

function ReliableWalletTransport({ children }) {
  const { connection } = useConnection();
  const { wallet, connected } = useWallet();

  useEffect(() => {
    const adapter = wallet?.adapter;
    if (!connected || !adapter || adapter[WATCHER_WALLET_SEND_PATCH]) return;
    if (typeof adapter.sendTransaction !== 'function') return;

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
        const useDappTransport = endpoint.includes('devnet') || watcherE2EEnabled();
        const oversizedLegacy = transaction instanceof Transaction && !legacyTransactionFits(transaction);

        // Keep normal deposits and any other transaction that fits Solana's packet
        // limit on the wallet adapter's native transport. Only the oversized Groth16
        // withdrawal needs our v0 + lookup-table conversion and direct RPC send.
        if (!useDappTransport || !oversizedLegacy || typeof adapter.signTransaction !== 'function') {
          return originalSendTransaction(transaction, rpc, options);
        }

        const transactionToSign = await convertOversizedLegacyTransaction(adapter, rpc, transaction);
        const signedTransaction = await adapter.signTransaction(transactionToSign);
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
  const wallets = useMemo(() => {
    const e2eWallet = createWatcherE2EWallet();
    return e2eWallet ? [e2eWallet] : [];
  }, []);

  useEffect(() => {
    installReliableDevnetSend();
  }, []);

  return (
    <ConnectionProvider endpoint={endpoint} config={{ commitment: 'confirmed' }}>
      <WalletProvider wallets={wallets} autoConnect>
        <ReliableWalletTransport>
          <WalletModalProvider>{children}</WalletModalProvider>
        </ReliableWalletTransport>
      </WalletProvider>
    </ConnectionProvider>
  );
}
