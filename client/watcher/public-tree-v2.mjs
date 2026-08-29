import { PublicKey } from '@solana/web3.js';

import { fieldFromLe32 } from './field.mjs';
import { buildSparseMerkleTreeV2, getMerkleAppendTransitionV2 } from './merkle-v2.mjs';
import { fetchActiveTreeV2 } from './state-v2.mjs';

const CACHE_VERSION_V2 = 1;
const CACHE_PREFIX_V2 = 'watcher-public-tree:v2';
const DEPOSIT_TAG_V2 = 0x20;
const WITHDRAW_TAG_V2 = 0x21;
const DEPOSIT_BYTES_V2 = 329;
const WITHDRAW_BYTES_V2 = 634;
const WITHDRAW_CHANGE_OFFSET_V2 = 258;
const WITHDRAW_NEW_ROOT_OFFSET_V2 = 346;
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_MAP = new Map(Array.from(BASE58_ALPHABET, (character, index) => [character, index]));

function storageName(scope) {
  const value = String(scope || '').trim();
  if (!value) throw new TypeError('V2 public tree scope is required');
  return `${CACHE_PREFIX_V2}:${value}`;
}

function normalizeCommitments(values) {
  if (!Array.isArray(values)) return [];
  return values.map((value, index) => {
    const parsed = BigInt(value);
    if (parsed <= 0n) throw new Error(`cached V2 commitment ${index} is invalid`);
    return parsed;
  });
}

function isZero32(bytes) {
  return bytes.length === 32 && bytes.every((value) => value === 0);
}

function decodeBase58(value) {
  const text = String(value || '');
  if (!text) return new Uint8Array();
  let bytes = [0];
  for (const character of text) {
    const digit = BASE58_MAP.get(character);
    if (digit === undefined) throw new Error('transaction instruction contains invalid base58 data');
    let carry = digit;
    for (let index = 0; index < bytes.length; index += 1) {
      const next = bytes[index] * 58 + carry;
      bytes[index] = next & 0xff;
      carry = next >> 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let leadingZeroes = 0;
  while (leadingZeroes < text.length && text[leadingZeroes] === '1') leadingZeroes += 1;
  const output = new Uint8Array(leadingZeroes + bytes.length);
  for (let index = 0; index < bytes.length; index += 1) {
    output[output.length - 1 - index] = bytes[index];
  }
  return output;
}

function instructionBytes(instruction) {
  const value = instruction?.data;
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === 'string') return decodeBase58(value);
  return null;
}

function accountKeys(message) {
  if (Array.isArray(message?.staticAccountKeys)) return message.staticAccountKeys;
  if (Array.isArray(message?.accountKeys)) return message.accountKeys.map((value) => value?.pubkey || value);
  if (typeof message?.getAccountKeys === 'function') {
    try {
      const resolved = message.getAccountKeys();
      if (Array.isArray(resolved?.staticAccountKeys)) return resolved.staticAccountKeys;
    } catch {
      return [];
    }
  }
  return [];
}

function compiledInstructions(message) {
  if (Array.isArray(message?.compiledInstructions)) return message.compiledInstructions;
  if (Array.isArray(message?.instructions)) return message.instructions;
  return [];
}

function instructionProgramId(message, instruction) {
  if (instruction?.programId) {
    try { return instruction.programId instanceof PublicKey ? instruction.programId : new PublicKey(instruction.programId); } catch { return null; }
  }
  const index = instruction?.programIdIndex;
  if (!Number.isInteger(index)) return null;
  const keys = accountKeys(message);
  const value = keys[index];
  if (!value) return null;
  try { return value instanceof PublicKey ? value : new PublicKey(value); } catch { return null; }
}

function decodeAppendEventV2(data) {
  if (!(data instanceof Uint8Array) || data.length < 1) return null;
  if (data[0] === DEPOSIT_TAG_V2) {
    if (data.length !== DEPOSIT_BYTES_V2) return null;
    const commitmentBytes = data.slice(1, 33);
    const newRootBytes = data.slice(41, 73);
    if (isZero32(commitmentBytes) || isZero32(newRootBytes)) return null;
    return Object.freeze({
      kind: 'deposit',
      commitment: fieldFromLe32(commitmentBytes, 'V2 deposit commitment'),
      newRoot: fieldFromLe32(newRootBytes, 'V2 deposit new root'),
    });
  }
  if (data[0] === WITHDRAW_TAG_V2) {
    if (data.length !== WITHDRAW_BYTES_V2) return null;
    const commitmentBytes = data.slice(WITHDRAW_CHANGE_OFFSET_V2, WITHDRAW_CHANGE_OFFSET_V2 + 32);
    if (isZero32(commitmentBytes)) return null;
    const newRootBytes = data.slice(WITHDRAW_NEW_ROOT_OFFSET_V2, WITHDRAW_NEW_ROOT_OFFSET_V2 + 32);
    if (isZero32(newRootBytes)) throw new Error('V2 change withdrawal has a zero new-root sentinel');
    return Object.freeze({
      kind: 'change',
      commitment: fieldFromLe32(commitmentBytes, 'V2 change commitment'),
      newRoot: fieldFromLe32(newRootBytes, 'V2 withdrawal new root'),
    });
  }
  return null;
}

function appendEventsFromTransaction(transaction, programId) {
  if (!transaction || transaction.meta?.err) return [];
  const message = transaction.transaction?.message || transaction.message;
  if (!message) return [];
  const output = [];
  for (const instruction of compiledInstructions(message)) {
    const instructionProgram = instructionProgramId(message, instruction);
    if (!instructionProgram?.equals(programId)) continue;
    const data = instructionBytes(instruction);
    if (!data) continue;
    const event = decodeAppendEventV2(data);
    if (event) output.push(event);
  }
  return output;
}

async function fetchTransactions(connection, signatures, commitment) {
  const options = { commitment, maxSupportedTransactionVersion: 0 };
  if (typeof connection.getTransactions === 'function') return connection.getTransactions(signatures, options);
  if (typeof connection.getTransaction !== 'function') {
    throw new TypeError('connection.getTransactions or connection.getTransaction is required');
  }
  return Promise.all(signatures.map((signature) => connection.getTransaction(signature, options)));
}

function canRebuildFromChain(connection, chain) {
  return Boolean(
    chain?.owner
    && typeof chain.owner.toBytes === 'function'
    && connection
    && typeof connection.getSignaturesForAddress === 'function'
    && (typeof connection.getTransactions === 'function' || typeof connection.getTransaction === 'function'),
  );
}

export function loadPublicTreeCacheV2({ storage = globalThis.localStorage, scope } = {}) {
  if (!storage || typeof storage.getItem !== 'function') throw new Error('Local storage is unavailable for the V2 public tree cache');
  const raw = storage.getItem(storageName(scope));
  if (!raw) return null;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error('V2 public tree cache is malformed'); }
  if (parsed?.version !== CACHE_VERSION_V2) throw new Error('Unsupported V2 public tree cache version');
  const epoch = Number(parsed.epoch);
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error('V2 public tree cache epoch is invalid');
  const commitments = normalizeCommitments(parsed.commitments);
  return Object.freeze({
    version: CACHE_VERSION_V2,
    epoch,
    commitments: Object.freeze(commitments),
    updatedAt: Number(parsed.updatedAt || 0),
    tree: buildSparseMerkleTreeV2(commitments, { epoch }),
  });
}

