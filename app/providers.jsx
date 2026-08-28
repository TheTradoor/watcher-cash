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

const WATCHER_RELIABLE_SEND_PATCH = '__watcherReliableDevnetSendV1';
const WATCHER_WALLET_SEND_PATCH = '__watcherWalletDirectRpcSendV2';
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

    if (!endpoint.toLowerCase().includes('devnet')) return signature;

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

async function convertOversizedLegacyTransaction(adapter, rpc, transaction) {
  const payer = transaction.feePayer || adapter.publicKey;
  if (!payer || !transaction.recentBlockhash) {
    throw new Error('Oversized transaction is missing payer or recent blockhash');
  }

  const lookupTable = await getOrCreateLookupTable(adapter, rpc, transaction);
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
        if (!endpoint.includes('devnet') || typeof adapter.signTransaction !== 'function') {
          return originalSendTransaction(transaction, rpc, options);
        }

        let transactionToSign = transaction;
        if (transaction instanceof Transaction && !legacyTransactionFits(transaction)) {
          // Groth16 withdrawals are larger than Solana's legacy 1232-byte packet cap.
          // Create/reuse a wallet-owned devnet ALT and compile the same instructions
          // into a v0 transaction before Phantom signs them.
          transactionToSign = await convertOversizedLegacyTransaction(adapter, rpc, transaction);
        }

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
