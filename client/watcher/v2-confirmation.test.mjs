import assert from 'node:assert/strict';
import test from 'node:test';

import { reconcileSignatureStatusV2 } from './v2-confirmation.mjs';

function connectionWithStatuses(statuses) {
  let index = 0;
  return {
    async getSignatureStatuses() {
      const value = statuses[Math.min(index, statuses.length - 1)];
      index += 1;
      if (value instanceof Error) throw value;
      return { value: [value] };
    },
  };
}

test('reconciles an eventually confirmed signature after transient misses', async () => {
  const connection = connectionWithStatuses([
    null,
    null,
    { slot: 42, err: null, confirmationStatus: 'confirmed' },
  ]);

  const result = await reconcileSignatureStatusV2({
    connection,
    signature: 'sig-confirmed',
    attempts: 4,
    delayMs: 0,
  });

  assert.deepEqual(result, {
    context: { slot: 42 },
    value: { err: null },
    reconciled: true,
  });
});

test('returns the on-chain transaction error when the signature landed unsuccessfully', async () => {
  const chainError = { InstructionError: [2, 'Custom'] };
  const connection = connectionWithStatuses([
    { slot: 77, err: chainError, confirmationStatus: 'confirmed' },
  ]);

  const result = await reconcileSignatureStatusV2({
    connection,
    signature: 'sig-failed',
    attempts: 1,
    delayMs: 0,
  });

  assert.deepEqual(result, {
    context: { slot: 77 },
    value: { err: chainError },
    reconciled: true,
  });
});

test('returns null when no landed signature can be found', async () => {
  const connection = connectionWithStatuses([
    null,
    new Error('temporary RPC rate limit'),
    null,
  ]);

  const result = await reconcileSignatureStatusV2({
    connection,
    signature: 'sig-missing',
    attempts: 3,
    delayMs: 0,
  });

  assert.equal(result, null);
});
