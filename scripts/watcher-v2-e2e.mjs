import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';

import { fieldToLe32, noteCommitmentV1, nullifierV1 } from '../client/watcher/field.mjs';
import {
  buildSparseMerkleTreeV2,
  getMerkleAppendTransitionV2,
  getMerkleProofV2,
  MERKLE_DEPTH_V2,
} from '../client/watcher/merkle-v2.mjs';
import {
  depositContextBindingV2,
  recipientBindingV2,
  withdrawContextBindingV2,
} from '../client/watcher/bindings-v2.mjs';
import {
  deriveNullifierMarkerPdaV2,
  encodeDepositDataV2,
  encodeWithdrawDataV2,
} from '../client/watcher/instructions-v2.mjs';

const rpcUrl = process.env.WATCHER_V2_RPC_URL || 'http://127.0.0.1:8899';
const programId = new PublicKey(process.env.WATCHER_V2_PROGRAM_ID);
const payerPath = process.env.WATCHER_V2_PAYER_KEYPAIR;
const proverPath = process.env.WATCHER_V2_PROVER || 'circuits/withdraw/fixture-out/v2/watcher-v2-prover';
const bundlePath = process.env.WATCHER_V2_BUNDLE || 'circuits/withdraw/fixture-out/v2';
const allowAirdrop = String(process.env.WATCHER_V2_ALLOW_AIRDROP ?? '1') === '1';
const requiredPayerLamports = BigInt(process.env.WATCHER_V2_REQUIRED_PAYER_LAMPORTS || '20000000000');
const auxiliaryAccountLamports = BigInt(process.env.WATCHER_V2_AUXILIARY_ACCOUNT_LAMPORTS || '1000000');
if (!payerPath) throw new Error('WATCHER_V2_PAYER_KEYPAIR is required');
if (requiredPayerLamports < 100_000_000n) throw new Error('WATCHER_V2_REQUIRED_PAYER_LAMPORTS is too low for a custody smoke test');
if (auxiliaryAccountLamports < 1n || auxiliaryAccountLamports > 10_000_000n) {
  throw new Error('WATCHER_V2_AUXILIARY_ACCOUNT_LAMPORTS must be between 1 and 10000000');
}
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(payerPath, 'utf8'))));
const connection = new Connection(rpcUrl, 'confirmed');

const ACTIVE_TREE_BYTES = 591;
const CONFIG_BYTES = 100;
const VAULT_TRACKED_BALANCE_OFFSET = 42;
const VAULT_SEED_V2 = Buffer.from('watcher-vault-v2');

function u64From(data, offset) {
  return new DataView(data.buffer, data.byteOffset + offset, 8).getBigUint64(0, true);
}

function u32From(data, offset) {
  return new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0, true);
}

function bytesEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function toDecimalArray(values) {
  return values.map((value) => BigInt(value).toString(10));
}

function prove(circuit, witness) {
  const result = spawnSync(
    proverPath,
    ['--bundle', bundlePath, '--circuit', circuit],
    { input: JSON.stringify(witness), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(`V2 ${circuit} prover failed: ${result.stderr || result.stdout}`);
  }
  const parsed = JSON.parse(result.stdout);
  if (parsed.proofBytes !== 256) throw new Error(`unexpected ${circuit} proof size`);
  return Uint8Array.from(Buffer.from(parsed.proofHex, 'hex'));
}

async function send(instruction, signers = [payer]) {
  return sendAndConfirmTransaction(
    connection,
    new Transaction().add(instruction),
    signers,
    { commitment: 'confirmed', skipPreflight: false },
  );
}

async function ensurePayerFunding() {
  let balance = BigInt(await connection.getBalance(payer.publicKey, 'confirmed'));
  if (balance >= requiredPayerLamports) return balance;
  if (!allowAirdrop) {
    throw new Error(
      `V2 custody smoke payer has ${balance} lamports; ${requiredPayerLamports} required and faucet use is disabled`,
    );
  }
  const deficit = requiredPayerLamports - balance;
  const signature = await connection.requestAirdrop(payer.publicKey, Number(deficit));
  const latest = await connection.getLatestBlockhash('confirmed');
  const confirmation = await connection.confirmTransaction({ signature, ...latest }, 'confirmed');
  if (confirmation.value.err) throw new Error(`V2 payer airdrop failed: ${JSON.stringify(confirmation.value.err)}`);
  balance = BigInt(await connection.getBalance(payer.publicKey, 'confirmed'));
  if (balance < requiredPayerLamports) {
    throw new Error(`V2 payer balance remained below ${requiredPayerLamports} after airdrop`);
  }
  return balance;
}

async function fundAuxiliaryAccounts(...publicKeys) {
  const instructions = [];
  for (const publicKey of publicKeys) {
    const balance = BigInt(await connection.getBalance(publicKey, 'confirmed'));
    if (balance >= auxiliaryAccountLamports) continue;
    instructions.push(SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: publicKey,
      lamports: Number(auxiliaryAccountLamports - balance),
    }));
  }
  if (instructions.length === 0) return;
  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(...instructions),
    [payer],
    { commitment: 'confirmed', skipPreflight: false },
  );
}

