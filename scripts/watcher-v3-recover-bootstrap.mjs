#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { PublicKey } from '@solana/web3.js';

import {
  ACTIVE_TREE_ACCOUNT_LEN_V2,
  NULLIFIER_BUCKETS_PER_SHARD_V3,
  NULLIFIER_SHARD_COUNT_V3,
  NULLIFIER_SHARD_HEADER_BYTES_V3,
  decodeActiveTreeV2,
  deriveNullifierShardPdaV3,
  deriveWatcherVaultPdaV2,
} from '../client/watcher/index.mjs';

const DEFAULT_RPC = 'https://api.devnet.solana.com';
const DEFAULT_PROGRAM_ID = 'AyAyADfWVV3ZRUDGgJ9sEeU5GnYdZ9DyW4t3uW49pUHg';
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const VAULT_ACCOUNT_LEN = 50;
const CONFIG_ACCOUNT_LEN = 100;
const NULLIFIER_RECORD_BYTES_V3 = 36;
const SOL_ASSET_ID = 1n;
const SHARD_MAGIC = Buffer.from([0x57, 0x4e, 0x55, 0x4c, 0x4c, 0x56, 0x33, 0x00]);
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_INDEX = new Map([...BASE58_ALPHABET].map((char, index) => [char, index]));

function argument(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = String(process.argv[index + 1] || '');
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

const rpcUrl = argument('--rpc', process.env.WATCHER_V3_RPC_URL || DEFAULT_RPC);
const programId = new PublicKey(argument('--program-id', process.env.WATCHER_V3_PROGRAM_ID || DEFAULT_PROGRAM_ID));
const outputPath = argument('--out', process.env.WATCHER_V3_RECOVERY_OUT || '');
const scanLimit = Number(argument('--limit', process.env.WATCHER_V3_RECOVERY_LIMIT || '80'));
if (!Number.isInteger(scanLimit) || scanLimit < 10 || scanLimit > 1000) {
  throw new Error('--limit must be an integer between 10 and 1000');
}
if (programId.toBase58() !== DEFAULT_PROGRAM_ID) {
  throw new Error(`Refusing recovery for unexpected V3 program id ${programId.toBase58()}`);
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let rpcSequence = 0;

function retryableRpcError(status, payload, raw) {
  if (status === 429 || status >= 500) return true;
  const code = Number(payload?.error?.code);
  const message = String(payload?.error?.message || raw || '');
  return code === 429 || code === -32005 || /too many requests|rate limit|temporar|timeout|timed out|node is behind/i.test(message);
}

async function rpc(method, params, { attempts = 10, quiet = false } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcSequence, method, params }),
      });
      const raw = await response.text();
      let payload = null;
      try { payload = raw ? JSON.parse(raw) : null; } catch {}
      if (!response.ok || payload?.error) {
        if (attempt < attempts && retryableRpcError(response.status, payload, raw)) {
          const waitMs = Math.min(12_000, 500 * (2 ** (attempt - 1))) + Math.floor(Math.random() * 250);
          if (!quiet) console.error(`[v3-recovery] ${method} retry ${attempt}/${attempts} after ${waitMs}ms`);
          await delay(waitMs);
          continue;
        }
        throw new Error(`${method} failed: HTTP ${response.status} ${payload?.error?.message || raw || response.statusText}`);
      }
      return payload?.result;
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      const message = String(error?.message || error);
      if (!/fetch failed|network|socket|ECONN|ETIMEDOUT|timeout|429|Too Many Requests/i.test(message)) throw error;
      const waitMs = Math.min(12_000, 500 * (2 ** (attempt - 1))) + Math.floor(Math.random() * 250);
      if (!quiet) console.error(`[v3-recovery] ${method} transport retry ${attempt}/${attempts} after ${waitMs}ms`);
      await delay(waitMs);
    }
  }
  throw lastError || new Error(`${method} failed after retries`);
}

