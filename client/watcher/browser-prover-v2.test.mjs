import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getBrowserProverV2,
  proveDepositWithBrowserProverV2,
  proveWithdrawWithBrowserProverV2,
} from './browser-prover-v2.mjs';
import {
  DEPOSIT_PUBLIC_INPUT_BYTES_V2,
  WITHDRAW_PUBLIC_INPUT_BYTES_V2,
} from './public-inputs-v2.mjs';

function hex(bytes) {
  return Buffer.from(bytes).toString('hex');
}

class FakeWorker {
  static instances = [];

  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.onmessage = null;
    this.onerror = null;
    this.terminated = false;
    FakeWorker.instances.push(this);
  }

  postMessage(message) {
    queueMicrotask(() => {
      if (message.type === 'init') {
        this.onmessage?.({ data: {
          id: message.id,
          type: 'ready',
          payload: {
            status: 'ready',
            version: 2,
            bundleDigest: '11'.repeat(32),
            circuits: ['deposit-v2', 'withdraw-v2'],
          },
        } });
        return;
      }
      if (message.type === 'prove') {
        const bytes = message.payload.circuit === 'deposit'
          ? DEPOSIT_PUBLIC_INPUT_BYTES_V2
          : WITHDRAW_PUBLIC_INPUT_BYTES_V2;
        this.onmessage?.({ data: {
          id: message.id,
          type: 'result',
          payload: {
            circuit: `${message.payload.circuit}-v2`,
            proofHex: '22'.repeat(256),
            publicInputsHex: hex(message.payload.witness.__expectedPublicInputs),
            proofBytes: 256,
            publicInputBytes: bytes,
            bundleDigest: '11'.repeat(32),
          },
        } });
      }
    });
  }

  terminate() {
    this.terminated = true;
  }
}

test('V2 browser prover uses an isolated worker path and validates deposit proof bytes', async () => {
  const previousWorker = globalThis.Worker;
  globalThis.Worker = FakeWorker;
  try {
    const expected = Uint8Array.from({ length: DEPOSIT_PUBLIC_INPUT_BYTES_V2 }, (_, index) => index & 0xff);
    const result = await proveDepositWithBrowserProverV2({
      basePath: '/watcher-prover-v2-test',
      witness: { __expectedPublicInputs: expected },
      expectedPublicInputs: expected,
    });
    assert.equal(result.proof.length, 256);
    assert.deepEqual(result.publicInputs, expected);
    assert.equal(FakeWorker.instances.at(-1).url, '/watcher-prover-v2-test/worker.js');
    assert.equal(FakeWorker.instances.at(-1).options.name, 'watcher-browser-prover-v2');
  } finally {
    getBrowserProverV2({ basePath: '/watcher-prover-v2-test' }).terminate();
    globalThis.Worker = previousWorker;
  }
});

test('V2 browser prover accepts the 19-field withdrawal public witness', async () => {
  const previousWorker = globalThis.Worker;
  globalThis.Worker = FakeWorker;
  try {
    const expected = Uint8Array.from({ length: WITHDRAW_PUBLIC_INPUT_BYTES_V2 }, (_, index) => (index * 7) & 0xff);
    const result = await proveWithdrawWithBrowserProverV2({
      basePath: '/watcher-prover-v2-withdraw-test',
      witness: { __expectedPublicInputs: expected },
      expectedPublicInputs: expected,
    });
    assert.equal(result.publicInputs.length, WITHDRAW_PUBLIC_INPUT_BYTES_V2);
    assert.equal(result.bundleDigest, '11'.repeat(32));
  } finally {
    getBrowserProverV2({ basePath: '/watcher-prover-v2-withdraw-test' }).terminate();
    globalThis.Worker = previousWorker;
  }
});

test('V2 browser prover rejects public inputs that do not match the client statement', async () => {
  const previousWorker = globalThis.Worker;
  globalThis.Worker = FakeWorker;
  try {
    const expected = new Uint8Array(DEPOSIT_PUBLIC_INPUT_BYTES_V2);
    const returned = new Uint8Array(DEPOSIT_PUBLIC_INPUT_BYTES_V2);
    returned[0] = 1;
    await assert.rejects(
      proveDepositWithBrowserProverV2({
        basePath: '/watcher-prover-v2-mismatch-test',
        witness: { __expectedPublicInputs: returned },
        expectedPublicInputs: expected,
      }),
      /public inputs do not match/,
    );
  } finally {
    getBrowserProverV2({ basePath: '/watcher-prover-v2-mismatch-test' }).terminate();
    globalThis.Worker = previousWorker;
  }
});
