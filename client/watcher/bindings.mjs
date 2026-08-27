import { asBytes, concatBytes } from './keccak.mjs';
import { assertU64, fieldFromLe32, fieldToLe32 } from './field.mjs';

const encoder = new TextEncoder();

async function sha256ToField(domain, parts) {
  if (!globalThis.crypto?.subtle) throw new Error('Web Crypto SHA-256 is unavailable');
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest(
      'SHA-256',
      concatBytes(encoder.encode(domain), ...parts.map((part) => asBytes(part))),
    ),
  );
  digest[31] &= 0x1f;
  return Object.freeze({ bytes: digest, field: fieldFromLe32(digest, `${domain} binding`) });
}

function exact32(value, label) {
  const bytes = asBytes(value, label);
  if (bytes.length !== 32) throw new RangeError(`${label} must be exactly 32 bytes`);
  return bytes;
}

export async function withdrawContextBindingV1({
  programId,
  config,
  vault,
  relayer,
  treasury,
  assetId = 1n,
}) {
  return sha256ToField('watcher-withdraw-context-v1', [
    exact32(programId, 'programId'),
    exact32(config, 'config'),
    exact32(vault, 'vault'),
    exact32(relayer, 'relayer'),
    exact32(treasury, 'treasury'),
    fieldToLe32(assertU64(assetId, 'assetId')),
  ]);
}

export async function recipientBindingBytesV1(recipient) {
  return sha256ToField('watcher-recipient-v1', [exact32(recipient, 'recipient')]);
}
