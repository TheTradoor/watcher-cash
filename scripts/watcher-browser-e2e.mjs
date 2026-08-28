#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const url = String(process.env.WATCHER_E2E_URL || 'http://127.0.0.1:3000/').trim();
const timeout = Number(process.env.WATCHER_E2E_TIMEOUT_MS || 300_000);
const WALLET_STORAGE_KEY = 'watcher-cash:walletName:v1';
const LEGACY_WALLET_STORAGE_KEY = 'walletName';
const E2E_WALLET_NAME = 'Watcher E2E Wallet';
const E2E_ALTERNATE_WALLET_NAME = 'Watcher E2E Alternate Wallet';
const E2E_REJECT_MESSAGE_KEY = 'watcher-e2e:reject-next-message';
const E2E_REJECT_TRANSACTION_KEY = 'watcher-e2e:reject-next-transaction';
const CANCELLED_MESSAGE = 'Request cancelled in your wallet. Nothing was signed or submitted. You can try again.';

function fail(message) {
  throw new Error(message);
}

async function waitForText(locator, expected, label) {
  await locator.waitFor({ state: 'visible', timeout });
  await locator.evaluate((element, value) => new Promise((resolve, reject) => {
    const deadline = Date.now() + 300_000;
    const check = () => {
      const text = element.textContent || '';
      if (text.includes(value)) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`Timed out waiting for ${value}; saw ${text}`));
        return;
      }
      setTimeout(check, 250);
    };
    check();
  }), expected).catch((error) => fail(`${label}: ${error.message}`));
}

async function waitForExactText(locator, expected, label) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const text = String(await locator.textContent().catch(() => '')).trim();
    if (text === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  fail(`${label}: expected ${JSON.stringify(expected)}, saw ${JSON.stringify(String(await locator.textContent().catch(() => '')).trim())}`);
}

async function waitForCount(locator, expected, label) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const count = await locator.count();
    if (count === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  fail(`${label}: expected ${expected} rows, saw ${await locator.count()}`);
}

async function connectE2eWallet(page) {
  const walletButton = page.locator('nav.topbar .wallet-adapter-button').first();
  await walletButton.click({ timeout });

  const modal = page.locator('.wallet-adapter-modal-wrapper');
  await modal.waitFor({ state: 'visible', timeout });

  // Wallet Adapter UI appends readiness text such as "Detected" to the
  // accessible button name. Match the visible wallet row by text instead of an
  // exact aria name so the regression remains stable across adapter UI labels.
  const primaryWallet = modal.locator('button').filter({ hasText: E2E_WALLET_NAME }).first();
  const alternateWallet = modal.locator('button').filter({ hasText: E2E_ALTERNATE_WALLET_NAME }).first();
  await primaryWallet.waitFor({ state: 'visible', timeout });
  await alternateWallet.waitFor({ state: 'visible', timeout });
  await primaryWallet.click();

  await page.waitForFunction(
    ({ key, legacy, wallet }) => (
      window.localStorage.getItem(key) === JSON.stringify(wallet)
      && window.localStorage.getItem(legacy) === null
    ),
    { key: WALLET_STORAGE_KEY, legacy: LEGACY_WALLET_STORAGE_KEY, wallet: E2E_WALLET_NAME },
    { timeout },
  );
}

