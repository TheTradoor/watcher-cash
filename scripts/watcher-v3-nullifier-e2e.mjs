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
import { encodeDepositDataV2 } from '../client/watcher/instructions-v2.mjs';
import {
  buildInitializeNullifierShardInstructionV3,
  buildWithdrawInstructionV3,
  NULLIFIER_RECORD_BYTES_V3,
  NULLIFIER_SHARD_COUNT_V3,
} from '../client/watcher/instructions-v3.mjs';

const rpcUrl = process.env.WATCHER_V3_RPC_URL || 'http://127.0.0.1:8899';
const programId = new PublicKey(process.env.WATCHER_V3_PROGRAM_ID);
const payerPath = process.env.WATCHER_V3_PAYER_KEYPAIR;
const proverPath = process.env.WATCHER_V3_PROVER || 'circuits/withdraw/fixture-out/v2/watcher-v2-prover';
const bundlePath = process.env.WATCHER_V3_BUNDLE || 'circuits/withdraw/fixture-out/v2';
if (!payerPath) throw new Error('WATCHER_V3_PAYER_KEYPAIR is required');

const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(payerPath, 'utf8'))));
const connection = new Connection(rpcUrl, 'confirmed');

const ACTIVE_TREE_BYTES = 591;
const CONFIG_BYTES = 100;
const VAULT_TRACKED_BALANCE_OFFSET = 42;
const VAULT_SEED_V2 = Buffer.from('watcher-vault-v2');
const REQUIRED_PAYER_LAMPORTS = 5_000_000_000n;

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
  if (result.status !== 0) throw new Error(`V3 ${circuit} prover failed: ${result.stderr || result.stdout}`);
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
  if (balance >= REQUIRED_PAYER_LAMPORTS) return balance;
  const signature = await connection.requestAirdrop(payer.publicKey, Number(REQUIRED_PAYER_LAMPORTS - balance));
  const latest = await connection.getLatestBlockhash('confirmed');
  const confirmation = await connection.confirmTransaction({ signature, ...latest }, 'confirmed');
  if (confirmation.value.err) throw new Error(`V3 payer airdrop failed: ${JSON.stringify(confirmation.value.err)}`);
  balance = BigInt(await connection.getBalance(payer.publicKey, 'confirmed'));
  if (balance < REQUIRED_PAYER_LAMPORTS) throw new Error('V3 payer remained underfunded');
  return balance;
}

async function fund(publicKey, lamports = 1_000_000) {
  const balance = await connection.getBalance(publicKey, 'confirmed');
  if (balance >= lamports) return;
  await send(new TransactionInstruction({
    programId: SystemProgram.programId,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: publicKey, isSigner: false, isWritable: true },
    ],
    data: SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: publicKey,
      lamports: lamports - balance,
    }).data,
  }));
}

