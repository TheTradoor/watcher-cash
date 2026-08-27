#!/usr/bin/env node

import { readFile, writeFile, chmod } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
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
  checkLocalProverV1,
  deriveVaultAddressV1,
  fieldFromLe32,
  prepareDepositV1,
  prepareWithdrawV1,
} from '../client/watcher/index.mjs';

const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const GROTH16_COMPUTE_UNITS_V1 = 1_400_000;
const rpcURL = process.env.WATCHER_DEVNET_RPC || 'https://api.devnet.solana.com';
const proverEndpoint = process.env.WATCHER_PROVER_URL || 'http://127.0.0.1:8090';
const recoveryPath = process.env.WATCHER_RECOVERY_FILE || '.watcher-devnet-recovery.json';

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

function randomField() {
  while (true) {
    const bytes = new Uint8Array(randomBytes(32));
    bytes[31] &= 0x1f;
    const value = fieldFromLe32(bytes, 'random note secret');
    if (value !== 0n) return value;
  }
}

function transactionInstruction(descriptor) {
  return new TransactionInstruction({
    programId: descriptor.programId,
    keys: descriptor.keys,
    data: Buffer.from(descriptor.data),
  });
}

function groth16ComputeBudgetInstruction() {
  return ComputeBudgetProgram.setComputeUnitLimit({ units: GROTH16_COMPUTE_UNITS_V1 });
}

async function send(connection, payer, instructions, extraSigners = []) {
  const transaction = new Transaction().add(...instructions);
  return sendAndConfirmTransaction(
    connection,
    transaction,
    [payer, ...extraSigners],
    { commitment: 'confirmed', preflightCommitment: 'confirmed' },
  );
}

function accountSnapshot(accounts) {
  return Object.fromEntries(
    Object.entries(accounts).map(([name, value]) => [name, value.toBase58()]),
  );
}

