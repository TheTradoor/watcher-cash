import fs from 'node:fs';
import path from 'node:path';

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';

import {
  ACTIVE_TREE_ACCOUNT_LEN_V2,
  buildInitializeInstructionV2,
  deriveWatcherVaultPdaV2,
  fetchActiveTreeV2,
} from '../client/watcher/index.mjs';
import { CONFIG_ACCOUNT_LEN_V1 } from '../client/watcher/instructions.mjs';

const rpcUrl = process.env.WATCHER_V2_RPC_URL || 'http://127.0.0.1:8899';
const programIdText = process.env.WATCHER_V2_PROGRAM_ID;
const payerPath = process.env.WATCHER_V2_PAYER_KEYPAIR;
const runtimeOut = process.env.WATCHER_V2_RUNTIME_OUT || '';
const proverBasePath = process.env.WATCHER_V2_PROVER_BASE_PATH || '/watcher-prover-v2';
if (!programIdText) throw new Error('WATCHER_V2_PROGRAM_ID is required');
if (!payerPath) throw new Error('WATCHER_V2_PAYER_KEYPAIR is required');

const connection = new Connection(rpcUrl, 'confirmed');
const programId = new PublicKey(programIdText);
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(payerPath, 'utf8'))));
const treasury = process.env.WATCHER_V2_TREASURY
  ? new PublicKey(process.env.WATCHER_V2_TREASURY)
  : payer.publicKey;

function descriptorInstruction(descriptor) {
  return new TransactionInstruction({
    programId: descriptor.programId,
    keys: descriptor.keys,
    data: Buffer.from(descriptor.data),
  });
}

async function main() {
  const programInfo = await connection.getAccountInfo(programId, 'confirmed');
  if (!programInfo?.executable) throw new Error('Watcher V2 program is not deployed or executable');

  const config = Keypair.generate();
  const activeTree = Keypair.generate();
  const [vault] = deriveWatcherVaultPdaV2({ programId, config: config.publicKey });
  const [configRent, activeTreeRent] = await Promise.all([
    connection.getMinimumBalanceForRentExemption(CONFIG_ACCOUNT_LEN_V1),
    connection.getMinimumBalanceForRentExemption(ACTIVE_TREE_ACCOUNT_LEN_V2),
  ]);

  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: config.publicKey,
        lamports: configRent,
        space: CONFIG_ACCOUNT_LEN_V1,
        programId,
      }),
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: activeTree.publicKey,
        lamports: activeTreeRent,
        space: ACTIVE_TREE_ACCOUNT_LEN_V2,
        programId,
      }),
    ),
    [payer, config, activeTree],
    { commitment: 'confirmed' },
  );

  const initialize = buildInitializeInstructionV2({
    programId,
    authority: payer.publicKey,
    config: config.publicKey,
    activeTree: activeTree.publicKey,
    vault,
    treasury,
  });
  const initializeSignature = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(descriptorInstruction(initialize)),
    [payer],
    { commitment: 'confirmed' },
  );

  const [genesisHash, activeState, vaultInfo, configInfo] = await Promise.all([
    connection.getGenesisHash(),
    fetchActiveTreeV2({ connection, activeTree: activeTree.publicKey }),
    connection.getAccountInfo(vault, 'confirmed'),
    connection.getAccountInfo(config.publicKey, 'confirmed'),
  ]);
  if (!vaultInfo || !vaultInfo.owner.equals(programId)) throw new Error('V2 vault was not created under the program');
  if (!configInfo || !configInfo.owner.equals(programId)) throw new Error('V2 config ownership mismatch');
  if (activeState.nextIndex !== 0 || activeState.currentRoot !== 0n || activeState.epoch !== 0n) {
    throw new Error('fresh V2 active tree did not initialize empty');
  }

  const runtime = {
    version: 2,
    network: process.env.WATCHER_V2_NETWORK || 'localnet',
    rpcUrl,
    genesisHash,
    programId: programId.toBase58(),
    config: config.publicKey.toBase58(),
    activeTree: activeTree.publicKey.toBase58(),
    vault: vault.toBase58(),
    treasury: treasury.toBase58(),
    treeDepth: 16,
    treeCapacity: 65_536,
    protocolFeeLamports: '0',
    relayerFeeLamports: process.env.WATCHER_V2_RELAYER_FEE_LAMPORTS || '0',
    proverBasePath,
    initializeSignature,
    createdAt: new Date().toISOString(),
    warning: 'DEVELOPMENT / NOT AUDITED / V2 ISOLATED',
  };

  if (runtimeOut) {
    fs.mkdirSync(path.dirname(runtimeOut), { recursive: true });
    fs.writeFileSync(runtimeOut, `${JSON.stringify(runtime, null, 2)}\n`, { mode: 0o644 });
  }
  process.stdout.write(`${JSON.stringify(runtime, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
