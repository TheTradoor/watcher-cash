import test from 'node:test';
import assert from 'node:assert/strict';

import { recipientBindingBytesV1, withdrawContextBindingV1 } from './bindings.mjs';

function fixed(value) {
  return new Uint8Array(32).fill(value);
}

function hex(value) {
  return Buffer.from(value).toString('hex');
}

test('recipient binding matches the Rust development fixture', async () => {
  const binding = await recipientBindingBytesV1(fixed(7));
  assert.equal(
    hex(binding.bytes),
    '9aab992c0da2c09036f03213a555c11a8034ee94234b0a5b4c5fcd624334da1f',
  );
});

test('withdraw context binds program, config, vault, relayer, treasury and SOL asset', async () => {
  const binding = await withdrawContextBindingV1({
    programId: fixed(42),
    config: fixed(43),
    vault: Uint8Array.from(
      Buffer.from('5300975dd0c07b8bc9071d94ad6fcd4d6e87b5f1ef54e18dd96f6542ba5531f1', 'hex'),
    ),
    relayer: fixed(44),
    treasury: fixed(45),
    assetId: 1n,
  });
  assert.equal(
    hex(binding.bytes),
    'b676b04ac36e79d23531ba0835dfec95c8ae1d5975398610b2d588c4aceb4718',
  );
});
