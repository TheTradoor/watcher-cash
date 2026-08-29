#!/usr/bin/env node

import fs from 'node:fs';
import { chromium } from 'playwright';
import { Connection, PublicKey } from '@solana/web3.js';

const url = String(process.env.WATCHER_V3_E2E_URL || 'http://127.0.0.1:3000/v3/').trim();
const timeout = Number(process.env.WATCHER_V3_E2E_TIMEOUT_MS || 600_000);
const assertionTimeout = Number(process.env.WATCHER_V3_E2E_ASSERT_TIMEOUT_MS || 60_000);
const runtimePath = process.env.WATCHER_V3_RUNTIME_PATH || 'public/watcher-protocol/v3-local.json';
const rpcUrl = process.env.WATCHER_V3_RPC_URL || 'http://127.0.0.1:8899';
const PHANTOM_NAME = 'Phantom';

function fail(message) { throw new Error(message); }

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
  await page.waitForFunction(() => document.querySelector('[data-v3-primary]')?.getAttribute('data-v3-busy') !== 'idle', { timeout: 10_000 });
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
  fail(`${label}: timed out waiting for ${JSON.stringify(expectedMessage)}`);
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
  let total = 0;
  let growthBytes = 0;
  for (let index = 0; index < infos.length; index += 1) {
    const info = infos[index];
    if (!info) fail(`V3 shard ${index} missing`);
    const count = readU32(info.data, 44);
    const expectedLength = runtime.nullifierShardHeaderBytes + (count * runtime.nullifierRecordBytes);
    if (info.data.length !== expectedLength) fail(`V3 shard ${index} storage geometry mismatch`);
    total += count;
    growthBytes += info.data.length - runtime.nullifierShardHeaderBytes;
  }
  return { total, growthBytes };
}

