import { asBytes, hexToBytes } from './keccak.mjs';
import {
  DEPOSIT_PUBLIC_INPUT_BYTES_V1,
  WITHDRAW_PUBLIC_INPUT_BYTES_V1,
  XARK_PROOF_BYTES_V1,
} from './instructions.mjs';

export const DEFAULT_LOCAL_PROVER_URL_V1 = 'http://127.0.0.1:8090';

function endpointURL(base, path) {
  const normalized = String(base || DEFAULT_LOCAL_PROVER_URL_V1).replace(/\/+$/, '');
  return `${normalized}${path}`;
}

function equalBytes(left, right) {
  const a = asBytes(left, 'left bytes');
  const b = asBytes(right, 'right bytes');
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

async function parseResponse(response) {
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`local prover returned invalid JSON (HTTP ${response.status})`);
  }
  if (!response.ok) {
    throw new Error(payload.error || `local prover failed with HTTP ${response.status}`);
  }
  return payload;
}

async function requestLocalProofV1({
  endpoint = DEFAULT_LOCAL_PROVER_URL_V1,
  path,
  witness,
  expectedPublicInputs,
  expectedPublicInputBytes,
  fetchImpl = globalThis.fetch,
}) {
  if (typeof fetchImpl !== 'function') throw new Error('Fetch API is unavailable');
  if (!witness || typeof witness !== 'object') throw new TypeError('witness is required');
  const expected = asBytes(expectedPublicInputs, 'expectedPublicInputs');
  if (expected.length !== expectedPublicInputBytes) {
    throw new RangeError(`expectedPublicInputs must be ${expectedPublicInputBytes} bytes`);
  }

  const response = await fetchImpl(endpointURL(endpoint, path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(witness),
  });
  const payload = await parseResponse(response);
  const proof = hexToBytes(payload.proofHex || '');
  const publicInputs = hexToBytes(payload.publicInputsHex || '');
  if (proof.length !== XARK_PROOF_BYTES_V1 || payload.proofBytes !== XARK_PROOF_BYTES_V1) {
    throw new Error(`local prover returned a ${proof.length}-byte proof; expected ${XARK_PROOF_BYTES_V1}`);
  }
  if (publicInputs.length !== expectedPublicInputBytes || payload.publicInputBytes !== expectedPublicInputBytes) {
    throw new Error(
      `local prover returned ${publicInputs.length} public-input bytes; expected ${expectedPublicInputBytes}`,
    );
  }
  if (!equalBytes(publicInputs, expected)) {
    throw new Error('local prover public inputs do not match the client-built statement');
  }
  if (typeof payload.bundleDigest !== 'string' || !/^[0-9a-f]{64}$/i.test(payload.bundleDigest)) {
    throw new Error('local prover did not identify its matched proving bundle');
  }
  return {
    circuit: payload.circuit,
    proof,
    publicInputs,
    bundleDigest: payload.bundleDigest.toLowerCase(),
  };
}

export async function checkLocalProverV1({
  endpoint = DEFAULT_LOCAL_PROVER_URL_V1,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('Fetch API is unavailable');
  const response = await fetchImpl(endpointURL(endpoint, '/healthz'), { method: 'GET' });
  const payload = await parseResponse(response);
  if (payload.status !== 'ready' || !Array.isArray(payload.circuits)) {
    throw new Error('local prover is not ready');
  }
  return payload;
}

export function proveDepositWithLocalProverV1({
  witness,
  expectedPublicInputs,
  endpoint,
  fetchImpl,
}) {
  return requestLocalProofV1({
    endpoint,
    path: '/v1/prove/deposit',
    witness,
    expectedPublicInputs,
    expectedPublicInputBytes: DEPOSIT_PUBLIC_INPUT_BYTES_V1,
    fetchImpl,
  });
}

export function proveWithdrawWithLocalProverV1({
  witness,
  expectedPublicInputs,
  endpoint,
  fetchImpl,
}) {
  return requestLocalProofV1({
    endpoint,
    path: '/v1/prove/withdraw',
    witness,
    expectedPublicInputs,
    expectedPublicInputBytes: WITHDRAW_PUBLIC_INPUT_BYTES_V1,
    fetchImpl,
  });
}