async function main() {
  const payerBalanceBefore = await ensurePayerFunding();
  const config = Keypair.generate();
  const activeTree = Keypair.generate();
  const treasury = Keypair.generate();
  const recipient = Keypair.generate();
  await fund(treasury.publicKey);
  await fund(recipient.publicKey);

  const [vault] = PublicKey.findProgramAddressSync(
    [VAULT_SEED_V2, config.publicKey.toBuffer()],
    programId,
  );
  const configRent = await connection.getMinimumBalanceForRentExemption(CONFIG_BYTES);
  const activeRent = await connection.getMinimumBalanceForRentExemption(ACTIVE_TREE_BYTES);
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

  await send(new TransactionInstruction({
    programId,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: config.publicKey, isSigner: false, isWritable: true },
      { pubkey: activeTree.publicKey, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([0x22]), treasury.publicKey.toBuffer()]),
  }));

  const shardPdas = [];
  for (let shard = 0; shard < NULLIFIER_SHARD_COUNT_V3; shard += 1) {
    const built = buildInitializeNullifierShardInstructionV3({
      programId,
      authority: payer.publicKey,
      config: config.publicKey,
      shard,
    });
    shardPdas.push(built.shardPda);
    await send(new TransactionInstruction({
      programId: built.programId,
      keys: built.keys,
      data: Buffer.from(built.data),
    }));
  }

  const depositContext = await depositContextBindingV2({
    programId: programId.toBytes(),
    config: config.publicKey.toBytes(),
    vault: vault.toBytes(),
    activeTree: activeTree.publicKey.toBytes(),
    assetId: 1n,
  });

  const notes = [
    { assetId: 1n, amount: 8_000_000n, owner: 1111n, nonce: 2222n },
    { assetId: 1n, amount: 8_000_000n, owner: 3333n, nonce: 4444n },
  ];
  let tree = buildSparseMerkleTreeV2([], { epoch: 0 });
  const commitments = [];
  const depositSignatures = [];

  for (let index = 0; index < notes.length; index += 1) {
    const note = notes[index];
    const commitment = noteCommitmentV1(note);
    commitments.push(commitment);
    const append = getMerkleAppendTransitionV2(tree, commitment);
    const witness = {
      Owner: note.owner.toString(),
      Nonce: note.nonce.toString(),
      Path: toDecimalArray(append.path),
      Index: append.indexBits,
      Commitment: commitment.toString(),
      Amount: note.amount.toString(),
      AssetID: '1',
      Epoch: '0',
      ContextBinding: depositContext.field.toString(),
      OldRoot: append.oldRoot.toString(),
      NewRoot: append.newRoot.toString(),
      LeafIndex: String(append.index),
    };
    const proof = prove('deposit', witness);
    const data = encodeDepositDataV2({
      commitment: fieldToLe32(commitment),
      amount: note.amount,
      newRoot: fieldToLe32(append.newRoot),
      proof,
    });
    depositSignatures.push(await send(new TransactionInstruction({
      programId,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: config.publicKey, isSigner: false, isWritable: false },
        { pubkey: activeTree.publicKey, isSigner: false, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(data),
    })));
    tree = append.tree;
  }

  const activeAfterDeposits = await connection.getAccountInfo(activeTree.publicKey, 'confirmed');
  const vaultAfterDeposits = await connection.getAccountInfo(vault, 'confirmed');
  if (!activeAfterDeposits || !vaultAfterDeposits) throw new Error('V3 state missing after deposits');
  if (u32From(activeAfterDeposits.data, 41) !== 2) throw new Error('two V3 deposits did not advance tree to index 2');
  if (!bytesEqual(activeAfterDeposits.data.slice(45, 77), fieldToLe32(tree.root))) {
    throw new Error('V3 active root does not match two-deposit tree');
  }
  if (u64From(vaultAfterDeposits.data, VAULT_TRACKED_BALANCE_OFFSET) !== 16_000_000n) {
    throw new Error('V3 vault liability did not reach 0.016 SOL');
  }

  const memberships = commitments.map((_, index) => getMerkleProofV2(tree, index));
  const nullifierFields = notes.map((note, index) => nullifierV1({
    owner: note.owner,
    nonce: note.nonce,
    commitment: commitments[index],
  }));
  const nullifierBytes = nullifierFields.map(fieldToLe32);
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
  const inputs = Array.from({ length: 4 }, (_, index) => index < 2 ? {
    Enabled: 1,
    Amount: notes[index].amount.toString(),
    Owner: notes[index].owner.toString(),
    Nonce: notes[index].nonce.toString(),
    Path: toDecimalArray(memberships[index].path),
    Index: memberships[index].indexBits,
    Root: memberships[index].root.toString(),
    Nullifier: nullifierFields[index].toString(),
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
  const publicAmount = 15_999_000n;
  const relayerFee = 1_000n;
  const withdrawProof = prove('withdraw', {
    Inputs: inputs,
    Change: {
      Enabled: 0,
      Amount: '0',
      Owner: '0',
      Nonce: '0',
      Path: zeroPath,
      Index: zeroBits,
    },
    InputCount: '2',
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
  });

  const zero32 = new Uint8Array(32);
  const builtWithdraw = buildWithdrawInstructionV3({
    programId,
    config: config.publicKey,
    activeTree: activeTree.publicKey,
    vault,
    recipient: recipient.publicKey,
    relayer: payer.publicKey,
    treasury: treasury.publicKey,
    inputCount: 2,
    inputRoots: [fieldToLe32(tree.root), fieldToLe32(tree.root), zero32, zero32],
    nullifiers: [nullifierBytes[0], nullifierBytes[1], zero32, zero32],
    changeCommitment: zero32,
    publicAmount,
    protocolFee: 0n,
    relayerFee,
    newRoot: zero32,
    proof: withdrawProof,
  });
  const withdrawInstruction = new TransactionInstruction({
    programId: builtWithdraw.programId,
    keys: builtWithdraw.keys,
    data: Buffer.from(builtWithdraw.data),
  });

  const shardInfosBefore = await connection.getMultipleAccountsInfo(shardPdas, 'confirmed');
  if (shardInfosBefore.some((info) => !info || !info.owner.equals(programId))) {
    throw new Error('one or more V3 nullifier shards were not initialized');
  }
  const shardBytesBefore = shardInfosBefore.reduce((sum, info) => sum + info.data.length, 0);
  const shardLamportsBefore = shardInfosBefore.reduce((sum, info) => sum + BigInt(info.lamports), 0n);
  const recipientBefore = await connection.getBalance(recipient.publicKey, 'confirmed');
  const withdrawSignature = await send(withdrawInstruction);

  const activeAfterWithdraw = await connection.getAccountInfo(activeTree.publicKey, 'confirmed');
  const vaultAfterWithdraw = await connection.getAccountInfo(vault, 'confirmed');
  const shardInfosAfter = await connection.getMultipleAccountsInfo(shardPdas, 'confirmed');
  const recipientAfter = await connection.getBalance(recipient.publicKey, 'confirmed');
  if (!activeAfterWithdraw || !vaultAfterWithdraw || shardInfosAfter.some((info) => !info)) {
    throw new Error('V3 withdrawal state missing');
  }
  if (u32From(activeAfterWithdraw.data, 41) !== 2) throw new Error('exact V3 withdrawal mutated active tree index');
  if (!bytesEqual(activeAfterWithdraw.data.slice(45, 77), fieldToLe32(tree.root))) {
    throw new Error('exact V3 withdrawal mutated active tree root');
  }
  if (u64From(vaultAfterWithdraw.data, VAULT_TRACKED_BALANCE_OFFSET) !== 0n) {
    throw new Error('V3 vault liability did not reach zero');
  }
  if (recipientAfter - recipientBefore !== Number(publicAmount)) throw new Error('V3 recipient payout mismatch');

  const shardBytesAfter = shardInfosAfter.reduce((sum, info) => sum + info.data.length, 0);
  const shardLamportsAfter = shardInfosAfter.reduce((sum, info) => sum + BigInt(info.lamports), 0n);
  const growthBytes = shardBytesAfter - shardBytesBefore;
  const growthLamports = shardLamportsAfter - shardLamportsBefore;
  if (growthBytes !== 2 * NULLIFIER_RECORD_BYTES_V3) {
    throw new Error(`V3 nullifier storage grew ${growthBytes} bytes; expected ${2 * NULLIFIER_RECORD_BYTES_V3}`);
  }
  const totalStored = shardInfosAfter.reduce((sum, info) => sum + u32From(info.data, 44), 0);
  if (totalStored !== 2) throw new Error(`V3 shards recorded ${totalStored} nullifiers; expected 2`);

  const v2MarkerRent = BigInt(await connection.getMinimumBalanceForRentExemption(0));
  const v2TwoMarkerRent = v2MarkerRent * 2n;
  if (growthLamports >= v2TwoMarkerRent) {
    throw new Error(`V3 rent growth ${growthLamports} is not cheaper than V2 markers ${v2TwoMarkerRent}`);
  }

  let replayRejected = false;
  try {
    await send(withdrawInstruction);
  } catch {
    replayRejected = true;
  }
  if (!replayRejected) throw new Error('V3 replayed nullifiers were not rejected');

  // Cross-store bypass must be impossible in a V3 build. The old V2 withdrawal
  // tag is disabled at the entrypoint, so changing only the tag cannot bypass
  // the packed replay set.
  const legacyData = Buffer.from(builtWithdraw.data);
  legacyData[0] = 0x21;
  let v2BypassRejected = false;
  try {
    await send(new TransactionInstruction({
      programId,
      keys: builtWithdraw.keys,
      data: legacyData,
    }));
  } catch {
    v2BypassRejected = true;
  }
  if (!v2BypassRejected) throw new Error('V2 withdrawal tag bypassed V3 nullifier storage');

  const payerBalanceAfter = BigInt(await connection.getBalance(payer.publicKey, 'confirmed'));
  const savingsBps = v2TwoMarkerRent === 0n
    ? 0
    : Number(((v2TwoMarkerRent - growthLamports) * 10_000n) / v2TwoMarkerRent);

  console.log(JSON.stringify({
    status: 'pass',
    programId: programId.toBase58(),
    config: config.publicKey.toBase58(),
    activeTree: activeTree.publicKey.toBase58(),
    vault: vault.toBase58(),
    depositSignatures,
    withdrawSignature,
    treeDepth: MERKLE_DEPTH_V2,
    nextIndex: u32From(activeAfterWithdraw.data, 41),
    trackedBalance: u64From(vaultAfterWithdraw.data, VAULT_TRACKED_BALANCE_OFFSET).toString(),
    replayRejected,
    v2BypassRejected,
    nullifiersStored: totalStored,
    nullifierStorageGrowthBytes: growthBytes,
    v3NullifierRentGrowthLamports: growthLamports.toString(),
    v2EquivalentMarkerRentLamports: v2TwoMarkerRent.toString(),
    rentSavingsBps: savingsBps,
    payerBalanceBefore: payerBalanceBefore.toString(),
    payerBalanceAfter: payerBalanceAfter.toString(),
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