function decodeBase58(value) {
  const text = String(value || '');
  if (!text) return new Uint8Array();
  let number = 0n;
  for (const char of text) {
    const digit = BASE58_INDEX.get(char);
    if (digit === undefined) throw new Error('instruction data is not valid base58');
    number = number * 58n + BigInt(digit);
  }
  let body = Buffer.alloc(0);
  if (number > 0n) {
    let hex = number.toString(16);
    if (hex.length % 2) hex = `0${hex}`;
    body = Buffer.from(hex, 'hex');
  }
  let leadingZeroes = 0;
  while (leadingZeroes < text.length && text[leadingZeroes] === '1') leadingZeroes += 1;
  return Uint8Array.from(Buffer.concat([Buffer.alloc(leadingZeroes), body]));
}

function u32le(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
}

function u64le(bytes, offset) {
  let value = 0n;
  for (let index = 7; index >= 0; index -= 1) value = (value << 8n) | BigInt(bytes[offset + index]);
  return value;
}

function accountData(info, label) {
  if (!info) throw new Error(`${label} account is missing`);
  if (!Array.isArray(info.data) || info.data[1] !== 'base64') throw new Error(`${label} account data encoding is unexpected`);
  return new Uint8Array(Buffer.from(info.data[0], 'base64'));
}

function bytesEqual(left, right) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

async function getAccounts(addresses, batchSize = 8) {
  const output = [];
  for (let offset = 0; offset < addresses.length; offset += batchSize) {
    const batch = addresses.slice(offset, offset + batchSize).map((value) => value.toBase58());
    const response = await rpc('getMultipleAccounts', [batch, { encoding: 'base64', commitment: 'confirmed' }]);
    if (!response || !Array.isArray(response.value) || response.value.length !== batch.length) {
      throw new Error('getMultipleAccounts returned an invalid batch');
    }
    output.push(...response.value);
    if (offset + batchSize < addresses.length) await delay(250);
  }
  return output;
}

function parsedCustomInstructions(transaction) {
  const instructions = transaction?.transaction?.message?.instructions;
  if (!Array.isArray(instructions)) return [];
  return instructions.filter((instruction) =>
    instruction
    && String(instruction.programId || '') === programId.toBase58()
    && Array.isArray(instruction.accounts)
    && typeof instruction.data === 'string');
}

async function recoverInstructionHistory() {
  const signatures = await rpc('getSignaturesForAddress', [programId.toBase58(), {
    commitment: 'confirmed',
    limit: scanLimit,
  }]);
  if (!Array.isArray(signatures) || signatures.length === 0) throw new Error('no V3 program transaction history was found');

  const initializations = [];
  const shardEvents = [];
  const successful = signatures.filter((item) => item && !item.err);
  for (let index = 0; index < successful.length; index += 1) {
    const entry = successful[index];
    const transaction = await rpc('getTransaction', [entry.signature, {
      encoding: 'jsonParsed',
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    }]);
    if (!transaction?.meta || transaction.meta.err) continue;
    for (const instruction of parsedCustomInstructions(transaction)) {
      const data = decodeBase58(instruction.data);
      if (data[0] === 0x22 && data.length >= 33 && instruction.accounts.length >= 4) {
        initializations.push({
          signature: entry.signature,
          slot: Number(entry.slot || transaction.slot || 0),
          blockTime: entry.blockTime ?? transaction.blockTime ?? null,
          config: String(instruction.accounts[1]),
          activeTree: String(instruction.accounts[2]),
          vault: String(instruction.accounts[3]),
          treasury: new PublicKey(data.slice(1, 33)).toBase58(),
        });
      } else if (data[0] === 0x33 && data.length >= 2 && instruction.accounts.length >= 3) {
        shardEvents.push({
          signature: entry.signature,
          slot: Number(entry.slot || transaction.slot || 0),
          blockTime: entry.blockTime ?? transaction.blockTime ?? null,
          config: String(instruction.accounts[1]),
          shard: Number(data[1]),
          address: String(instruction.accounts[2]),
        });
      }
    }
    if (index + 1 < successful.length) await delay(175);
  }
  return { initializations, shardEvents };
}

