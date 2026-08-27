import {
  DEPOSIT_INSTRUCTION_PUBLIC_INPUT_BYTES_V1,
  WITHDRAW_PUBLIC_INPUT_BYTES_V1,
} from './instructions.mjs';
import { validateProofPayloadV1 } from './prover.mjs';

export const DEFAULT_BROWSER_PROVER_BASE_V1 = '/watcher-prover';

function normalizeBasePath(value) {
  const text = String(value || DEFAULT_BROWSER_PROVER_BASE_V1).trim();
  if (!text) return DEFAULT_BROWSER_PROVER_BASE_V1;
  return text.replace(/\/+$/, '');
}

class BrowserProverV1 {
  constructor(basePath) {
    this.basePath = normalizeBasePath(basePath);
    this.worker = null;
    this.ready = null;
    this.sequence = 0;
    this.pending = new Map();
    this.progressListeners = new Set();
  }

  addProgressListener(listener) {
    if (typeof listener !== 'function') return () => {};
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  emitProgress(payload) {
    for (const listener of this.progressListeners) {
      try {
        listener(payload);
      } catch {
        // Progress reporting must never break proving.
      }
    }
  }

  ensureWorker() {
    if (this.worker) return;
    if (typeof Worker !== 'function') {
      throw new Error('Web Workers are unavailable in this browser');
    }
    this.worker = new Worker(`${this.basePath}/worker.js`, {
      name: 'watcher-browser-prover-v1',
    });
    this.worker.onmessage = (event) => {
      const message = event.data || {};
      if (message.type === 'progress') {
        this.emitProgress(message.payload || {});
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.type === 'error') {
        pending.reject(new Error(message.error || 'Browser prover failed'));
      } else {
        pending.resolve(message.payload);
      }
    };
    this.worker.onerror = (event) => {
      const error = new Error(event?.message || 'Browser prover worker crashed');
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.ready = null;
    };
  }

  request(type, payload = {}) {
    this.ensureWorker();
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, payload });
    });
  }

  initialize({ onProgress } = {}) {
    const remove = this.addProgressListener(onProgress);
    if (!this.ready) {
      this.ready = this.request('init', { basePath: this.basePath }).catch((error) => {
        this.ready = null;
        throw error;
      });
    }
    return this.ready.finally(remove);
  }

  async proveDeposit({ witness, expectedPublicInputs, onProgress } = {}) {
    const remove = this.addProgressListener(onProgress);
    try {
      await this.initialize();
      const payload = await this.request('prove', { circuit: 'deposit', witness });
      return validateProofPayloadV1({
        payload,
        expectedPublicInputs,
        expectedPublicInputBytes: DEPOSIT_INSTRUCTION_PUBLIC_INPUT_BYTES_V1,
        source: 'browser prover',
      });
    } finally {
      remove();
    }
  }

  async proveWithdraw({ witness, expectedPublicInputs, onProgress } = {}) {
    const remove = this.addProgressListener(onProgress);
    try {
      await this.initialize();
      const payload = await this.request('prove', { circuit: 'withdraw', witness });
      return validateProofPayloadV1({
        payload,
        expectedPublicInputs,
        expectedPublicInputBytes: WITHDRAW_PUBLIC_INPUT_BYTES_V1,
        source: 'browser prover',
      });
    } finally {
      remove();
    }
  }

  terminate() {
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
    const error = new Error('Browser prover was terminated');
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

const instances = new Map();

export function getBrowserProverV1({ basePath = DEFAULT_BROWSER_PROVER_BASE_V1 } = {}) {
  const normalized = normalizeBasePath(basePath);
  let instance = instances.get(normalized);
  if (!instance) {
    instance = new BrowserProverV1(normalized);
    instances.set(normalized, instance);
  }
  return instance;
}

export async function checkBrowserProverV1({ basePath, onProgress } = {}) {
  return getBrowserProverV1({ basePath }).initialize({ onProgress });
}

export function proveDepositWithBrowserProverV1({
  witness,
  expectedPublicInputs,
  basePath,
  onProgress,
}) {
  return getBrowserProverV1({ basePath }).proveDeposit({
    witness,
    expectedPublicInputs,
    onProgress,
  });
}

export function proveWithdrawWithBrowserProverV1({
  witness,
  expectedPublicInputs,
  basePath,
  onProgress,
}) {
  return getBrowserProverV1({ basePath }).proveWithdraw({
    witness,
    expectedPublicInputs,
    onProgress,
  });
}
