import { buildSparseMerkleTreeV2 } from './merkle-v2.mjs';
import { fetchActiveTreeV2 } from './state-v2.mjs';

const CACHE_VERSION_V2 = 1;
const CACHE_PREFIX_V2 = 'watcher-public-tree:v2';

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

export function loadPublicTreeCacheV2({
  storage = globalThis.localStorage,
  scope,
} = {}) {
  if (!storage || typeof storage.getItem !== 'function') {
    throw new Error('Local storage is unavailable for the V2 public tree cache');
  }
  const raw = storage.getItem(storageName(scope));
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('V2 public tree cache is malformed');
  }
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

export function savePublicTreeCacheV2({
  storage = globalThis.localStorage,
  scope,
  epoch,
  commitments,
} = {}) {
  if (!storage || typeof storage.setItem !== 'function') {
    throw new Error('Local storage is unavailable for the V2 public tree cache');
  }
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
  if (current && current.epoch !== epoch) {
    throw new Error('V2 public tree cache belongs to another epoch');
  }
  const commitments = current ? [...current.commitments] : [];
  commitments.push(BigInt(commitment));
  return savePublicTreeCacheV2({ storage, scope, epoch, commitments });
}

export async function verifyPublicTreeCacheV2({
  connection,
  activeTree,
  scope,
  storage = globalThis.localStorage,
  commitment = 'confirmed',
} = {}) {
  const chain = await fetchActiveTreeV2({ connection, activeTree, commitment });
  const cached = loadPublicTreeCacheV2({ storage, scope });

  if (!cached) {
    if (chain.nextIndex === 0) {
      const initialized = savePublicTreeCacheV2({
        storage,
        scope,
        epoch: Number(chain.epoch),
        commitments: [],
      });
      return Object.freeze({ chain, cache: initialized, tree: initialized.tree, status: 'ready' });
    }
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
  if (cached.tree.count !== chain.nextIndex || cached.tree.root !== chain.currentRoot) {
    return Object.freeze({
      chain,
      cache: cached,
      tree: cached.tree,
      status: 'stale',
      error: 'The local V2 public tree cache is behind the on-chain tree. Sync it before generating a proof.',
    });
  }
  return Object.freeze({ chain, cache: cached, tree: cached.tree, status: 'ready' });
}
