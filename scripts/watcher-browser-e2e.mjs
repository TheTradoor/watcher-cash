#!/usr/bin/env node

import { chromium } from 'playwright';

const url = String(process.env.WATCHER_E2E_URL || 'http://127.0.0.1:3000/').trim();
const timeout = Number(process.env.WATCHER_E2E_TIMEOUT_MS || 300_000);

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

    const walletButton = page.locator('nav.topbar .wallet-adapter-button').first();
    await walletButton.click({ timeout });
    const e2eWalletButton = page.getByRole('button', { name: /Watcher E2E Wallet/i }).last();
    await e2eWalletButton.waitFor({ state: 'visible', timeout });
    await e2eWalletButton.click();

    const primary = page.locator('.primary-action');
    await waitForText(primary, 'Unlock private notes', 'wallet connection');
    await primary.click();
    await waitForText(page.locator('.feedback-success'), 'Private note vault unlocked and synced.', 'vault unlock');

    const amount = page.locator('#amount');
    await amount.fill('0.01');

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

    console.log('Withdrawal');
    await page.getByRole('button', { name: 'Withdraw', exact: true }).click();
    await amount.fill('0.01');
    const recipient = page.locator('#recipient');
    if (!(await recipient.inputValue()).trim()) {
      await page.getByRole('button', { name: 'Use connected wallet', exact: true }).click();
    }
    await waitForText(page.locator('.preview-card'), 'Notes consumed', 'withdrawal preview');
    await waitForText(page.locator('.preview-card'), 'Private change', 'withdrawal change preview');
    await waitForText(primary, 'Generate proof & withdraw', 'withdrawal button');
    await primary.click();
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
      page.locator('.preview-card'),
      'Another withdrawal needs 2 confirmed notes. Deposit 1 more private note to continue.',
      'post-withdraw guidance',
    );
    await waitForText(primary, 'Deposit 1 more note to withdraw again', 'post-withdraw button label');
    if (!(await primary.isDisabled())) {
      fail('post-withdraw UX regression: withdrawal button should be disabled with only one confirmed note');
    }

    // The encrypted inventory intentionally retains spent notes as local history.
    // After two deposits and one two-input withdrawal it should contain two spent
    // deposit records plus one confirmed private-change record.
    const noteRows = page.locator('.notes-list .note-row');
    await waitForCount(noteRows, 3, 'final encrypted note inventory');

    const spentRows = page.locator('.notes-list .note-row .note-status.note-spent');
    await waitForCount(spentRows, 2, 'spent input notes');

    const confirmedRows = page.locator('.notes-list .note-row .note-status.note-confirmed');
    await waitForCount(confirmedRows, 1, 'confirmed private change');
    const confirmedChangeRow = confirmedRows.first().locator('xpath=..').locator('xpath=..');
    await waitForText(confirmedChangeRow, '0.01 SOL', 'final change amount');
    await waitForText(confirmedChangeRow, 'PRIVATE CHANGE', 'final change kind');

    if (pageErrors.length > 0) {
      fail(`Browser page errors:\n${pageErrors.join('\n\n')}`);
    }

    console.log(JSON.stringify({
      status: 'pass',
      flow: ['connect', 'unlock', 'deposit', 'deposit', 'withdraw-v0-alt', 'sync', 'post-withdraw-guidance'],
      lookupTableAddress,
      final: {
        privateBalanceSol: '0.01',
        confirmedNotes: 1,
        spentNotes: 2,
        pendingNotes: 0,
        commitmentCount: 3,
        spentNullifiers: 2,
        withdrawalBlockedUntilSecondNote: true,
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
