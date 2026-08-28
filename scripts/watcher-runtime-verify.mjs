#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  Connection,
  PublicKey,
} from '@solana/web3.js';
import {
  COMMITMENT_REGISTRY_LEN_V1,
  CONFIG_ACCOUNT_LEN_V1,
  NULLIFIER_REGISTRY_LEN_V1,
  ROOT_HISTORY_ACCOUNT_LEN_V1,
  VAULT_ACCOUNT_LEN_V1,
  decodeCommitmentRegistryV1,
} from '../client/watcher/index.mjs';

function parseArguments(argv) {
  const result = {
    runtime: 'public/watcher-protocol/devnet.json',
    rpc: 'https://api.devnet.solana.com',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--runtime') result.runtime = argv[++index];
    else if (argument === '--rpc') result.rpc = argv[++index];
    else if (argument === '--help') {
      console.log('Usage: node scripts/watcher-runtime-verify.mjs [--runtime path] [--rpc url]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return result;
}

function requiredString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`runtime is missing ${name}`);
  }
  return value.trim();
}

function readU64LE(bytes, offset) {
  let value = 0n;
  for (let index = 7; index >= 0; index -= 1) {
    value = (value << 8n) | BigInt(bytes[offset + index]);
  }
  return value;
}

function expectLength(info, expected, label) {
  if (!info) throw new Error(`${label} account is missing`);
  if (info.data.length !== expected) {
    throw new Error(`${label} has ${info.data.length} data bytes; expected ${expected}`);
  }
}

async function main() {
  const arguments_ = parseArguments(process.argv.slice(2));
  const runtimePath = resolve(arguments_.runtime);
  const runtime = JSON.parse(await readFile(runtimePath, 'utf8'));

  if (runtime.status !== 'ready') {
    throw new Error(`runtime status is ${runtime.status || 'missing'}, not ready`);
  }
  if (runtime.cluster !== 'devnet') {
    throw new Error(`runtime cluster must be devnet, got ${runtime.cluster}`);
  }

  const addresses = {
    programId: new PublicKey(requiredString(runtime.programId, 'programId')),
    config: new PublicKey(requiredString(runtime.config, 'config')),
    commitments: new PublicKey(requiredString(runtime.commitments, 'commitments')),
    nullifiers: new PublicKey(requiredString(runtime.nullifiers, 'nullifiers')),
    rootHistory: new PublicKey(requiredString(runtime.rootHistory, 'rootHistory')),
    vault: new PublicKey(requiredString(runtime.vault, 'vault')),
    treasury: new PublicKey(requiredString(runtime.treasury, 'treasury')),
    relayer: new PublicKey(requiredString(runtime.relayer, 'relayer')),
  };

  const connection = new Connection(arguments_.rpc, 'confirmed');
  const [genesisHash, infos] = await Promise.all([
    connection.getGenesisHash(),
    connection.getMultipleAccountsInfo([
      addresses.programId,
      addresses.config,
      addresses.commitments,
      addresses.nullifiers,
      addresses.rootHistory,
      addresses.vault,
      addresses.treasury,
      addresses.relayer,
    ], 'confirmed'),
  ]);

  if (genesisHash !== requiredString(runtime.genesisHash, 'genesisHash')) {
    throw new Error(`genesis hash mismatch: runtime=${runtime.genesisHash} rpc=${genesisHash}`);
  }
  if (!infos[0]?.executable) throw new Error('program account is missing or not executable');

  const stateInfos = infos.slice(1, 6);
  for (const [index, info] of stateInfos.entries()) {
    if (!info) throw new Error(`protocol state account ${index} is missing`);
    if (!info.owner.equals(addresses.programId)) {
      throw new Error(`protocol state account ${index} has owner ${info.owner.toBase58()}`);
    }
  }

  expectLength(infos[1], CONFIG_ACCOUNT_LEN_V1, 'config');
  expectLength(infos[2], COMMITMENT_REGISTRY_LEN_V1, 'commitments');
  expectLength(infos[3], NULLIFIER_REGISTRY_LEN_V1, 'nullifiers');
  expectLength(infos[4], ROOT_HISTORY_ACCOUNT_LEN_V1, 'root history');
  expectLength(infos[5], VAULT_ACCOUNT_LEN_V1, 'vault');
  if (!infos[6]) throw new Error('treasury account is missing');
  if (!infos[7]) throw new Error('relayer account is missing');

  const configData = new Uint8Array(infos[1].data);
  if (configData[0] !== 1) throw new Error('config account is not initialized');
  const configuredTreasury = new PublicKey(configData.slice(33, 65));
  if (!configuredTreasury.equals(addresses.treasury)) {
    throw new Error('config treasury does not match runtime treasury');
  }

  const vaultData = new Uint8Array(infos[5].data);
  if (vaultData[0] !== 1) throw new Error('vault account is not initialized');
  const vaultConfig = new PublicKey(vaultData.slice(1, 33));
  if (!vaultConfig.equals(addresses.config)) {
    throw new Error('vault config does not match runtime config');
  }
  const assetId = readU64LE(vaultData, 34);
  if (assetId !== 1n) throw new Error(`vault asset id is ${assetId}, expected 1`);

  const commitments = decodeCommitmentRegistryV1(infos[2].data);
  const nullifierData = new Uint8Array(infos[3].data);
  const nullifierCount = nullifierData[0] === 1
    ? (
      nullifierData[1]
      | (nullifierData[2] << 8)
      | (nullifierData[3] << 16)
      | (nullifierData[4] << 24)
    ) >>> 0
    : 0;

  const result = {
    status: 'verified',
    cluster: runtime.cluster,
    genesisHash,
    programId: addresses.programId.toBase58(),
    config: addresses.config.toBase58(),
    commitments: addresses.commitments.toBase58(),
    nullifiers: addresses.nullifiers.toBase58(),
    rootHistory: addresses.rootHistory.toBase58(),
    vault: addresses.vault.toBase58(),
    treasury: addresses.treasury.toBase58(),
    relayer: addresses.relayer.toBase58(),
    commitmentCount: commitments.count,
    nullifierCount,
    trackedVaultLamports: readU64LE(vaultData, 42).toString(10),
    programExecutable: true,
    verifiedAt: new Date().toISOString(),
  };

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
