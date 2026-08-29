#!/usr/bin/env node

import fs from 'node:fs';
import { chromium } from 'playwright';
import { Connection, PublicKey } from '@solana/web3.js';

const url = String(process.env.WATCHER_V2_E2E_URL || 'http://127.0.0.1:3000/v2/').trim();
const timeout = Number(process.env.WATCHER_V2_E2E_TIMEOUT_MS || 600_000);
const runtimePath = process.env.WATCHER_V2_RUNTIME_PATH || 'public/watcher-protocol/v2-devnet.json';
const rpcUrl = process.env.WATCHER_V2_RPC_URL || 'http://127.0.0.1:8899';
const E2E_WALLET_NAME = 'Watcher E2E Wallet';

function fail(message) {
  throw new Error(message);
}

async function waitForText(locator, expected, label) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const text = String(await locator.textContent().catch(() => ''));
    if (text.includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  fail(`${label}: timed out waiting for ${JSON.stringify(expected)}; saw ${JSON.stringify(String(await locator.textContent().catch(() => '')).trim())}`);
}

async function waitForCount(locator, expected, label) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await locator.count() === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  fail(`${label}: expected ${expected}, saw ${await locator.count()}`);
}

async function connectE2eWallet(page) {
  const button = page.locator('.wallet-adapter-button').first();
  await button.click({ timeout });
  const modal = page.locator('.wallet-adapter-modal-wrapper');
  await modal.waitFor({ state: 'visible', timeout });
  const wallet = modal.locator('button').filter({ hasText: E2E_WALLET_NAME }).first();
  await wallet.waitFor({ state: 'visible', timeout });
  await wallet.click();
  await page.waitForFunction(
    (name) => window.localStorage.getItem('watcher-cash:walletName:v1') === JSON.stringify(name),
    E2E_WALLET_NAME,
    { timeout },
  );
}

