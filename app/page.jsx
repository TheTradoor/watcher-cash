'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Buffer } from 'buffer';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal, WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import {
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  checkBrowserProverV1,
  confirmedNoteRecordsV1,
  createNoteRecordV1,
  decodeCommitmentRegistryV1,
  deriveNoteVaultKeyV1,
  loadNoteVaultV1,
  noteRecordToInputV1,
  prepareDepositV1,
  prepareWithdrawV1,
  privateBalanceLamportsV1,
  proveDepositWithBrowserProverV1,
  proveWithdrawWithBrowserProverV1,
  removeNoteRecordV1,
  saveNoteVaultV1,
  selectInputPairV1,
  syncNoteRecordsV1,
  upsertNoteRecordV1,
} from '../client/watcher/index.mjs';

const RUNTIME_URL = process.env.NEXT_PUBLIC_WATCHER_RUNTIME_URL || '/watcher-protocol/devnet.json';
const DEFAULT_PROVER_BASE = process.env.NEXT_PUBLIC_WATCHER_PROVER_BASE || '/watcher-prover';
const GROTH16_COMPUTE_UNITS = 1_400_000;
const COMPUTE_UNIT_PRICE = 1_000;

function parseSol(value) {
  const normalized = String(value || '').trim();
  if (!/^\d+(?:\.\d{0,9})?$/.test(normalized)) {
    throw new Error('Enter a valid SOL amount with up to 9 decimals');
  }
  const [whole, fraction = ''] = normalized.split('.');
  const lamports = BigInt(whole) * BigInt(LAMPORTS_PER_SOL)
    + BigInt(fraction.padEnd(9, '0') || '0');
  if (lamports <= 0n) throw new Error('Amount must be greater than zero');
  if (lamports > 0xffff_ffff_ffff_ffffn) throw new Error('Amount is too large');
  return lamports;
}