export function savePublicTreeCacheV2({ storage = globalThis.localStorage, scope, epoch, commitments } = {}) {
  if (!storage || typeof storage.setItem !== 'function') throw new Error('Local storage is unavailable for the V2 public tree cache');
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new RangeError('V2 tree epoch is invalid');
  const values = normalizeCommitments(commitments);
  const tree = buildSparseMerkleTreeV2(values, { epoch });
  const payload = {
    version: CACHE_VERSION_V2,
    epoch,
    commitments: values.map((value) => value.toString(10)),
    updatedAt: Date.now(),
  };
  storage.setItem(storageName(scope), JSON.stringify(payload));
  return Object.freeze({ ...payload, commitments: Object.freeze(values), tree });
}

export function appendPublicTreeCacheV2({ storage = globalThis.localStorage, scope, epoch, commitment }) {
  const current = loadPublicTreeCacheV2({ storage, scope });
  if (current && current.epoch !== epoch) throw new Error('V2 public tree cache belongs to another epoch');
  const commitments = current ? [...current.commitments] : [];
  commitments.push(BigInt(commitment));
  return savePublicTreeCacheV2({ storage, scope, epoch, commitments });
}

export async function rebuildPublicTreeCacheFromChainV2({
  connection,
  programId,
  activeTree,
  scope,
  storage = globalThis.localStorage,
  commitment = 'confirmed',
  pageSize = 1000,
  maxSignatures = 20_000,
} = {}) {
  if (!connection || typeof connection.getSignaturesForAddress !== 'function') {
    throw new TypeError('connection.getSignaturesForAddress is required');
  }
  const treeAddress = activeTree instanceof PublicKey ? activeTree : new PublicKey(activeTree);
  const chain = await fetchActiveTreeV2({ connection, activeTree: treeAddress, commitment });
  const owner = programId || chain.owner;
  if (!owner) throw new Error('Cannot derive the Watcher V2 program id from the active-tree account');
  const program = owner instanceof PublicKey ? owner : new PublicKey(owner);
  const target = chain.nextIndex;
  if (target === 0) {
    const cache = savePublicTreeCacheV2({ storage, scope, epoch: Number(chain.epoch), commitments: [] });
    return Object.freeze({ chain, cache, tree: cache.tree, scannedSignatures: 0, appendEvents: 0 });
  }

  const newestFirst = [];
  let before;
  let scannedSignatures = 0;
  let appendCount = 0;
  while (appendCount < target && scannedSignatures < maxSignatures) {
    const limit = Math.min(pageSize, maxSignatures - scannedSignatures);
    const page = await connection.getSignaturesForAddress(
      treeAddress,
      { limit, ...(before ? { before } : {}) },
      commitment,
    );
    if (!Array.isArray(page) || page.length === 0) break;
    scannedSignatures += page.length;
    const successful = page.filter((entry) => !entry.err && typeof entry.signature === 'string');
    const signatures = successful.map((entry) => entry.signature);
    const transactions = await fetchTransactions(connection, signatures, commitment);
    for (let index = 0; index < successful.length; index += 1) {
      const events = appendEventsFromTransaction(transactions[index], program);
      if (events.length > 0) {
        newestFirst.push({ signature: successful[index].signature, events });
        appendCount += events.length;
      }
    }
    before = page.at(-1)?.signature;
    if (page.length < limit) break;
  }

  const chronological = newestFirst.reverse().flatMap((entry) => (
    entry.events.map((event) => ({ ...event, signature: entry.signature }))
  ));
  if (chronological.length < target) {
    throw new Error(`Could only reconstruct ${chronological.length} of ${target} V2 public commitments from chain history`);
  }
  if (chronological.length > target) chronological.splice(0, chronological.length - target);

  let tree = buildSparseMerkleTreeV2([], { epoch: Number(chain.epoch) });
  const commitments = [];
  for (let index = 0; index < chronological.length; index += 1) {
    const event = chronological[index];
    const transition = getMerkleAppendTransitionV2(tree, event.commitment);
    if (transition.newRoot !== event.newRoot) throw new Error(`V2 chain history root mismatch at append ${index}`);
    commitments.push(event.commitment);
    tree = transition.tree;
  }
  if (tree.count !== target || tree.root !== chain.currentRoot) {
    throw new Error('Reconstructed V2 public tree does not match the on-chain active tree');
  }
  const cache = savePublicTreeCacheV2({ storage, scope, epoch: Number(chain.epoch), commitments });
  return Object.freeze({ chain, cache, tree: cache.tree, scannedSignatures, appendEvents: chronological.length });
}

