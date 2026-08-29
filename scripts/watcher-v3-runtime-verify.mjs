#!/usr/bin/env node

import fs from 'node:fs';
import { Connection, PublicKey } from '@solana/web3.js';

import {
  ACTIVE_TREE_ACCOUNT_LEN_V2,
  NULLIFIER_BUCKETS_PER_SHARD_V3,
  NULLIFIER_SHARD_COUNT_V3,
  NULLIFIER_SHARD_HEADER_BYTES_V3,
  decodeActiveTreeV2,
  deriveNullifierShardPdaV3,
  deriveWatcherVaultPdaV2,
} from '../client/watcher/index.mjs';

const VAULT_ACCOUNT_LEN = 50;
const SOL_ASSET_ID = 1n;

function argument(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = String(process.argv[index + 1] || '');
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

const runtimePath = argument('--runtime', 'public/watcher-protocol/v3-devnet.json');
const rpcOverride = argument('--rpc', '');
const pinPath = argument('--pin', '');

function fail(message) {
  throw new Error(message);
}

function readJson(path, label) {
  if (!path || !fs.existsSync(path)) fail(`${label} file was not found: ${path}`);
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch {
    fail(`${label} file is not valid JSON`);
  }
}

function pubkey(value, label) {
  try {
    return new PublicKey(String(value || ''));
  } catch {
    fail(`${label} is not a valid Solana address`);
  }
}

function equalBytes(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function u32le(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
}

function u64le(bytes, offset) {
  let value = 0n;
  for (let index = 7; index >= 0; index -= 1) value = (value << 8n) | BigInt(bytes[offset + index]);
  return value;
}

function verifyPinBinding(runtime, pin) {
  if (!pin) return;
  if (pin.version !== 2 || pin.status !== 'pinned-development-setup') {
    fail('shared V2/V3 prover pin is invalid');
  }
  const bindings = [
    ['proverReleaseTag', 'releaseTag'],
    ['proverBundleSha256', 'bundleSha256'],
    ['depositVkSha256', 'depositVkSha256'],
    ['withdrawVkSha256', 'withdrawVkSha256'],
  ];
  for (const [runtimeField, pinField] of bindings) {
    if (runtime[runtimeField] !== pin[pinField]) {
      fail(`V3 runtime ${runtimeField} does not match pinned prover ${pinField}`);
    }
  }
}

async function main() {
  const runtime = readJson(runtimePath, 'V3 runtime');
  const pin = pinPath ? readJson(pinPath, 'shared V2/V3 prover pin') : null;
  if (Number(runtime.version) !== 3) fail('runtime version is not V3');
  if (!['devnet', 'localnet'].includes(runtime.network)) fail('runtime network is unsupported');
  if (Number(runtime.treeDepth) !== 16 || Number(runtime.treeCapacity) !== 65_536) {
    fail('runtime V3 tree dimensions are invalid');
  }
  if (Number(runtime.nullifierShardCount) !== NULLIFIER_SHARD_COUNT_V3) fail('V3 shard count is invalid');
  if (Number(runtime.nullifierBucketsPerShard) !== NULLIFIER_BUCKETS_PER_SHARD_V3) fail('V3 bucket geometry is invalid');
  if (Number(runtime.nullifierShardHeaderBytes) !== NULLIFIER_SHARD_HEADER_BYTES_V3) fail('V3 shard header size is invalid');
  if (Number(runtime.nullifierRecordBytes) !== 36) fail('V3 nullifier record size is invalid');
  if (!Array.isArray(runtime.nullifierShards) || runtime.nullifierShards.length !== NULLIFIER_SHARD_COUNT_V3) {
    fail('V3 runtime does not list all packed nullifier shards');
  }
  if (String(runtime.protocolFeeLamports || '0') !== '0') fail('V3 development runtime unexpectedly enables protocol fees');

  const rpcUrl = rpcOverride || String(runtime.rpcUrl || '');
  if (!rpcUrl) fail('runtime RPC URL is missing');
  const programId = pubkey(runtime.programId, 'programId');
  const config = pubkey(runtime.config, 'config');
  const activeTree = pubkey(runtime.activeTree, 'activeTree');
  const vault = pubkey(runtime.vault, 'vault');
  const treasury = pubkey(runtime.treasury, 'treasury');
  const shards = runtime.nullifierShards.map((value, index) => pubkey(value, `nullifierShards[${index}]`));
  const connection = new Connection(rpcUrl, 'confirmed');

  for (let shard = 0; shard < shards.length; shard += 1) {
    const [expected] = deriveNullifierShardPdaV3({ programId, config, shard });
    if (!expected.equals(shards[shard])) fail(`V3 shard ${shard} PDA does not match runtime config`);
  }

  const [genesisHash, coreAccounts, shardInfos, vaultRent] = await Promise.all([
    connection.getGenesisHash(),
    connection.getMultipleAccountsInfo([programId, config, activeTree, vault], 'confirmed'),
    connection.getMultipleAccountsInfo(shards, 'confirmed'),
    connection.getMinimumBalanceForRentExemption(VAULT_ACCOUNT_LEN),
  ]);
  if (runtime.genesisHash !== genesisHash) fail('runtime genesis hash does not match RPC');
  if (!coreAccounts[0]?.executable) fail('V3 program is not executable');
  for (let index = 1; index < coreAccounts.length; index += 1) {
    const info = coreAccounts[index];
    if (!info) fail(`V3 state account ${index} is missing`);
    if (!info.owner.equals(programId)) fail(`V3 state account ${index} has the wrong owner`);
  }

  const configData = new Uint8Array(coreAccounts[1].data);
  if (configData.length < 100 || configData[0] !== 1) fail('V3 config account is invalid');
  if (!equalBytes(configData.slice(33, 65), treasury.toBytes())) fail('V3 treasury does not match runtime');
  if (configData[65] !== 0 || configData[66] !== 0 || configData[67] !== 0) {
    fail('V3 development deployment unexpectedly enables protocol fees');
  }

  if (coreAccounts[2].data.length !== ACTIVE_TREE_ACCOUNT_LEN_V2) fail('V3 active tree account length is invalid');
  const tree = decodeActiveTreeV2(coreAccounts[2].data);
  if (!tree.config.equals(config)) fail('V3 active tree belongs to another config');
  if (tree.nextIndex > 65_536) fail('V3 active tree exceeds capacity');

  const [expectedVault] = deriveWatcherVaultPdaV2({ programId, config });
  if (!expectedVault.equals(vault)) fail('V3 vault PDA does not match runtime config');
  const vaultData = new Uint8Array(coreAccounts[3].data);
  if (vaultData.length < VAULT_ACCOUNT_LEN || vaultData[0] !== 1) fail('V3 vault account is invalid');
  if (!equalBytes(vaultData.slice(1, 33), config.toBytes())) fail('V3 vault belongs to another config');
  const assetId = u64le(vaultData, 34);
  const trackedBalance = u64le(vaultData, 42);
  if (assetId !== SOL_ASSET_ID) fail('V3 vault asset id is not SOL');
  if (BigInt(coreAccounts[3].lamports) < BigInt(vaultRent) + trackedBalance) {
    fail('V3 vault lamports are below rent reserve plus tracked private liability');
  }

  let packedNullifiers = 0;
  let packedBytesBeyondHeaders = 0;
  for (let shard = 0; shard < shardInfos.length; shard += 1) {
    const info = shardInfos[shard];
    if (!info) fail(`V3 nullifier shard ${shard} is missing`);
    if (!info.owner.equals(programId)) fail(`V3 nullifier shard ${shard} has the wrong owner`);
    if (info.data.length < NULLIFIER_SHARD_HEADER_BYTES_V3) fail(`V3 nullifier shard ${shard} is too small`);
    const data = new Uint8Array(info.data);
    const magic = new TextDecoder().decode(data.slice(0, 8));
    if (magic !== 'WNULLV3\0') fail(`V3 nullifier shard ${shard} magic is invalid`);
    if (data[8] !== 3 || data[9] !== shard) fail(`V3 nullifier shard ${shard} header identity is invalid`);
    if (!equalBytes(data.slice(12, 44), config.toBytes())) fail(`V3 nullifier shard ${shard} belongs to another config`);
    const count = u32le(data, 44);
    const expectedLength = NULLIFIER_SHARD_HEADER_BYTES_V3 + count * 36;
    if (data.length !== expectedLength) fail(`V3 nullifier shard ${shard} length does not match record count`);
    packedNullifiers += count;
    packedBytesBeyondHeaders += count * 36;
  }

  verifyPinBinding(runtime, pin);

  process.stdout.write(`${JSON.stringify({
    status: 'ready',
    network: runtime.network,
    rpcUrl,
    genesisHash,
    programId: programId.toBase58(),
    config: config.toBase58(),
    activeTree: activeTree.toBase58(),
    vault: vault.toBase58(),
    treasury: treasury.toBase58(),
    epoch: tree.epoch.toString(),
    nextIndex: tree.nextIndex,
    currentRoot: tree.currentRoot.toString(),
    trackedBalance: trackedBalance.toString(),
    nullifierShardCount: shards.length,
    packedNullifiers,
    packedBytesBeyondHeaders,
    proverReleaseTag: runtime.proverReleaseTag || '',
    proverBundleSha256: runtime.proverBundleSha256 || '',
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
