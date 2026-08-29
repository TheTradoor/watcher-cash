import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair } from '@solana/web3.js';

import { fieldToLe32 } from './field.mjs';
import { ACTIVE_TREE_ACCOUNT_LEN_V2, decodeActiveTreeV2 } from './state-v2.mjs';

function u32(value) {
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function u64(value) {
  let remaining = BigInt(value);
  const bytes = new Uint8Array(8);
  for (let index = 0; index < 8; index += 1) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return bytes;
}

test('decodes populated V2 active tree state', () => {
  const data = new Uint8Array(ACTIVE_TREE_ACCOUNT_LEN_V2);
  const config = Keypair.generate().publicKey;
  data[0] = 2;
  data.set(config.toBytes(), 1);
  data.set(u64(7n), 33);
  data.set(u32(9), 41);
  data.set(fieldToLe32(123n), 45);
  data[77] = 1;
  data[78] = 1;
  data.set(fieldToLe32(99n), 79);

  const decoded = decodeActiveTreeV2(data);
  assert.equal(decoded.version, 2);
  assert(decoded.config.equals(config));
  assert.equal(decoded.epoch, 7n);
  assert.equal(decoded.nextIndex, 9);
  assert.equal(decoded.currentRoot, 123n);
  assert.deepEqual(decoded.recentRoots, [99n]);
});

test('accepts canonical empty V2 active tree', () => {
  const data = new Uint8Array(ACTIVE_TREE_ACCOUNT_LEN_V2);
  data[0] = 2;
  data.set(Keypair.generate().publicKey.toBytes(), 1);
  const decoded = decodeActiveTreeV2(data);
  assert.equal(decoded.nextIndex, 0);
  assert.equal(decoded.currentRoot, 0n);
});

test('rejects populated V2 tree with zero current root', () => {
  const data = new Uint8Array(ACTIVE_TREE_ACCOUNT_LEN_V2);
  data[0] = 2;
  data.set(Keypair.generate().publicKey.toBytes(), 1);
  data.set(u32(1), 41);
  assert.throws(() => decodeActiveTreeV2(data), /zero root/);
});