function formatSol(value, maximumFractionDigits = 9) {
  const lamports = typeof value === 'bigint' ? value : BigInt(value || 0);
  const whole = lamports / BigInt(LAMPORTS_PER_SOL);
  const remainder = lamports % BigInt(LAMPORTS_PER_SOL);
  let fraction = remainder.toString().padStart(9, '0').slice(0, maximumFractionDigits);
  fraction = fraction.replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function shortAddress(value, left = 5, right = 5) {
  const text = String(value || '');
  if (text.length <= left + right + 3) return text;
  return `${text.slice(0, left)}…${text.slice(-right)}`;
}

function friendlyError(error) {
  const message = error?.message || String(error || 'Unknown error');
  return message
    .replace(/^WalletSendTransactionError:\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .replace('Transaction simulation failed: ', 'Simulation failed: ');
}

function descriptorInstruction(descriptor) {
  return new TransactionInstruction({
    programId: descriptor.programId,
    keys: descriptor.keys,
    data: Buffer.from(descriptor.data),
  });
}

function explorerTransaction(signature) {
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}

function explorerAddress(address) {
  return `https://explorer.solana.com/address/${address}?cluster=devnet`;
}

function validateRuntime(value) {
  const required = [
    'programId', 'config', 'commitments', 'nullifiers', 'rootHistory',
    'vault', 'treasury', 'relayer', 'genesisHash',
  ];
  if (!value || typeof value !== 'object') throw new Error('Runtime configuration is missing');
  for (const name of required) {
    if (typeof value[name] !== 'string' || !value[name]) {
      throw new Error(`Runtime configuration is missing ${name}`);
    }
  }
  if (value.cluster !== 'devnet') throw new Error('This interface only accepts a devnet runtime');
  return {
    ...value,
    commitmentCapacity: Number(value.commitmentCapacity || 16),
    protocolFeeLamports: String(value.protocolFeeLamports || '0'),
    relayerFeeLamports: String(value.relayerFeeLamports || '0'),
    proverBasePath: value.proverBasePath || DEFAULT_PROVER_BASE,
  };
}

function Logo() {
  return (
    <div className="brand-lockup" aria-label="Watcher Cash">
      <div className="brand-mark" aria-hidden="true">
        <span />
        <span />
      </div>
      <div>
        <strong>WATCHER</strong>
        <small>CASH</small>
      </div>
    </div>
  );
}

function StatusPill({ tone = 'neutral', children }) {
  return <span className={`status-pill status-${tone}`}><i />{children}</span>;
}

function NoteRow({ record, onDiscard }) {
  return (
    <div className="note-row">
      <div className="note-main">
        <span className={`note-status note-${record.status}`}>{record.status}</span>
        <strong>{formatSol(record.amount, 6)} SOL</strong>
        <small>{record.kind === 'change' ? 'PRIVATE CHANGE' : 'PRIVATE DEPOSIT'}</small>
      </div>
      <div className="note-meta">
        <span>{shortAddress(BigInt(record.commitment).toString(16), 8, 8)}</span>
        {record.transaction ? (
          <a href={explorerTransaction(record.transaction)} target="_blank" rel="noreferrer">View tx ↗</a>
        ) : null}
        {record.status === 'pending' ? (
          <button type="button" className="link-button danger-link" onClick={() => onDiscard(record)}>
            Discard local draft
          </button>
        ) : null}
      </div>
    </div>
  );
}

export default function Home() {
  const { connection } = useConnection();
  const {
    connected,
    publicKey,
    sendTransaction,
    signMessage,
    signTransaction,
  } = useWallet();
  const { setVisible } = useWalletModal();

  const [runtime, setRuntime] = useState(null);
  const [runtimeStatus, setRuntimeStatus] = useState('loading');
  const [runtimeMessage, setRuntimeMessage] = useState('Reading the current devnet deployment…');
  const [treeCount, setTreeCount] = useState(0);
  const [nullifierCount, setNullifierCount] = useState(0);
  const [publicBalance, setPublicBalance] = useState(0);

  const [vaultKey, setVaultKey] = useState(null);
  const [unlocked, setUnlocked] = useState(false);
  const [records, setRecords] = useState([]);
  const [syncing, setSyncing] = useState(false);

  const [mode, setMode] = useState('deposit');
  const [amount, setAmount] = useState('0.01');
  const [recipient, setRecipient] = useState('');
  const [busy, setBusy] = useState('');
  const [actionStage, setActionStage] = useState('');
  const [feedback, setFeedback] = useState(null);
  const [history, setHistory] = useState([]);
  const [prover, setProver] = useState({
    status: 'idle',
    progress: 0,
    message: 'Local prover has not been loaded yet.',
    bundleDigest: '',
  });

  const walletAddress = publicKey?.toBase58() || '';
  const runtimeScope = runtime ? `${runtime.programId}:${runtime.config}` : '';
  const runtimeKeys = useMemo(() => {
    if (!runtime) return null;
    try {
      return {
        programId: new PublicKey(runtime.programId),
        config: new PublicKey(runtime.config),
        commitments: new PublicKey(runtime.commitments),
        nullifiers: new PublicKey(runtime.nullifiers),
        rootHistory: new PublicKey(runtime.rootHistory),
        vault: new PublicKey(runtime.vault),
        treasury: new PublicKey(runtime.treasury),
        relayer: new PublicKey(runtime.relayer),
      };
    } catch {
      return null;
    }
  }, [runtime]);

  const privateBalance = useMemo(() => privateBalanceLamportsV1(records), [records]);
  const confirmedNotes = useMemo(() => confirmedNoteRecordsV1(records), [records]);
  const pendingNotes = useMemo(() => records.filter((record) => record.status === 'pending'), [records]);
  const amountLamports = useMemo(() => {
    try {
      return parseSol(amount);
    } catch {
      return null;
    }
  }, [amount]);
  const protocolFee = BigInt(runtime?.protocolFeeLamports || '0');
  const relayerFee = BigInt(runtime?.relayerFeeLamports || '0');
  const withdrawPreview = useMemo(() => {
    if (mode !== 'withdraw' || amountLamports === null) return null;
    try {
      const selection = selectInputPairV1(
        records,
        amountLamports + protocolFee + relayerFee,
      );
      return { selection, error: '' };
    } catch (error) {
      return { selection: null, error: friendlyError(error) };
    }
  }, [mode, amountLamports, records, protocolFee, relayerFee]);

  const handleProverProgress = useCallback((progress) => {
    const value = Number(progress?.progress);
    const stage = progress?.stage || 'loading';
    setProver((current) => ({
      ...current,
      status: stage === 'ready' || stage === 'proved' ? 'ready' : stage === 'proving' ? 'proving' : 'loading',
      progress: Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : current.progress,
      message: progress?.message || current.message,
    }));
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      setRuntimeStatus('loading');
      setRuntimeMessage('Reading the current devnet deployment…');
      try {
        const response = await fetch(RUNTIME_URL, { cache: 'no-store' });
        if (!response.ok) throw new Error(`Runtime file returned HTTP ${response.status}`);
        const parsed = validateRuntime(await response.json());
        const keys = {
          programId: new PublicKey(parsed.programId),
          config: new PublicKey(parsed.config),
          commitments: new PublicKey(parsed.commitments),
          nullifiers: new PublicKey(parsed.nullifiers),
          rootHistory: new PublicKey(parsed.rootHistory),
          vault: new PublicKey(parsed.vault),
        };
        const [genesis, accounts] = await Promise.all([
          connection.getGenesisHash(),
          connection.getMultipleAccountsInfo([
            keys.programId,
            keys.config,
            keys.commitments,
            keys.nullifiers,
            keys.rootHistory,
            keys.vault,
          ], 'confirmed'),
        ]);
        if (genesis !== parsed.genesisHash) {
          throw new Error('RPC genesis does not match the published Watcher devnet runtime');
        }
        if (!accounts[0]?.executable) throw new Error('Published Watcher program is not executable');
        for (let index = 1; index < accounts.length; index += 1) {
          const account = accounts[index];
          if (!account) throw new Error(`Published protocol account ${index} is missing`);
          if (!account.owner.equals(keys.programId)) {
            throw new Error(`Published protocol account ${index} has the wrong owner`);
          }
        }
        const registry = decodeCommitmentRegistryV1(accounts[2].data);
        if (!active) return;
        setRuntime(parsed);
        setTreeCount(registry.count);
        setRuntimeStatus('ready');
        setRuntimeMessage('Program, state accounts, and RPC genesis verified.');
      } catch (error) {
        if (!active) return;
        setRuntime(null);
        setRuntimeStatus('error');
        setRuntimeMessage(friendlyError(error));
      }
    })();
    return () => { active = false; };
  }, [connection]);

  useEffect(() => {
    setVaultKey(null);
    setUnlocked(false);
    setRecords([]);
    setFeedback(null);
    if (walletAddress) setRecipient(walletAddress);
  }, [walletAddress]);

  useEffect(() => {
    if (!walletAddress || !runtimeScope || typeof window === 'undefined') {
      setHistory([]);
      return;
    }
    try {
      const raw = window.localStorage.getItem(`watcher-history:${runtimeScope}:${walletAddress}`);
      setHistory(raw ? JSON.parse(raw) : []);
    } catch {
      setHistory([]);
    }
  }, [walletAddress, runtimeScope]);

  useEffect(() => {
    if (!publicKey) {
      setPublicBalance(0);
      return undefined;
    }
    let active = true;
    connection.getBalance(publicKey, 'confirmed')
      .then((balance) => { if (active) setPublicBalance(balance); })
      .catch(() => {});
    return () => { active = false; };
  }, [connection, publicKey]);

  const recordHistory = useCallback((entry) => {
    if (!walletAddress || !runtimeScope || typeof window === 'undefined') return;
    setHistory((current) => {
      const next = [{ ...entry, createdAt: Date.now() }, ...current].slice(0, 20);
      window.localStorage.setItem(
        `watcher-history:${runtimeScope}:${walletAddress}`,
        JSON.stringify(next),
      );
      return next;
    });
  }, [walletAddress, runtimeScope]);

  const ensureProver = useCallback(async () => {
    if (!runtime) throw new Error('Watcher runtime is not ready');
    setProver((current) => ({
      ...current,
      status: current.status === 'ready' ? 'ready' : 'loading',
      message: current.status === 'ready' ? current.message : 'Starting local browser prover…',
    }));
    try {
      const ready = await checkBrowserProverV1({
        basePath: runtime.proverBasePath || DEFAULT_PROVER_BASE,
        onProgress: handleProverProgress,
      });
      setProver({
        status: 'ready',
        progress: 1,
        message: 'Matched proving bundle is loaded in this browser.',
        bundleDigest: ready.bundleDigest,
      });
      return ready;
    } catch (error) {
      setProver({
        status: 'error',
        progress: 0,
        message: friendlyError(error),
        bundleDigest: '',
      });
      throw error;
    }
  }, [runtime, handleProverProgress]);

  const persistRecords = useCallback(async (nextRecords, keyOverride = vaultKey) => {
    if (!runtime || !publicKey || !keyOverride) throw new Error('Private note vault is locked');
    const saved = await saveNoteVaultV1({
      key: keyOverride,
      publicKey,
      scope: runtimeScope,
      records: nextRecords,
    });
    setRecords(saved);
    return saved;
  }, [runtime, publicKey, runtimeScope, vaultKey]);

  const syncPrivateState = useCallback(async ({
    recordsOverride = records,
    keyOverride = vaultKey,
    silent = false,
  } = {}) => {
    if (!runtimeKeys || !publicKey || !keyOverride) throw new Error('Private note vault is locked');
    setSyncing(true);
    if (!silent) setFeedback({ tone: 'info', text: 'Checking commitments and nullifiers on devnet…' });
    try {
      const synced = await syncNoteRecordsV1({
        connection,
        commitmentsAccount: runtimeKeys.commitments,
        nullifiersAccount: runtimeKeys.nullifiers,
        records: recordsOverride,
      });
      await persistRecords(synced.records, keyOverride);
      setTreeCount(synced.registry.count);
      setNullifierCount(synced.nullifierCount);
      const walletLamports = await connection.getBalance(publicKey, 'confirmed');
      setPublicBalance(walletLamports);
      if (!silent) setFeedback({ tone: 'success', text: 'Private balance synced from devnet state.' });
      return synced.records;
    } finally {
      setSyncing(false);
    }
  }, [connection, persistRecords, publicKey, records, runtimeKeys, vaultKey]);

  const unlockVault = useCallback(async () => {
    if (!connected || !publicKey) {
      setVisible(true);
      return;
    }
    if (runtimeStatus !== 'ready' || !runtime) {
      throw new Error(runtimeMessage || 'Watcher runtime is not ready');
    }
    if (typeof signMessage !== 'function') {
      throw new Error('This wallet does not support message signing');
    }
    setBusy('unlock');
    setActionStage('Waiting for a wallet signature…');
    setFeedback({
      tone: 'info',
      text: 'This signature only unlocks encrypted notes on this device. It is not a transaction.',
    });
    try {
      const message = new TextEncoder().encode([
        'Watcher Cash private note vault',
        'Network: Solana devnet',
        `Program: ${runtime.programId}`,
        `Config: ${runtime.config}`,
        'Signing does not authorize a transaction or move funds.',
      ].join('\n'));
      const signature = await signMessage(message);
      const key = await deriveNoteVaultKeyV1({
        signature,
        publicKey,
        scope: runtimeScope,
      });
      const stored = await loadNoteVaultV1({ key, publicKey, scope: runtimeScope });
      setVaultKey(key);
      setUnlocked(true);
      await syncPrivateState({ recordsOverride: stored, keyOverride: key, silent: true });
      setFeedback({ tone: 'success', text: 'Private note vault unlocked and synced.' });
      ensureProver().catch(() => {});
    } finally {
      setBusy('');
      setActionStage('');
    }
  }, [
    connected,
    ensureProver,
    publicKey,
    runtime,
    runtimeMessage,
    runtimeScope,
    runtimeStatus,
    setVisible,
    signMessage,
    syncPrivateState,
  ]);

  const sendWatcherInstruction = useCallback(async (descriptor) => {
    if (!publicKey || typeof sendTransaction !== 'function') throw new Error('Wallet is not connected');
    const latest = await connection.getLatestBlockhash('confirmed');
    const transaction = new Transaction({
      feePayer: publicKey,
      recentBlockhash: latest.blockhash,
    }).add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: GROTH16_COMPUTE_UNITS }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: COMPUTE_UNIT_PRICE }),
      descriptorInstruction(descriptor),
    );

    const opcode = Number(descriptor?.data?.[0] ?? -1);
    let signature;
    if (opcode === 1 && typeof signTransaction === 'function') {
      const signedTransaction = await signTransaction(transaction);
      const rawTransaction = signedTransaction.serialize();
      try {
        signature = await connection.sendRawTransaction(rawTransaction, {
          skipPreflight: false,
          preflightCommitment: 'confirmed',
          maxRetries: 40,
        });
      } catch (error) {
        const message = error?.message || String(error || '');
        if (!/unexpected|429|fetch|network|timeout|temporar/i.test(message)) throw error;
        signature = await connection.sendRawTransaction(rawTransaction, {
          skipPreflight: true,
          preflightCommitment: 'confirmed',
          maxRetries: 40,
        });
      }
    } else {
      signature = await sendTransaction(transaction, connection, {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
        maxRetries: 8,
      });
    }

    try {
      await connection.confirmTransaction({
        signature,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      }, 'confirmed');
    } catch (error) {
      const statuses = await connection.getSignatureStatuses(
        [signature],
        { searchTransactionHistory: true },
      ).catch(() => null);
      const status = statuses?.value?.[0];
      if (status?.err) {
        throw new Error(`Transaction failed on devnet: ${JSON.stringify(status.err)}`);
      }
      if (status?.confirmationStatus !== 'confirmed' && status?.confirmationStatus !== 'finalized') {
        throw error;
      }
    }
    return signature;
  }, [connection, publicKey, sendTransaction, signTransaction]);

  const browserDepositProof = useCallback((options) => (
    proveDepositWithBrowserProverV1({
      ...options,
      basePath: runtime?.proverBasePath || DEFAULT_PROVER_BASE,
      onProgress: options.onProgress || handleProverProgress,
    })
  ), [runtime, handleProverProgress]);

  const browserWithdrawProof = useCallback((options) => (
    proveWithdrawWithBrowserProverV1({
      ...options,
      basePath: runtime?.proverBasePath || DEFAULT_PROVER_BASE,
      onProgress: options.onProgress || handleProverProgress,
    })
  ), [runtime, handleProverProgress]);

  const executeDeposit = useCallback(async () => {
    if (!runtimeKeys || !runtime || !publicKey) throw new Error('Watcher runtime is not ready');
    const lamports = parseSol(amount);
    if (treeCount >= runtime.commitmentCapacity) throw new Error('The development commitment tree is full');
    setBusy('deposit');
    setFeedback(null);
    let pendingRecord;
    try {
      setActionStage('Loading the local prover…');
      await ensureProver();
      pendingRecord = createNoteRecordV1({ amount: lamports, kind: 'deposit' });
      const opening = noteRecordToInputV1(pendingRecord);
      setActionStage('Generating a private deposit proof in this browser…');
      const prepared = await prepareDepositV1({
        connection,
        accounts: {
          programId: runtimeKeys.programId,
          depositor: publicKey,
          config: runtimeKeys.config,
          commitments: runtimeKeys.commitments,
          rootHistory: runtimeKeys.rootHistory,
          vault: runtimeKeys.vault,
          systemProgram: SystemProgram.programId,
        },
        owner: opening.owner,
        nonce: opening.nonce,
        amount: opening.amount,
        proveDeposit: browserDepositProof,
        proverOptions: { onProgress: handleProverProgress },
      });
      let nextRecords = upsertNoteRecordV1(records, pendingRecord);
      await persistRecords(nextRecords);
      setActionStage('Approve the proof-bound deposit in your wallet…');
      const signature = await sendWatcherInstruction(prepared.instruction);
      nextRecords = upsertNoteRecordV1(nextRecords, { ...pendingRecord, transaction: signature });
      await persistRecords(nextRecords);
      setActionStage('Confirming the commitment on devnet…');
      await syncPrivateState({ recordsOverride: nextRecords, silent: true });
      recordHistory({ type: 'deposit', amount: lamports.toString(), signature });
      setFeedback({
        tone: 'success',
        text: `Deposited ${formatSol(lamports)} SOL into a proof-bound private note.`,
        signature,
      });
    } catch (error) {
      setFeedback({ tone: 'error', text: friendlyError(error) });
      throw error;
    } finally {
      setBusy('');
      setActionStage('');
      setProver((current) => current.status === 'error' ? current : {
        ...current,
        status: current.bundleDigest ? 'ready' : current.status,
        progress: current.bundleDigest ? 1 : current.progress,
      });
    }
  }, [
    amount,
    browserDepositProof,
    ensureProver,
    handleProverProgress,
    persistRecords,
    publicKey,
    recordHistory,
    records,
    runtime,
    runtimeKeys,
    sendWatcherInstruction,
    syncPrivateState,
    treeCount,
  ]);

  const executeWithdraw = useCallback(async () => {
    if (!runtimeKeys || !runtime || !publicKey) throw new Error('Watcher runtime is not ready');
    const publicAmount = parseSol(amount);
    let recipientKey;
    try {
      recipientKey = new PublicKey(recipient.trim());
    } catch {
      throw new Error('Recipient is not a valid Solana address');
    }
    const required = publicAmount + protocolFee + relayerFee;
    const selection = selectInputPairV1(records, required);
    if (treeCount >= runtime.commitmentCapacity) {
      throw new Error('The development tree is full and cannot append the required change note');
    }

    setBusy('withdraw');
    setFeedback(null);
    let changeRecord;
    try {
      setActionStage('Loading the local prover…');
      await ensureProver();
      changeRecord = createNoteRecordV1({
        amount: selection.changeAmount,
        kind: 'change',
      });
      const changeOpening = noteRecordToInputV1(changeRecord);
      setActionStage('Generating a private withdrawal proof in this browser…');
      const prepared = await prepareWithdrawV1({
        connection,
        accounts: {
          programId: runtimeKeys.programId,
          config: runtimeKeys.config,
          commitments: runtimeKeys.commitments,
          nullifiers: runtimeKeys.nullifiers,
          rootHistory: runtimeKeys.rootHistory,
          vault: runtimeKeys.vault,
          recipient: recipientKey,
          relayer: runtimeKeys.relayer,
          treasury: runtimeKeys.treasury,
        },
        input0: selection.inputs[0],
        input1: selection.inputs[1],
        change: changeOpening,
        publicAmount,
        protocolFee,
        relayerFee,
        proveWithdraw: browserWithdrawProof,
        proverOptions: { onProgress: handleProverProgress },
      });
      let nextRecords = upsertNoteRecordV1(records, changeRecord);
      await persistRecords(nextRecords);
      setActionStage('Approve the proof-bound withdrawal in your wallet…');
      const signature = await sendWatcherInstruction(prepared.instruction);
      nextRecords = upsertNoteRecordV1(nextRecords, { ...changeRecord, transaction: signature });
      await persistRecords(nextRecords);
      setActionStage('Confirming nullifiers and private change on devnet…');
      await syncPrivateState({ recordsOverride: nextRecords, silent: true });
      recordHistory({
        type: 'withdraw',
        amount: publicAmount.toString(),
        recipient: recipientKey.toBase58(),
        signature,
      });
      setFeedback({
        tone: 'success',
        text: `Withdrew ${formatSol(publicAmount)} SOL. ${formatSol(selection.changeAmount)} SOL returned as private change.`,
        signature,
      });
    } catch (error) {
      setFeedback({ tone: 'error', text: friendlyError(error) });
      throw error;
    } finally {
      setBusy('');
      setActionStage('');
      setProver((current) => current.status === 'error' ? current : {
        ...current,
        status: current.bundleDigest ? 'ready' : current.status,
        progress: current.bundleDigest ? 1 : current.progress,
      });
    }
  }, [
    amount,
    browserWithdrawProof,
    connection,
    ensureProver,
    handleProverProgress,
    persistRecords,
    protocolFee,
    publicKey,
    recipient,
    recordHistory,
    records,
    relayerFee,
    runtime,
    runtimeKeys,
    sendWatcherInstruction,
    syncPrivateState,
    treeCount,
  ]);

  const handlePrimaryAction = useCallback(async () => {
    setFeedback(null);
    try {
      if (!connected || !publicKey) {
        setVisible(true);
        return;
      }
      if (runtimeStatus !== 'ready') throw new Error(runtimeMessage || 'Watcher runtime is not ready');
      if (!unlocked) {
        await unlockVault();
        return;
      }
      if (mode === 'deposit') await executeDeposit();
      else await executeWithdraw();
    } catch (error) {
      if (!feedback || feedback.tone !== 'error') {
        setFeedback({ tone: 'error', text: friendlyError(error) });
      }
    }
  }, [
    connected,
    executeDeposit,
    executeWithdraw,
    feedback,
    mode,
    publicKey,
    runtimeMessage,
    runtimeStatus,
    setVisible,
    unlockVault,
    unlocked,
  ]);

  const discardPending = useCallback(async (record) => {
    if (record.status !== 'pending' || busy) return;
    try {
      const next = removeNoteRecordV1(records, record.id);
      await persistRecords(next);
      setFeedback({ tone: 'success', text: 'Local pending note draft removed.' });
    } catch (error) {
      setFeedback({ tone: 'error', text: friendlyError(error) });
    }
  }, [busy, persistRecords, records]);

  const primaryLabel = busy
    ? actionStage || 'Working…'
    : !connected
      ? 'Connect wallet'
      : !unlocked
        ? 'Unlock private notes'
        : mode === 'deposit'
          ? 'Generate proof & deposit'
          : 'Generate proof & withdraw';

  const capacity = runtime?.commitmentCapacity || 16;
  const capacityRemaining = Math.max(0, capacity - treeCount);
  const runtimeTone = runtimeStatus === 'ready' ? 'success' : runtimeStatus === 'error' ? 'error' : 'neutral';
  const proverTone = prover.status === 'ready' ? 'success' : prover.status === 'error' ? 'error' : 'neutral';

  return (
    <main className="site-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />

      <nav className="topbar">
        <Logo />
        <div className="nav-statuses">
          <StatusPill tone={runtimeTone}>{runtimeStatus === 'ready' ? 'DEVNET VERIFIED' : 'DEVNET CHECK'}</StatusPill>
          <StatusPill tone={proverTone}>{prover.status === 'ready' ? 'LOCAL PROVER READY' : 'LOCAL PROVER'}</StatusPill>
        </div>
        <WalletMultiButton className="wallet-button" />
      </nav>

      <section className="hero">
        <div className="eyebrow"><span>ZERO-KNOWLEDGE CUSTODY</span><b>SOLANA DEVNET</b></div>
        <h1>Privacy that happens<br /><em>inside your browser.</em></h1>
        <p>
          Deposit SOL into a proof-bound private note. Withdraw it later without exposing
          the note opening, owner secret, nonce, or Merkle path to a hosted prover.
        </p>
        <div className="hero-proofline">
          <div><strong>LOCAL</strong><span>Witness generation</span></div>
          <div><strong>GROTH16</strong><span>BN254 proofs</span></div>
          <div><strong>ONCHAIN</strong><span>Solana verification</span></div>
        </div>
      </section>

      <section className="runtime-banner">
        <div className={`runtime-icon runtime-${runtimeTone}`}><span /></div>
        <div>
          <strong>{runtimeMessage}</strong>
          <small>
            {runtime ? `Program ${shortAddress(runtime.programId)} · ${capacityRemaining}/${capacity} commitment slots remain` : 'Transactions stay disabled until deployment verification completes.'}
          </small>
        </div>
        {runtime ? (
          <a href={explorerAddress(runtime.programId)} target="_blank" rel="noreferrer">Inspect program ↗</a>
        ) : null}
      </section>

      <section className="vault-grid">
        <div className="vault-panel">
          <header className="panel-header">
            <div>
              <span className="panel-kicker">PRIVATE VAULT</span>
              <h2>{unlocked ? `${formatSol(privateBalance, 6)} SOL` : 'Locked'}</h2>
              <p>{unlocked ? `${confirmedNotes.length} confirmed notes · ${pendingNotes.length} pending` : 'Sign a message to decrypt notes stored on this device.'}</p>
            </div>
            <button
              type="button"
              className="refresh-button"
              disabled={!unlocked || syncing || Boolean(busy)}
              onClick={() => syncPrivateState().catch((error) => setFeedback({ tone: 'error', text: friendlyError(error) }))}
            >
              {syncing ? 'Syncing…' : 'Refresh balance'}
            </button>
          </header>

          <div className="mode-tabs" role="tablist">
            <button type="button" className={mode === 'deposit' ? 'active' : ''} onClick={() => { setMode('deposit'); setFeedback(null); }}>
              Deposit privately
            </button>
            <button type="button" className={mode === 'withdraw' ? 'active' : ''} onClick={() => { setMode('withdraw'); setFeedback(null); }}>
              Withdraw
            </button>
          </div>

          <div className="amount-card">
            <label htmlFor="amount">{mode === 'deposit' ? 'Amount to privatize' : 'Amount recipient receives'}</label>
            <div className="amount-input-row">
              <input
                id="amount"
                inputMode="decimal"
                autoComplete="off"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                placeholder="0.00"
              />
              <span>SOL</span>
            </div>
            <div className="quick-values">
              {['0.001', '0.01', '0.05', '0.1'].map((value) => (
                <button type="button" key={value} onClick={() => setAmount(value)}>{value}</button>
              ))}
            </div>
          </div>

          {mode === 'withdraw' ? (
            <div className="recipient-card">
              <label htmlFor="recipient">Recipient</label>
              <input
                id="recipient"
                value={recipient}
                onChange={(event) => setRecipient(event.target.value)}
                placeholder="Solana address"
                autoComplete="off"
              />
              <button type="button" onClick={() => walletAddress && setRecipient(walletAddress)}>Use connected wallet</button>
            </div>
          ) : null}

          {mode === 'withdraw' && withdrawPreview ? (
            <div className={`preview-card ${withdrawPreview.error ? 'preview-warning' : ''}`}>
              {withdrawPreview.error ? (
                <p>{withdrawPreview.error}</p>
              ) : (
                <>
                  <div><span>Notes consumed</span><strong>2</strong></div>
                  <div><span>Private change</span><strong>{formatSol(withdrawPreview.selection.changeAmount, 6)} SOL</strong></div>
                  <div><span>Protocol fee</span><strong>{formatSol(protocolFee)} SOL</strong></div>
                </>
              )}
            </div>
          ) : null}

          <button
            type="button"
            className="primary-action"
            disabled={Boolean(busy)}
            onClick={handlePrimaryAction}
          >
            <span>{primaryLabel}</span>
            <b>→</b>
          </button>

          {actionStage ? <div className="action-stage"><span className="spinner" />{actionStage}</div> : null}
          {feedback ? (
            <div className={`feedback feedback-${feedback.tone}`}>
              <p>{feedback.text}</p>
              {feedback.signature ? (
                <a href={explorerTransaction(feedback.signature)} target="_blank" rel="noreferrer">Open transaction ↗</a>
              ) : null}
            </div>
          ) : null}

          <div className="wallet-balance-line">
            <span>Connected wallet</span>
            <strong>{connected ? `${(publicBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL` : 'Not connected'}</strong>
          </div>
        </div>

        <aside className="side-stack">
          <div className="side-card prover-card">
            <div className="side-card-title">
              <span className="panel-kicker">BROWSER PROVER</span>
              <StatusPill tone={proverTone}>{prover.status.toUpperCase()}</StatusPill>
            </div>
            <h3>{prover.message}</h3>
            <div className="progress-track"><span style={{ width: `${Math.round(prover.progress * 100)}%` }} /></div>
            <div className="side-data-row"><span>Private witness upload</span><strong>NONE</strong></div>
            <div className="side-data-row"><span>Bundle fingerprint</span><strong>{prover.bundleDigest ? shortAddress(prover.bundleDigest, 8, 8) : '—'}</strong></div>
            <button type="button" className="secondary-action" disabled={Boolean(busy)} onClick={() => ensureProver().catch(() => {})}>
              {prover.status === 'ready' ? 'Verify prover again' : 'Load local prover'}
            </button>
          </div>

          <div className="side-card capacity-card">
            <span className="panel-kicker">DEVELOPMENT TREE</span>
            <div className="capacity-number"><strong>{treeCount}</strong><span>/ {capacity}</span></div>
            <div className="capacity-track"><span style={{ width: `${Math.min(100, (treeCount / capacity) * 100)}%` }} /></div>
            <p>Every deposit and withdrawal change appends one commitment. This V1 tree is intentionally small.</p>
            <div className="side-data-row"><span>Spent nullifiers</span><strong>{nullifierCount}</strong></div>
          </div>

          <div className="side-card security-card">
            <span className="panel-kicker">SECURITY BOUNDARY</span>
            <ul>
              <li>Owner, nonce, and Merkle paths stay in this browser.</li>
              <li>Notes are encrypted with a wallet-derived AES-GCM key.</li>
              <li>The program verifies proof-bound deposits and withdrawals.</li>
              <li>Development setup, devnet only, not independently audited.</li>
            </ul>
          </div>
        </aside>
      </section>

      <section className="records-section">
        <div className="section-heading">
          <div>
            <span className="panel-kicker">LOCAL NOTE INVENTORY</span>
            <h2>Encrypted records</h2>
          </div>
          <p>Clearing browser storage without a backup can make private notes unrecoverable.</p>
        </div>
        {!unlocked ? (
          <button type="button" className="empty-state" onClick={handlePrimaryAction}>
            <strong>Unlock private notes</strong>
            <span>Your wallet signs a deterministic message. No transaction is created.</span>
          </button>
        ) : records.length === 0 ? (
          <div className="empty-state static-empty">
            <strong>No private notes yet</strong>
            <span>Make two deposits before using the current two-input withdrawal circuit.</span>
          </div>
        ) : (
          <div className="notes-list">
            {records.slice().reverse().map((record) => (
              <NoteRow key={record.id} record={record} onDiscard={discardPending} />
            ))}
          </div>
        )}
      </section>

      <section className="history-section">
        <div className="section-heading">
          <div>
            <span className="panel-kicker">PUBLIC TRANSACTION LOG</span>
            <h2>Recent activity</h2>
          </div>
        </div>
        {history.length === 0 ? (
          <div className="history-empty">Confirmed transactions from this wallet and deployment will appear here.</div>
        ) : (
          <div className="history-list">
            {history.map((entry) => (
              <a key={`${entry.signature}:${entry.createdAt}`} href={explorerTransaction(entry.signature)} target="_blank" rel="noreferrer">
                <span className={`history-type history-${entry.type}`}>{entry.type}</span>
                <strong>{formatSol(entry.amount, 6)} SOL</strong>
                <small>{new Date(entry.createdAt).toLocaleString()}</small>
                <b>{shortAddress(entry.signature, 8, 8)} ↗</b>
              </a>
            ))}
          </div>
        )}
      </section>

      <section className="how-section">
        <div className="section-heading">
          <div>
            <span className="panel-kicker">HOW IT MOVES</span>
            <h2>Proof first. Funds second.</h2>
          </div>
        </div>
        <div className="steps-grid">
          <article><span>01</span><h3>Create a private note</h3><p>Your device generates fresh owner and nonce secrets, then derives the public commitment.</p></article>
          <article><span>02</span><h3>Prove locally</h3><p>WebAssembly builds and self-verifies a Groth16 proof without a witness API.</p></article>
          <article><span>03</span><h3>Verify on Solana</h3><p>The Watcher program checks proof, statement, root history, nullifiers, and custody invariants.</p></article>
        </div>
      </section>

      <footer>
        <Logo />
        <p>Development software on Solana devnet. Do not send mainnet SOL.</p>
        <div>
          {runtime ? <a href={explorerAddress(runtime.vault)} target="_blank" rel="noreferrer">Vault ↗</a> : null}
          <a href="https://github.com/TheTradoor/watcher-cash/tree/watcher-protocol" target="_blank" rel="noreferrer">Source ↗</a>
        </div>
      </footer>
    </main>
  );
}
