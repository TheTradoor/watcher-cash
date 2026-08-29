'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Buffer } from 'buffer';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import {
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';

import {
  appendPublicTreeCacheV2,
  checkBrowserProverV2,
  createNoteRecordV1,
  deriveNoteVaultKeyV1,
  deriveNullifierShardPdaV3,
  loadNoteVaultV1,
  noteRecordToInputV1,
  prepareDepositV3,
  prepareWithdrawV3,
  privateBalanceLamportsV1,
  proveDepositWithBrowserProverV2,
  proveWithdrawWithBrowserProverV2,
  removeNoteRecordV1,
  saveNoteVaultV1,
  selectInputsV2,
  syncNoteRecordsV3,
  upsertNoteRecordV1,
  verifyPublicTreeCacheV2,
} from '../../client/watcher/index.mjs';
import styles from '../v2/v2.module.css';

if (typeof globalThis !== 'undefined' && !globalThis.Buffer) globalThis.Buffer = Buffer;

const RUNTIME_URL = process.env.NEXT_PUBLIC_WATCHER_V3_RUNTIME_URL || '/watcher-protocol/v3-local.json';
const DEFAULT_PROVER_BASE = process.env.NEXT_PUBLIC_WATCHER_V3_PROVER_BASE || '/watcher-prover-v3';
const GROTH16_COMPUTE_UNITS = 1_400_000;
const COMPUTE_UNIT_PRICE = 1_000;

function parseSol(value) {
  const text = String(value || '').trim();
  if (!/^\d+(?:\.\d{0,9})?$/.test(text)) throw new Error('Enter a valid SOL amount with up to 9 decimals');
  const [whole, fraction = ''] = text.split('.');
  const amount = BigInt(whole) * BigInt(LAMPORTS_PER_SOL) + BigInt(fraction.padEnd(9, '0') || '0');
  if (amount <= 0n) throw new Error('Amount must be greater than zero');
  return amount;
}

