'use client';

import dynamic from 'next/dynamic';
import { Buffer } from 'buffer';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { useCallback, useEffect, useRef, useState } from 'react';

const WalletButton = dynamic(
  () => import('@solana/wallet-adapter-react-ui').then((m) => m.WalletMultiButton),
  { ssr: false },
);

const GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const RELAYER = process.env.NEXT_PUBLIC_RELAYER_API_URL || 'https://api3.privacycash.org';
const CIRCUIT = process.env.NEXT_PUBLIC_CIRCUIT_BASE_PATH || 'https://cdn.jsdelivr.net/gh/Privacy-Cash/solana-sdk-demo-interface@df7df0198dc202ba8d13292fd07a05b55f5d7cd3/public/circuit2';
const SIGN_MESSAGE = 'Privacy Money account sign in';

const TOKEN_META = {
  sol: { label: 'SOL', decimals: 9 },
  usdc: { label: 'USDC', decimals: 6 },
  usdt: { label: 'USDT', decimals: 6 },
};

let sdkPromise;
let hasherPromise;

function setupBuffer() {
  if (!globalThis.Buffer) globalThis.Buffer = Buffer;
}

function loadSdk() {
  setupBuffer();
  if (!sdkPromise) sdkPromise = import('privacycash/utils');
  return sdkPromise;
}

function loadHasher() {
  setupBuffer();
  if (!hasherPromise) {
    hasherPromise = import('@lightprotocol/hasher.rs').then((m) => m.WasmFactory.getInstance());
  }
  return hasherPromise;
}

