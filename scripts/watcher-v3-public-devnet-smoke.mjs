#!/usr/bin/env node

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';

import {
  NULLIFIER_RECORD_BYTES_V3,
  buildSparseMerkleTreeV2,
  createNoteRecordV1,
  fetchActiveTreeV2,
  prepareDepositV3,
  prepareWithdrawV3,
  selectInputsV2,
  syncNoteRecordsV3,
} from '../client/watcher/index.mjs';

const runtimePath = process.env.WATCHER_V3_RUNTIME || 'public/watcher-protocol/v3-devnet.json';
const payerPath = process.env.WATCHER_V3_PAYER_KEYPAIR;
const proverPath = process.env.WATCHER_V3_PROVER || '/tmp/watcher-v3-prover';
const bundlePath = process.env.WATCHER_V3_BUNDLE || 'public/watcher-prover-v2/assets';
const amount = BigInt(process.env.WATCHER_V3_SMOKE_AMOUNT_LAMPORTS || '1000000');

if (!payerPath) throw new Error('WATCHER_V3_PAYER_KEYPAIR is required');
if (amount < 100_000n || amount > 10_000_000n) {
  throw new Error('WATCHER_V3_SMOKE_AMOUNT_LAMPORTS must be between 100000 and 10000000');
}

function readJson(path, label) {
  if (!fs.existsSync(path)) throw new Error(`${label} was not found: ${path}`);
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

function descriptorInstruction(descriptor) {
  return new TransactionInstruction({
    programId: descriptor.programId,
    keys: descriptor.keys,
    data: Buffer.from(descriptor.data),
  });
}

function u64le(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 8).getBigUint64(0, true);
}

function prove(circuit, witness, expectedPublicInputs) {
  const result = spawnSync(
    proverPath,
    ['--bundle', bundlePath, '--circuit', circuit],
    { input: JSON.stringify(witness), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(`V3 public-devnet ${circuit} prover failed: ${result.stderr || result.stdout}`);
  }
  const parsed = JSON.parse(result.stdout);
  if (parsed.proofBytes !== 256 || !/^[0-9a-f]{512}$/i.test(parsed.proofHex || '')) {
    throw new Error(`V3 public-devnet ${circuit} prover returned an invalid proof`);
  }
  return {
    proof: Uint8Array.from(Buffer.from(parsed.proofHex, 'hex')),
    publicInputs: expectedPublicInputs,
    bundleDigest: 'pinned-v2-v3-public-devnet-smoke',
  };
}

async function send(connection, payer, descriptor) {
  const transaction = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }),
    descriptorInstruction(descriptor),
  );
  return sendAndConfirmTransaction(connection, transaction, [payer], {
    commitment: 'confirmed',
    skipPreflight: false,
  });
}