function selectCandidate(history) {
  if (history.initializations.length === 0) throw new Error('no successful V3 initialize instruction was found');
  const scored = history.initializations.map((initialize) => {
    const events = history.shardEvents.filter((event) => event.config === initialize.config);
    const uniqueShards = new Set(events.map((event) => event.shard));
    return { initialize, events, shardCount: uniqueShards.size };
  }).sort((left, right) => right.shardCount - left.shardCount || right.initialize.slot - left.initialize.slot);

  const candidate = scored[0];
  if (candidate.shardCount !== NULLIFIER_SHARD_COUNT_V3) {
    throw new Error(`recovered V3 config ${candidate.initialize.config} has only ${candidate.shardCount}/${NULLIFIER_SHARD_COUNT_V3} shard-init instructions; refusing to invent missing state`);
  }
  const byIndex = new Map();
  for (const event of candidate.events) {
    if (!Number.isInteger(event.shard) || event.shard < 0 || event.shard >= NULLIFIER_SHARD_COUNT_V3) continue;
    const existing = byIndex.get(event.shard);
    if (existing && existing.address !== event.address) throw new Error(`shard ${event.shard} was initialized at conflicting addresses`);
    byIndex.set(event.shard, event);
  }
  if (byIndex.size !== NULLIFIER_SHARD_COUNT_V3) throw new Error('recovered V3 shard history is incomplete');
  return { ...candidate, byIndex };
}