async function runTransaction(page, expectedMessage, label) {
  const primary = page.locator('[data-v2-primary]');
  await primary.click({ timeout });
  await waitForText(page.locator('[data-v2-message]'), expectedMessage, label);
  const error = page.locator('[data-v2-error="true"]');
  if (await error.count()) fail(`${label}: ${String(await error.textContent()).trim()}`);
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
    await waitForText(page.getByText('RUNTIME VERIFIED', { exact: true }), 'RUNTIME VERIFIED', 'V2 runtime verification');
    await waitForText(page.locator('[data-v2-tree-index]'), '0 / 65536', 'fresh V2 tree');
    await connectE2eWallet(page);

    const primary = page.locator('[data-v2-primary]');
    await waitForText(primary, 'Unlock V2 private notes', 'V2 wallet connection');
    await primary.click();
    await waitForText(page.locator('[data-v2-message]'), 'Unlocked 0 encrypted V2 note records.', 'V2 vault unlock');
    await waitForText(page.locator('[data-v2-private-balance]'), '0 SOL', 'empty private balance');

    console.log('V2 deposit #1 + one-note exact withdrawal');
    await page.locator('[data-v2-amount]').fill('0.008');
    await runTransaction(page, 'Deposited 0.008 SOL into a V2 proof-bound private note.', 'V2 deposit #1');
    await waitForText(page.locator('[data-v2-private-balance]'), '0.008 SOL', 'private balance after deposit #1');
    await waitForText(page.locator('[data-v2-tree-index]'), '1 / 65536', 'tree after deposit #1');
    await waitForCount(page.locator('[data-note-status="confirmed"]'), 1, 'confirmed note after deposit #1');
    await waitForText(page.locator('[data-v2-prover]'), 'V2 proof generated and self-verified locally.', 'V2 deposit browser prover');

    await page.locator('[data-v2-tab="withdraw"]').click();
    await page.locator('[data-v2-amount]').fill('0.008');
    await waitForText(page.locator('[data-v2-selection]'), '1 private input', 'one-input exact selection');
    await waitForText(page.locator('[data-v2-selection]'), 'Exact withdrawal', 'one-input exact sentinel');
    await runTransaction(page, 'Withdrew 0.008 SOL exactly using 1 private note. No change note was created.', 'one-input exact withdrawal');
    await waitForText(page.locator('[data-v2-private-balance]'), '0 SOL', 'balance after exact withdrawal');
    await waitForText(page.locator('[data-v2-tree-index]'), '1 / 65536', 'exact withdrawal did not append');
    await waitForCount(page.locator('[data-note-status="spent"]'), 1, 'spent note after exact withdrawal');

    console.log('V2 private-change withdrawal');
    await page.locator('[data-v2-tab="deposit"]').click();
    await page.locator('[data-v2-amount]').fill('0.01');
    await runTransaction(page, 'Deposited 0.01 SOL into a V2 proof-bound private note.', 'V2 deposit #2');
    await waitForText(page.locator('[data-v2-tree-index]'), '2 / 65536', 'tree after deposit #2');

    await page.locator('[data-v2-tab="withdraw"]').click();
    await page.locator('[data-v2-amount]').fill('0.006');
    await waitForText(page.locator('[data-v2-selection]'), '1 private input', 'one-input change selection');
    await waitForText(page.locator('[data-v2-selection]'), '0.004 SOL private change', 'private change preview');
    await runTransaction(page, 'Withdrew 0.006 SOL using 1 private note. 0.004 SOL returned as private change.', 'V2 private-change withdrawal');
    await waitForText(page.locator('[data-v2-private-balance]'), '0.004 SOL', 'balance after private change');
    await waitForText(page.locator('[data-v2-tree-index]'), '3 / 65536', 'change leaf appended');
    await waitForCount(page.locator('[data-note-status="confirmed"]'), 1, 'confirmed private change');
    await waitForCount(page.locator('[data-note-status="spent"]'), 2, 'spent notes before multi-input withdrawal');

    console.log('V2 two-input exact withdrawal');
    await page.locator('[data-v2-tab="deposit"]').click();
    await page.locator('[data-v2-amount]').fill('0.004');
    await runTransaction(page, 'Deposited 0.004 SOL into a V2 proof-bound private note.', 'V2 deposit #3');
    await waitForText(page.locator('[data-v2-private-balance]'), '0.008 SOL', 'balance before two-input exact');
    await waitForText(page.locator('[data-v2-tree-index]'), '4 / 65536', 'tree after deposit #3');

    await page.locator('[data-v2-tab="withdraw"]').click();
    await page.locator('[data-v2-amount]').fill('0.008');
    await waitForText(page.locator('[data-v2-selection]'), '2 private inputs', 'two-input exact selection');
    await waitForText(page.locator('[data-v2-selection]'), 'Exact withdrawal', 'two-input exact sentinel');
    await runTransaction(page, 'Withdrew 0.008 SOL exactly using 2 private notes. No change note was created.', 'two-input exact withdrawal');
    await waitForText(page.locator('[data-v2-private-balance]'), '0 SOL', 'final private balance');
    await waitForText(page.locator('[data-v2-tree-index]'), '4 / 65536', 'two-input exact withdrawal did not append');
    await waitForCount(page.locator('[data-note-status="spent"]'), 4, 'all V2 private notes spent');
    await waitForCount(page.locator('[data-note-status="confirmed"]'), 0, 'no remaining confirmed V2 notes');

    console.log('V2 public tree reconstructs from chain after local cache loss');
    const removedPublicTreeKeys = await page.evaluate(() => {
      const removed = [];
      for (let index = localStorage.length - 1; index >= 0; index -= 1) {
        const key = localStorage.key(index);
        if (key?.startsWith('watcher-public-tree:v2:')) {
          removed.push(key);
          localStorage.removeItem(key);
        }
      }
      return removed;
    });
    if (removedPublicTreeKeys.length !== 1) {
      fail(`expected exactly one V2 public-tree cache key, removed ${removedPublicTreeKeys.length}`);
    }
    await page.reload({ waitUntil: 'domcontentloaded', timeout });
    await waitForText(page.getByText('RUNTIME VERIFIED', { exact: true }), 'RUNTIME VERIFIED', 'runtime after public-tree cache loss');
    await waitForText(page.locator('[data-v2-tree-index]'), '4 / 65536', 'rebuilt V2 public tree index');
    await waitForText(page.locator('[data-tree-status="ready"]'), 'local commitment history matches on-chain root', 'rebuilt V2 public tree root');

    console.log('V2 encrypted note metadata survives reload independently of public-tree cache');
    await waitForText(page.locator('[data-v2-primary]'), 'Unlock V2 private notes', 'remembered V2 wallet');
    await page.locator('[data-v2-primary]').click();
    await waitForText(page.locator('[data-v2-message]'), 'Unlocked 4 encrypted V2 note records.', 'V2 encrypted vault reload');
    await waitForText(page.locator('[data-v2-private-balance]'), '0 SOL', 'reloaded private balance');
    await waitForText(page.locator('[data-v2-tree-index]'), '4 / 65536', 'reloaded V2 public tree');
    await waitForCount(page.locator('[data-note-status="spent"]'), 4, 'reloaded spent metadata');

    const activeTree = new PublicKey(runtime.activeTree);
    const vault = new PublicKey(runtime.vault);
    const programId = new PublicKey(runtime.programId);
    const [activeInfo, vaultInfo, markerAccounts] = await Promise.all([
      connection.getAccountInfo(activeTree, 'confirmed'),
      connection.getAccountInfo(vault, 'confirmed'),
      connection.getProgramAccounts(programId, { commitment: 'confirmed', filters: [{ dataSize: 0 }] }),
    ]);
    if (!activeInfo || !vaultInfo) fail('V2 final on-chain state accounts are missing');
    const nextIndex = new DataView(activeInfo.data.buffer, activeInfo.data.byteOffset + 41, 4).getUint32(0, true);
    const trackedBalance = new DataView(vaultInfo.data.buffer, vaultInfo.data.byteOffset + 42, 8).getBigUint64(0, true);
    if (nextIndex !== 4) fail(`V2 final next_index is ${nextIndex}, want 4`);
    if (trackedBalance !== 0n) fail(`V2 final tracked vault balance is ${trackedBalance}, want 0`);
    if (markerAccounts.length !== 4) fail(`V2 nullifier marker count is ${markerAccounts.length}, want 4`);
    if (pageErrors.length > 0) fail(`V2 browser page errors:\n\n${pageErrors.join('\n\n')}`);

    console.log(JSON.stringify({
      status: 'pass',
      flow: [
        'connect',
        'unlock-v2-vault',
        'deposit-browser-proof',
        'one-input-exact-withdraw',
        'private-change-withdraw',
        'two-input-exact-withdraw',
        'rebuild-public-tree-from-chain',
        'reload-encrypted-metadata',
      ],
      treeDepth: runtime.treeDepth,
      nextIndex,
      trackedBalance: trackedBalance.toString(),
      nullifierMarkers: markerAccounts.length,
      browserProver: 'V2 WASM Groth16',
      publicTreeRecovery: true,
    }, null, 2));
  } catch (error) {
    await page.screenshot({ path: '/tmp/watcher-v2-browser-e2e-failure.png', fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