async function armWalletRejection(page, key) {
  await page.evaluate((storageKey) => window.sessionStorage.setItem(storageKey, '1'), key);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1200 },
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error?.stack || error?.message || String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      console.error(`[browser console] ${message.text()}`);
    }
  });

  try {
    console.log(`Opening ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });

    await waitForText(page.locator('.nav-statuses'), 'DEVNET VERIFIED', 'runtime verification');
    const primary = page.locator('.primary-action');
    await waitForText(primary, 'Connect wallet', 'no selected wallet state');
    await connectE2eWallet(page);

    await waitForText(primary, 'Unlock private vault', 'wallet connection');

    console.log('Locked vault UX');
    await waitForText(page.locator('.locked-vault-state'), 'Unlock your private vault', 'locked vault card');
    await waitForCount(page.locator('.mode-tabs'), 0, 'locked mode tabs hidden');
    await waitForCount(page.locator('#amount'), 0, 'locked amount input hidden');
    await waitForCount(page.locator('#recipient'), 0, 'locked recipient input hidden');
    await waitForCount(page.locator('.withdraw-readiness'), 0, 'locked withdrawal guidance hidden');
    await waitForExactText(page.locator('.capacity-card .side-data-row strong'), '—', 'locked nullifier placeholder');

    console.log('Wallet message rejection + retry');
    await armWalletRejection(page, E2E_REJECT_MESSAGE_KEY);
    await primary.click();
    await waitForText(page.locator('.feedback-info'), CANCELLED_MESSAGE, 'informational unlock rejection');
    await waitForText(primary, 'Unlock private vault', 'unlock remains retryable after rejection');
    await waitForCount(page.locator('#amount'), 0, 'unlock rejection keeps private form locked');

    await primary.click();
    await waitForText(page.locator('.feedback-success'), 'Private note vault unlocked and synced.', 'vault unlock retry');

    const amount = page.locator('#amount');
    await amount.fill('0.01');

    console.log('Wallet transaction rejection + local draft recovery');
    await armWalletRejection(page, E2E_REJECT_TRANSACTION_KEY);
    await waitForText(primary, 'Generate proof & deposit', 'rejected deposit button');
    await primary.click();
    await waitForText(page.locator('.feedback-info'), CANCELLED_MESSAGE, 'informational deposit rejection');
    await waitForText(page.locator('.vault-panel'), '0 confirmed notes · 1 pending', 'rejected deposit draft retained locally');
    const discardDraft = page.getByRole('button', { name: 'Discard local draft', exact: true });
    await discardDraft.click();
    await waitForText(page.locator('.feedback-success'), 'Local pending note draft removed.', 'rejected deposit draft cleanup');
    await waitForText(page.locator('.vault-panel'), '0 confirmed notes · 0 pending', 'clean vault after rejected deposit');

    console.log('Deposit #1');
    await waitForText(primary, 'Generate proof & deposit', 'deposit #1 button');
    await primary.click();
    await waitForText(page.locator('.feedback-success'), 'Deposited 0.01 SOL into a proof-bound private note.', 'deposit #1');
    await waitForText(page.locator('.vault-panel'), '1 confirmed notes · 0 pending', 'deposit #1 note sync');

    console.log('Deposit #2');
    await primary.click();
    await waitForText(page.locator('.feedback-success'), 'Deposited 0.01 SOL into a proof-bound private note.', 'deposit #2');
    await waitForText(page.locator('.vault-panel'), '2 confirmed notes · 0 pending', 'deposit #2 note sync');
    await waitForExactText(page.locator('.capacity-card .capacity-number strong'), '2', 'tree after deposits');

    console.log('Encrypted vault backup');
    const downloadPromise = page.waitForEvent('download', { timeout });
    await page.getByRole('button', { name: 'Export encrypted backup', exact: true }).click();
    const backupDownload = await downloadPromise;
    const backupPath = await backupDownload.path();
    if (!backupPath) fail('encrypted backup regression: browser did not provide a downloaded file');
    const backup = JSON.parse(await readFile(backupPath, 'utf8'));
    if (backup?.format !== 'watcher-cash-encrypted-vault-backup' || backup?.version !== 1) {
      fail('encrypted backup regression: exported file has the wrong format/version');
    }
    if (backup?.ciphertextOnly !== true) {
      fail('encrypted backup regression: exported file is not marked ciphertext-only');
    }
    const envelopeKeys = Object.keys(backup?.envelope || {}).sort().join(',');
    if (envelopeKeys !== 'ciphertext,iv,version') {
      fail(`encrypted backup regression: unexpected envelope fields ${envelopeKeys}`);
    }
    const backupText = JSON.stringify(backup);
    if (backupText.includes('"owner"') || backupText.includes('"nonce"') || backupText.includes('"notes"')) {
      fail('encrypted backup regression: private note plaintext leaked into exported backup');
    }

    const removedVaultKey = await page.evaluate(() => {
      const key = Object.keys(window.localStorage)
        .find((name) => name.startsWith('watcher-note-vault:v1:'));
      if (!key) return '';
      window.localStorage.removeItem(key);
      return key;
    });
    if (!removedVaultKey) fail('encrypted backup regression: local encrypted vault was not found before loss simulation');

    console.log('Encrypted vault recovery');
    await page.reload({ waitUntil: 'domcontentloaded', timeout });
    await waitForText(page.locator('.nav-statuses'), 'DEVNET VERIFIED', 'runtime verification after reload');
    const primaryAfterReload = page.locator('.primary-action');
    await waitForText(primaryAfterReload, 'Unlock private vault', 'remembered wallet auto-connect');
    await primaryAfterReload.click();
    await waitForText(page.locator('.feedback-success'), 'Private note vault unlocked and synced.', 'empty vault unlock after loss');
    await waitForText(page.locator('.vault-panel'), '0 confirmed notes · 0 pending', 'vault loss reflected locally');

    await page.locator('#vault-backup-input').setInputFiles(backupPath);
    await waitForText(
      page.locator('.feedback-success'),
      'Encrypted vault backup restored and synced. 2 note records available.',
      'encrypted vault restore',
    );
    await waitForText(page.locator('.vault-panel'), '2 confirmed notes · 0 pending', 'restored note sync');

    console.log('Withdrawal');
    await page.getByRole('button', { name: 'Withdraw', exact: true }).click();
    await page.locator('#amount').fill('0.01');
    const recipient = page.locator('#recipient');
    if (!(await recipient.inputValue()).trim()) {
      await page.getByRole('button', { name: 'Use connected wallet', exact: true }).click();
    }
    await waitForText(page.locator('.preview-card'), 'Notes consumed', 'withdrawal preview');
    await waitForText(page.locator('.preview-card'), 'Private change', 'withdrawal change preview');
    await waitForText(primaryAfterReload, 'Generate proof & withdraw', 'withdrawal button');
    await primaryAfterReload.click();
    await waitForText(page.locator('.feedback-success'), 'Withdrew 0.01 SOL. 0.01 SOL returned as private change.', 'withdrawal');

    const lookupTableAddress = await page.evaluate(() => {
      const key = Object.keys(window.localStorage)
        .find((name) => name.startsWith('watcher-withdraw-alt:'));
      return key ? String(window.localStorage.getItem(key) || '') : '';
    });
    if (!lookupTableAddress) {
      fail('v0 withdrawal regression: oversized withdrawal did not create/cache an address lookup table');
    }

    const refresh = page.getByRole('button', { name: 'Refresh balance', exact: true });
    await refresh.click();
    await waitForText(page.locator('.feedback-success'), 'Private balance synced from devnet state.', 'final private sync');

    await waitForExactText(page.locator('.vault-panel h2'), '0.01 SOL', 'final private balance');
    await waitForText(page.locator('.vault-panel'), '1 confirmed notes · 0 pending', 'final note inventory');
    await waitForExactText(page.locator('.capacity-card .capacity-number strong'), '3', 'final commitment count');
    await waitForExactText(page.locator('.capacity-card .side-data-row strong'), '2', 'final nullifier count');
    await waitForText(
      page.locator('.withdraw-readiness'),
      'Withdrawal requires 2 confirmed notes. You have 1. Deposit 1 more note to continue.',
      'post-withdraw guidance',
    );
    await waitForText(primaryAfterReload, 'Deposit 1 more note', 'post-withdraw button label');
    if (await primaryAfterReload.isDisabled()) {
      fail('post-withdraw UX regression: deposit shortcut should remain clickable');
    }
    await primaryAfterReload.click();
    await waitForText(primaryAfterReload, 'Generate proof & deposit', 'deposit shortcut destination');
    await waitForText(
      page.locator('.feedback-info'),
      'Deposit 1 more private note, then return to Withdraw.',
      'deposit shortcut feedback',
    );

    const noteRows = page.locator('.notes-list .note-row');
    await waitForCount(noteRows, 3, 'final encrypted note inventory');

    const spentRows = page.locator('.notes-list .note-row .note-status.note-spent');
    await waitForCount(spentRows, 2, 'spent input notes');

    const confirmedRows = page.locator('.notes-list .note-row .note-status.note-confirmed');
    await waitForCount(confirmedRows, 1, 'confirmed private change');
    const confirmedChangeRow = confirmedRows.first().locator('xpath=..').locator('xpath=..');
    await waitForText(confirmedChangeRow, '0.01 SOL', 'final change amount');
    await waitForText(confirmedChangeRow, 'PRIVATE CHANGE', 'final change kind');

    console.log('Legacy wallet selection migration');
    const rememberedWallet = await page.evaluate(({ key }) => window.localStorage.getItem(key), { key: WALLET_STORAGE_KEY });
    if (!rememberedWallet) fail('wallet compatibility regression: namespaced remembered wallet is missing');
    await page.evaluate(({ currentKey, legacyKey, value }) => {
      window.localStorage.removeItem(currentKey);
      window.localStorage.setItem(legacyKey, value);
    }, {
      currentKey: WALLET_STORAGE_KEY,
      legacyKey: LEGACY_WALLET_STORAGE_KEY,
      value: rememberedWallet,
    });
    await page.reload({ waitUntil: 'domcontentloaded', timeout });
    await waitForText(page.locator('.nav-statuses'), 'DEVNET VERIFIED', 'runtime verification after wallet migration reload');
    const primaryAfterMigration = page.locator('.primary-action');
    await waitForText(primaryAfterMigration, 'Unlock private vault', 'legacy wallet selection migration auto-connect');
    await page.waitForFunction(
      ({ currentKey, legacyKey, value }) => (
        window.localStorage.getItem(currentKey) === value
        && window.localStorage.getItem(legacyKey) === null
      ),
      {
        currentKey: WALLET_STORAGE_KEY,
        legacyKey: LEGACY_WALLET_STORAGE_KEY,
        value: rememberedWallet,
      },
      { timeout },
    );

    if (pageErrors.length > 0) {
      fail(`Browser page errors:\n\n${pageErrors.join('\n\n')}`);
    }

    console.log(JSON.stringify({
      status: 'pass',
      flow: [
        'no-wallet-state',
        'multi-wallet-modal',
        'connect',
        'namespaced-wallet-persistence',
        'locked-vault-form-hidden',
        'wallet-message-rejection-retry',
        'wallet-transaction-rejection-draft-recovery',
        'unlock',
        'deposit',
        'deposit',
        'backup-export-ciphertext-only',
        'local-vault-loss',
        'remembered-wallet-auto-connect',
        'backup-restore-and-sync',
        'withdraw-v0-alt',
        'sync',
        'post-withdraw-deposit-shortcut',
        'legacy-wallet-storage-migration',
      ],
      lookupTableAddress,
      final: {
        privateBalanceSol: '0.01',
        confirmedNotes: 1,
        spentNotes: 2,
        pendingNotes: 0,
        commitmentCount: 3,
        spentNullifiers: 2,
        encryptedBackupRecovery: true,
        depositShortcutReady: true,
        rememberedWalletAutoConnect: true,
        multiWalletModal: true,
        legacyWalletStorageMigrated: true,
        walletRejectionRecovery: true,
        retryableFailuresInformational: true,
      },
    }, null, 2));
  } catch (error) {
    await page.screenshot({ path: '/tmp/watcher-browser-e2e-failure.png', fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