async function validateCandidate(candidate) {
  const config = new PublicKey(candidate.initialize.config);
  const activeTree = new PublicKey(candidate.initialize.activeTree);
  const vault = new PublicKey(candidate.initialize.vault);
  const treasury = new PublicKey(candidate.initialize.treasury);
  const expectedShards = [];
  for (let shard = 0; shard < NULLIFIER_SHARD_COUNT_V3; shard += 1) {
    const [expected] = deriveNullifierShardPdaV3({ programId, config, shard });
    const recovered = candidate.byIndex.get(shard);
    if (!recovered || recovered.address !== expected.toBase58()) {
      throw new Error(`recovered shard ${shard} does not match its deterministic PDA`);
    }
    expectedShards.push(expected);
  }

  const genesisHash = await rpc('getGenesisHash', []);
  if (genesisHash !== DEVNET_GENESIS) throw new Error(`unexpected Solana genesis hash ${genesisHash}`);
  const accounts = await getAccounts([programId, config, activeTree, vault, ...expectedShards]);
  const [programInfo, configInfo, treeInfo, vaultInfo, ...shardInfos] = accounts;
  if (!programInfo?.executable) throw new Error('recovered V3 program is not executable');
  for (const [label, info] of [['config', configInfo], ['active tree', treeInfo], ['vault', vaultInfo]]) {
    if (!info) throw new Error(`recovered V3 ${label} is missing`);
    if (info.owner !== programId.toBase58()) throw new Error(`recovered V3 ${label} has the wrong owner`);
  }

  const configBytes = accountData(configInfo, 'config');
  if (configBytes.length < CONFIG_ACCOUNT_LEN || configBytes[0] !== 1) throw new Error('recovered V3 config is invalid');
  if (!bytesEqual(configBytes.slice(33, 65), treasury.toBytes())) throw new Error('recovered V3 treasury does not match initialize instruction');
  if (configBytes[65] !== 0 || configBytes[66] !== 0 || configBytes[67] !== 0) throw new Error('recovered V3 config unexpectedly enables protocol fees');

  const treeBytes = accountData(treeInfo, 'active tree');
  if (treeBytes.length !== ACTIVE_TREE_ACCOUNT_LEN_V2) throw new Error('recovered V3 active tree has the wrong size');
  const tree = decodeActiveTreeV2(treeBytes);
  if (!tree.config.equals(config)) throw new Error('recovered V3 active tree belongs to another config');
  if (tree.epoch !== 0n || tree.nextIndex !== 0 || tree.currentRoot !== 0n) {
    throw new Error(`recovered V3 tree is not fresh: epoch=${tree.epoch} nextIndex=${tree.nextIndex} root=${tree.currentRoot}`);
  }

  const [expectedVault] = deriveWatcherVaultPdaV2({ programId, config });
  if (!expectedVault.equals(vault)) throw new Error('recovered V3 vault is not the deterministic vault PDA');
  const vaultBytes = accountData(vaultInfo, 'vault');
  if (vaultBytes.length < VAULT_ACCOUNT_LEN || vaultBytes[0] !== 1) throw new Error('recovered V3 vault is invalid');
  if (!bytesEqual(vaultBytes.slice(1, 33), config.toBytes())) throw new Error('recovered V3 vault belongs to another config');
  if (u64le(vaultBytes, 34) !== SOL_ASSET_ID) throw new Error('recovered V3 vault asset is not SOL');
  if (u64le(vaultBytes, 42) !== 0n) throw new Error('recovered V3 vault already has private liability; recovery is not safe to finalize as fresh');

  for (let shard = 0; shard < shardInfos.length; shard += 1) {
    const info = shardInfos[shard];
    if (!info) throw new Error(`recovered V3 shard ${shard} is missing on-chain`);
    if (info.owner !== programId.toBase58()) throw new Error(`recovered V3 shard ${shard} has the wrong owner`);
    const data = accountData(info, `shard ${shard}`);
    if (data.length !== NULLIFIER_SHARD_HEADER_BYTES_V3) throw new Error(`recovered V3 shard ${shard} is not an empty header`);
    if (!bytesEqual(data.slice(0, 8), SHARD_MAGIC)) throw new Error(`recovered V3 shard ${shard} magic is invalid`);
    if (data[8] !== 3 || data[9] !== shard) throw new Error(`recovered V3 shard ${shard} identity is invalid`);
    if (!bytesEqual(data.slice(12, 44), config.toBytes())) throw new Error(`recovered V3 shard ${shard} belongs to another config`);
    if (u32le(data, 44) !== 0) throw new Error(`recovered V3 shard ${shard} unexpectedly contains nullifiers`);
  }

  const shardInitializeSignatures = [...new Map(
    [...candidate.byIndex.values()]
      .sort((left, right) => left.slot - right.slot || left.shard - right.shard)
      .map((event) => [event.signature, event]),
  ).values()].map((event) => event.signature);

  const createdAt = candidate.initialize.blockTime
    ? new Date(candidate.initialize.blockTime * 1000).toISOString()
    : new Date().toISOString();

  return {
    version: 3,
    network: 'devnet',
    rpcUrl,
    genesisHash,
    programId: programId.toBase58(),
    config: config.toBase58(),
    activeTree: activeTree.toBase58(),
    vault: vault.toBase58(),
    treasury: treasury.toBase58(),
    treeDepth: 16,
    treeCapacity: 65_536,
    protocolFeeLamports: '0',
    relayerFeeLamports: '0',
    proverBasePath: '/watcher-prover-v3',
    nullifierShardCount: NULLIFIER_SHARD_COUNT_V3,
    nullifierBucketsPerShard: NULLIFIER_BUCKETS_PER_SHARD_V3,
    nullifierShardHeaderBytes: NULLIFIER_SHARD_HEADER_BYTES_V3,
    nullifierRecordBytes: NULLIFIER_RECORD_BYTES_V3,
    nullifierShards: expectedShards.map((value) => value.toBase58()),
    initializeSignature: candidate.initialize.signature,
    shardInitializeSignatures,
    createdAt,
    recoveredAt: new Date().toISOString(),
    recoverySource: 'confirmed-program-transaction-history-and-account-state',
    warning: 'DEVELOPMENT / NOT AUDITED / V3 ISOLATED',
  };
}

async function main() {
  console.error(`[v3-recovery] scanning ${programId.toBase58()} read-only on ${rpcUrl}`);
  const history = await recoverInstructionHistory();
  console.error(`[v3-recovery] found ${history.initializations.length} initialize event(s) and ${history.shardEvents.length} shard-init instruction(s)`);
  const candidate = selectCandidate(history);
  const runtime = await validateCandidate(candidate);
  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(runtime, null, 2)}\n`, { mode: 0o644 });
  }
  process.stdout.write(`${JSON.stringify(runtime, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
