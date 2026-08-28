import { asBytes, concatBytes } from './keccak.mjs';
import { assertFieldV1, fieldFromLe32, fieldToLe32 } from './field.mjs';

const encoder = new TextEncoder();

function exact32(value, label) {
  const bytes = asBytes(value, label);
  if (bytes.length !== 32) throw new RangeError(`${label} must be exactly 32 bytes`);
  return bytes;
}

async function sha256ToFieldV2(domain, parts) {
  if (!globalThis.crypto?.subtle) throw new Error('Web Crypto SHA-256 is unavailable');
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest(
      'SHA-256',
      concatBytes(encoder.encode(domain), ...parts.map((part) => asBytes(part))),
    ),
  );
  digest[31] &= 0x1f;
  return Object.freeze({
    bytes: digest,
    field: fieldFromLe32(digest, `${domain} binding`),
  });
}

export async function recipientBindingV2(recipient) {
  return sha256ToFieldV2('watcher-recipient-v2', [exact32(recipient, 'recipient')]);
}

export async function depositContextBindingV2({
  programId,
  config,
  vault,
  activeTree,
  assetId = 1n,
}) {
  return sha256ToFieldV2('watcher-deposit-context-v2', [
    exact32(programId, 'programId'),
    exact32(config, 'config'),
    exact32(vault, 'vault'),
    exact32(activeTree, 'activeTree'),
    fieldToLe32(assertFieldV1(assetId, 'assetId')),
  ]);
}

export async function withdrawContextBindingV2({
  programId,
  config,
  vault,
  activeTree,
  relayer,
  treasury,
  assetId = 1n,
}) {
  return sha256ToFieldV2('watcher-withdraw-context-v2', [
    exact32(programId, 'programId'),
    exact32(config, 'config'),
    exact32(vault, 'vault'),
    exact32(activeTree, 'activeTree'),
    exact32(relayer, 'relayer'),
    exact32(treasury, 'treasury'),
    fieldToLe32(assertFieldV1(assetId, 'assetId')),
  ]);
}
