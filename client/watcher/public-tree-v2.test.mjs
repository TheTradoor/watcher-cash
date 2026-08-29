import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair } from '@solana/web3.js';

import { fieldToLe32 } from './field.mjs';
import { getMerkleAppendTransitionV2 } from './merkle-v2.mjs';
import { encodeDepositDataV2, encodeWithdrawDataV2 } from './instructions-v2.mjs';
import {
  appendPublicTreeCacheV2,
  loadPublicTreeCacheV2,
  rebuildPublicTreeCacheFromChainV2,
  savePublicTreeCacheV2,
  verifyPublicTreeCacheV2,
} from './public-tree-v2.mjs';
import { ACTIVE_TREE_ACCOUNT_LEN_V2 } from './state-v2.mjs';

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
}

function activeTreeData({ config, epoch = 0n, nextIndex = 0, root = 0n }) {
  const data = new Uint8Array(ACTIVE_TREE_ACCOUNT_LEN_V2);
  data[0] = 2;
  data.set(config.toBytes(), 1);
  let epochValue = BigInt(epoch);
  for (let index = 0; index < 8; index += 1) {
    data[33 + index] = Number(epochValue & 0xffn);
    epochValue >>= 8n;
  }
  data[41] = nextIndex & 0xff;
  data[42] = (nextIndex >>> 8) & 0xff;
  data[43] = (nextIndex >>> 16) & 0xff;
  data[44] = (nextIndex >>> 24) & 0xff;
  if (root !== 0n) data.set(fieldToLe32(root), 45);
  return data;
}

function transaction({ programId, data }) {
  return {
    meta: { err: null },
    transaction: {
      message: {
        staticAccountKeys: [programId],
        compiledInstructions: [{ programIdIndex: 0, data }],
      },
    },
  };
}

