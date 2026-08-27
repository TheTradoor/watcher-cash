#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  COMMITMENT_REGISTRY_LEN_V1,
  CONFIG_ACCOUNT_LEN_V1,
  NULLIFIER_REGISTRY_LEN_V1,
  ROOT_HISTORY_ACCOUNT_LEN_V1,
  VAULT_ACCOUNT_LEN_V1,
  buildInitializeInstructionV1,
  deriveVaultAddressV1,
} from '../client/watcher/index.mjs';

const DEFAULT_RPC = 'https://api.devnet.solana.com';

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function loadKeypair(path) {
  const raw = JSON.parse(await readFile(path, 'utf8'));
  if (!Array.isArray(raw) || raw.length !== 64) {
    throw new Error(`${path} must contain a Solana 64-byte keypair JSON array`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function transactionInstruction(descriptor) {
  return new TransactionInstruction({
    programId: descriptor.programId,
    keys: descriptor.keys,
    data: Buffer.from(descriptor.data),
  });
}

async function send(connection, payer, instructions, signers = []) {
  const price = Number(process.env.WATCHER_COMPUTE_UNIT_PRICE_MICROLAMPORTS || 1000);
  const transaction = new Transaction();
  if (Number.isSafeInteger(price) && price > 0) {
    transaction.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }));
  }
  transaction.add(...instructions);
  return sendAndConfirmTransaction(
    connection,
    transaction,
    [payer, ...signers],
    { commitment: 'confirmed', preflightCommitment: 'confirmed', maxRetries: 8 },
  );
}

async function main() {
  const rpcUrl = String(process.env.WATCHER_RPC_URL || DEFAULT_RPC).trim();
  const outputPath = resolve(process.env.WATCHER_RUNTIME_OUT || 'public/watcher-protocol/devnet.json');
  const publicBasePath = String(process.env.WATCHER_PUBLIC_BASE_PATH || '').replace(/\/+$/, '');
  const payer = await loadKeypair(required('WATCHER_PAYER_KEYPAIR'));
  const programId = new PublicKey(required('WATCHER_PROGRAM_ID'));
  const connection = new Connection(rpcUrl, 'confirmed');
  const genesisHash = await connection.getGenesisHash();

  const program = await connection.getAccountInfo(programId, 'confirmed');
  if (!program?.executable) {
    throw new Error(`Watcher program ${programId.toBase58()} is not executable on ${rpcUrl}`);
  }

  const config = Keypair.generate();
  const commitments = Keypair.generate();
  const nullifiers = Keypair.generate();
  const rootHistory = Keypair.generate();
  const treasury = Keypair.generate();
  const relayer = Keypair.generate();
  const { vault } = deriveVaultAddressV1({
    programId,
    config: config.publicKey,
    findProgramAddressSync: PublicKey.findProgramAddressSync,
  });

  const protocolAccounts = [
    [config, CONFIG_ACCOUNT_LEN_V1],
    [commitments, COMMITMENT_REGISTRY_LEN_V1],
    [nullifiers, NULLIFIER_REGISTRY_LEN_V1],
    [rootHistory, ROOT_HISTORY_ACCOUNT_LEN_V1],
  ];
  const rents = await Promise.all(
    protocolAccounts.map(([, space]) => connection.getMinimumBalanceForRentExemption(space)),
  );
  const createInstructions = protocolAccounts.map(([account, space], index) => (
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: account.publicKey,
      lamports: rents[index],
      space,
      programId,
    })
  ));
  const createSignature = await send(
    connection,
    payer,
    createInstructions,
    protocolAccounts.map(([account]) => account),
  );

  const payoutRent = await connection.getMinimumBalanceForRentExemption(0);
  const payoutSignature = await send(connection, payer, [treasury, relayer].map((account) => (
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: account.publicKey,
      lamports: payoutRent,
    })
  )));

  const initialize = buildInitializeInstructionV1({
    programId,
    authority: payer.publicKey,
    config: config.publicKey,
    commitments: commitments.publicKey,
    nullifiers: nullifiers.publicKey,
    rootHistory: rootHistory.publicKey,
    vault,
    treasury: treasury.publicKey,
    systemProgram: SystemProgram.programId,
  });
  const initializeSignature = await send(
    connection,
    payer,
    [transactionInstruction(initialize)],
  );

  const infos = await connection.getMultipleAccountsInfo([
    config.publicKey,
    commitments.publicKey,
    nullifiers.publicKey,
    rootHistory.publicKey,
    vault,
    treasury.publicKey,
    relayer.publicKey,
  ], 'confirmed');
  const expectedLengths = [
    CONFIG_ACCOUNT_LEN_V1,
    COMMITMENT_REGISTRY_LEN_V1,
    NULLIFIER_REGISTRY_LEN_V1,
    ROOT_HISTORY_ACCOUNT_LEN_V1,
    VAULT_ACCOUNT_LEN_V1,
    0,
    0,
  ];
  infos.forEach((info, index) => {
    if (!info) throw new Error(`runtime account ${index} was not created`);
    if (info.data.length !== expectedLengths[index]) {
      throw new Error(`runtime account ${index} has ${info.data.length} bytes; expected ${expectedLengths[index]}`);
    }
  });

  const runtime = {
    version: 1,
    cluster: 'devnet',
    rpcUrl,
    genesisHash,
    programId: programId.toBase58(),
    config: config.publicKey.toBase58(),
    commitments: commitments.publicKey.toBase58(),
    nullifiers: nullifiers.publicKey.toBase58(),
    rootHistory: rootHistory.publicKey.toBase58(),
    vault: vault.toBase58(),
    treasury: treasury.publicKey.toBase58(),
    relayer: relayer.publicKey.toBase58(),
    assetId: '1',
    protocolFeeLamports: '0',
    relayerFeeLamports: '0',
    commitmentCapacity: 16,
    proverBasePath: `${publicBasePath}/watcher-prover`,
    createdAt: new Date().toISOString(),
    transactions: {
      createProtocolAccounts: createSignature,
      fundPayoutAccounts: payoutSignature,
      initialize: initializeSignature,
    },
    warning: 'DEVELOPMENT DEVNET DEPLOYMENT. Do not use mainnet funds.',
  };

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(runtime, null, 2)}\n`, { mode: 0o644 });
  console.log(JSON.stringify(runtime, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