function formatSol(value, digits = 9) {
  const lamports = BigInt(value || 0);
  const whole = lamports / BigInt(LAMPORTS_PER_SOL);
  let fraction = (lamports % BigInt(LAMPORTS_PER_SOL)).toString().padStart(9, '0').slice(0, digits);
  fraction = fraction.replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function short(value, left = 5, right = 5) {
  const text = String(value || '');
  if (text.length <= left + right + 3) return text;
  return `${text.slice(0, left)}…${text.slice(-right)}`;
}

function descriptorInstruction(descriptor) {
  return new TransactionInstruction({
    programId: descriptor.programId,
    keys: descriptor.keys,
    data: Buffer.from(descriptor.data),
  });
}

function validateRuntime(value) {
  const required = ['programId', 'config', 'activeTree', 'vault', 'treasury', 'genesisHash'];
  if (!value || typeof value !== 'object' || Number(value.version) !== 3) {
    throw new Error('Watcher V3 runtime configuration is invalid');
  }
  for (const name of required) {
    if (typeof value[name] !== 'string' || !value[name]) throw new Error(`Watcher V3 runtime is missing ${name}`);
  }
  const shardCount = Number(value.nullifierShardCount || 32);
  const bucketsPerShard = Number(value.nullifierBucketsPerShard || 2048);
  const shardHeaderBytes = Number(value.nullifierShardHeaderBytes || 8240);
  const recordBytes = Number(value.nullifierRecordBytes || 36);
  if (!Number.isInteger(shardCount) || shardCount !== 32) throw new Error('Watcher V3 runtime must expose 32 nullifier shards');
  if (!Number.isInteger(bucketsPerShard) || bucketsPerShard !== 2048) throw new Error('Watcher V3 runtime bucket geometry is invalid');
  if (!Number.isInteger(shardHeaderBytes) || shardHeaderBytes !== 8240) throw new Error('Watcher V3 shard header size is invalid');
  if (!Number.isInteger(recordBytes) || recordBytes !== 36) throw new Error('Watcher V3 nullifier record size is invalid');
  if (!Array.isArray(value.nullifierShards) || value.nullifierShards.length !== shardCount) {
    throw new Error('Watcher V3 runtime nullifier shard list is incomplete');
  }
  return {
    ...value,
    version: 3,
    treeDepth: Number(value.treeDepth || 16),
    treeCapacity: Number(value.treeCapacity || 65_536),
    protocolFeeLamports: String(value.protocolFeeLamports || '0'),
    relayerFeeLamports: String(value.relayerFeeLamports || '0'),
    proverBasePath: value.proverBasePath || DEFAULT_PROVER_BASE,
    nullifierShardCount: shardCount,
    nullifierBucketsPerShard: bucketsPerShard,
    nullifierShardHeaderBytes: shardHeaderBytes,
    nullifierRecordBytes: recordBytes,
  };
}

export default function WatcherV3Page() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [runtime, setRuntime] = useState(null);
  const [runtimeState, setRuntimeState] = useState('loading');
  const [runtimeMessage, setRuntimeMessage] = useState('Verifying isolated V3 runtime and packed nullifier shards…');
  const [treeState, setTreeState] = useState(null);
  const [records, setRecords] = useState([]);
  const [vaultKey, setVaultKey] = useState(null);
  const [unlocked, setUnlocked] = useState(false);
  const [mode, setMode] = useState('deposit');
  const [amount, setAmount] = useState('0.008');
  const [recipient, setRecipient] = useState('');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('Connect Phantom or another Solana wallet to use the isolated V3 browser flow.');
  const [error, setError] = useState('');
  const [prover, setProver] = useState({ status: 'idle', progress: 0, message: 'V3 uses the proven V2 browser Groth16 bundle; prover not loaded.', digest: '' });
  const [walletBalance, setWalletBalance] = useState(0n);
  const inFlightRef = useRef(false);

  const publicKey = wallet.publicKey;
  const walletAddress = publicKey?.toBase58() || '';
  const runtimeScope = runtime ? `watcher-v3:${runtime.programId}:${runtime.config}` : '';
  const keys = useMemo(() => {
    if (!runtime) return null;
    try {
      return {
        programId: new PublicKey(runtime.programId),
        config: new PublicKey(runtime.config),
        activeTree: new PublicKey(runtime.activeTree),
        vault: new PublicKey(runtime.vault),
        treasury: new PublicKey(runtime.treasury),
      };
    } catch {
      return null;
    }
  }, [runtime]);
  const privateBalance = useMemo(() => privateBalanceLamportsV1(records), [records]);
  const confirmedRecords = useMemo(() => records.filter((record) => record.status === 'confirmed'), [records]);
  const protocolFee = BigInt(runtime?.protocolFeeLamports || '0');
  const relayerFee = BigInt(runtime?.relayerFeeLamports || '0');
  const parsedAmount = useMemo(() => {
    try { return parseSol(amount); } catch { return null; }
  }, [amount]);
  const selectionPreview = useMemo(() => {
    if (mode !== 'withdraw' || !unlocked || parsedAmount === null) return null;
    try {
      return { selection: selectInputsV2(records, { publicAmount: parsedAmount, protocolFee, relayerFee }), error: '' };
    } catch (selectionError) {
      return { selection: null, error: selectionError?.message || String(selectionError) };
    }
  }, [mode, unlocked, parsedAmount, records, protocolFee, relayerFee]);

  const onProverProgress = useCallback((progress) => {
    setProver((current) => ({
      ...current,
      status: progress?.stage === 'proved' || progress?.stage === 'ready'
        ? 'ready'
        : progress?.stage === 'proving'
          ? 'proving'
          : 'loading',
      progress: Number.isFinite(Number(progress?.progress)) ? Number(progress.progress) : current.progress,
      message: progress?.message || current.message,
    }));
  }, []);

  const persistRecords = useCallback(async (nextRecords) => {
    if (!vaultKey || !publicKey || !runtimeScope) return nextRecords;
    const saved = await saveNoteVaultV1({
      key: vaultKey,
      publicKey,
      scope: runtimeScope,
      records: nextRecords,
    });
    setRecords(saved);
    return saved;
  }, [vaultKey, publicKey, runtimeScope]);

  const refreshTree = useCallback(async ({ syncNotes = true, recordsOverride = null } = {}) => {
    if (!keys || !runtimeScope) return null;
    const checked = await verifyPublicTreeCacheV2({
      connection,
      activeTree: keys.activeTree,
      scope: runtimeScope,
    });
    setTreeState(checked);
    let effectiveRecords = recordsOverride || records;
    if (syncNotes && unlocked && checked.status === 'ready') {
      const synced = await syncNoteRecordsV3({
        connection,
        programId: keys.programId,
        config: keys.config,
        tree: checked.tree,
        records: effectiveRecords,
      });
      effectiveRecords = await persistRecords(synced.records);
    }
    return { ...checked, records: effectiveRecords };
  }, [connection, keys, runtimeScope, unlocked, records, persistRecords]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        setRuntimeState('loading');
        const response = await fetch(RUNTIME_URL, { cache: 'no-store' });
        if (!response.ok) throw new Error(`V3 runtime returned HTTP ${response.status}`);
        const parsed = validateRuntime(await response.json());
        const programId = new PublicKey(parsed.programId);
        const config = new PublicKey(parsed.config);
        const activeTree = new PublicKey(parsed.activeTree);
        const vault = new PublicKey(parsed.vault);
        const shardKeys = parsed.nullifierShards.map((value, shard) => {
          const supplied = new PublicKey(value);
          const [expected] = deriveNullifierShardPdaV3({ programId, config, shard });
          if (!supplied.equals(expected)) throw new Error(`Watcher V3 shard ${shard} address is not canonical`);
          return supplied;
        });
        const [genesis, accounts] = await Promise.all([
          connection.getGenesisHash(),
          connection.getMultipleAccountsInfo([programId, config, activeTree, vault, ...shardKeys], 'confirmed'),
        ]);
        if (genesis !== parsed.genesisHash) throw new Error('RPC genesis does not match the Watcher V3 runtime');
        if (!accounts[0]?.executable) throw new Error('Watcher V3 program is not executable');
        for (let index = 1; index <= 3; index += 1) {
          if (!accounts[index] || !accounts[index].owner.equals(programId)) {
            throw new Error(`Watcher V3 state account ${index} is missing or owned by another program`);
          }
        }
        for (let shard = 0; shard < shardKeys.length; shard += 1) {
          const info = accounts[4 + shard];
          if (!info || !info.owner.equals(programId)) throw new Error(`Watcher V3 nullifier shard ${shard} is missing or owned by another program`);
          if (info.data.length < parsed.nullifierShardHeaderBytes
            || (info.data.length - parsed.nullifierShardHeaderBytes) % parsed.nullifierRecordBytes !== 0) {
            throw new Error(`Watcher V3 nullifier shard ${shard} has invalid storage geometry`);
          }
        }
        if (!active) return;
        setRuntime(parsed);
        setRuntimeState('ready');
        setRuntimeMessage('V3 program, state, all 32 packed nullifier shards, and RPC genesis verified.');
      } catch (runtimeError) {
        if (!active) return;
        setRuntime(null);
        setRuntimeState('error');
        setRuntimeMessage(runtimeError?.message || String(runtimeError));
      }
    })();
    return () => { active = false; };
  }, [connection]);

  useEffect(() => {
    setUnlocked(false);
    setVaultKey(null);
    setRecords([]);
    setError('');
    if (walletAddress) setRecipient(walletAddress);
  }, [walletAddress]);

  useEffect(() => {
    if (!publicKey) {
      setWalletBalance(0n);
      return;
    }
    let active = true;
    connection.getBalance(publicKey, 'confirmed')
      .then((value) => { if (active) setWalletBalance(BigInt(value)); })
      .catch(() => {});
    return () => { active = false; };
  }, [connection, publicKey]);

  const unlock = useCallback(async () => {
    if (!publicKey || !wallet.signMessage || !runtimeScope) throw new Error('Connect a wallet with message signing support first');
    const text = `Watcher Cash V3 private notes\n${runtimeScope}\nSign to unlock encrypted notes stored on this device.`;
    const signature = await wallet.signMessage(new TextEncoder().encode(text));
    const key = await deriveNoteVaultKeyV1({ signature, publicKey, scope: runtimeScope });
    const restored = await loadNoteVaultV1({ key, publicKey, scope: runtimeScope });
    setVaultKey(key);
    setUnlocked(true);
    setRecords(restored);
    setMessage(`Unlocked ${restored.length} encrypted V3 note record${restored.length === 1 ? '' : 's'}.`);
    return { key, restored };
  }, [publicKey, wallet, runtimeScope]);

  useEffect(() => {
    if (!keys || !runtimeScope || runtimeState !== 'ready') return;
    refreshTree({ syncNotes: false }).catch((treeError) => {
      setTreeState({ status: 'error', error: treeError?.message || String(treeError) });
    });
  }, [keys, runtimeScope, runtimeState]); // eslint-disable-line react-hooks/exhaustive-deps

  async function ensureProver() {
    const ready = await checkBrowserProverV2({
      basePath: runtime?.proverBasePath || DEFAULT_PROVER_BASE,
      onProgress: onProverProgress,
    });
    setProver({ status: 'ready', progress: 1, message: 'V3 browser prover ready. V2 circuit bundle self-verified locally.', digest: ready.bundleDigest });
    return ready;
  }

  async function sendDescriptor(descriptor) {
    if (!publicKey) throw new Error('Wallet is not connected');
    const latest = await connection.getLatestBlockhash('confirmed');
    const transaction = new Transaction({
      feePayer: publicKey,
      recentBlockhash: latest.blockhash,
    }).add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: GROTH16_COMPUTE_UNITS }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: COMPUTE_UNIT_PRICE }),
      descriptorInstruction(descriptor),
    );
    const signature = await wallet.sendTransaction(transaction, connection, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 25,
    });
    const confirmation = await connection.confirmTransaction({
      signature,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    }, 'confirmed');
    if (confirmation.value.err) throw new Error(`V3 transaction failed: ${JSON.stringify(confirmation.value.err)}`);
    return signature;
  }

  async function transact() {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setError('');
    setBusy('prepare');
    try {
      if (!wallet.connected || !publicKey) throw new Error('Connect your wallet first');
      if (runtimeState !== 'ready' || !keys) throw new Error('Watcher V3 runtime is not ready');
      if (!unlocked) {
        setBusy('unlock');
        await unlock();
        return;
      }
      setMessage('Preparing V3 transaction: syncing private note state and loading the browser prover…');
      const [current] = await Promise.all([
        refreshTree({ syncNotes: true }),
        ensureProver(),
      ]);
      if (!current || current.status !== 'ready') throw new Error(current?.error || 'V3 public tree cache is not ready');
      const sourceRecords = current.records || records;
      const value = parseSol(amount);

      if (mode === 'deposit') {
        setBusy('deposit');
        setMessage('Generating V3 deposit proof locally using the proven V2 commitment circuit…');
        const pending = createNoteRecordV1({
          amount: value,
          kind: 'deposit',
          status: 'pending',
          protocolVersion: 3,
          epoch: current.tree.epoch,
          leafIndex: current.tree.count,
        });
        const pendingRecords = upsertNoteRecordV1(sourceRecords, pending);
        await persistRecords(pendingRecords);
        const prepared = await prepareDepositV3({
          accounts: {
            programId: keys.programId,
            depositor: publicKey,
            config: keys.config,
            activeTree: keys.activeTree,
            vault: keys.vault,
          },
          tree: current.tree,
          note: noteRecordToInputV1(pending),
          proveDeposit: (options) => proveDepositWithBrowserProverV2({
            ...options,
            basePath: runtime.proverBasePath,
            onProgress: onProverProgress,
          }),
        });
        const signature = await sendDescriptor(prepared.instruction);
        appendPublicTreeCacheV2({
          scope: runtimeScope,
          epoch: current.tree.epoch,
          commitment: prepared.commitment,
        });
        const confirmed = {
          ...pending,
          status: 'confirmed',
          transaction: signature,
          confirmedAt: Date.now(),
          epoch: current.tree.epoch,
          leafIndex: prepared.append.index,
          root: prepared.append.newRoot.toString(10),
          protocolVersion: 3,
        };
        const finalRecords = await persistRecords(upsertNoteRecordV1(pendingRecords, confirmed));
        await refreshTree({ syncNotes: true, recordsOverride: finalRecords });
        setMessage(`Deposited ${formatSol(value)} SOL into a V3 private note.`);
      } else {
        setBusy('withdraw');
        if (!recipient) throw new Error('Enter a withdrawal recipient');
        const recipientKey = new PublicKey(recipient);
        const selection = selectInputsV2(sourceRecords, { publicAmount: value, protocolFee, relayerFee });
        const changeRecord = selection.hasChange
          ? createNoteRecordV1({
              amount: selection.changeAmount,
              kind: 'change',
              status: 'pending',
              protocolVersion: 3,
              epoch: current.tree.epoch,
              leafIndex: current.tree.count,
            })
          : null;
        if (changeRecord) await persistRecords(upsertNoteRecordV1(sourceRecords, changeRecord));
        setMessage(`Generating V3 ${selection.inputCount}-input withdrawal proof locally…`);
        const prepared = await prepareWithdrawV3({
          accounts: {
            programId: keys.programId,
            config: keys.config,
            activeTree: keys.activeTree,
            vault: keys.vault,
            recipient: recipientKey,
            relayer: publicKey,
            treasury: keys.treasury,
          },
          tree: current.tree,
          selection,
          change: changeRecord ? noteRecordToInputV1(changeRecord) : null,
          publicAmount: value,
          protocolFee,
          relayerFee,
          proveWithdraw: (options) => proveWithdrawWithBrowserProverV2({
            ...options,
            basePath: runtime.proverBasePath,
            onProgress: onProverProgress,
          }),
        });
        const signature = await sendDescriptor(prepared.instruction);
        let nextRecords = sourceRecords;
        for (const spent of selection.records) {
          nextRecords = upsertNoteRecordV1(nextRecords, {
            ...spent,
            status: 'spent',
            spentAt: Date.now(),
            spentTransaction: signature,
            protocolVersion: 3,
          });
        }
        if (prepared.changeNote && changeRecord) {
          appendPublicTreeCacheV2({
            scope: runtimeScope,
            epoch: current.tree.epoch,
            commitment: prepared.changeNote.commitment,
          });
          nextRecords = upsertNoteRecordV1(nextRecords, {
            ...changeRecord,
            status: 'confirmed',
            transaction: signature,
            confirmedAt: Date.now(),
            root: prepared.append.newRoot.toString(10),
            protocolVersion: 3,
          });
        }
        const finalRecords = await persistRecords(nextRecords);
        await refreshTree({ syncNotes: true, recordsOverride: finalRecords });
        setMessage(prepared.changeNote
          ? `Withdrew ${formatSol(value)} SOL using ${selection.inputCount} private note${selection.inputCount === 1 ? '' : 's'}. ${formatSol(selection.changeAmount)} SOL returned as private change.`
          : `Withdrew ${formatSol(value)} SOL exactly using ${selection.inputCount} private note${selection.inputCount === 1 ? '' : 's'}. No change note was created.`);
      }
      const balance = await connection.getBalance(publicKey, 'confirmed');
      setWalletBalance(BigInt(balance));
    } catch (transactionError) {
      setError(transactionError?.message || String(transactionError));
    } finally {
      inFlightRef.current = false;
      setBusy('');
    }
  }

  async function discardPending(record) {
    if (record.status !== 'pending') return;
    await persistRecords(removeNoteRecordV1(records, record.id));
  }

  const treeReady = treeState?.status === 'ready';
  const primaryLabel = !wallet.connected
    ? 'Connect wallet above'
    : !unlocked
      ? 'Unlock V3 private notes'
      : mode === 'deposit'
        ? 'Generate proof & deposit'
        : selectionPreview?.selection
          ? `Withdraw with ${selectionPreview.selection.inputCount} note${selectionPreview.selection.inputCount === 1 ? '' : 's'}`
          : 'Generate proof & withdraw';

  return (
    <main className={styles.shell} data-watcher-v3="true">
      <header className={styles.header}>
        <a className={styles.brand} href="/">WATCHER <span>CASH</span></a>
        <div className={styles.headerActions}>
          <span className={styles.version}>PROTOCOL V3 · ISOLATED</span>
          <WalletMultiButton />
        </div>
      </header>

      <section className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>BROWSER-LOCAL GROTH16 · PACKED NULLIFIERS · SOLANA</p>
          <h1>Watcher Protocol <span>V3</span></h1>
          <p>V2 proof-bound commitments and depth-16 tree, with exact full-width nullifiers stored in packed deterministic shards instead of one PDA per spend.</p>
        </div>
        <div className={styles.runtimeCard}>
          <strong>{runtimeState === 'ready' ? 'RUNTIME VERIFIED' : runtimeState.toUpperCase()}</strong>
          <span>{runtimeMessage}</span>
          {runtime ? <small>{short(runtime.programId, 8, 8)} · {runtime.nullifierShardCount} shards</small> : null}
        </div>
      </section>

      <section className={styles.grid}>
        <div className={styles.panel}>
          <div className={styles.balanceRow}>
            <div><small>PUBLIC WALLET</small><strong>{formatSol(walletBalance, 6)} SOL</strong></div>
            <div><small>PRIVATE BALANCE</small><strong data-v3-private-balance>{unlocked ? `${formatSol(privateBalance, 6)} SOL` : 'LOCKED'}</strong></div>
          </div>

          <div className={styles.tabs}>
            <button type="button" data-v3-tab="deposit" className={mode === 'deposit' ? styles.activeTab : ''} onClick={() => setMode('deposit')}>Deposit</button>
            <button type="button" data-v3-tab="withdraw" className={mode === 'withdraw' ? styles.activeTab : ''} onClick={() => setMode('withdraw')}>Withdraw</button>
          </div>

          {!unlocked ? (
            <div className={styles.gate}>
              <strong>Unlock encrypted V3 notes</strong>
              <p>Phantom message signing derives a local encryption key. Private note openings and Groth16 witnesses remain in this browser.</p>
            </div>
          ) : (
            <>
              <label className={styles.field}>
                <span>{mode === 'deposit' ? 'Deposit amount' : 'Public withdrawal'}</span>
                <div><input data-v3-amount value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" /><b>SOL</b></div>
              </label>
              {mode === 'withdraw' ? (
                <label className={styles.field}>
                  <span>Recipient</span>
                  <div><input data-v3-recipient value={recipient} onChange={(event) => setRecipient(event.target.value)} /><button type="button" onClick={() => setRecipient(walletAddress)}>ME</button></div>
                </label>
              ) : null}
              {mode === 'withdraw' && selectionPreview ? (
                <div className={selectionPreview.error ? styles.warning : styles.preview} data-v3-selection>
                  {selectionPreview.error ? selectionPreview.error : (
                    <>
                      <strong>{selectionPreview.selection.inputCount} private input{selectionPreview.selection.inputCount === 1 ? '' : 's'}</strong>
                      <span>{selectionPreview.selection.hasChange ? `${formatSol(selectionPreview.selection.changeAmount, 6)} SOL private change` : 'Exact withdrawal · no change leaf'}</span>
                    </>
                  )}
                </div>
              ) : null}
            </>
          )}

          <button
            type="button"
            className={styles.primary}
            data-v3-primary
            data-v3-busy={busy || 'idle'}
            onClick={transact}
            disabled={Boolean(busy) || runtimeState !== 'ready' || (unlocked && !treeReady)}
          >
            {busy ? 'WORKING…' : primaryLabel}
          </button>
          {message ? <p className={styles.message} data-v3-message>{message}</p> : null}
          {error ? <p className={styles.error} data-v3-error="true">{error}</p> : null}
        </div>

        <div className={styles.panel}>
          <div className={styles.sectionHead}><div><small>V3 PUBLIC TREE</small><strong data-v3-tree-index>{treeState?.chain ? `${treeState.chain.nextIndex} / ${runtime?.treeCapacity || 65_536}` : '—'}</strong></div><button type="button" onClick={() => refreshTree({ syncNotes: true }).catch((refreshError) => setError(refreshError.message))}>Refresh</button></div>
          <div className={styles.statusLine} data-tree-status={treeState?.status || 'loading'}>
            <i />
            <span>{treeState?.status === 'ready' ? `Epoch ${treeState.chain.epoch.toString()} · local commitment history matches on-chain root` : treeState?.error || 'Checking V3 public tree cache…'}</span>
          </div>
          <div className={styles.proverCard} data-v3-prover={prover.status}>
            <small>V3 BROWSER PROVER</small>
            <strong>{prover.status.toUpperCase()}</strong>
            <span>{prover.message}</span>
            {prover.digest ? <code>{short(prover.digest, 10, 10)}</code> : null}
            <div className={styles.progress}><span style={{ width: `${Math.max(0, Math.min(1, prover.progress)) * 100}%` }} /></div>
          </div>
          <div className={styles.preview} data-v3-nullifier-geometry>
            <strong>{runtime?.nullifierShardCount || 32} packed shards · {(runtime?.nullifierShardCount || 32) * (runtime?.nullifierBucketsPerShard || 2048)} buckets</strong>
            <span>{runtime?.nullifierRecordBytes || 36} bytes marginal storage per exact spent nullifier</span>
          </div>
        </div>
      </section>

      <section className={styles.notes}>
        <div className={styles.sectionHead}><div><small>ENCRYPTED V3 NOTES</small><strong>{unlocked ? `${confirmedRecords.length} spendable` : 'Locked'}</strong></div></div>
        {!unlocked ? <p>Unlock the private vault to inspect note state.</p> : records.length === 0 ? <p>No V3 private notes stored on this device yet.</p> : (
          <div className={styles.noteList}>
            {records.map((record) => (
              <div className={styles.note} key={record.id} data-note-status={record.status}>
                <div><b>{formatSol(BigInt(record.amount), 6)} SOL</b><span>{record.kind === 'change' ? 'PRIVATE CHANGE' : 'PRIVATE DEPOSIT'}</span></div>
                <div><strong>{record.status.toUpperCase()}</strong><span>epoch {record.epoch ?? '—'} · leaf {record.leafIndex ?? '—'}</span></div>
                {record.status === 'pending' ? <button type="button" onClick={() => discardPending(record)}>Discard draft</button> : null}
              </div>
            ))}
          </div>
        )}
      </section>

      <footer className={styles.footer}>DEVELOPMENT · NOT AUDITED · V3 ISOLATED · V2 PUBLIC DEVNET UNCHANGED</footer>
    </main>
  );
}
