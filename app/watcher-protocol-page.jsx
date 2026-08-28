'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import { Buffer } from 'buffer';

import { bytesToHex } from '../client/watcher/keccak.mjs';
import {
  BN254_SCALAR_MODULUS,
  bytesToBigIntLE,
  noteCommitmentV1,
  nullifierV1,
} from '../client/watcher/field.mjs';
import {
  CONFIG_ACCOUNT_LEN_V1,
  COMMITMENT_REGISTRY_LEN_V1,
  deriveVaultAddressV1,
  buildInitializeInstructionV1,
  NULLIFIER_REGISTRY_LEN_V1,
  ROOT_HISTORY_ACCOUNT_LEN_V1,
  VAULT_ACCOUNT_LEN_V1,
} from '../client/watcher/instructions.mjs';
import { getBrowserProverV1 } from '../client/watcher/browser-prover.mjs';
import { prepareUiDepositV1, prepareUiWithdrawV1 } from '../client/watcher/ui-flows.mjs';
import styles from './page.module.css';

if (typeof globalThis !== 'undefined' && !globalThis.Buffer) globalThis.Buffer = Buffer;

const BASE_PATH = process.env.NEXT_PUBLIC_WATCHER_BASE_PATH || '';
const DEFAULT_RPC = process.env.NEXT_PUBLIC_WATCHER_RPC_URL || 'https://api.devnet.solana.com';
const DEFAULT_PROGRAM = process.env.NEXT_PUBLIC_WATCHER_PROGRAM_ID || '';
const SETTINGS_KEY = 'watcher-protocol-v1-settings';
const MAX_COMPUTE_UNITS = 1_200_000;

const emptySettings = Object.freeze({
  rpcUrl: DEFAULT_RPC,
  programId: DEFAULT_PROGRAM,
  config: '',
  commitments: '',
  nullifiers: '',
  rootHistory: '',
  vault: '',
  treasury: '',
  relayer: '',
});

function short(value, left = 5, right = 5) {
  const text = String(value || '');
  if (text.length <= left + right + 3) return text;
  return `${text.slice(0, left)}...${text.slice(-right)}`;
}

function publicKey(value, label) {
  try {
    return value instanceof PublicKey ? value : new PublicKey(String(value));
  } catch {
    throw new Error(`${label} is not a valid Solana address`);
  }
}

function descriptorInstruction(descriptor) {
  return new TransactionInstruction({
    programId: publicKey(descriptor.programId, 'program id'),
    keys: descriptor.keys.map((item) => ({
      pubkey: publicKey(item.pubkey, 'instruction account'),
      isSigner: Boolean(item.isSigner),
      isWritable: Boolean(item.isWritable),
    })),
    data: Buffer.from(descriptor.data),
  });
}

function parseSol(value, label = 'amount') {
  const text = String(value ?? '').trim();
  if (!/^\d+(?:\.\d{0,9})?$/.test(text)) {
    throw new Error(`${label} must use at most 9 decimal places`);
  }
  const [whole, fraction = ''] = text.split('.');
  const lamports = BigInt(whole) * BigInt(LAMPORTS_PER_SOL)
    + BigInt((fraction + '000000000').slice(0, 9));
  if (lamports <= 0n) throw new Error(`${label} must be greater than zero`);
  return lamports;
}

function formatSol(lamports, maximumFractionDigits = 6) {
  const value = typeof lamports === 'bigint' ? lamports : BigInt(lamports || 0);
  const whole = value / BigInt(LAMPORTS_PER_SOL);
  const fraction = (value % BigInt(LAMPORTS_PER_SOL)).toString().padStart(9, '0');
  const trimmed = fraction.slice(0, maximumFractionDigits).replace(/0+$/, '');
  return trimmed ? `${whole}.${trimmed}` : whole.toString();
}

function randomFieldSecret() {
  if (!globalThis.crypto?.getRandomValues) throw new Error('secure browser randomness is unavailable');
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  let value = bytesToBigIntLE(bytes) % BN254_SCALAR_MODULUS;
  if (value === 0n) value = 1n;
  return value;
}

function readU32LE(bytes, offset) {
  return (
    bytes[offset]
    | (bytes[offset + 1] << 8)
    | (bytes[offset + 2] << 16)
    | (bytes[offset + 3] << 24)
  ) >>> 0;
}

