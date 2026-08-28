'use client';

import {
  BaseSignerWalletAdapter,
  WalletReadyState,
} from '@solana/wallet-adapter-base';
import {
  Keypair,
  VersionedTransaction,
} from '@solana/web3.js';

const E2E_WALLET_NAME = 'Watcher E2E Wallet';
const E2E_ALTERNATE_WALLET_NAME = 'Watcher E2E Alternate Wallet';
const E2E_WALLET_ICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='18' fill='%23111310'/%3E%3Ccircle cx='32' cy='32' r='16' fill='none' stroke='%23b7ff45' stroke-width='4'/%3E%3Ccircle cx='32' cy='32' r='4' fill='%23b7ff45'/%3E%3C/svg%3E";

function parseSeedHex(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(text)) {
    throw new Error('NEXT_PUBLIC_WATCHER_E2E_SEED must be a 32-byte hex seed');
  }
  const bytes = new Uint8Array(32);
  for (let index = 0; index < 32; index += 1) {
    bytes[index] = Number.parseInt(text.slice(index * 2, (index * 2) + 2), 16);
  }
  return bytes;
}

function alternateSeed(seed) {
  const bytes = seed.slice();
  bytes[bytes.length - 1] ^= 0x01;
  return bytes;
}

class WatcherE2EWalletAdapter extends BaseSignerWalletAdapter {
  url = 'https://github.com/TheTradoor/watcher-cash';
  icon = E2E_WALLET_ICON;
  readyState = WalletReadyState.Installed;
  supportedTransactionVersions = new Set(['legacy', 0]);

  constructor(seed, name = E2E_WALLET_NAME) {
    super();
    this.name = name;
    this._keypair = Keypair.fromSeed(seed);
    this._connected = false;
    this._connecting = false;
  }

  get publicKey() {
    return this._connected ? this._keypair.publicKey : null;
  }

  get connecting() {
    return this._connecting;
  }

  async connect() {
    if (this._connected || this._connecting) return;
    this._connecting = true;
    try {
      this._connected = true;
      this.emit('connect', this._keypair.publicKey);
    } finally {
      this._connecting = false;
    }
  }

  async disconnect() {
    if (!this._connected) return;
    this._connected = false;
    this.emit('disconnect');
  }

  async signTransaction(transaction) {
    if (!this._connected) throw new Error('Watcher E2E wallet is not connected');
    if (transaction instanceof VersionedTransaction) {
      transaction.sign([this._keypair]);
      return transaction;
    }
    transaction.partialSign(this._keypair);
    return transaction;
  }

  async signAllTransactions(transactions) {
    return Promise.all(transactions.map((transaction) => this.signTransaction(transaction)));
  }

  async signMessage(message) {
    if (!this._connected) throw new Error('Watcher E2E wallet is not connected');
    const input = message instanceof Uint8Array ? message : new Uint8Array(message);
    const signature = new Uint8Array(64);
    for (let index = 0; index < signature.length; index += 1) {
      signature[index] = this._keypair.secretKey[index] ^ (input[index % Math.max(1, input.length)] || 0);
    }
    return signature;
  }
}

export function createWatcherE2EWallets() {
  if (process.env.NEXT_PUBLIC_WATCHER_E2E !== '1') return [];
  const seed = parseSeedHex(process.env.NEXT_PUBLIC_WATCHER_E2E_SEED);
  return [
    new WatcherE2EWalletAdapter(seed, E2E_WALLET_NAME),
    new WatcherE2EWalletAdapter(alternateSeed(seed), E2E_ALTERNATE_WALLET_NAME),
  ];
}

export function createWatcherE2EWallet() {
  return createWatcherE2EWallets()[0] || null;
}

export function watcherE2EEnabled() {
  return process.env.NEXT_PUBLIC_WATCHER_E2E === '1';
}
