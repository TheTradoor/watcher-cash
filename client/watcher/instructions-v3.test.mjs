import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';

import {
  buildInitializeNullifierShardInstructionV3,
  buildWithdrawInstructionV3,
  deriveNullifierShardForSpendV3,
  deriveNullifierShardPdaV3,
  encodeWithdrawDataV3,
  NULLIFIER_RECORD_BYTES_V3,
  NULLIFIER_SHARD_COUNT_V3,
  NULLIFIER_SHARD_HEADER_BYTES_V3,
  routeNullifierV3,
  WATCHER_INSTRUCTION_WITHDRAW_V3,
} from './instructions-v3.mjs';
import { WATCHER_WITHDRAW_DATA_BYTES_V2 } from './instructions-v2.mjs';

function bytes(seed) {
  const value = new Uint8Array(32);
  value[0] = seed;
  value[31] = seed + 1;
  return value;
}

test('V3 nullifier routing is deterministic and bounded', () => {
  const config = Keypair.generate().publicKey;
  const nullifier = bytes(9);
  const first = routeNullifierV3({ config, nullifier });
  const second = routeNullifierV3({ config, nullifier });
  assert.deepEqual(first, second);
  assert.ok(first.shard >= 0 && first.shard < NULLIFIER_SHARD_COUNT_V3);
  assert.ok(first.bucket >= 0 && first.bucket < 4096);
});

test('V3 shard PDA matches spend routing', () => {
  const programId = Keypair.generate().publicKey;
  const config = Keypair.generate().publicKey;
  const nullifier = bytes(17);
  const routed = deriveNullifierShardForSpendV3({ programId, config, nullifier });
  const [direct, bump] = deriveNullifierShardPdaV3({ programId, config, shard: routed.shard });
  assert.equal(routed.pubkey.toBase58(), direct.toBase58());
  assert.equal(routed.bump, bump);
});

test('V3 shard initialization uses a compact two-byte instruction', () => {
  const programId = Keypair.generate().publicKey;
  const authority = Keypair.generate().publicKey;
  const config = Keypair.generate().publicKey;
  const instruction = buildInitializeNullifierShardInstructionV3({
    programId,
    authority,
    config,
    shard: 3,
  });
  assert.deepEqual([...instruction.data], [0x33, 3]);
  assert.equal(instruction.keys.length, 4);
  assert.equal(instruction.keys[2].pubkey.toBase58(), instruction.shardPda.toBase58());
});

test('V3 withdraw preserves V2 proof-bound bytes and swaps only tag', () => {
  const zero = new Uint8Array(32);
  const roots = [bytes(1), zero, zero, zero];
  const nullifiers = [bytes(2), zero, zero, zero];
  const recipient = Keypair.generate().publicKey;
  const data = encodeWithdrawDataV3({
    inputCount: 1,
    inputRoots: roots,
    nullifiers,
    changeCommitment: zero,
    recipient,
    publicAmount: 10n,
    protocolFee: 0n,
    relayerFee: 0n,
    newRoot: zero,
    proof: new Uint8Array(256),
  });
  assert.equal(data.length, WATCHER_WITHDRAW_DATA_BYTES_V2);
  assert.equal(data[0], WATCHER_INSTRUCTION_WITHDRAW_V3);
});

test('V3 withdraw accounts point each active nullifier at its exact shard PDA', () => {
  const programId = Keypair.generate().publicKey;
  const config = Keypair.generate().publicKey;
  const activeTree = Keypair.generate().publicKey;
  const vault = Keypair.generate().publicKey;
  const recipient = Keypair.generate().publicKey;
  const relayer = Keypair.generate().publicKey;
  const treasury = Keypair.generate().publicKey;
  const zero = new Uint8Array(32);
  const roots = [bytes(1), bytes(2), zero, zero];
  const nullifiers = [bytes(11), bytes(12), zero, zero];
  const built = buildWithdrawInstructionV3({
    programId,
    config,
    activeTree,
    vault,
    recipient,
    relayer,
    treasury,
    inputCount: 2,
    inputRoots: roots,
    nullifiers,
    changeCommitment: zero,
    publicAmount: 10n,
    newRoot: zero,
    proof: new Uint8Array(256),
  });
  assert.equal(built.shardAccounts.length, 2);
  assert.equal(built.keys[7].pubkey.toBase58(), built.shardAccounts[0].toBase58());
  assert.equal(built.keys[8].pubkey.toBase58(), built.shardAccounts[1].toBase58());
  for (const account of built.shardAccounts) assert.ok(account instanceof PublicKey);
});

test('V3 packed storage marginal footprint is 36 bytes per spent note', () => {
  assert.equal(NULLIFIER_RECORD_BYTES_V3, 36);
  assert.equal(NULLIFIER_SHARD_HEADER_BYTES_V3, 16_432);
});