function readU64LE(bytes, offset) {
  let value = 0n;
  for (let index = 7; index >= 0; index -= 1) {
    value = (value << 8n) | BigInt(bytes[offset + index]);
  }
  return value;
}

function decodeRegistry32(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length < 5 || bytes[0] !== 1) throw new Error('registry is uninitialized');
  const count = readU32LE(bytes, 1);
  if (5 + count * 32 > bytes.length) throw new Error('registry data is truncated');
  const values = new Set();
  for (let index = 0; index < count; index += 1) {
    const start = 5 + index * 32;
    values.add(bytesToHex(bytes.slice(start, start + 32)));
  }
  return { count, values };
}

function downloadJson(filename, value) {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(href);
}

function settingsReady(settings) {
  return [
    settings.programId,
    settings.config,
    settings.commitments,
    settings.nullifiers,
    settings.rootHistory,
    settings.vault,
    settings.treasury,
    settings.relayer,
  ].every(Boolean);
}

function normalizeNote(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('recovery file does not contain a note');
  const amount = BigInt(raw.amount);
  const owner = BigInt(raw.owner);
  const nonce = BigInt(raw.nonce);
  const assetId = BigInt(raw.assetId ?? 1);
  const commitment = noteCommitmentV1({ amount, owner, nonce, assetId });
  if (raw.commitment !== undefined && BigInt(raw.commitment) !== commitment) {
    throw new Error('recovery note commitment does not match its secrets');
  }
  return {
    id: commitment.toString(10),
    amount: amount.toString(10),
    owner: owner.toString(10),
    nonce: nonce.toString(10),
    assetId: assetId.toString(10),
    commitment: commitment.toString(10),
    source: raw.source || 'imported',
    createdAt: raw.createdAt || new Date().toISOString(),
    signature: raw.signature || '',
    spent: Boolean(raw.spent),
    spentSignature: raw.spentSignature || '',
  };
}