test('initializes an empty verified cache when the on-chain tree is empty', async () => {
  const storage = new MemoryStorage();
  const config = Keypair.generate().publicKey;
  const connection = {
    async getAccountInfo() { return { data: activeTreeData({ config }) }; },
  };
  const result = await verifyPublicTreeCacheV2({
    connection,
    activeTree: Keypair.generate().publicKey,
    scope: 'test-empty',
    storage,
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.tree.count, 0);
  assert.equal(loadPublicTreeCacheV2({ scope: 'test-empty', storage }).epoch, 0);
});

test('append cache produces the same sparse root expected by chain state', async () => {
  const storage = new MemoryStorage();
  const scope = 'test-append';
  const config = Keypair.generate().publicKey;
  const empty = savePublicTreeCacheV2({ storage, scope, epoch: 0, commitments: [] });
  const append = getMerkleAppendTransitionV2(empty.tree, 123n);
  appendPublicTreeCacheV2({ storage, scope, epoch: 0, commitment: 123n });
  const connection = {
    async getAccountInfo() {
      return { data: activeTreeData({ config, nextIndex: 1, root: append.newRoot }) };
    },
  };
  const result = await verifyPublicTreeCacheV2({
    connection,
    activeTree: Keypair.generate().publicKey,
    scope,
    storage,
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.tree.root, append.newRoot);
});

test('stale local commitment history is never accepted silently', async () => {
  const storage = new MemoryStorage();
  const scope = 'test-stale';
  const config = Keypair.generate().publicKey;
  savePublicTreeCacheV2({ storage, scope, epoch: 0, commitments: [123n] });
  const connection = {
    async getAccountInfo() {
      return { data: activeTreeData({ config, nextIndex: 2, root: 456n }) };
    },
  };
  const result = await verifyPublicTreeCacheV2({
    connection,
    activeTree: Keypair.generate().publicKey,
    scope,
    storage,
  });
  assert.equal(result.status, 'stale');
  assert.match(result.error, /behind the on-chain tree/);
});

test('rebuilds a missing V2 public tree cache from successful on-chain append instructions', async () => {
  const storage = new MemoryStorage();
  const scope = 'test-rebuild';
  const programId = Keypair.generate().publicKey;
  const activeTree = Keypair.generate().publicKey;
  const config = Keypair.generate().publicKey;
  const recipient = Keypair.generate().publicKey;

  const empty = savePublicTreeCacheV2({ storage, scope: 'scratch', epoch: 0, commitments: [] }).tree;
  const first = getMerkleAppendTransitionV2(empty, 123n);
  const second = getMerkleAppendTransitionV2(first.tree, 456n);

  const depositData = encodeDepositDataV2({
    commitment: fieldToLe32(123n),
    amount: 1_000_000n,
    newRoot: fieldToLe32(first.newRoot),
    proof: new Uint8Array(256),
  });
  const withdrawData = encodeWithdrawDataV2({
    inputCount: 1,
    inputRoots: [fieldToLe32(first.newRoot), new Uint8Array(32), new Uint8Array(32), new Uint8Array(32)],
    nullifiers: [fieldToLe32(999n), new Uint8Array(32), new Uint8Array(32), new Uint8Array(32)],
    changeCommitment: fieldToLe32(456n),
    recipient,
    publicAmount: 1n,
    protocolFee: 0n,
    relayerFee: 0n,
    newRoot: fieldToLe32(second.newRoot),
    proof: new Uint8Array(256),
  });

  const transactions = new Map([
    ['withdraw-change', transaction({ programId, data: withdrawData })],
    ['deposit', transaction({ programId, data: depositData })],
  ]);
  const connection = {
    async getAccountInfo() {
      return { data: activeTreeData({ config, nextIndex: 2, root: second.newRoot }) };
    },
    async getSignaturesForAddress(_address, options) {
      if (options.before) return [];
      return [
        { signature: 'withdraw-change', err: null },
        { signature: 'exact-withdraw', err: null },
        { signature: 'deposit', err: null },
      ];
    },
    async getTransactions(signatures) {
      return signatures.map((signature) => transactions.get(signature) || transaction({
        programId,
        data: encodeWithdrawDataV2({
          inputCount: 1,
          inputRoots: [fieldToLe32(first.newRoot), new Uint8Array(32), new Uint8Array(32), new Uint8Array(32)],
          nullifiers: [fieldToLe32(998n), new Uint8Array(32), new Uint8Array(32), new Uint8Array(32)],
          changeCommitment: new Uint8Array(32),
          recipient,
          publicAmount: 1n,
          protocolFee: 0n,
          relayerFee: 0n,
          newRoot: new Uint8Array(32),
          proof: new Uint8Array(256),
        }),
      }));
    },
  };

  const rebuilt = await rebuildPublicTreeCacheFromChainV2({
    connection,
    programId,
    activeTree,
    scope,
    storage,
  });
  assert.equal(rebuilt.tree.count, 2);
  assert.deepEqual(rebuilt.tree.commitments, [123n, 456n]);
  assert.equal(rebuilt.tree.root, second.newRoot);
  assert.equal(rebuilt.appendEvents, 2);
  assert.equal(loadPublicTreeCacheV2({ storage, scope }).tree.root, second.newRoot);
});

test('chain-history rebuild fails closed when an instruction claims the wrong root', async () => {
  const storage = new MemoryStorage();
  const scope = 'test-bad-root';
  const programId = Keypair.generate().publicKey;
  const activeTree = Keypair.generate().publicKey;
  const config = Keypair.generate().publicKey;
  const badData = encodeDepositDataV2({
    commitment: fieldToLe32(321n),
    amount: 1n,
    newRoot: fieldToLe32(654n),
    proof: new Uint8Array(256),
  });
  const connection = {
    async getAccountInfo() {
      return { data: activeTreeData({ config, nextIndex: 1, root: 654n }) };
    },
    async getSignaturesForAddress() { return [{ signature: 'bad', err: null }]; },
    async getTransactions() { return [transaction({ programId, data: badData })]; },
  };
  await assert.rejects(
    rebuildPublicTreeCacheFromChainV2({ connection, programId, activeTree, scope, storage }),
    /root mismatch/,
  );
});
