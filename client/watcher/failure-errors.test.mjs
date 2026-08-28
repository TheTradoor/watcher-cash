import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyWatcherFailure,
  normalizeWatcherFailure,
  watcherFailureMessage,
} from './failure-errors.mjs';

test('classifies wallet rejection without exposing SDK wrappers', () => {
  const cause = Object.assign(new Error('User rejected the request.'), { code: 4001 });
  const error = new Error('WalletSignTransactionError: Unexpected error', { cause });
  const failure = classifyWatcherFailure(error);
  assert.equal(failure.kind, 'wallet_rejected');
  assert.equal(failure.retryable, true);
  assert.equal(failure.uncertain, false);
  assert.match(watcherFailureMessage(error), /Request cancelled in your wallet/);
});

test('classifies expired blockhash as a safe fresh-sign retry', () => {
  const error = new Error('Signature abc has expired: block height exceeded.');
  const failure = classifyWatcherFailure(error);
  assert.equal(failure.kind, 'blockhash_expired');
  assert.equal(failure.retryable, true);
  assert.equal(failure.uncertain, false);
  assert.match(watcherFailureMessage(error), /sign a fresh transaction/);
});

test('classifies transient RPC failures as uncertain', () => {
  const error = new Error('429 Too Many Requests: fetch failed after timeout');
  const failure = classifyWatcherFailure(error);
  assert.equal(failure.kind, 'rpc_transient');
  assert.equal(failure.retryable, true);
  assert.equal(failure.uncertain, true);
  assert.match(watcherFailureMessage(error), /may still be pending/);
});

test('classifies explicit on-chain failures separately from transport failures', () => {
  const error = new Error('Transaction failed on devnet: {"InstructionError":[2,{"Custom":6001}]}');
  const failure = classifyWatcherFailure(error);
  assert.equal(failure.kind, 'transaction_failed');
  assert.equal(failure.retryable, false);
  assert.equal(failure.uncertain, false);
  assert.match(watcherFailureMessage(error), /No partial protocol state was applied/);
});

test('normalization preserves machine-readable failure metadata', () => {
  const normalized = normalizeWatcherFailure(Object.assign(new Error('User denied request'), { code: 4001 }));
  assert.equal(normalized.name, 'WatcherTransportError');
  assert.equal(normalized.watcherFailureKind, 'wallet_rejected');
  assert.equal(normalized.watcherRetryable, true);
  assert.equal(normalized.watcherUncertain, false);
});
