#!/usr/bin/env node

import fs from 'node:fs';
import { Connection, PublicKey } from '@solana/web3.js';

import {
  ACTIVE_TREE_ACCOUNT_LEN_V2,
  decodeActiveTreeV2,
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

const runtimePath = argument('--runtime', 'public/watcher-protocol/v2-devnet.json');
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

function u64le(bytes, offset) {
  let value = 0n;
  for (let index = 7; index >= 0; index -= 1) value = (value << 8n) | BigInt(bytes[offset + index]);
  return value;
}

function verifyPinBinding(runtime, pin) {
  if (!pin) return;
  if (pin.version !== 2 || pin.status !== 'pinned-development-setup') fail('V2 prover pin is invalid');
  const bindings = [
    ['proverReleaseTag', 'releaseTag'],
    ['proverBundleSha256', 'bundleSha256'],
    ['depositVkSha256', 'depositVkSha256'],
    ['withdrawVkSha256', 'withdrawVkSha256'],
  ];
  for (const [runtimeField, pinField] of bindings) {
    if (runtime[runtimeField] !== pin[pinField]) {
      fail(`V2 runtime ${runtimeField} does not match pinned prover ${pinField}`);
    }
  }
}

async function main() {
  const runtime = readJson(runtimePath, 'V2 runtime');
  const pin = pinPath ? readJson(pinPath, 'V2 prover pin') : null;
  if (Number(runtime.version) !== 2) fail('runtime version is not V2');
  if (!['devnet', 'localnet'].includes(runtime.network)) fail('runtime network is unsupported');
  if (Number(runtime.treeDepth) !== 16 || Number(runtime.treeCapacity) !== 65_536) {
    fail('runtime V2 tree dimensions are invalid');
  }
  if (String(runtime.protocolFeeLamports || '0') !== '0') fail('V2 development runtime unexpectedly enables protocol fees');

  const rpcUrl = rpcOverride || String(runtime.rpcUrl || '');
  if (!rpcUrl) fail('runtime RPC URL is missing');
  const programId = pubkey(runtime.programId, 'programId');
  const config = pubkey(runtime.config, 'config');
  const activeTree = pubkey(runtime.activeTree, 'activeTree');
  const vault = pubkey(runtime.vault, 'vault');
  const treasury = pubkey(runtime.treasury, 'treasury');
  const connection = new Connection(rpcUrl, 'confirmed');

  const [genesisHash, accounts, vaultRent] = await Promise.all([
    connection.getGenesisHash(),
    connection.getMultipleAccountsInfo([programId, config, activeTree, vault], 'confirmed'),
    connection.getMinimumBalanceForRentExemption(VAULT_ACCOUNT_LEN),
  ]);
  if (runtime.genesisHash !== genesisHash) fail('runtime genesis hash does not match RPC');
  if (!accounts[0]?.executable) fail('V2 program is not executable');
  for (let index = 1; index < accounts.length; index += 1) {
    const info = accounts[index];
    if (!info) fail(`V2 state account ${index} is missing`);
    if (!info.owner.equals(programId)) fail(`V2 state account ${index} has the wrong owner`);
  }

  const configData = new Uint8Array(accounts[1].data);
  if (configData.length < 100 || configData[0] !== 1) fail('V2 config account is invalid');
  if (!equalBytes(configData.slice(33, 65), treasury.toBytes())) fail('V2 treasury does not match runtime');
  if (configData[65] !== 0 || configData[66] !== 0 || configData[67] !== 0) {
    fail('V2 development deployment unexpectedly enables protocol fees');
  }

  if (accounts[2].data.length !== ACTIVE_TREE_ACCOUNT_LEN_V2) fail('V2 active tree account length is invalid');
  const tree = decodeActiveTreeV2(accounts[2].data);
  if (!tree.config.equals(config)) fail('V2 active tree belongs to another config');
  if (tree.nextIndex > 65_536) fail('V2 active tree exceeds capacity');

  const [expectedVault] = deriveWatcherVaultPdaV2({ programId, config });
  if (!expectedVault.equals(vault)) fail('V2 vault PDA does not match runtime config');
  const vaultData = new Uint8Array(accounts[3].data);
  if (vaultData.length < VAULT_ACCOUNT_LEN || vaultData[0] !== 1) fail('V2 vault account is invalid');
  if (!equalBytes(vaultData.slice(1, 33), config.toBytes())) fail('V2 vault belongs to another config');
  const assetId = u64le(vaultData, 34);
  const trackedBalance = u64le(vaultData, 42);
  if (assetId !== SOL_ASSET_ID) fail('V2 vault asset id is not SOL');
  if (BigInt(accounts[3].lamports) < BigInt(vaultRent) + trackedBalance) {
    fail('V2 vault lamports are below rent reserve plus tracked private liability');
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
    proverReleaseTag: runtime.proverReleaseTag || '',
    proverBundleSha256: runtime.proverBundleSha256 || '',
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