async function writeRecovery(value) {
  await writeFile(recoveryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(recoveryPath, 0o600);
}

async function main() {
  const programId = new PublicKey(required('WATCHER_PROGRAM_ID'));
  const payer = await loadKeypair(required('WATCHER_PAYER_KEYPAIR'));
  const connection = new Connection(rpcURL, 'confirmed');

  const genesis = await connection.getGenesisHash();
  if (genesis === MAINNET_GENESIS && process.env.WATCHER_ALLOW_MAINNET !== '1') {
    throw new Error('refusing to run the development E2E against Solana Mainnet');
  }
  const programAccount = await connection.getAccountInfo(programId, 'confirmed');
  if (!programAccount?.executable) {
    throw new Error(`Watcher program ${programId.toBase58()} is not deployed and executable on this cluster`);
  }
  const prover = await checkLocalProverV1({ endpoint: proverEndpoint });
  console.log(`Local prover ready: ${prover.bundleDigest}`);

  const config = Keypair.generate();
  const commitments = Keypair.generate();
  const nullifiers = Keypair.generate();
  const rootHistory = Keypair.generate();
  const treasury = Keypair.generate();
  const relayer = Keypair.generate();
  const recipient = Keypair.generate();
  const { vault, bump } = deriveVaultAddressV1({
    programId,
    config: config.publicKey,
    findProgramAddressSync: PublicKey.findProgramAddressSync,
  });

  const accountKeys = {
    programId,
    payer: payer.publicKey,
    config: config.publicKey,
    commitments: commitments.publicKey,
    nullifiers: nullifiers.publicKey,
    rootHistory: rootHistory.publicKey,
    vault,
    treasury: treasury.publicKey,
    relayer: relayer.publicKey,
    recipient: recipient.publicKey,
  };

  const input0 = { amount: 8_000_000n, owner: randomField(), nonce: randomField() };
  const input1 = { amount: 3_000_000n, owner: randomField(), nonce: randomField() };
  const change = { amount: 6_000_000n, owner: randomField(), nonce: randomField() };
  const recovery = {
    version: 1,
    warning: 'DEVNET DEVELOPMENT NOTES. Keep private until the run is complete.',
    status: 'prepared',
    rpcURL,
    proverEndpoint,
    vaultBump: bump,
    accounts: accountSnapshot(accountKeys),
    notes: {
      input0: Object.fromEntries(Object.entries(input0).map(([key, value]) => [key, value.toString()])),
      input1: Object.fromEntries(Object.entries(input1).map(([key, value]) => [key, value.toString()])),
      change: Object.fromEntries(Object.entries(change).map(([key, value]) => [key, value.toString()])),
    },
    transactions: {},
  };
  await writeRecovery(recovery);

  const spaces = [
    [config, CONFIG_ACCOUNT_LEN_V1],
    [commitments, COMMITMENT_REGISTRY_LEN_V1],
    [nullifiers, NULLIFIER_REGISTRY_LEN_V1],
    [rootHistory, ROOT_HISTORY_ACCOUNT_LEN_V1],
  ];
  const rent = await Promise.all(
    spaces.map(([, space]) => connection.getMinimumBalanceForRentExemption(space, 'confirmed')),
  );
  const createInstructions = spaces.map(([account, space], index) => SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: account.publicKey,
    lamports: rent[index],
    space,
    programId,
  }));
  // A real validator enforces rent at transaction finalization. Seeding these
  // zero-data payout accounts with one lamport works in some mocks but fails on
  // RPC, even when the Watcher initialize instruction itself succeeds.
  const payoutSeedLamports = await connection.getMinimumBalanceForRentExemption(0, 'confirmed');
  recovery.payoutSeedLamports = payoutSeedLamports;
  await writeRecovery(recovery);
  for (const destination of [treasury.publicKey, relayer.publicKey, recipient.publicKey]) {
    createInstructions.push(SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: destination,
      lamports: payoutSeedLamports,
    }));
  }

  const initializeDescriptor = {
    programId,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: config.publicKey, isSigner: false, isWritable: true },
      { pubkey: commitments.publicKey, isSigner: false, isWritable: true },
      { pubkey: nullifiers.publicKey, isSigner: false, isWritable: true },
      { pubkey: rootHistory.publicKey, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([0]), treasury.publicKey.toBuffer()]),
  };
  const initializeTx = await send(
    connection,
    payer,
    [...createInstructions, transactionInstruction(initializeDescriptor)],
    [config, commitments, nullifiers, rootHistory],
  );
  recovery.status = 'initialized';
  recovery.transactions.initialize = initializeTx;
  await writeRecovery(recovery);
  console.log(`Initialize: ${initializeTx}`);

  const sharedDepositAccounts = {
    programId,
    depositor: payer.publicKey,
    config: config.publicKey,
    commitments: commitments.publicKey,
    rootHistory: rootHistory.publicKey,
    vault,
    systemProgram: SystemProgram.programId,
  };
  const firstDeposit = await prepareDepositV1({
    connection,
    accounts: sharedDepositAccounts,
    ...input0,
    proverEndpoint,
  });
  const firstDepositTx = await send(
    connection,
    payer,
    [groth16ComputeBudgetInstruction(), transactionInstruction(firstDeposit.instruction)],
  );
  recovery.status = 'deposit-1-confirmed';
  recovery.transactions.deposit0 = firstDepositTx;
  recovery.bundleDigest = firstDeposit.bundleDigest;
  await writeRecovery(recovery);
  console.log(`Deposit 8,000,000 lamports: ${firstDepositTx}`);

  const secondDeposit = await prepareDepositV1({
    connection,
    accounts: sharedDepositAccounts,
    ...input1,
    proverEndpoint,
  });
  if (secondDeposit.bundleDigest !== recovery.bundleDigest) {
    throw new Error('local prover bundle changed between deposits');
  }
  const secondDepositTx = await send(
    connection,
    payer,
    [groth16ComputeBudgetInstruction(), transactionInstruction(secondDeposit.instruction)],
  );
  recovery.status = 'deposit-2-confirmed';
  recovery.transactions.deposit1 = secondDepositTx;
  await writeRecovery(recovery);
  console.log(`Deposit 3,000,000 lamports: ${secondDepositTx}`);

  const recipientBefore = await connection.getBalance(recipient.publicKey, 'confirmed');
  const relayerBefore = await connection.getBalance(relayer.publicKey, 'confirmed');
  const treasuryBefore = await connection.getBalance(treasury.publicKey, 'confirmed');
  const withdrawal = await prepareWithdrawV1({
    connection,
    accounts: {
      programId,
      config: config.publicKey,
      commitments: commitments.publicKey,
      nullifiers: nullifiers.publicKey,
      rootHistory: rootHistory.publicKey,
      vault,
      recipient: recipient.publicKey,
      relayer: relayer.publicKey,
      treasury: treasury.publicKey,
    },
    input0,
    input1,
    change,
    publicAmount: 4_000_000n,
    protocolFee: 0n,
    relayerFee: 1_000_000n,
    proverEndpoint,
  });
  if (withdrawal.bundleDigest !== recovery.bundleDigest) {
    throw new Error('local prover bundle changed before withdrawal');
  }
  const withdrawalTx = await send(
    connection,
    payer,
    [groth16ComputeBudgetInstruction(), transactionInstruction(withdrawal.instruction)],
  );
  recovery.status = 'withdraw-confirmed';
  recovery.transactions.withdraw = withdrawalTx;
  await writeRecovery(recovery);
  console.log(`Withdraw: ${withdrawalTx}`);

  const recipientAfter = await connection.getBalance(recipient.publicKey, 'confirmed');
  const relayerAfter = await connection.getBalance(relayer.publicKey, 'confirmed');
  const treasuryAfter = await connection.getBalance(treasury.publicKey, 'confirmed');
  if (recipientAfter - recipientBefore !== 4_000_000) {
    throw new Error(`recipient delta is ${recipientAfter - recipientBefore}, want 4000000`);
  }
  if (relayerAfter - relayerBefore !== 1_000_000) {
    throw new Error(`relayer delta is ${relayerAfter - relayerBefore}, want 1000000`);
  }
  if (treasuryAfter - treasuryBefore !== 0) {
    throw new Error(`treasury delta is ${treasuryAfter - treasuryBefore}, want 0`);
  }
  const vaultAccount = await connection.getAccountInfo(vault, 'confirmed');
  if (!vaultAccount || vaultAccount.data.length !== VAULT_ACCOUNT_LEN_V1) {
    throw new Error('vault account is missing or malformed after withdrawal');
  }
  const trackedBalance = Buffer.from(vaultAccount.data).readBigUInt64LE(42);
  if (trackedBalance !== 6_000_000n) {
    throw new Error(`vault tracked balance is ${trackedBalance}, want 6000000`);
  }

  recovery.status = 'complete';
  recovery.result = {
    recipientDelta: recipientAfter - recipientBefore,
    relayerDelta: relayerAfter - relayerBefore,
    treasuryDelta: treasuryAfter - treasuryBefore,
    vaultTrackedBalance: trackedBalance.toString(),
  };
  await writeRecovery(recovery);
  console.log(JSON.stringify({
    status: 'PASS',
    clusterGenesis: genesis,
    accounts: recovery.accounts,
    transactions: recovery.transactions,
    result: recovery.result,
    recoveryFile: recoveryPath,
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error);
  console.error(`Recovery state, including private devnet note secrets, is stored at ${recoveryPath}`);
  process.exitCode = 1;
});
