// Watcher Protocol SDK skeleton.
// Clean-room implementation boundary: this module must not import privacycash.
// Cryptographic functions intentionally fail closed until a proof stack is selected and audited.

export const WATCHER_PROTOCOL_VERSION = 1;
export const WATCHER_DOMAINS = Object.freeze({
  note: 'WATCHER_NOTE_V1',
  commitment: 'WATCHER_COMMITMENT_V1',
  nullifier: 'WATCHER_NULLIFIER_V1',
  merkle: 'WATCHER_MERKLE_V1',
});

export class WatcherProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WatcherProtocolError';
    this.code = code;
  }
}

export function assertBaseUnits(value, label = 'amount') {
  if (typeof value !== 'bigint' || value < 0n) {
    throw new WatcherProtocolError('INVALID_AMOUNT', `${label} must be a non-negative bigint in base units.`);
  }
  return value;
}

export function calculateWithdrawalValue({ inputs, publicOutput, privateChange, protocolFee, relayerFee }) {
  const inputTotal = inputs.reduce((sum, value) => sum + assertBaseUnits(value, 'input'), 0n);
  const output = assertBaseUnits(publicOutput, 'publicOutput');
  const change = assertBaseUnits(privateChange, 'privateChange');
  const fee = assertBaseUnits(protocolFee, 'protocolFee');
  const relay = assertBaseUnits(relayerFee, 'relayerFee');
  const outputTotal = output + change + fee + relay;

  if (inputTotal !== outputTotal) {
    throw new WatcherProtocolError(
      'VALUE_CONSERVATION_FAILED',
      `Private inputs (${inputTotal}) must equal public output + change + fees (${outputTotal}).`,
    );
  }

  return Object.freeze({ inputTotal, outputTotal });
}

export function calculateProtocolFee(amount, basisPoints, minimumFee = 0n) {
  assertBaseUnits(amount);
  assertBaseUnits(minimumFee, 'minimumFee');
  if (!Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > 10_000) {
    throw new WatcherProtocolError('INVALID_FEE_RATE', 'basisPoints must be an integer between 0 and 10000.');
  }
  const percentageFee = (amount * BigInt(basisPoints)) / 10_000n;
  return percentageFee > minimumFee ? percentageFee : minimumFee;
}

export function createNoteDraft({ asset, amount, ownerKey, blinding, nonce }) {
  if (!asset || typeof asset !== 'string') throw new WatcherProtocolError('INVALID_ASSET', 'asset is required.');
  assertBaseUnits(amount);
  if (!(ownerKey instanceof Uint8Array) || ownerKey.length === 0) throw new WatcherProtocolError('INVALID_OWNER_KEY', 'ownerKey bytes are required.');
  if (!(blinding instanceof Uint8Array) || blinding.length < 16) throw new WatcherProtocolError('INVALID_BLINDING', 'blinding must contain at least 16 bytes.');
  if (!(nonce instanceof Uint8Array) || nonce.length < 16) throw new WatcherProtocolError('INVALID_NONCE', 'nonce must contain at least 16 bytes.');

  return Object.freeze({
    version: WATCHER_PROTOCOL_VERSION,
    asset,
    amount,
    ownerKey: new Uint8Array(ownerKey),
    blinding: new Uint8Array(blinding),
    nonce: new Uint8Array(nonce),
  });
}

function cryptoNotFinalized(operation) {
  throw new WatcherProtocolError(
    'CRYPTO_NOT_FINALIZED',
    `${operation} is disabled until Watcher Protocol freezes an audited hash/proof construction.`,
  );
}

export function deriveCommitment() { return cryptoNotFinalized('Commitment derivation'); }
export function deriveNullifier() { return cryptoNotFinalized('Nullifier derivation'); }
export function proveWithdrawal() { return cryptoNotFinalized('Withdrawal proof generation'); }
export function verifyWithdrawalProof() { return cryptoNotFinalized('Withdrawal proof verification'); }

export class WatcherClient {
  constructor({ rpcUrl, relayerUrl = null } = {}) {
    if (!rpcUrl) throw new WatcherProtocolError('RPC_REQUIRED', 'rpcUrl is required.');
    this.rpcUrl = rpcUrl;
    this.relayerUrl = relayerUrl;
  }

  async getPrivateBalance() { return cryptoNotFinalized('Private balance scanning'); }
  async buildDeposit() { return cryptoNotFinalized('Deposit construction'); }
  async quoteWithdrawal() { return cryptoNotFinalized('Withdrawal quoting'); }
  async withdraw() { return cryptoNotFinalized('Withdrawal'); }
}
