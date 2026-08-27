const MASK_64 = (1n << 64n) - 1n;
const RATE_BYTES = 136;
const ROUND_CONSTANTS = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an,
  0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
  0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an,
  0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n,
  0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
  0x000000000000800an, 0x800000008000000an, 0x8000000080008081n,
  0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const ROTATION = [
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
];

export function asBytes(value, label = 'value') {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (Array.isArray(value)) return Uint8Array.from(value);
  throw new TypeError(`${label} must be Uint8Array, ArrayBuffer, or byte array`);
}

export function concatBytes(...chunks) {
  const arrays = chunks.map((chunk, index) => asBytes(chunk, `chunk ${index}`));
  const output = new Uint8Array(arrays.reduce((sum, item) => sum + item.length, 0));
  let offset = 0;
  for (const item of arrays) {
    output.set(item, offset);
    offset += item.length;
  }
  return output;
}

export function bytesToHex(bytes) {
  return Array.from(asBytes(bytes), (value) => value.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex) {
  if (typeof hex !== 'string' || !/^(?:0x)?[0-9a-fA-F]*$/.test(hex)) {
    throw new TypeError('hex must be a hexadecimal string');
  }
  const normalized = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (normalized.length % 2 !== 0) throw new RangeError('hex must contain an even number of digits');
  const output = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
  }
  return output;
}

function rotateLeft64(value, shift) {
  const amount = BigInt(shift);
  if (amount === 0n) return value & MASK_64;
  return ((value << amount) | (value >> (64n - amount))) & MASK_64;
}

function permute(state) {
  const column = new Array(5).fill(0n);
  const delta = new Array(5).fill(0n);
  const moved = new Array(25).fill(0n);
  for (const roundConstant of ROUND_CONSTANTS) {
    for (let x = 0; x < 5; x += 1) {
      column[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
    }
    for (let x = 0; x < 5; x += 1) {
      delta[x] = column[(x + 4) % 5] ^ rotateLeft64(column[(x + 1) % 5], 1);
    }
    for (let y = 0; y < 5; y += 1) {
      for (let x = 0; x < 5; x += 1) {
        state[x + 5 * y] = (state[x + 5 * y] ^ delta[x]) & MASK_64;
      }
    }
    for (let y = 0; y < 5; y += 1) {
      for (let x = 0; x < 5; x += 1) {
        moved[y + 5 * ((2 * x + 3 * y) % 5)] =
          rotateLeft64(state[x + 5 * y], ROTATION[x + 5 * y]);
      }
    }
    for (let y = 0; y < 5; y += 1) {
      for (let x = 0; x < 5; x += 1) {
        const current = moved[x + 5 * y];
        const next = moved[((x + 1) % 5) + 5 * y];
        const afterNext = moved[((x + 2) % 5) + 5 * y];
        state[x + 5 * y] = (current ^ ((~next & MASK_64) & afterNext)) & MASK_64;
      }
    }
    state[0] = (state[0] ^ roundConstant) & MASK_64;
  }
}

export function keccak256(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : asBytes(input);
  const padLength = RATE_BYTES - (bytes.length % RATE_BYTES);
  const padded = new Uint8Array(bytes.length + padLength);
  padded.set(bytes);
  padded[bytes.length] = 0x01;
  padded[padded.length - 1] |= 0x80;
  const state = new Array(25).fill(0n);
  for (let offset = 0; offset < padded.length; offset += RATE_BYTES) {
    for (let laneIndex = 0; laneIndex < RATE_BYTES / 8; laneIndex += 1) {
      let lane = 0n;
      const laneOffset = offset + laneIndex * 8;
      for (let byteIndex = 0; byteIndex < 8; byteIndex += 1) {
        lane |= BigInt(padded[laneOffset + byteIndex]) << BigInt(byteIndex * 8);
      }
      state[laneIndex] = (state[laneIndex] ^ lane) & MASK_64;
    }
    permute(state);
  }
  const output = new Uint8Array(32);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = Number(
      (state[Math.floor(index / 8)] >> BigInt((index % 8) * 8)) & 0xffn,
    );
  }
  return output;
}
