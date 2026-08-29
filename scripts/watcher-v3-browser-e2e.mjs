#!/usr/bin/env node

import fs from 'node:fs';
import { chromium } from 'playwright';
import { Connection, PublicKey } from '@solana/web3.js';

const url = String(process.env.WATCHER_V3_E2E_URL || 'http://127.0.0.1:3000/v3/').trim();
const timeout = Number(process.env.WATCHER_V3_E2E_TIMEOUT_MS || 600_000);
const assertionTimeout = Number(process.env.WATCHER_V3_E2E_ASSERT_TIMEOUT_MS || 45_000);
const runtimePath = process.env.WATCHER_V3_RUNTIME_PATH || 'public/watcher-protocol/v3-local.json';
const rpcUrl = process.env.WATCHER_V3_RPC_URL || 'http://127.0.0.1:8899';
const PHANTOM_NAME = 'Phantom';

function fail(message) {
  throw new Error(message);
}

async function waitForText(locator, expected, label) {
  const deadline = Date.now() + assertionTimeout;
  while (Date.now() < deadline) {
    const text = String(await locator.textContent().catch(() => ''));
    if (text.includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  fail(`${label}: timed out waiting for ${JSON.stringify(expected)}; saw ${JSON.stringify(String(await locator.textContent().catch(() => '')).trim())}`);
}

async function waitForCount(locator, expected, label) {
  const deadline = Date.now() + assertionTimeout;
  while (Date.now() < deadline) {
    if (await locator.count() === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  fail(`${label}: expected ${expected}, saw ${await locator.count()}`);
}

async function connectPhantom(page) {
  const button = page.locator('.wallet-adapter-button').first();
  await button.click({ timeout });
  const modal = page.locator('.wallet-adapter-modal-wrapper');
  await modal.waitFor({ state: 'visible', timeout });
  const wallet = modal.locator('button').filter({ hasText: PHANTOM_NAME }).first();
  await wallet.waitFor({ state: 'visible', timeout });
  await wallet.click();
  await page.waitForFunction(
    (name) => window.localStorage.getItem('watcher-cash:walletName:v1') === JSON.stringify(name),
    PHANTOM_NAME,
    { timeout },
  );
}

async function runTransaction(page, expectedMessage, label) {
  const primary = page.locator('[data-v3-primary]');
  const message = page.locator('[data-v3-message]');
  const error = page.locator('[data-v3-error="true"]');
  await primary.click({ timeout });
  const deadline = Date.now() + Math.min(timeout, 300_000);
  while (Date.now() < deadline) {
    if (await error.count()) {
      const errorText = String(await error.textContent().catch(() => '')).trim();
      if (errorText) fail(`${label}: ${errorText}`);
    }
    const messageText = String(await message.textContent().catch(() => ''));
    if (messageText.includes(expectedMessage)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const proverText = String(await page.locator('[data-v3-prover]').textContent().catch(() => '')).trim();
  fail(`${label}: timed out waiting for ${JSON.stringify(expectedMessage)}; message=${JSON.stringify(String(await message.textContent().catch(() => '')).trim())}; prover=${JSON.stringify(proverText)}`);
}

function readU32(data, offset) {
  return new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0, true);
}

function readU64(data, offset) {
  return new DataView(data.buffer, data.byteOffset + offset, 8).getBigUint64(0, true);
}

async function countPackedNullifiers(connection, runtime) {
  const shards = runtime.nullifierShards.map((value) => new PublicKey(value));
  const infos = await connection.getMultipleAccountsInfo(shards, 'confirmed');
  if (infos.length !== shards.length || infos.some((info) => !info)) fail('one or more V3 nullifier shards are missing');
  let total = 0;
  let growthBytes = 0;
  for (let index = 0; index < infos.length; index += 1) {
    const info = infos[index];
    const count = readU32(info.data, 44);
    const expectedLength = runtime.nullifierShardHeaderBytes + (count * runtime.nullifierRecordBytes);
    if (info.data.length !== expectedLength) {
      fail(`V3 shard ${index} length ${info.data.length} does not match count ${count}`);
    }
    total += count;
    growthBytes += info.data.length - runtime.nullifierShardHeaderBytes;
  }
  return { total, growthBytes };
}

async function main() {
  const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
  const connection = new Connection(rpcUrl, 'confirmed');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error?.stack || error?.message || String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') console.error(`[browser console] ${message.text()}`);
  });

  try {
    console.log(`Opening ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    await waitForText(page.getByText('RUNTIME VERIFIED', { exact: true }), 'RUNTIME VERIFIED', 'V3 runtime verification');
    await waitForText(page.locator('[data-v3-tree-index]'), '0 / 65536', 'fresh V3 tree');
    await waitForText(page.locator('[data-v3-nullifier-geometry]'), '32 packed shards', 'V3 nullifier geometry');
    await connectPhantom(page);

    console.log('Phantom-compatible message rejection remains recoverable');
    await waitForText(page.locator('[data-v3-primary]'), 'Unlock V3 private notes', 'Phantom wallet connection');
    await page.evaluate(() => sessionStorage.setItem('watcher-e2e:reject-next-message', '1'));
    await page.locator('[data-v3-primary]').click();
    await waitForText(page.locator('[data-v3-error="true"]'), 'Request cancelled in your wallet', 'Phantom unlock rejection');
    await page.locator('[data-v3-primary]').click();
    await waitForText(page.locator('[data-v3-message]'), 'Unlocked 0 encrypted V3 note records.', 'V3 vault unlock');
    await waitForText(page.locator('[data-v3-private-balance]'), '0 SOL', 'empty V3 private balance');

    console.log('V3 browser deposit + one-note exact withdrawal');
    await page.locator('[data-v3-amount]').fill('0.008');
    await runTransaction(page, 'Deposited 0.008 SOL into a V3 private note.', 'V3 deposit #1');
    await waitForText(page.locator('[data-v3-private-balance]'), '0.008 SOL', 'private balance after V3 deposit #1');
    await waitForText(page.locator('[data-v3-tree-index]'), '1 / 65536', 'tree after V3 deposit #1');
    await waitForText(page.locator('[data-v3-prover]'), 'self-verified locally', 'V3 browser prover');

    await page.locator('[data-v3-tab="withdraw"]').click();
    await page.locator('[data-v3-amount]').fill('0.008');
    await waitForText(page.locator('[data-v3-selection]'), '1 private input', 'V3 one-input exact selection');
    await waitForText(page.locator('[data-v3-selection]'), 'Exact withdrawal', 'V3 exact sentinel');
    await runTransaction(page, 'Withdrew 0.008 SOL exactly using 1 private note. No change note was created.', 'V3 one-input exact withdrawal');
    await waitForText(page.locator('[data-v3-private-balance]'), '0 SOL', 'V3 balance after exact withdrawal');
    await waitForText(page.locator('[data-v3-tree-index]'), '1 / 65536', 'V3 exact withdrawal did not append');
    await waitForCount(page.locator('[data-note-status="spent"]'), 1, 'spent V3 note after exact withdrawal');

    const afterOne = await countPackedNullifiers(connection, runtime);
    if (afterOne.total !== 1 || afterOne.growthBytes !== 36) {
      fail(`V3 first browser withdrawal packed storage mismatch: ${JSON.stringify(afterOne)}`);
    }

    console.log('V3 reload sync reads packed shard state rather than V2 marker PDAs');
    await page.reload({ waitUntil: 'domcontentloaded', timeout });
    await waitForText(page.getByText('RUNTIME VERIFIED', { exact: true }), 'RUNTIME VERIFIED', 'V3 runtime after reload');
    await waitForText(page.locator('[data-v3-primary]'), 'Unlock V3 private notes', 'remembered Phantom after reload');
    await page.locator('[data-v3-primary]').click();
    await waitForText(page.locator('[data-v3-message]'), 'Unlocked 1 encrypted V3 note record.', 'V3 vault reload');
    await page.locator('[data-v3-tab="withdraw"]').click();
    await page.locator('[data-v3-amount]').fill('0.008');
    await page.locator('[data-v3-primary]').click();
    await waitForText(page.locator('[data-v3-error="true"]'), 'No spendable private notes', 'spent V3 note cannot be replay-selected after reload');
    await waitForCount(page.locator('[data-note-status="spent"]'), 1, 'V3 packed state resynced spent note');

    console.log('V3 two-note exact browser withdrawal');
    await page.locator('[data-v3-tab="deposit"]').click();
    await page.locator('[data-v3-amount]').fill('0.003');
    await runTransaction(page, 'Deposited 0.003 SOL into a V3 private note.', 'V3 deposit #2');
    await page.locator('[data-v3-amount]').fill('0.005');
    await runTransaction(page, 'Deposited 0.005 SOL into a V3 private note.', 'V3 deposit #3');
    await waitForText(page.locator('[data-v3-private-balance]'), '0.008 SOL', 'V3 balance before two-input exact');
    await waitForText(page.locator('[data-v3-tree-index]'), '3 / 65536', 'tree after three V3 deposits');

    await page.locator('[data-v3-tab="withdraw"]').click();
    await page.locator('[data-v3-amount]').fill('0.008');
    await waitForText(page.locator('[data-v3-selection]'), '2 private inputs', 'V3 two-input exact selection');
    await waitForText(page.locator('[data-v3-selection]'), 'Exact withdrawal', 'V3 two-input exact sentinel');
    await runTransaction(page, 'Withdrew 0.008 SOL exactly using 2 private notes. No change note was created.', 'V3 two-input exact withdrawal');
    await waitForText(page.locator('[data-v3-private-balance]'), '0 SOL', 'final V3 private balance');
    await waitForText(page.locator('[data-v3-tree-index]'), '3 / 65536', 'V3 two-input exact withdrawal did not append');
    await waitForCount(page.locator('[data-note-status="spent"]'), 3, 'all V3 notes spent');

    const packed = await countPackedNullifiers(connection, runtime);
    if (packed.total !== 3 || packed.growthBytes !== 108) {
      fail(`V3 browser packed-nullifier total mismatch: ${JSON.stringify(packed)}`);
    }

    const programId = new PublicKey(runtime.programId);
    const activeTree = new PublicKey(runtime.activeTree);
    const vault = new PublicKey(runtime.vault);
    const [activeInfo, vaultInfo, v2MarkerAccounts] = await Promise.all([
      connection.getAccountInfo(activeTree, 'confirmed'),
      connection.getAccountInfo(vault, 'confirmed'),
      connection.getProgramAccounts(programId, { commitment: 'confirmed', filters: [{ dataSize: 0 }] }),
    ]);
    if (!activeInfo || !vaultInfo) fail('V3 final on-chain state accounts are missing');
    const nextIndex = readU32(activeInfo.data, 41);
    const trackedBalance = readU64(vaultInfo.data, 42);
    if (nextIndex !== 3) fail(`V3 final next_index is ${nextIndex}, want 3`);
    if (trackedBalance !== 0n) fail(`V3 final tracked vault balance is ${trackedBalance}, want 0`);
    if (v2MarkerAccounts.length !== 0) fail(`V3 browser flow created ${v2MarkerAccounts.length} zero-data V2 marker PDA(s)`);
    if (pageErrors.length > 0) fail(`V3 browser page errors:\n\n${pageErrors.join('\n\n')}`);

    console.log(JSON.stringify({
      status: 'pass',
      walletSurface: PHANTOM_NAME,
      flow: [
        'phantom-connect',
        'phantom-message-rejection',
        'unlock-v3-vault',
        'deposit-browser-proof',
        'one-input-v3-exact-withdraw',
        'packed-nullifier-reload-sync',
        'two-input-v3-exact-withdraw',
      ],
      treeNextIndex: nextIndex,
      packedNullifiers: packed.total,
      packedGrowthBytes: packed.growthBytes,
      v2MarkerAccounts: v2MarkerAccounts.length,
      trackedBalance: trackedBalance.toString(),
    }, null, 2));
  } catch (error) {
    await page.screenshot({ path: '/tmp/watcher-v3-browser-e2e-failure.png', fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