export async function verifyPublicTreeCacheV2({
  connection,
  activeTree,
  scope,
  storage = globalThis.localStorage,
  commitment = 'confirmed',
  rebuildFromChain = true,
} = {}) {
  const chain = await fetchActiveTreeV2({ connection, activeTree, commitment });
  const cached = loadPublicTreeCacheV2({ storage, scope });

  if (!cached && chain.nextIndex === 0) {
    const initialized = savePublicTreeCacheV2({ storage, scope, epoch: Number(chain.epoch), commitments: [] });
    return Object.freeze({ chain, cache: initialized, tree: initialized.tree, status: 'ready', rebuilt: false });
  }

  const cacheMatches = Boolean(
    cached
    && BigInt(cached.epoch) === chain.epoch
    && cached.tree.count === chain.nextIndex
    && cached.tree.root === chain.currentRoot,
  );
  if (cacheMatches) {
    return Object.freeze({ chain, cache: cached, tree: cached.tree, status: 'ready', rebuilt: false });
  }

  if (rebuildFromChain && canRebuildFromChain(connection, chain)) {
    const rebuilt = await rebuildPublicTreeCacheFromChainV2({
      connection,
      programId: chain.owner,
      activeTree,
      scope,
      storage,
      commitment,
    });
    return Object.freeze({
      chain: rebuilt.chain,
      cache: rebuilt.cache,
      tree: rebuilt.tree,
      status: 'ready',
      rebuilt: true,
      scannedSignatures: rebuilt.scannedSignatures,
    });
  }

  if (!cached) {
    return Object.freeze({
      chain,
      cache: null,
      tree: null,
      status: 'missing',
      error: 'This browser does not have the public commitment history for the current V2 tree yet.',
    });
  }
  if (BigInt(cached.epoch) !== chain.epoch) {
    return Object.freeze({
      chain,
      cache: cached,
      tree: cached.tree,
      status: 'stale',
      error: 'The local V2 tree cache is from another epoch.',
    });
  }
  return Object.freeze({
    chain,
    cache: cached,
    tree: cached.tree,
    status: 'stale',
    error: 'The local V2 public tree cache is behind the on-chain tree. Sync it before generating a proof.',
  });
}