async function main() {
  const runtime = readJson(runtimePath, 'V3 runtime');
  if (Number(runtime.version) !== 3 || runtime.network !== 'devnet' || runtime.status !== 'ready') {
    throw new Error('V3 public-devnet smoke requires a ready devnet runtime');
  }

  const payer = Keypair.fromSecretKey(Uint8Array.from(readJson(payerPath, 'V3 payer keypair')));
  const connection = new Connection(runtime.rpcUrl || 'https://api.devnet.solana.com', 'confirmed');
  const programId = new PublicKey(runtime.programId);
  const config = new PublicKey(runtime.config);
  const activeTree = new PublicKey(runtime.activeTree);
  const vault = new PublicKey(runtime.vault);
  const treasury = new PublicKey(runtime.treasury);

  const [genesisHash, programInfo, treeBefore, vaultBefore] = await Promise.all([
    connection.getGenesisHash(),
    connection.getAccountInfo(programId, 'confirmed'),
    fetchActiveTreeV2({ connection, activeTree }),
    connection.getAccountInfo(vault, 'confirmed'),
  ]);
  if (genesisHash !== runtime.genesisHash) throw new Error('V3 smoke RPC genesis does not match runtime');
  if (!programInfo?.executable) throw new Error('V3 smoke program is not executable');
  if (!vaultBefore || !vaultBefore.owner.equals(programId)) throw new Error('V3 smoke vault is missing');
  if (treeBefore.nextIndex !== 0 || treeBefore.currentRoot !== 0n) {
    throw new Error('V3 first-deployment smoke only runs against a fresh empty persistent tree');
  }
  if (u64le(vaultBefore.data, 42) !== 0n) throw new Error('V3 fresh runtime already has private liability');

  const tree = buildSparseMerkleTreeV2([], { epoch: Number(treeBefore.epoch) });
  const note = { assetId: 1n, amount, owner: 777_001n, nonce: 888_002n };
  const deposit = await prepareDepositV3({
    accounts: {
      programId,
      depositor: payer.publicKey,
      config,
      activeTree,
      vault,
    },
    tree,
    note,
    proveDeposit: ({ witness, expectedPublicInputs }) => prove('deposit', witness, expectedPublicInputs),
  });

  const depositSignature = await send(connection, payer, deposit.instruction);
  const [treeAfterDeposit, vaultAfterDeposit] = await Promise.all([
    fetchActiveTreeV2({ connection, activeTree }),
    connection.getAccountInfo(vault, 'confirmed'),
  ]);
  if (treeAfterDeposit.nextIndex !== 1 || treeAfterDeposit.currentRoot !== deposit.append.newRoot) {
    throw new Error('V3 public-devnet deposit did not commit the expected tree transition');
  }
  if (!vaultAfterDeposit || u64le(vaultAfterDeposit.data, 42) !== amount) {
    throw new Error('V3 public-devnet deposit did not create the expected vault liability');
  }

  const record = createNoteRecordV1({
    assetId: 1n,
    amount,
    owner: note.owner,
    nonce: note.nonce,
    kind: 'deposit',
    status: 'confirmed',
    protocolVersion: 3,
    epoch: Number(treeBefore.epoch),
    leafIndex: 0,
    root: deposit.append.newRoot.toString(10),
  });
  const selection = selectInputsV2([record], { publicAmount: amount });
  const withdrawal = await prepareWithdrawV3({
    accounts: {
      programId,
      config,
      activeTree,
      vault,
      recipient: payer.publicKey,
      relayer: payer.publicKey,
      treasury,
    },
    tree: deposit.append.tree,
    selection,
    publicAmount: amount,
    proveWithdraw: ({ witness, expectedPublicInputs }) => prove('withdraw', witness, expectedPublicInputs),
  });
  if (withdrawal.shardAccounts.length !== 1) throw new Error('V3 one-note smoke did not route exactly one shard');

  const shard = withdrawal.shardAccounts[0];
  const shardBefore = await connection.getAccountInfo(shard, 'confirmed');
  if (!shardBefore || !shardBefore.owner.equals(programId)) throw new Error('V3 routed shard is missing before withdrawal');
  const shardLengthBefore = shardBefore.data.length;
  const withdrawSignature = await send(connection, payer, withdrawal.instruction);

  const [treeAfterWithdraw, vaultAfterWithdraw, shardAfter] = await Promise.all([
    fetchActiveTreeV2({ connection, activeTree }),
    connection.getAccountInfo(vault, 'confirmed'),
    connection.getAccountInfo(shard, 'confirmed'),
  ]);
  if (treeAfterWithdraw.nextIndex !== 1 || treeAfterWithdraw.currentRoot !== deposit.append.newRoot) {
    throw new Error('V3 exact withdrawal mutated the persistent tree');
  }
  if (!vaultAfterWithdraw || u64le(vaultAfterWithdraw.data, 42) !== 0n) {
    throw new Error('V3 exact withdrawal did not return persistent liability to zero');
  }
  if (!shardAfter || shardAfter.data.length - shardLengthBefore !== NULLIFIER_RECORD_BYTES_V3) {
    throw new Error('V3 public-devnet shard did not grow by exactly one 36-byte nullifier record');
  }

  const synced = await syncNoteRecordsV3({
    connection,
    programId,
    config,
    tree: deposit.append.tree,
    records: [record],
  });
  if (synced.spentCount !== 1 || synced.records[0]?.status !== 'spent') {
    throw new Error('V3 packed-shard sync did not detect the spent smoke note');
  }

  let replayRejected = false;
  try {
    await send(connection, payer, withdrawal.instruction);
  } catch {
    replayRejected = true;
  }
  if (!replayRejected) throw new Error('V3 public-devnet replay was not rejected');

  const legacyMarkers = await connection.getProgramAccounts(programId, {
    commitment: 'confirmed',
    filters: [{ dataSize: 0 }],
  });
  if (legacyMarkers.length !== 0) throw new Error('V3 public-devnet smoke created a legacy V2 zero-data marker account');

  process.stdout.write(`${JSON.stringify({
    status: 'pass',
    network: 'devnet',
    programId: programId.toBase58(),
    config: config.toBase58(),
    activeTree: activeTree.toBase58(),
    vault: vault.toBase58(),
    depositSignature,
    withdrawSignature,
    amountLamports: amount.toString(),
    nextIndex: treeAfterWithdraw.nextIndex,
    trackedBalance: u64le(vaultAfterWithdraw.data, 42).toString(),
    shard: shard.toBase58(),
    shardGrowthBytes: shardAfter.data.length - shardLengthBefore,
    replayRejected,
    legacyV2MarkerAccounts: legacyMarkers.length,
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