async function main() {
  const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
  const connection = new Connection(rpcUrl, 'confirmed');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error?.stack || error?.message || String(error)));

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    await waitForText(page.getByText('RUNTIME VERIFIED', { exact: true }), 'RUNTIME VERIFIED', 'runtime');
    await waitForText(page.locator('[data-v3-tree-index]'), '0 / 65536', 'fresh tree');
    await connectPhantom(page);
    await waitForText(page.locator('[data-v3-primary]'), 'Unlock V3 private notes', 'wallet connected');
    await page.locator('[data-v3-primary]').click();
    await waitForText(page.locator('[data-v3-message]'), 'Unlocked 0 encrypted V3 note records.', 'vault unlock');

    console.log('Deposit 0.010 SOL before destructive backup test');
    await page.locator('[data-v3-amount]').fill('0.010');
    await runTransaction(page, 'Deposited 0.01 SOL into a V3 private note.', 'deposit before backup');
    await waitForText(page.locator('[data-v3-private-balance]'), '0.01 SOL', 'private balance before backup');
    await waitForText(page.locator('[data-v3-tree-index]'), '1 / 65536', 'tree after deposit');

    console.log('Export ciphertext-only V3 backup');
    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
    await page.locator('[data-v3-backup-export]').click();
    const download = await downloadPromise;
    const backupPath = await download.path();
    if (!backupPath) fail('V3 backup download did not produce a local file');
    const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
    if (backup.protocolVersion !== 3 || backup.ciphertextOnly !== true) fail('V3 backup metadata is invalid');
    const expectedKeys = ['ciphertextOnly','envelope','exportedAt','format','network','protocolVersion','scope','version','wallet'].sort();
    if (Object.keys(backup).sort().join(',') !== expectedKeys.join(',')) fail('V3 backup contains unexpected top-level fields');
    const serializedBackup = JSON.stringify(backup);
    for (const forbidden of ['Owner','Nonce','Amount','leafIndex','commitment','nullifier','records','notes']) {
      if (serializedBackup.includes(forbidden)) fail(`V3 backup leaked ${forbidden}`);
    }

    console.log('Delete encrypted vault only, reload, and prove local note loss');
    const removed = await page.evaluate(() => {
      const keys = Object.keys(localStorage).filter((key) => key.startsWith('watcher-note-vault:v1:watcher-v3:'));
      for (const key of keys) localStorage.removeItem(key);
      return keys.length;
    });
    if (removed !== 1) fail(`expected exactly one V3 encrypted vault key, removed ${removed}`);
    await page.reload({ waitUntil: 'domcontentloaded', timeout });
    await waitForText(page.getByText('RUNTIME VERIFIED', { exact: true }), 'RUNTIME VERIFIED', 'runtime after destructive reload');
    await waitForText(page.locator('[data-v3-primary]'), 'Unlock V3 private notes', 'remembered wallet after destructive reload');
    await page.locator('[data-v3-primary]').click();
    await waitForText(page.locator('[data-v3-message]'), 'Unlocked 0 encrypted V3 note records.', 'empty vault after delete');
    await waitForText(page.locator('[data-v3-private-balance]'), '0 SOL', 'zero private balance after delete');

    console.log('Restore backup and chain-sync the recovered note');
    await page.locator('[data-v3-backup-file]').setInputFiles(backupPath);
    await waitForText(page.locator('[data-v3-message]'), 'Encrypted V3 vault backup restored and synced.', 'backup restore');
    await waitForText(page.locator('[data-v3-private-balance]'), '0.01 SOL', 'restored private balance');
    await waitForCount(page.locator('[data-note-status="confirmed"]'), 1, 'restored spendable note');

    console.log('Partial withdrawal creates a 0.004 SOL private change note');
    await page.locator('[data-v3-tab="withdraw"]').click();
    await page.locator('[data-v3-amount]').fill('0.006');
    await waitForText(page.locator('[data-v3-selection]'), '1 private input', 'partial withdrawal input');
    await waitForText(page.locator('[data-v3-selection]'), '0.004 SOL private change', 'change preview');
    await runTransaction(page, 'Withdrew 0.006 SOL using 1 private note. 0.004 SOL returned as private change.', 'partial withdrawal');
    await waitForText(page.locator('[data-v3-private-balance]'), '0.004 SOL', 'private change balance');
    await waitForText(page.locator('[data-v3-tree-index]'), '2 / 65536', 'change leaf appended');
    await waitForCount(page.locator('[data-note-status="spent"]'), 1, 'original note spent');
    await waitForCount(page.locator('[data-note-status="confirmed"]'), 1, 'change note spendable');

    console.log('Reload and prove packed-nullifier sync preserves only the change note');
    await page.reload({ waitUntil: 'domcontentloaded', timeout });
    await waitForText(page.getByText('RUNTIME VERIFIED', { exact: true }), 'RUNTIME VERIFIED', 'runtime after change reload');
    await page.locator('[data-v3-primary]').click();
    await waitForText(page.locator('[data-v3-message]'), 'Unlocked 2 encrypted V3 note records.', 'vault after change reload');
    await page.locator('[data-v3-tab="withdraw"]').click();
    await page.locator('[data-v3-amount]').fill('0.004');
    await waitForText(page.locator('[data-v3-selection]'), '1 private input', 'change note selection');
    await waitForText(page.locator('[data-v3-selection]'), 'Exact withdrawal', 'exact change-note withdrawal');
    await runTransaction(page, 'Withdrew 0.004 SOL exactly using 1 private note. No change note was created.', 'final change withdrawal');
    await waitForText(page.locator('[data-v3-private-balance]'), '0 SOL', 'final private balance');
    await waitForText(page.locator('[data-v3-tree-index]'), '2 / 65536', 'final exact withdrawal does not append');
    await waitForCount(page.locator('[data-note-status="spent"]'), 2, 'both notes spent');

    const packed = await countPackedNullifiers(connection, runtime);
    if (packed.total !== 2 || packed.growthBytes !== 72) fail(`packed nullifier mismatch ${JSON.stringify(packed)}`);

    const [activeInfo, vaultInfo] = await Promise.all([
      connection.getAccountInfo(new PublicKey(runtime.activeTree), 'confirmed'),
      connection.getAccountInfo(new PublicKey(runtime.vault), 'confirmed'),
    ]);
    if (!activeInfo || !vaultInfo) fail('final V3 state accounts missing');
    const nextIndex = readU32(activeInfo.data, 41);
    const trackedBalance = readU64(vaultInfo.data, 42);
    if (nextIndex !== 2) fail(`final nextIndex ${nextIndex}, want 2`);
    if (trackedBalance !== 0n) fail(`final tracked balance ${trackedBalance}, want 0`);
    if (pageErrors.length) fail(`page errors:\n${pageErrors.join('\n')}`);

    console.log(JSON.stringify({
      status: 'pass',
      destructiveRecovery: true,
      changeWithdrawal: true,
      restoredAmountLamports: '10000000',
      publicWithdrawalLamports: '6000000',
      privateChangeLamports: '4000000',
      finalTreeNextIndex: nextIndex,
      packedNullifiers: packed.total,
      packedGrowthBytes: packed.growthBytes,
      trackedBalance: trackedBalance.toString(),
    }, null, 2));
  } catch (error) {
    await page.screenshot({ path: '/tmp/watcher-v3-recovery-change-failure.png', fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
