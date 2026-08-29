import {
  DEPOSIT_PUBLIC_INPUT_BYTES_V2,
  WITHDRAW_PUBLIC_INPUT_BYTES_V2,
} from './public-inputs-v2.mjs';
import { validateProofPayloadV1 } from './prover.mjs';

export const DEFAULT_BROWSER_PROVER_BASE_V3 = '/watcher-prover-v3';

function normalizeBasePath(value) {
  const text = String(value || DEFAULT_BROWSER_PROVER_BASE_V3).trim();
  return (text || DEFAULT_BROWSER_PROVER_BASE_V3).replace(/\/+$/, '');
}

function requireCircuit(value) {
  const circuit = String(value || '');
  if (circuit !== 'deposit' && circuit !== 'withdraw') throw new Error(`Unsupported V3 browser circuit: ${circuit}`);
  return circuit;
}

async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (value) => value.toString(16).padStart(2, '0')).join('');
}

export async function checkBrowserProverManifestV3({
  basePath = DEFAULT_BROWSER_PROVER_BASE_V3,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('Fetch API is unavailable');
  if (!globalThis.crypto?.subtle) throw new Error('Web Crypto SHA-256 is unavailable');
  const base = normalizeBasePath(basePath);
  const response = await fetchImpl(`${base}/assets/manifest.json`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`V3 proving bundle manifest failed with HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('V3 proving bundle manifest is not valid JSON');
  }
  if (Number(manifest.version) !== 2 || manifest.curve !== 'BN254' || manifest.scheme !== 'Groth16') {
    throw new Error('V3 proving bundle manifest does not describe the expected BN254 Groth16 setup');
  }
  if (Number(manifest.merkleDepth) !== 16 || Number(manifest.maxInputs) !== 4) {
    throw new Error('V3 proving bundle manifest has unexpected circuit dimensions');
  }
  const checksums = manifest.filesSha256 || manifest.files_sha256 || manifest.files || {};
  for (const name of [
    'deposit.r1cs', 'deposit.pk', 'deposit.vk',
    'withdraw.r1cs', 'withdraw.pk', 'withdraw.vk',
  ]) {
    if (!/^[0-9a-f]{64}$/i.test(String(checksums[name] || ''))) {
      throw new Error(`V3 proving bundle manifest is missing SHA-256 for ${name}`);
    }
  }
  return {
    status: 'ready',
    version: 3,
    curve: 'BN254',
    scheme: 'Groth16',
    bundleDigest: await sha256Hex(bytes),
    circuits: ['deposit-v2', 'withdraw-v2'],
  };
}

class CircuitWorkerV3 {
  constructor(basePath, circuit) {
    this.basePath = normalizeBasePath(basePath);
    this.circuit = requireCircuit(circuit);
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
      try { listener({ circuit: this.circuit, ...payload }); } catch {}
    }
  }

  ensureWorker() {
    if (this.worker) return;
    if (typeof Worker !== 'function') throw new Error('Web Workers are unavailable in this browser');
    this.worker = new Worker(`${this.basePath}/worker.js`, {
      name: `watcher-browser-prover-v3-${this.circuit}`,
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
      if (message.type === 'error') pending.reject(new Error(message.error || `V3 ${this.circuit} prover failed`));
      else pending.resolve(message.payload);
    };
    this.worker.onerror = (event) => {
      const error = new Error(event?.message || `V3 ${this.circuit} prover worker crashed`);
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
      this.worker.postMessage({
        id,
        type,
        payload: { ...payload, basePath: this.basePath, circuit: this.circuit },
      });
    });
  }

  initialize({ onProgress } = {}) {
    const remove = this.addProgressListener(onProgress);
    if (!this.ready) {
      this.ready = this.request('init').catch((error) => {
        this.ready = null;
        throw error;
      });
    }
    return this.ready.finally(remove);
  }

  async prove({ witness, expectedPublicInputs, onProgress } = {}) {
    const remove = this.addProgressListener(onProgress);
    try {
      await this.initialize();
      const payload = await this.request('prove', { witness });
      return validateProofPayloadV1({
        payload,
        expectedPublicInputs,
        expectedPublicInputBytes: this.circuit === 'deposit'
          ? DEPOSIT_PUBLIC_INPUT_BYTES_V2
          : WITHDRAW_PUBLIC_INPUT_BYTES_V2,
        source: `V3 ${this.circuit} browser prover`,
      });
    } finally {
      remove();
    }
  }

  terminate() {
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
    const error = new Error(`V3 ${this.circuit} browser prover was terminated`);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

class BrowserProverV3 {
  constructor(basePath) {
    this.basePath = normalizeBasePath(basePath);
    this.circuits = new Map();
  }

  circuit(name) {
    const circuit = requireCircuit(name);
    let instance = this.circuits.get(circuit);
    if (!instance) {
      instance = new CircuitWorkerV3(this.basePath, circuit);
      this.circuits.set(circuit, instance);
    }
    return instance;
  }

  initialize(circuit, options = {}) {
    return this.circuit(circuit).initialize(options);
  }

  prove(circuit, options = {}) {
    return this.circuit(circuit).prove(options);
  }

  terminate() {
    for (const circuit of this.circuits.values()) circuit.terminate();
    this.circuits.clear();
  }
}

const instances = new Map();

export function getBrowserProverV3({ basePath = DEFAULT_BROWSER_PROVER_BASE_V3 } = {}) {
  const normalized = normalizeBasePath(basePath);
  let instance = instances.get(normalized);
  if (!instance) {
    instance = new BrowserProverV3(normalized);
    instances.set(normalized, instance);
  }
  return instance;
}

export function checkBrowserProverV3({ basePath, circuit = 'deposit', onProgress } = {}) {
  return getBrowserProverV3({ basePath }).initialize(circuit, { onProgress });
}

export function prewarmBrowserProverV3({ basePath, circuit = 'deposit', onProgress } = {}) {
  return checkBrowserProverV3({ basePath, circuit, onProgress });
}

export function proveDepositWithBrowserProverV3({ witness, expectedPublicInputs, basePath, onProgress }) {
  return getBrowserProverV3({ basePath }).prove('deposit', { witness, expectedPublicInputs, onProgress });
}

export function proveWithdrawWithBrowserProverV3({ witness, expectedPublicInputs, basePath, onProgress }) {
  return getBrowserProverV3({ basePath }).prove('withdraw', { witness, expectedPublicInputs, onProgress });
}
