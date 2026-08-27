import { asBytes, hexToBytes } from './keccak.mjs';

const DEFAULT_TIMEOUT_MS = 240_000;

function equalBytes(leftValue, rightValue) {
  const left = asBytes(leftValue, 'left bytes');
  const right = asBytes(rightValue, 'right bytes');
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

function normalizeProofResponse(response, expectedPublicInputs, label) {
  if (!response || typeof response !== 'object') {
    throw new TypeError(`${label} prover returned an invalid response`);
  }
  if (typeof response.error === 'string' && response.error) {
    throw new Error(response.error);
  }
  if (typeof response.proofHex !== 'string' || typeof response.publicInputsHex !== 'string') {
    throw new Error(`${label} prover response is missing proof bytes`);
  }
  const proof = hexToBytes(response.proofHex);
  const publicInputs = hexToBytes(response.publicInputsHex);
  if (proof.length !== 256) {
    throw new RangeError(`${label} proof must be exactly 256 bytes`);
  }
  const expected = asBytes(expectedPublicInputs, `${label} expected public inputs`);
  if (!equalBytes(publicInputs, expected)) {
    throw new Error(`${label} prover public inputs do not match the browser-built statement`);
  }
  return Object.freeze({
    ...response,
    proof,
    publicInputs,
  });
}

export class WatcherBrowserProverV1 {
  constructor({
    workerUrl,
    assetBase,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {}) {
    if (typeof Worker !== 'function') {
      throw new Error('Web Workers are unavailable in this browser');
    }
    if (typeof workerUrl !== 'string' || workerUrl.length === 0) {
      throw new TypeError('workerUrl is required');
    }
    if (typeof assetBase !== 'string' || assetBase.length === 0) {
      throw new TypeError('assetBase is required');
    }
    this.workerUrl = workerUrl;
    this.assetBase = assetBase.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
    this.sequence = 0;
    this.pending = new Map();
    this.worker = new Worker(workerUrl);
    this.worker.addEventListener('message', (event) => this.#handleMessage(event));
    this.worker.addEventListener('error', (event) => this.#failAll(
      new Error(event?.message || 'Watcher prover worker crashed'),
    ));
    this.readyPromise = this.#request('init', { assetBase: this.assetBase }, 300_000);
  }

  #handleMessage(event) {
    const payload = event?.data;
    if (!payload || typeof payload.id !== 'number') return;
    const pending = this.pending.get(payload.id);
    if (!pending) return;
    this.pending.delete(payload.id);
    clearTimeout(pending.timer);
    if (payload.ok) pending.resolve(payload.result);
    else pending.reject(new Error(payload.error || 'Watcher prover worker request failed'));
  }

  #failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  #request(type, payload = {}, timeoutMs = this.timeoutMs) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${type} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, type, ...payload });
    });
  }

  async ready() {
    return this.readyPromise;
  }

  async proveDeposit(witness, expectedPublicInputs) {
    await this.ready();
    const response = await this.#request('proveDeposit', { witness });
    return normalizeProofResponse(response, expectedPublicInputs, 'deposit');
  }

  async proveWithdraw(witness, expectedPublicInputs) {
    await this.ready();
    const response = await this.#request('proveWithdraw', { witness });
    return normalizeProofResponse(response, expectedPublicInputs, 'withdrawal');
  }

  terminate() {
    this.#failAll(new Error('Watcher prover was terminated'));
    this.worker.terminate();
  }
}

export function createWatcherBrowserProverV1(options) {
  return new WatcherBrowserProverV1(options);
}