async function main() {
  const payerBalanceBefore = await ensurePayerFunding();
  const config = Keypair.generate();
  const activeTree = Keypair.generate();
  const treasury = Keypair.generate();
  const recipient = Keypair.generate();
  // Public-devnet smoke must not depend on faucet capacity for throwaway
  // recipient/treasury accounts. Fund tiny system-account balances from the
  // already-funded payer instead; local-validator mode still permits payer airdrop.
  await fundAuxiliaryAccounts(treasury.publicKey, recipient.publicKey);

  const [vault] = PublicKey.findProgramAddressSync(
    [VAULT_SEED_V2, config.publicKey.toBuffer()],
    programId,
  );
  const configRent = await connection.getMinimumBalanceForRentExemption(CONFIG_BYTES);
  const activeRent = await connection.getMinimumBalanceForRentExemption(ACTIVE_TREE_BYTES);
  await send(
    new TransactionInstruction({
      programId: SystemProgram.programId,
      keys: [],
      data: Buffer.alloc(0),
    }),
  ).catch(() => {});
  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: config.publicKey,
        lamports: configRent,
        space: CONFIG_BYTES,
        programId,
      }),
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: activeTree.publicKey,
        lamports: activeRent,
        space: ACTIVE_TREE_BYTES,
        programId,
      }),
    ),
    [payer, config, activeTree],
    { commitment: 'confirmed' },
  );

  const initializeData = Buffer.concat([
    Buffer.from([0x22]),
    treasury.publicKey.toBuffer(),
  ]);
  await send(new TransactionInstruction({
    programId,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: config.publicKey, isSigner: false, isWritable: true },
      { pubkey: activeTree.publicKey, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: initializeData,
  }));

  const note = { assetId: 1n, amount: 8_000_000n, owner: 1111n, nonce: 2222n };
  const commitment = noteCommitmentV1(note);
  const emptyTree = buildSparseMerkleTreeV2([], { epoch: 0 });
  const append = getMerkleAppendTransitionV2(emptyTree, commitment);
  const depositContext = await depositContextBindingV2({
    programId: programId.toBytes(),
    config: config.publicKey.toBytes(),
    vault: vault.toBytes(),
    activeTree: activeTree.publicKey.toBytes(),
    assetId: 1n,
  });
  const depositWitness = {
    Owner: note.owner.toString(),
    Nonce: note.nonce.toString(),
    Path: toDecimalArray(append.path),
    Index: append.indexBits,
    Commitment: commitment.toString(),
    Amount: note.amount.toString(),
    AssetID: '1',
    Epoch: '0',
    ContextBinding: depositContext.field.toString(),
    OldRoot: '0',
    NewRoot: append.newRoot.toString(),
    LeafIndex: '0',
  };
  const depositProof = prove('deposit', depositWitness);
  const depositData = encodeDepositDataV2({
    commitment: fieldToLe32(commitment),
    amount: note.amount,
    newRoot: fieldToLe32(append.newRoot),
    proof: depositProof,
  });
  const depositSignature = await send(new TransactionInstruction({
    programId,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: config.publicKey, isSigner: false, isWritable: false },
      { pubkey: activeTree.publicKey, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(depositData),
  }));

  const activeAfterDeposit = await connection.getAccountInfo(activeTree.publicKey, 'confirmed');
  const vaultAfterDeposit = await connection.getAccountInfo(vault, 'confirmed');
  if (!activeAfterDeposit || !vaultAfterDeposit) throw new Error('V2 state missing after deposit');
  if (u32From(activeAfterDeposit.data, 41) !== 1) throw new Error('V2 deposit did not advance next_index');
  if (!bytesEqual(activeAfterDeposit.data.slice(45, 77), fieldToLe32(append.newRoot))) {
    throw new Error('V2 active root does not match proof-bound deposit root');
  }
  if (u64From(vaultAfterDeposit.data, VAULT_TRACKED_BALANCE_OFFSET) !== note.amount) {
    throw new Error('V2 vault liability did not increase after deposit');
  }

  const tree = append.tree;
  const membership = getMerkleProofV2(tree, 0);
  const nullifier = nullifierV1({ owner: note.owner, nonce: note.nonce, commitment });
  const recipientBinding = await recipientBindingV2(recipient.publicKey.toBytes());
  const withdrawContext = await withdrawContextBindingV2({
    programId: programId.toBytes(),
    config: config.publicKey.toBytes(),
    vault: vault.toBytes(),
    activeTree: activeTree.publicKey.toBytes(),
    relayer: payer.publicKey.toBytes(),
    treasury: treasury.publicKey.toBytes(),
    assetId: 1n,
  });
  const zeroPath = Array.from({ length: MERKLE_DEPTH_V2 }, () => '0');
  const zeroBits = Array.from({ length: MERKLE_DEPTH_V2 }, () => 0);
  const inputs = Array.from({ length: 4 }, (_, index) => index === 0 ? {
    Enabled: 1,
    Amount: note.amount.toString(),
    Owner: note.owner.toString(),
    Nonce: note.nonce.toString(),
    Path: toDecimalArray(membership.path),
    Index: membership.indexBits,
    Root: membership.root.toString(),
    Nullifier: nullifier.toString(),
  } : {
    Enabled: 0,
    Amount: '0',
    Owner: '0',
    Nonce: '0',
    Path: zeroPath,
    Index: zeroBits,
    Root: '0',
    Nullifier: '0',
  });
  const publicAmount = 7_999_000n;
  const relayerFee = 1_000n;
  const withdrawWitness = {
    Inputs: inputs,
    Change: {
      Enabled: 0,
      Amount: '0',
      Owner: '0',
      Nonce: '0',
      Path: zeroPath,
      Index: zeroBits,
    },
    InputCount: '1',
    ChangeCommitment: '0',
    PublicAmount: publicAmount.toString(),
    ProtocolFee: '0',
    RelayerFee: relayerFee.toString(),
    RecipientBinding: recipientBinding.field.toString(),
    AssetID: '1',
    ContextBinding: withdrawContext.field.toString(),
    CurrentRoot: '0',
    NewMerkleRoot: '0',
    ChangeLeafIndex: '0',
  };
  const withdrawProof = prove('withdraw', withdrawWitness);
  const inputRoots = [fieldToLe32(membership.root), new Uint8Array(32), new Uint8Array(32), new Uint8Array(32)];
  const nullifiers = [fieldToLe32(nullifier), new Uint8Array(32), new Uint8Array(32), new Uint8Array(32)];
  const withdrawData = encodeWithdrawDataV2({
    inputCount: 1,
    inputRoots,
    nullifiers,
    changeCommitment: new Uint8Array(32),
    recipient: recipient.publicKey,
    publicAmount,
    protocolFee: 0n,
    relayerFee,
    newRoot: new Uint8Array(32),
    proof: withdrawProof,
  });
  const [marker] = deriveNullifierMarkerPdaV2({
    programId,
    config: config.publicKey,
    nullifier: fieldToLe32(nullifier),
  });
  const recipientBefore = await connection.getBalance(recipient.publicKey, 'confirmed');
  const withdrawInstruction = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: config.publicKey, isSigner: false, isWritable: false },
      { pubkey: activeTree.publicKey, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: recipient.publicKey, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: treasury.publicKey, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: marker, isSigner: false, isWritable: true },
    ],
    data: Buffer.from(withdrawData),
  });
  const withdrawSignature = await send(withdrawInstruction);

  const activeAfterWithdraw = await connection.getAccountInfo(activeTree.publicKey, 'confirmed');
  const vaultAfterWithdraw = await connection.getAccountInfo(vault, 'confirmed');
  const markerInfo = await connection.getAccountInfo(marker, 'confirmed');
  const recipientAfter = await connection.getBalance(recipient.publicKey, 'confirmed');
  if (!activeAfterWithdraw || !vaultAfterWithdraw || !markerInfo) throw new Error('V2 withdrawal state missing');
  if (u32From(activeAfterWithdraw.data, 41) !== 1) throw new Error('exact V2 withdrawal unexpectedly mutated active tree index');
  if (!bytesEqual(activeAfterWithdraw.data.slice(45, 77), fieldToLe32(append.newRoot))) {
    throw new Error('exact V2 withdrawal unexpectedly mutated active root');
  }
  if (u64From(vaultAfterWithdraw.data, VAULT_TRACKED_BALANCE_OFFSET) !== 0n) {
    throw new Error('V2 vault liability did not reach zero after exact withdrawal');
  }
  if (!markerInfo.owner.equals(programId)) throw new Error('V2 nullifier marker is not program-owned');
  if (recipientAfter - recipientBefore !== Number(publicAmount)) throw new Error('V2 recipient payout mismatch');

  let replayRejected = false;
  try {
    await send(withdrawInstruction);
  } catch {
    replayRejected = true;
  }
  if (!replayRejected) throw new Error('V2 replayed nullifier was not rejected');

  const payerBalanceAfter = BigInt(await connection.getBalance(payer.publicKey, 'confirmed'));
  console.log(JSON.stringify({
    status: 'pass',
    programId: programId.toBase58(),
    config: config.publicKey.toBase58(),
    activeTree: activeTree.publicKey.toBase58(),
    vault: vault.toBase58(),
    marker: marker.toBase58(),
    depositSignature,
    withdrawSignature,
    treeDepth: MERKLE_DEPTH_V2,
    nextIndex: u32From(activeAfterWithdraw.data, 41),
    trackedBalance: u64From(vaultAfterWithdraw.data, VAULT_TRACKED_BALANCE_OFFSET).toString(),
    replayRejected,
    airdropAllowed: allowAirdrop,
    requiredPayerLamports: requiredPayerLamports.toString(),
    payerBalanceBefore: payerBalanceBefore.toString(),
    payerBalanceAfter: payerBalanceAfter.toString(),
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