export default function WatcherProtocolPage() {
  const wallet = useWallet();
  const [settings, setSettings] = useState(emptySettings);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [tab, setTab] = useState('deposit');
  const [showSetup, setShowSetup] = useState(false);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('Connect a wallet, configure a devnet program, then generate proofs locally.');
  const [error, setError] = useState('');
  const [assetStatus, setAssetStatus] = useState('checking');
  const [proverStatus, setProverStatus] = useState('idle');
  const [bundleDigest, setBundleDigest] = useState('');
  const [depositAmount, setDepositAmount] = useState('0.01');
  const [withdrawAmount, setWithdrawAmount] = useState('0.005');
  const [relayerFee, setRelayerFee] = useState('0.001');
  const [recipient, setRecipient] = useState('');
  const [notes, setNotes] = useState([]);
  const [selectedNotes, setSelectedNotes] = useState([]);
  const [walletLamports, setWalletLamports] = useState(0n);
  const [vaultLamports, setVaultLamports] = useState(0n);
  const [trackedVaultLamports, setTrackedVaultLamports] = useState(0n);
  const [nullifierCount, setNullifierCount] = useState(0);
  const [activity, setActivity] = useState([]);
  const proverRef = useRef(null);
  const importRef = useRef(null);

  const connection = useMemo(
    () => new Connection(settings.rpcUrl || DEFAULT_RPC, 'confirmed'),
    [settings.rpcUrl],
  );
  const ready = settingsReady(settings);
  const walletAddress = wallet.publicKey?.toBase58() || '';
  const notesStorageKey = walletAddress && settings.config
    ? `watcher-notes-v1:${walletAddress}:${settings.config}`
    : '';

  const unspentNotes = useMemo(() => notes.filter((note) => !note.spent), [notes]);
  const privateBalance = useMemo(
    () => unspentNotes.reduce((sum, note) => sum + BigInt(note.amount), 0n),
    [unspentNotes],
  );

  const pushActivity = useCallback((label, signature = '') => {
    setActivity((current) => [{ label, signature, at: new Date().toISOString() }, ...current].slice(0, 8));
  }, []);

  const persistSettings = useCallback((next) => {
    setSettings(next);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  }, []);

  const persistNotes = useCallback((next) => {
    setNotes(next);
    if (notesStorageKey) sessionStorage.setItem(notesStorageKey, JSON.stringify(next));
  }, [notesStorageKey]);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
      if (saved && typeof saved === 'object') setSettings({ ...emptySettings, ...saved });
    } catch {
      localStorage.removeItem(SETTINGS_KEY);
    } finally {
      setSettingsLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!notesStorageKey) {
      setNotes([]);
      return;
    }
    try {
      const saved = JSON.parse(sessionStorage.getItem(notesStorageKey) || '[]');
      setNotes(Array.isArray(saved) ? saved.map(normalizeNote) : []);
    } catch {
      sessionStorage.removeItem(notesStorageKey);
      setNotes([]);
    }
  }, [notesStorageKey]);

  useEffect(() => {
    if (walletAddress && !recipient) setRecipient(walletAddress);
  }, [walletAddress, recipient]);

  useEffect(() => {
    let cancelled = false;
    fetch(`${BASE_PATH}/watcher-prover/assets/manifest.json`, { cache: 'no-store' })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then(() => { if (!cancelled) setAssetStatus('ready'); })
      .catch(() => { if (!cancelled) setAssetStatus('missing'); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => () => {
    proverRef.current?.terminate?.();
  }, []);

  const ensureProver = useCallback(async () => {
    if (!proverRef.current) {
      proverRef.current = getBrowserProverV1({
        basePath: `${BASE_PATH}/watcher-prover`,
      });
    }
    setProverStatus('loading');
    const result = await proverRef.current.initialize();
    setBundleDigest(result?.bundleDigest || '');
    setProverStatus('ready');
    return proverRef.current;
  }, []);

  const confirm = useCallback(async (signature) => {
    const result = await connection.confirmTransaction(signature, 'confirmed');
    if (result.value.err) throw new Error(`transaction failed: ${JSON.stringify(result.value.err)}`);
  }, [connection]);

  const refresh = useCallback(async () => {
    setError('');
    try {
      if (wallet.publicKey) setWalletLamports(BigInt(await connection.getBalance(wallet.publicKey, 'confirmed')));
      if (!ready) return;
      const [vaultInfo, nullifierInfo] = await Promise.all([
        connection.getAccountInfo(publicKey(settings.vault, 'vault'), 'confirmed'),
        connection.getAccountInfo(publicKey(settings.nullifiers, 'nullifiers'), 'confirmed'),
      ]);
      if (!vaultInfo) throw new Error('vault account was not found');
      if (!nullifierInfo) throw new Error('nullifier registry was not found');
      setVaultLamports(BigInt(vaultInfo.lamports));
      const vaultData = new Uint8Array(vaultInfo.data);
      if (vaultData.length >= VAULT_ACCOUNT_LEN_V1 && vaultData[0] === 1) {
        setTrackedVaultLamports(readU64LE(vaultData, 42));
      }
      const registry = decodeRegistry32(new Uint8Array(nullifierInfo.data));
      setNullifierCount(registry.count);
      if (notes.length) {
        const next = notes.map((note) => {
          const commitment = BigInt(note.commitment);
          const derived = nullifierV1({
            owner: BigInt(note.owner),
            nonce: BigInt(note.nonce),
            commitment,
          });
          const spent = registry.values.has(bytesToHex((() => {
            let value = derived;
            const bytes = new Uint8Array(32);
            for (let index = 0; index < 32; index += 1) {
              bytes[index] = Number(value & 0xffn);
              value >>= 8n;
            }
            return bytes;
          })()));
          return spent === note.spent ? note : { ...note, spent };
        });
        persistNotes(next);
      }
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
    }
  }, [connection, notes, persistNotes, ready, settings.nullifiers, settings.vault, wallet.publicKey]);

  useEffect(() => {
    if (!settingsLoaded) return;
    void refresh();
  }, [settingsLoaded, walletAddress, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  const bootstrap = useCallback(async () => {
    if (!wallet.publicKey || !wallet.sendTransaction) throw new Error('connect a wallet first');
    const programId = publicKey(settings.programId, 'program id');
    setBusy('bootstrap');
    setError('');
    setMessage('Creating Watcher state accounts and vault PDA on devnet...');
    try {
      const config = Keypair.generate();
      const commitments = Keypair.generate();
      const nullifiers = Keypair.generate();
      const rootHistory = Keypair.generate();
      const [configRent, commitmentRent, nullifierRent, historyRent] = await Promise.all([
        connection.getMinimumBalanceForRentExemption(CONFIG_ACCOUNT_LEN_V1),
        connection.getMinimumBalanceForRentExemption(COMMITMENT_REGISTRY_LEN_V1),
        connection.getMinimumBalanceForRentExemption(NULLIFIER_REGISTRY_LEN_V1),
        connection.getMinimumBalanceForRentExemption(ROOT_HISTORY_ACCOUNT_LEN_V1),
      ]);
      const derived = deriveVaultAddressV1({
        programId,
        config: config.publicKey,
        findProgramAddressSync: PublicKey.findProgramAddressSync,
      });
      const transaction = new Transaction().add(
        SystemProgram.createAccount({
          fromPubkey: wallet.publicKey,
          newAccountPubkey: config.publicKey,
          lamports: configRent,
          space: CONFIG_ACCOUNT_LEN_V1,
          programId,
        }),
        SystemProgram.createAccount({
          fromPubkey: wallet.publicKey,
          newAccountPubkey: commitments.publicKey,
          lamports: commitmentRent,
          space: COMMITMENT_REGISTRY_LEN_V1,
          programId,
        }),
        SystemProgram.createAccount({
          fromPubkey: wallet.publicKey,
          newAccountPubkey: nullifiers.publicKey,
          lamports: nullifierRent,
          space: NULLIFIER_REGISTRY_LEN_V1,
          programId,
        }),
        SystemProgram.createAccount({
          fromPubkey: wallet.publicKey,
          newAccountPubkey: rootHistory.publicKey,
          lamports: historyRent,
          space: ROOT_HISTORY_ACCOUNT_LEN_V1,
          programId,
        }),
        descriptorInstruction(buildInitializeInstructionV1({
          programId,
          authority: wallet.publicKey,
          config: config.publicKey,
          commitments: commitments.publicKey,
          nullifiers: nullifiers.publicKey,
          rootHistory: rootHistory.publicKey,
          vault: derived.vault,
          treasury: wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })),
      );
      const signature = await wallet.sendTransaction(transaction, connection, {
        signers: [config, commitments, nullifiers, rootHistory],
      });
      await confirm(signature);
      const next = {
        ...settings,
        programId: programId.toBase58(),
        config: config.publicKey.toBase58(),
        commitments: commitments.publicKey.toBase58(),
        nullifiers: nullifiers.publicKey.toBase58(),
        rootHistory: rootHistory.publicKey.toBase58(),
        vault: derived.vault.toBase58(),
        treasury: wallet.publicKey.toBase58(),
        relayer: wallet.publicKey.toBase58(),
      };
      persistSettings(next);
      setShowSetup(false);
      setMessage('Watcher protocol state initialized. Browser proving is ready for deposits.');
      pushActivity('Protocol initialized', signature);
    } finally {
      setBusy('');
    }
  }, [confirm, connection, persistSettings, pushActivity, settings, wallet]);

  const deposit = useCallback(async () => {
    if (!wallet.publicKey || !wallet.sendTransaction) throw new Error('connect a wallet first');
    if (!ready) throw new Error('initialize or import a Watcher protocol configuration first');
    const amount = parseSol(depositAmount, 'deposit amount');
    setBusy('deposit');
    setError('');
    setMessage('Loading matched proving keys in an isolated browser worker...');
    try {
      const owner = randomFieldSecret();
      const nonce = randomFieldSecret();
      const prover = await ensureProver();
      setMessage('Generating a local Groth16 deposit proof. The private note never leaves this browser.');
      const prepared = await prepareUiDepositV1({
        connection,
        accounts: {
          programId: publicKey(settings.programId, 'program id'),
          depositor: wallet.publicKey,
          config: publicKey(settings.config, 'config'),
          commitments: publicKey(settings.commitments, 'commitments'),
          rootHistory: publicKey(settings.rootHistory, 'root history'),
          vault: publicKey(settings.vault, 'vault'),
          systemProgram: SystemProgram.programId,
        },
        owner,
        nonce,
        amount,
        assetId: 1n,
        prover,
      });
      const recovery = {
        format: 'watcher-note-v1',
        network: 'solana-devnet',
        protocol: {
          programId: settings.programId,
          config: settings.config,
          commitments: settings.commitments,
          nullifiers: settings.nullifiers,
          rootHistory: settings.rootHistory,
          vault: settings.vault,
        },
        note: {
          amount: amount.toString(10),
          owner: owner.toString(10),
          nonce: nonce.toString(10),
          assetId: '1',
          commitment: prepared.note.commitment.toString(10),
          source: 'deposit',
          createdAt: new Date().toISOString(),
        },
        warning: 'Keep this file private. Anyone with owner and nonce can spend the note.',
      };
      downloadJson(`watcher-note-${short(prepared.note.commitment, 8, 8)}.json`, recovery);
      setMessage('Recovery file downloaded. Broadcasting the proof-bound deposit...');
      const transaction = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_COMPUTE_UNITS }),
        descriptorInstruction(prepared.instruction),
      );
      const signature = await wallet.sendTransaction(transaction, connection);
      await confirm(signature);
      const note = normalizeNote({ ...recovery.note, signature });
      persistNotes([...notes.filter((item) => item.id !== note.id), note]);
      setMessage(`Deposit confirmed: ${formatSol(amount)} SOL moved into the Watcher vault.`);
      pushActivity(`Deposited ${formatSol(amount)} SOL`, signature);
      await refresh();
    } finally {
      setBusy('');
    }
  }, [confirm, connection, depositAmount, ensureProver, notes, persistNotes, pushActivity, ready, refresh, settings, wallet]);

  const withdraw = useCallback(async () => {
    if (!wallet.publicKey || !wallet.sendTransaction) throw new Error('connect a wallet first');
    if (!ready) throw new Error('Watcher protocol configuration is incomplete');
    const chosen = selectedNotes
      .map((id) => notes.find((note) => note.id === id))
      .filter((note) => note && !note.spent);
    if (chosen.length !== 2) throw new Error('select exactly two unspent notes');
    const publicAmount = parseSol(withdrawAmount, 'withdraw amount');
    const relayerValue = parseSol(relayerFee, 'relayer fee');
    const inputTotal = chosen.reduce((sum, note) => sum + BigInt(note.amount), 0n);
    const changeAmount = inputTotal - publicAmount - relayerValue;
    if (changeAmount <= 0n) {
      throw new Error('selected notes must leave positive private change after payout and relayer fee');
    }
    const recipientKey = publicKey(recipient, 'recipient');
    setBusy('withdraw');
    setError('');
    setMessage('Rebuilding Merkle paths from the live commitment registry...');
    try {
      const changeOwner = randomFieldSecret();
      const changeNonce = randomFieldSecret();
      const prover = await ensureProver();
      setMessage('Generating a local Groth16 withdrawal proof inside the browser worker...');
      const prepared = await prepareUiWithdrawV1({
        connection,
        accounts: {
          programId: publicKey(settings.programId, 'program id'),
          config: publicKey(settings.config, 'config'),
          commitments: publicKey(settings.commitments, 'commitments'),
          nullifiers: publicKey(settings.nullifiers, 'nullifiers'),
          rootHistory: publicKey(settings.rootHistory, 'root history'),
          vault: publicKey(settings.vault, 'vault'),
          recipient: recipientKey,
          relayer: publicKey(settings.relayer, 'relayer'),
          treasury: publicKey(settings.treasury, 'treasury'),
        },
        input0: {
          amount: BigInt(chosen[0].amount),
          owner: BigInt(chosen[0].owner),
          nonce: BigInt(chosen[0].nonce),
        },
        input1: {
          amount: BigInt(chosen[1].amount),
          owner: BigInt(chosen[1].owner),
          nonce: BigInt(chosen[1].nonce),
        },
        change: { amount: changeAmount, owner: changeOwner, nonce: changeNonce },
        publicAmount,
        protocolFee: 0n,
        relayerFee: relayerValue,
        assetId: 1n,
        prover,
      });
      const changeCommitment = prepared.publicFields.changeCommitment;
      const recovery = {
        format: 'watcher-note-v1',
        network: 'solana-devnet',
        protocol: {
          programId: settings.programId,
          config: settings.config,
          commitments: settings.commitments,
          nullifiers: settings.nullifiers,
          rootHistory: settings.rootHistory,
          vault: settings.vault,
        },
        note: {
          amount: changeAmount.toString(10),
          owner: changeOwner.toString(10),
          nonce: changeNonce.toString(10),
          assetId: '1',
          commitment: changeCommitment.toString(10),
          source: 'change',
          createdAt: new Date().toISOString(),
        },
        warning: 'This is the private change note. Keep it private and back it up before broadcasting.',
      };
      downloadJson(`watcher-change-${short(changeCommitment, 8, 8)}.json`, recovery);
      setMessage('Change recovery downloaded. Broadcasting the verified withdrawal...');
      const transaction = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_COMPUTE_UNITS }),
        descriptorInstruction(prepared.instruction),
      );
      const signature = await wallet.sendTransaction(transaction, connection);
      await confirm(signature);
      const spentIds = new Set(chosen.map((note) => note.id));
      const changeNote = normalizeNote({ ...recovery.note, signature });
      const next = notes
        .map((note) => spentIds.has(note.id)
          ? { ...note, spent: true, spentSignature: signature }
          : note)
        .filter((note) => note.id !== changeNote.id);
      next.push(changeNote);
      persistNotes(next);
      setSelectedNotes([]);
      setMessage(`Withdrawal confirmed. Recipient received ${formatSol(publicAmount)} SOL.`);
      pushActivity(`Withdrew ${formatSol(publicAmount)} SOL`, signature);
      await refresh();
    } finally {
      setBusy('');
    }
  }, [confirm, connection, ensureProver, notes, persistNotes, pushActivity, ready, recipient, refresh, relayerFee, selectedNotes, settings, wallet, withdrawAmount]);

  const execute = useCallback(async (action) => {
    try {
      await action();
    } catch (actionError) {
      setBusy('');
      setProverStatus((current) => current === 'loading' ? 'error' : current);
      setError(actionError instanceof Error ? actionError.message : String(actionError));
    }
  }, []);

  const importRecovery = useCallback(async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const raw = parsed.note || parsed;
      const note = normalizeNote(raw);
      persistNotes([...notes.filter((item) => item.id !== note.id), note]);
      setMessage(`Imported note ${short(note.commitment, 8, 8)} into this browser session.`);
      await refresh();
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : String(importError));
    }
  }, [notes, persistNotes, refresh]);

  const exportNotes = useCallback(() => {
    downloadJson('watcher-session-notes.json', {
      format: 'watcher-note-collection-v1',
      network: 'solana-devnet',
      protocol: settings,
      notes,
      warning: 'This file contains private spending secrets. Store it offline.',
    });
  }, [notes, settings]);

  const toggleSelected = useCallback((id) => {
    setSelectedNotes((current) => current.includes(id)
      ? current.filter((item) => item !== id)
      : current.length >= 2 ? [current[1], id] : [...current, id]);
  }, []);

  const resetState = useCallback(() => {
    const next = { ...emptySettings, rpcUrl: settings.rpcUrl, programId: settings.programId };
    persistSettings(next);
    setNotes([]);
    setSelectedNotes([]);
    setShowSetup(true);
  }, [persistSettings, settings.programId, settings.rpcUrl]);

  return (
    <main className={styles.shell}>
      <section className={styles.terminal}>
        <header className={styles.topbar}>
          <div className={styles.brandBlock}>
            <div className={styles.logoMark}>W</div>
            <div>
              <div className={styles.brand}>WATCHER CASH</div>
              <div className={styles.subtitle}>private SOL custody · development network</div>
            </div>
          </div>
          <div className={styles.badges}>
            <span className={styles.badge}><i /> DEVNET</span>
            <span className={styles.badge}><i /> GROTH16</span>
            <span className={`${styles.badge} ${assetStatus !== 'ready' ? styles.badgeMuted : ''}`}>
              <i /> {assetStatus === 'ready' ? 'BROWSER PROVER' : assetStatus.toUpperCase()}
            </span>
          </div>
        </header>

        <section className={styles.identityBar}>
          <div>
            <span>PUBLIC WALLET</span>
            <strong>{walletAddress ? short(walletAddress, 7, 7) : 'NOT CONNECTED'}</strong>
          </div>
          <div>
            <span>PRIVATE ACCESS</span>
            <strong className={wallet.connected ? styles.activeText : ''}>
              {wallet.connected ? 'UNLOCKED' : 'LOCKED'}
            </strong>
          </div>
          <div>
            <span>PROTOCOL</span>
            <strong className={ready ? styles.activeText : ''}>{ready ? 'CONFIGURED' : 'SETUP REQUIRED'}</strong>
          </div>
          <WalletMultiButton className={styles.walletButton} />
        </section>

        <div className={styles.grid}>
          <aside className={styles.balanceCard}>
            <div className={styles.assetTabs}>
              <button className={styles.assetActive}>SOL</button>
              <button disabled>USDC</button>
              <button disabled>USDT</button>
            </div>
            <div className={styles.metricLabel}>PRIVATE BALANCE</div>
            <div className={styles.balanceValue}>{formatSol(privateBalance, 5)} <small>SOL</small></div>
            <div className={styles.metricRows}>
              <div><span>Wallet</span><strong>{formatSol(walletLamports, 4)} SOL</strong></div>
              <div><span>Vault liability</span><strong>{formatSol(trackedVaultLamports, 4)} SOL</strong></div>
              <div><span>Vault lamports</span><strong>{formatSol(vaultLamports, 4)} SOL</strong></div>
              <div><span>Spent nullifiers</span><strong>{nullifierCount}</strong></div>
            </div>
            <button className={styles.secondaryButton} onClick={() => void refresh()} disabled={Boolean(busy)}>
              Refresh Protocol State
            </button>

            <div className={styles.noteHeader}>
              <span>LOCAL PRIVATE NOTES</span>
              <strong>{unspentNotes.length} UNSPENT</strong>
            </div>
            <div className={styles.noteList}>
              {notes.length === 0 && <div className={styles.emptyNote}>No note loaded in this browser session.</div>}
              {notes.map((note) => (
                <button
                  type="button"
                  key={note.id}
                  className={`${styles.noteRow} ${note.spent ? styles.noteSpent : ''} ${selectedNotes.includes(note.id) ? styles.noteSelected : ''}`}
                  onClick={() => !note.spent && toggleSelected(note.id)}
                >
                  <span>{short(note.commitment, 7, 7)}</span>
                  <strong>{formatSol(BigInt(note.amount), 5)} SOL</strong>
                  <em>{note.spent ? 'SPENT' : note.source.toUpperCase()}</em>
                </button>
              ))}
            </div>
            <div className={styles.noteActions}>
              <button onClick={() => importRef.current?.click()}>Import</button>
              <button onClick={exportNotes} disabled={!notes.length}>Export All</button>
              <input ref={importRef} type="file" accept="application/json" hidden onChange={importRecovery} />
            </div>
          </aside>

          <section className={styles.actionCard}>
            <div className={styles.modeTabs}>
              <button className={tab === 'deposit' ? styles.modeActive : ''} onClick={() => setTab('deposit')}>Deposit</button>
              <button className={tab === 'withdraw' ? styles.modeActive : ''} onClick={() => setTab('withdraw')}>Withdraw</button>
            </div>

            {!ready && (
              <div className={styles.setupGate}>
                <div>
                  <span>PROTOCOL SETUP</span>
                  <strong>A deployed Watcher program ID is required before funds can move.</strong>
                  <p>The setup transaction creates fresh program-owned registries and a vault PDA for this wallet.</p>
                </div>
                <button className={styles.primaryButton} onClick={() => setShowSetup(true)}>Configure Development Protocol</button>
              </div>
            )}

            {tab === 'deposit' ? (
              <div className={styles.formBody}>
                <label>
                  <span>AMOUNT</span>
                  <div className={styles.inputShell}>
                    <input value={depositAmount} onChange={(event) => setDepositAmount(event.target.value)} inputMode="decimal" />
                    <b>SOL</b>
                  </div>
                </label>
                <div className={styles.explainBox}>
                  <div><span>Proof location</span><strong>Your browser worker</strong></div>
                  <div><span>Deposit binding</span><strong>Commitment + exact lamports</strong></div>
                  <div><span>Recovery</span><strong>Downloaded before broadcast</strong></div>
                  <p>Owner, nonce, amount and witness data never go to a hosted proving server.</p>
                </div>
                <button
                  className={styles.primaryButton}
                  disabled={!wallet.connected || !ready || Boolean(busy) || assetStatus !== 'ready'}
                  onClick={() => void execute(deposit)}
                >
                  {busy === 'deposit' ? 'Generating Proof...' : 'Deposit SOL Privately'}
                </button>
              </div>
            ) : (
              <div className={styles.formBody}>
                <label>
                  <span>RECIPIENT</span>
                  <div className={styles.inputShell}>
                    <input value={recipient} onChange={(event) => setRecipient(event.target.value)} spellCheck={false} />
                  </div>
                </label>
                <div className={styles.splitFields}>
                  <label>
                    <span>PUBLIC AMOUNT</span>
                    <div className={styles.inputShell}>
                      <input value={withdrawAmount} onChange={(event) => setWithdrawAmount(event.target.value)} inputMode="decimal" />
                      <b>SOL</b>
                    </div>
                  </label>
                  <label>
                    <span>RELAYER FEE</span>
                    <div className={styles.inputShell}>
                      <input value={relayerFee} onChange={(event) => setRelayerFee(event.target.value)} inputMode="decimal" />
                      <b>SOL</b>
                    </div>
                  </label>
                </div>
                <div className={styles.explainBox}>
                  <div><span>Selected notes</span><strong>{selectedNotes.length} / 2</strong></div>
                  <div><span>Recent root policy</span><strong>32 accepted roots</strong></div>
                  <div><span>Recipient binding</span><strong>Proof enforced</strong></div>
                  <p>Select two unspent notes from the left panel. Positive private change is written back as a new note.</p>
                </div>
                <button
                  className={styles.primaryButton}
                  disabled={!wallet.connected || !ready || selectedNotes.length !== 2 || Boolean(busy) || assetStatus !== 'ready'}
                  onClick={() => void execute(withdraw)}
                >
                  {busy === 'withdraw' ? 'Generating Proof...' : 'Withdraw with Groth16 Proof'}
                </button>
              </div>
            )}

            <div className={styles.statusBox}>
              <span className={`${styles.statusDot} ${error ? styles.statusError : ''}`} />
              <div>
                <strong>{error ? 'Action blocked' : busy ? 'Processing locally' : 'Ready'}</strong>
                <p>{error || message}</p>
              </div>
            </div>
          </section>
        </div>

        <section className={styles.bottomPanel}>
          <div className={styles.protocolInfo}>
            <span>PROGRAM</span><strong>{settings.programId ? short(settings.programId, 8, 8) : 'NOT SET'}</strong>
            <span>CONFIG</span><strong>{settings.config ? short(settings.config, 8, 8) : 'NOT SET'}</strong>
            <span>PROVER</span><strong>{proverStatus.toUpperCase()}</strong>
            <span>BUNDLE</span><strong>{bundleDigest ? short(bundleDigest, 10, 10) : 'NOT LOADED'}</strong>
          </div>
          <div className={styles.bottomActions}>
            <button onClick={() => setShowSetup(true)}>Protocol Settings</button>
            <button onClick={resetState} disabled={!ready}>Disconnect State</button>
          </div>
        </section>

        <section className={styles.console}>
          <strong>&gt;</strong>
          <span>{activity[0]?.label || 'Watcher Protocol is development-only. Do not use production funds.'}</span>
          {activity[0]?.signature && <code>{short(activity[0].signature, 10, 10)}</code>}
        </section>
      </section>

      {showSetup && (
        <div className={styles.modalBackdrop} role="presentation" onMouseDown={() => !busy && setShowSetup(false)}>
          <section className={styles.modal} role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
            <div className={styles.modalHeader}>
              <div><span>DEVELOPMENT CONFIGURATION</span><strong>Watcher Protocol State</strong></div>
              <button onClick={() => setShowSetup(false)}>×</button>
            </div>
            <label>
              <span>SOLANA RPC</span>
              <input value={settings.rpcUrl} onChange={(event) => setSettings((current) => ({ ...current, rpcUrl: event.target.value }))} />
            </label>
            <label>
              <span>DEPLOYED WATCHER PROGRAM ID</span>
              <input value={settings.programId} onChange={(event) => setSettings((current) => ({ ...current, programId: event.target.value.trim() }))} placeholder="Program public key" />
            </label>
            <div className={styles.addressGrid}>
              {['config', 'commitments', 'nullifiers', 'rootHistory', 'vault', 'treasury', 'relayer'].map((key) => (
                <label key={key}>
                  <span>{key.replace(/[A-Z]/g, (letter) => ` ${letter}`).toUpperCase()}</span>
                  <input value={settings[key]} onChange={(event) => setSettings((current) => ({ ...current, [key]: event.target.value.trim() }))} placeholder="Created automatically or paste an existing address" />
                </label>
              ))}
            </div>
            <div className={styles.modalNotice}>
              This UI only targets Solana devnet. Browser proving assets and all current keys are development artifacts, not a production ceremony.
            </div>
            <div className={styles.modalActions}>
              <button className={styles.secondaryButton} onClick={() => persistSettings(settings)}>Save Existing State</button>
              <button className={styles.primaryButton} disabled={!wallet.connected || !settings.programId || Boolean(busy)} onClick={() => void execute(bootstrap)}>
                {busy === 'bootstrap' ? 'Creating Accounts...' : 'Create Fresh Protocol State'}
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
