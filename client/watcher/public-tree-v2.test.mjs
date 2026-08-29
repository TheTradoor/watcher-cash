import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair } from '@solana/web3.js';

import { fieldToLe32 } from './field.mjs';
import { getMerkleAppendTransitionV2 } from './merkle-v2.mjs';
import {
  appendPublicTreeCacheV2,
  loadPublicTreeCacheV2,
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
