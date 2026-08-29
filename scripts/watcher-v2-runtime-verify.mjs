#!/usr/bin/env node

import fs from 'node:fs';
import { Connection, PublicKey } from '@solana/web3.js';

import {
  decodeActiveTreeV2,
  deriveWatcherVaultPdaV2,
} from '../client/watcher/index.mjs';

function argument(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || '') : fallback;
}

const runtimePath = argument('--runtime', 'public/watcher-protocol/v2-devnet.json');
const rpcUrl = argument('--rpc', 'https://api.devnet.solana.com');

function fail(message) {
  throw new Error(message);
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
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

async function main() {
  const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
  if (Number(runtime.version) !== 2) fail('runtime version is not V2');
  if (runtime.network !== 'devnet') fail('runtime network is not devnet');
  if (Number(runtime.treeDepth) !== 16 || Number(runtime.treeCapacity) !== 65_536) {
    fail('runtime V2 tree dimensions are invalid');
  }

  const programId = pubkey(runtime.programId, 'programId');
  const config = pubkey(runtime.config, 'config');
  const activeTree = pubkey(runtime.activeTree, 'activeTree');
  const vault = pubkey(runtime.vault, 'vault');
  const treasury = pubkey(runtime.treasury, 'treasury');
  const connection = new Connection(rpcUrl, 'confirmed');

  const [genesisHash, accounts] = await Promise.all([
    connection.getGenesisHash(),
    connection.getMultipleAccountsInfo([programId, config, activeTree, vault], 'confirmed'),
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

  const tree = decodeActiveTreeV2(accounts[2].data);
  if (!tree.config.equals(config)) fail('V2 active tree belongs to another config');
  if (tree.nextIndex > 65_536) fail('V2 active tree exceeds capacity');

  const [expectedVault] = deriveWatcherVaultPdaV2({ programId, config });
  if (!expectedVault.equals(vault)) fail('V2 vault PDA does not match runtime config');
  const vaultData = new Uint8Array(accounts[3].data);
  if (vaultData.length < 50 || vaultData[0] !== 1) fail('V2 vault account is invalid');
  if (!equalBytes(vaultData.slice(1, 33), config.toBytes())) fail('V2 vault belongs to another config');

  process.stdout.write(`${JSON.stringify({
    status: 'ready',
    network: runtime.network,
    genesisHash,
    programId: programId.toBase58(),
    config: config.toBase58(),
    activeTree: activeTree.toBase58(),
    vault: vault.toBase58(),
    treasury: treasury.toBase58(),
    epoch: tree.epoch.toString(),
    nextIndex: tree.nextIndex,
    currentRoot: tree.currentRoot.toString(),
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
