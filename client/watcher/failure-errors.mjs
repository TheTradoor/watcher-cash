function collectErrorParts(error, depth = 0, seen = new Set()) {
  if (error == null || depth > 4) return [];
  if (typeof error === 'string' || typeof error === 'number') return [String(error)];
  if (typeof error !== 'object' || seen.has(error)) return [];
  seen.add(error);

  const parts = [];
  for (const key of ['name', 'message', 'code']) {
    const value = error[key];
    if (value !== undefined && value !== null && String(value).trim()) parts.push(String(value));
  }
  for (const key of ['cause', 'error', 'data']) {
    parts.push(...collectErrorParts(error[key], depth + 1, seen));
  }
  return parts;
}

function cleanOriginalMessage(error) {
  const parts = collectErrorParts(error);
  const message = parts.find((value) => !/^(error|wallet.*error|\d+)$/i.test(value.trim()))
    || error?.message
    || String(error || 'Unknown error');
  return String(message)
    .replace(/^WalletSendTransactionError:\s*/i, '')
    .replace(/^WalletSignTransactionError:\s*/i, '')
    .replace(/^WalletSignMessageError:\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .replace('Transaction simulation failed: ', 'Simulation failed: ')
    .trim();
}

export function classifyWatcherFailure(error) {
  const parts = collectErrorParts(error);
  const text = parts.join(' | ').toLowerCase();
  const numericCode = Number(error?.code ?? error?.cause?.code ?? error?.error?.code);

  if (
    numericCode === 4001
    || /user rejected|user denied|rejected the request|request rejected|declined|cancelled by user|canceled by user/.test(text)
  ) {
    return {
      kind: 'wallet_rejected',
      retryable: true,
      uncertain: false,
      tone: 'info',
      original: cleanOriginalMessage(error),
    };
  }

  if (
    /block height exceeded|blockheight exceeded|blockhash not found|blockhash expired|transactionexpiredblockheightexceeded|signature .* expired/.test(text)
  ) {
    return {
      kind: 'blockhash_expired',
      retryable: true,
      uncertain: false,
      tone: 'info',
      original: cleanOriginalMessage(error),
    };
  }

  if (
    /429|too many requests|fetch failed|failed to fetch|network|timeout|timed out|temporar|econnreset|etimedout|socket hang up|service unavailable|gateway timeout/.test(text)
  ) {
    return {
      kind: 'rpc_transient',
      retryable: true,
      uncertain: true,
      tone: 'info',
      original: cleanOriginalMessage(error),
    };
  }

  if (
    /transaction failed on devnet|simulation failed|transaction simulation failed|instructionerror|custom program error/.test(text)
  ) {
    return {
      kind: 'transaction_failed',
      retryable: false,
      uncertain: false,
      tone: 'error',
      original: cleanOriginalMessage(error),
    };
  }

  return {
    kind: 'unknown',
    retryable: false,
    uncertain: true,
    tone: 'error',
    original: cleanOriginalMessage(error),
  };
}

export function watcherFailureMessage(error) {
  const failure = classifyWatcherFailure(error);
  switch (failure.kind) {
    case 'wallet_rejected':
      return 'Request cancelled in your wallet. Nothing was signed or submitted. You can try again.';
    case 'blockhash_expired':
      return 'Transaction expired before confirmation. No confirmed on-chain result was found; retry to sign a fresh transaction.';
    case 'rpc_transient':
      return 'Temporary RPC/network issue. A signed transaction may still be pending; refresh the private balance before trying again.';
    case 'transaction_failed':
      return `Devnet rejected the transaction. No partial protocol state was applied.${failure.original ? ` ${failure.original}` : ''}`;
    default:
      return failure.original || 'Unexpected wallet or RPC error';
  }
}

export function normalizeWatcherFailure(error) {
  if (error?.watcherFailureKind) return error;
  const failure = classifyWatcherFailure(error);
  const normalized = new Error(watcherFailureMessage(error), { cause: error });
  normalized.name = 'WatcherTransportError';
  normalized.watcherFailureKind = failure.kind;
  normalized.watcherRetryable = failure.retryable;
  normalized.watcherUncertain = failure.uncertain;
  return normalized;
}
