import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getBrowserProverV3,
  proveDepositWithBrowserProverV3,
  proveWithdrawWithBrowserProverV3,
} from './browser-prover-v3.mjs';
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
    this.circuit = '';
    FakeWorker.instances.push(this);
  }

  postMessage(message) {
    queueMicrotask(() => {
      if (message.type === 'init') {
        this.circuit = message.payload.circuit;
        this.onmessage?.({ data: {
          id: message.id,
          type: 'ready',
          payload: {
            status: 'ready',
            version: 3,
            circuit: this.circuit,
            bundleDigest: '33'.repeat(32),
          },
        } });
        return;
      }
      if (message.type === 'prove') {
        assert.equal(message.payload.circuit, this.circuit);
        const bytes = this.circuit === 'deposit'
          ? DEPOSIT_PUBLIC_INPUT_BYTES_V2
          : WITHDRAW_PUBLIC_INPUT_BYTES_V2;
        this.onmessage?.({ data: {
          id: message.id,
          type: 'result',
          payload: {
            circuit: `${this.circuit}-v2`,
            proofHex: '22'.repeat(256),
            publicInputsHex: hex(message.payload.witness.__expectedPublicInputs),
            proofBytes: 256,
            publicInputBytes: bytes,
            bundleDigest: '33'.repeat(32),
          },
        } });
      }
    });
  }

  terminate() { this.terminated = true; }
}

test('V3 browser prover uses separate workers for deposit and withdraw circuits', async () => {
  const previousWorker = globalThis.Worker;
  globalThis.Worker = FakeWorker;
  const basePath = '/watcher-prover-v3-circuit-test';
  try {
    const depositInputs = Uint8Array.from({ length: DEPOSIT_PUBLIC_INPUT_BYTES_V2 }, (_, index) => index & 0xff);
    const withdrawInputs = Uint8Array.from({ length: WITHDRAW_PUBLIC_INPUT_BYTES_V2 }, (_, index) => (index * 5) & 0xff);

    const deposit = await proveDepositWithBrowserProverV3({
      basePath,
      witness: { __expectedPublicInputs: depositInputs },
      expectedPublicInputs: depositInputs,
    });
    const withdrawal = await proveWithdrawWithBrowserProverV3({
      basePath,
      witness: { __expectedPublicInputs: withdrawInputs },
      expectedPublicInputs: withdrawInputs,
    });

    assert.equal(deposit.proof.length, 256);
    assert.equal(withdrawal.proof.length, 256);
    assert.equal(FakeWorker.instances.length, 2);
    const names = FakeWorker.instances.map((worker) => worker.options.name).sort();
    assert.deepEqual(names, [
      'watcher-browser-prover-v3-deposit',
      'watcher-browser-prover-v3-withdraw',
    ]);
    assert.ok(FakeWorker.instances.every((worker) => worker.url === `${basePath}/worker.js`));
  } finally {
    getBrowserProverV3({ basePath }).terminate();
    globalThis.Worker = previousWorker;
    FakeWorker.instances.length = 0;
  }
});
