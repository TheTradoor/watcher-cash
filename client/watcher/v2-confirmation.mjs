const DEFAULT_RECONCILE_ATTEMPTS = 24;
const DEFAULT_RECONCILE_DELAY_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function reconcileSignatureStatusV2({
  connection,
  signature,
  attempts = DEFAULT_RECONCILE_ATTEMPTS,
  delayMs = DEFAULT_RECONCILE_DELAY_MS,
  sleepFn = sleep,
} = {}) {
  if (!connection || typeof connection.getSignatureStatuses !== 'function') {
    throw new Error('A Solana connection with getSignatureStatuses is required');
  }
  if (typeof signature !== 'string' || !signature) {
    throw new Error('A transaction signature is required');
  }

  const limit = Math.max(1, Number(attempts) || DEFAULT_RECONCILE_ATTEMPTS);
  const delay = Math.max(0, Number(delayMs) || 0);

  for (let attempt = 0; attempt < limit; attempt += 1) {
    try {
      const response = await connection.getSignatureStatuses(
        [signature],
        { searchTransactionHistory: true },
      );
      const status = response?.value?.[0] || null;

      if (status) {
        if (status.err) {
          return {
            context: { slot: Number(status.slot || 0) },
            value: { err: status.err },
            reconciled: true,
          };
        }

        if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
          return {
            context: { slot: Number(status.slot || 0) },
            value: { err: null },
            reconciled: true,
          };
        }
      }
    } catch {
      // Public devnet RPC can temporarily rate-limit signature status reads.
      // Keep reconciling before deciding an expired blockhash means failure.
    }

    if (attempt + 1 < limit && delay > 0) await sleepFn(delay);
  }

  return null;
}