function toBaseUnits(value, decimals) {
  const rx = new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`);
  if (!rx.test(value)) throw new Error('Enter a valid amount');
  const [whole, fraction = ''] = value.split('.');
  const scale = 10n ** BigInt(decimals);
  const result = BigInt(whole) * scale + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals));
  const n = Number(result);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('Amount is outside the supported range');
  return n;
}

function friendlyError(error) {
  const text = error?.message || String(error);
  if (/reject|declin/i.test(text)) return 'Request rejected in wallet.';
  if (/insufficient/i.test(text)) return 'Insufficient wallet or private balance.';
  if (/blockhash|expired/i.test(text)) return 'Transaction expired. Please try again.';
  if (/failed to fetch|network/i.test(text)) return 'Network request failed. Try another RPC or retry.';
  return text;
}

function shortAddress(value) {
  if (!value) return 'Not connected';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function AsciiRain() {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let raf;
    let width = 0;
    let height = 0;
    let cols = [];
    const chars = '0 8 $ # S X 6'.split(' ');

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.ceil(width / 18);
      cols = Array.from({ length: count }, (_, i) => ({
        x: i * 18 + Math.random() * 7,
        y: Math.random() * height,
        speed: 0.15 + Math.random() * 0.35,
        alpha: 0.17 + Math.random() * 0.25,
        gap: 16 + Math.random() * 20,
      }));
    };

    const frame = () => {
      ctx.clearRect(0, 0, width, height);
      ctx.font = '13px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'center';
      cols.forEach((col, index) => {
        col.y += col.speed;
        if (col.y > height + 80) col.y = -Math.random() * 200;
        for (let j = 0; j < 9; j += 1) {
          const y = col.y - j * col.gap;
          if (y < -20 || y > height + 20) continue;
          const fade = Math.max(0, 1 - j / 10);
          ctx.fillStyle = `rgba(255,255,255,${col.alpha * fade})`;
          ctx.fillText(chars[(index + j + Math.floor(col.y / 90)) % chars.length], col.x, y);
        }
      });
      raf = requestAnimationFrame(frame);
    };

    resize();
    window.addEventListener('resize', resize);
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return <canvas ref={canvasRef} className="ascii-rain" aria-hidden="true" />;
}

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <span />
      <span />
      <span />
      <span />
    </span>
  );
}

export default function Page() {
  const { connection } = useConnection();
  const { publicKey, connected, signMessage, signTransaction } = useWallet();

  const [vaultOpen, setVaultOpen] = useState(false);
  const [signature, setSignature] = useState(null);
  const [sdkReady, setSdkReady] = useState(false);
  const [network, setNetwork] = useState('checking');
  const [tokenName, setTokenName] = useState('sol');
  const [balance, setBalance] = useState(null);
  const [mode, setMode] = useState('deposit');
  const [amount, setAmount] = useState('');
  const [recipient, setRecipient] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Loading privacy engine…');
  const [error, setError] = useState('');
  const [tx, setTx] = useState('');

  const tokenMeta = TOKEN_META[tokenName];

  useEffect(() => {
    connection
      .getGenesisHash()
      .then((hash) => setNetwork(hash === GENESIS ? 'mainnet' : 'wrong-network'))
      .catch(() => setNetwork('offline'));
  }, [connection]);

  useEffect(() => {
    Promise.all([loadSdk(), loadHasher()])
      .then(() => {
        setSdkReady(true);
        setStatus('Privacy engine ready.');
      })
      .catch((e) => {
        setError(friendlyError(e));
        setStatus('Privacy engine failed to load.');
      });
  }, []);

  useEffect(() => {
    setBalance(null);
    setTx('');
  }, [tokenName]);

  useEffect(() => {
    setTx('');
    setBalance(null);
    if (publicKey) {
      setRecipient(publicKey.toBase58());
      const cached = sessionStorage.getItem(`watcher-cash-signature:${publicKey.toBase58()}`);
      if (cached) {
        try {
          setSignature(Uint8Array.from(Buffer.from(cached, 'hex')));
        } catch {
          sessionStorage.removeItem(`watcher-cash-signature:${publicKey.toBase58()}`);
          setSignature(null);
        }
      } else {
        setSignature(null);
      }
    } else {
      setRecipient('');
      setSignature(null);
    }
  }, [publicKey]);

  const encryption = useCallback(async () => {
    if (!signature) throw new Error('Unlock private account first.');
    const sdk = await loadSdk();
    const service = new sdk.EncryptionService();
    service.deriveEncryptionKeyFromSignature(signature);
    return { sdk, service };
  }, [signature]);

  const unlock = async () => {
    if (!publicKey || !signMessage) return;
    setBusy(true);
    setError('');
    try {
      const sig = await signMessage(new TextEncoder().encode(SIGN_MESSAGE));
      const sdk = await loadSdk();
      const service = new sdk.EncryptionService();
      service.deriveEncryptionKeyFromSignature(sig);
      setSignature(sig);
      sessionStorage.setItem(`watcher-cash-signature:${publicKey.toBase58()}`, Buffer.from(sig).toString('hex'));
      setStatus('Private account unlocked.');
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  const getOffset = async () => {
    try {
      const response = await fetch(`${RELAYER}/merkle/root?token=${tokenName}`);
      const json = await response.json();
      return typeof json.nextIndex === 'number' && json.nextIndex > 60000 ? json.nextIndex - 60000 : 0;
    } catch {
      return 0;
    }
  };

  const refreshBalance = async () => {
    if (!publicKey || !signature) return;
    setBusy(true);
    setError('');
    setStatus(`Scanning private ${tokenMeta.label} commitments…`);
    try {
      const { sdk, service } = await encryption();
      const offset = await getOffset();
      if (tokenName === 'sol') {
        const utxos = await sdk.getUtxos({
          connection,
          publicKey,
          storage: localStorage,
          encryptionService: service,
          offset,
        });
        setBalance(sdk.getBalanceFromUtxos(utxos).lamports / LAMPORTS_PER_SOL);
      } else {
        const token = sdk.tokens.find((t) => t.name.toLowerCase() === tokenName);
        if (!token) throw new Error(`${tokenMeta.label} is not available in this SDK build.`);
        const utxos = await sdk.getUtxosSPL({
          connection,
          publicKey,
          storage: localStorage,
          encryptionService: service,
          mintAddress: token.pubkey,
          offset,
        });
        setBalance(sdk.getBalanceFromUtxosSPL(utxos).base_units / token.units_per_token);
      }
      setStatus('Private balance synced.');
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!publicKey || !signature || !signTransaction) return;
    setBusy(true);
    setError('');
    setTx('');
    try {
      if (network !== 'mainnet') throw new Error('Watcher Cash is configured for Solana Mainnet.');
      const { sdk, service } = await encryption();
      const lightWasm = await loadHasher();
      const units = toBaseUnits(amount, tokenMeta.decimals);
      const token = sdk.tokens.find((t) => t.name.toLowerCase() === tokenName);
      let result;

      if (mode === 'deposit') {
        setStatus('Generating zero-knowledge deposit proof…');
        if (tokenName === 'sol') {
          result = await sdk.deposit({
            lightWasm,
            connection,
            amount_in_lamports: units,
            keyBasePath: CIRCUIT,
            publicKey,
            transactionSigner: (transaction) => signTransaction(transaction),
            storage: localStorage,
            encryptionService: service,
          });
        } else {
          if (!token) throw new Error(`${tokenMeta.label} is unavailable.`);
          result = await sdk.depositSPL({
            lightWasm,
            connection,
            base_units: units,
            keyBasePath: CIRCUIT,
            publicKey,
            transactionSigner: (transaction) => signTransaction(transaction),
            storage: localStorage,
            encryptionService: service,
            mintAddress: token.pubkey,
          });
        }
      } else {
        if (!recipient) throw new Error('Enter a recipient address.');
        const recipientKey = new PublicKey(recipient);
        setStatus('Generating zero-knowledge withdrawal proof…');
        if (tokenName === 'sol') {
          result = await sdk.withdraw({
            lightWasm,
            connection,
            amount_in_lamports: units,
            keyBasePath: CIRCUIT,
            publicKey,
            storage: localStorage,
            encryptionService: service,
            recipient: recipientKey,
          });
        } else {
          if (!token) throw new Error(`${tokenMeta.label} is unavailable.`);
          result = await sdk.withdrawSPL({
            lightWasm,
            connection,
            base_units: units,
            keyBasePath: CIRCUIT,
            publicKey,
            storage: localStorage,
            encryptionService: service,
            recipient: recipientKey,
            mintAddress: token.pubkey,
          });
        }
      }

      setTx(result.tx);
      setAmount('');
      setStatus('Transaction confirmed and indexed.');
      await refreshBalance();
    } catch (e) {
      setError(friendlyError(e));
      setStatus('Transaction stopped.');
    } finally {
      setBusy(false);
    }
  };

  const actionReady = connected && signature && sdkReady && network === 'mainnet' && !busy && amount;

  return (
    <main className="site-shell">
      <section className="hero-runtime" id="home">
        <div className="runtime-backdrop" aria-hidden="true">
          <div className="aurora aurora-one" />
          <div className="aurora aurora-two" />
          <div className="void-ring" />
          <div className="grain" />
          <AsciiRain />
        </div>

        <header className="floating-nav">
          <a className="mini-logo" href="#home" aria-label="Watcher Cash home"><BrandMark /></a>
          <nav className="nav-pill" aria-label="Primary navigation">
            <a className="active" href="#home">Home</a>
            <button type="button" onClick={() => setVaultOpen(true)}>Watcher Cash</button>
            <a href="#how">How It Works</a>
            <a href="https://github.com/Privacy-Cash" target="_blank" rel="noreferrer">Protocol</a>
          </nav>
          <button className="sign-pill" type="button" onClick={() => setVaultOpen(true)}>
            {connected ? shortAddress(publicKey?.toBase58()) : 'Connect'}
          </button>
        </header>

        <div className="hero-center">
          <div className="trusted-pill">
            <span className="trust-logos"><b>W</b><b>◎</b><b>◐</b></span>
            <span>Private transactions on Solana</span>
          </div>
          <h1 className="dot-title">Privacy<br />Designed To Disappear</h1>
          <p className="hero-subtitle">
            Shield balances and move assets through client-side zero-knowledge proofs,
            powered by existing Privacy Cash infrastructure.
          </p>
          <button className="get-started" type="button" onClick={() => setVaultOpen(true)}>Get Started</button>
        </div>

        <div className="metric-row" aria-label="Watcher Cash protocol metrics">
          <div><span className="metric-icon">‹</span><strong>0</strong><small>Keys Surrendered</small></div>
          <div><span className="metric-icon">%</span><strong>100%</strong><small>Client-side Proofs</small></div>
          <div><span className="metric-icon">✣</span><strong>24/7</strong><small>Solana Mainnet</small></div>
          <div><span className="metric-icon">⌗</span><strong>3</strong><small>Supported Assets</small></div>
        </div>
      </section>

      <section className="how-section" id="how">
        <p className="eyebrow">WATCHER CASH</p>
        <h2>Public chain.<br />Private intent.</h2>
        <div className="how-grid">
          <article><span>01</span><h3>Connect</h3><p>Your wallet stays in your control. Watcher Cash never asks for a seed phrase or private key.</p></article>
          <article><span>02</span><h3>Unlock</h3><p>Sign a fixed message. That signature deterministically unlocks your private account locally.</p></article>
          <article><span>03</span><h3>Prove</h3><p>Zero-knowledge proofs are generated client-side before deposits or withdrawals are submitted.</p></article>
        </div>
      </section>

      {vaultOpen && (
        <div className="vault-layer" role="dialog" aria-modal="true" aria-label="Watcher Cash private vault">
          <button className="vault-scrim" aria-label="Close vault" onClick={() => setVaultOpen(false)} />
          <section className="vault-panel">
            <div className="vault-head">
              <div>
                <p className="eyebrow">PRIVATE VAULT</p>
                <h2>Watcher Cash</h2>
              </div>
              <button className="close-vault" type="button" onClick={() => setVaultOpen(false)}>×</button>
            </div>

            <div className="system-strip">
              <span className={network === 'mainnet' ? 'ok' : 'bad'}>● {network === 'mainnet' ? 'MAINNET' : network.toUpperCase()}</span>
              <span className={sdkReady ? 'ok' : ''}>● ZK {sdkReady ? 'READY' : 'LOADING'}</span>
              <span>● RELAYER</span>
            </div>

            <div className="wallet-row">
              <div><small>PUBLIC WALLET</small><strong>{shortAddress(publicKey?.toBase58())}</strong></div>
              <div><small>PRIVATE ACCESS</small><strong className={signature ? 'ok-text' : ''}>{signature ? 'UNLOCKED' : 'LOCKED'}</strong></div>
              <div className="wallet-action"><WalletButton /></div>
            </div>

            {connected && !signature && (
              <button className="unlock-button" type="button" onClick={unlock} disabled={busy}>Unlock Private Account</button>
            )}

            <div className="vault-main">
              <div className="balance-card">
                <div className="token-tabs">
                  {Object.keys(TOKEN_META).map((name) => (
                    <button key={name} className={tokenName === name ? 'active' : ''} onClick={() => setTokenName(name)}>{TOKEN_META[name].label}</button>
                  ))}
                </div>
                <small>PRIVATE BALANCE</small>
                <strong>{balance === null ? '—' : balance.toLocaleString(undefined, { maximumFractionDigits: 6 })}<em>{tokenMeta.label}</em></strong>
                <button type="button" className="refresh-button" disabled={!signature || busy} onClick={refreshBalance}>Refresh Balance</button>
              </div>

              <div className="trade-card">
                <div className="mode-tabs">
                  <button className={mode === 'deposit' ? 'active' : ''} onClick={() => setMode('deposit')}>Deposit</button>
                  <button className={mode === 'withdraw' ? 'active' : ''} onClick={() => setMode('withdraw')}>Withdraw</button>
                </div>

                <label>Amount</label>
                <div className="amount-field"><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" /><span>{tokenMeta.label}</span></div>

                {mode === 'withdraw' && (
                  <>
                    <label>Recipient</label>
                    <input className="recipient-field" value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="Solana address" />
                  </>
                )}

                <button className="primary-action" type="button" disabled={!actionReady} onClick={submit}>
                  {busy ? 'Working…' : mode === 'deposit' ? `Deposit ${tokenMeta.label} Privately` : `Withdraw ${tokenMeta.label}`}
                </button>
              </div>
            </div>

            <div className="status-box"><span>&gt;</span><p>{status}</p></div>
            {error && <div className="error-box">{error}</div>}
            {tx && <a className="tx-link" href={`https://solscan.io/tx/${tx}`} target="_blank" rel="noreferrer">Transaction confirmed · View on Solscan ↗</a>}
            <p className="mainnet-warning">Mainnet uses real funds. Test with a separate wallet and a small amount first.</p>
          </section>
        </div>
      )}
    </main>
  );
}
