#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const ALLOWED_UNPATCHED = new Set([
  'GHSA-W3RX-R6R6-PGPR',
  'GHSA-5P2G-FCMC-QVQQ',
]);

const result = spawnSync('npm', ['audit', '--omit=dev', '--json'], {
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
});

if (!result.stdout) {
  process.stderr.write(result.stderr || 'npm audit produced no JSON output\n');
  process.exit(1);
}

let report;
try {
  report = JSON.parse(result.stdout);
} catch (error) {
  process.stderr.write(`Could not parse npm audit JSON: ${error.message}\n`);
  process.stderr.write(result.stdout.slice(0, 4000));
  process.exit(1);
}

const vulnerabilities = report?.vulnerabilities || {};
const memo = new Map();

function isBlockingSeverity(value) {
  return value === 'high' || value === 'critical';
}

function advisoryId(entry) {
  const text = `${entry?.url || ''} ${entry?.source || ''}`;
  const match = text.match(/GHSA-[0-9a-z-]+/i);
  return match ? match[0].toUpperCase() : '';
}

function onlyAllowedUnpatchedChain(name, stack = new Set()) {
  if (memo.has(name)) return memo.get(name);
  const vulnerability = vulnerabilities[name];
  if (!vulnerability || !isBlockingSeverity(vulnerability.severity)) {
    memo.set(name, true);
    return true;
  }
  if (stack.has(name)) return false;

  const nextStack = new Set(stack);
  nextStack.add(name);
  let sawBlockingCause = false;

  for (const cause of vulnerability.via || []) {
    if (typeof cause === 'string') {
      const nested = vulnerabilities[cause];
      if (nested && isBlockingSeverity(nested.severity)) {
        sawBlockingCause = true;
        if (!onlyAllowedUnpatchedChain(cause, nextStack)) {
          memo.set(name, false);
          return false;
        }
      }
      continue;
    }

    if (!cause || !isBlockingSeverity(cause.severity)) continue;
    sawBlockingCause = true;
    const id = advisoryId(cause);
    if (name !== 'image-size' || !ALLOWED_UNPATCHED.has(id)) {
      memo.set(name, false);
      return false;
    }
  }

  const allowed = sawBlockingCause;
  memo.set(name, allowed);
  return allowed;
}

const blockers = Object.keys(vulnerabilities)
  .filter((name) => isBlockingSeverity(vulnerabilities[name]?.severity))
  .filter((name) => !onlyAllowedUnpatchedChain(name));

if (blockers.length > 0) {
  console.error('Blocking production dependency vulnerabilities remain:');
  for (const name of blockers) {
    const vulnerability = vulnerabilities[name];
    console.error(`- ${name}: ${vulnerability.severity}`);
    for (const cause of vulnerability.via || []) {
      if (typeof cause === 'object' && isBlockingSeverity(cause?.severity)) {
        console.error(`  ${advisoryId(cause) || cause.source || 'advisory'} ${cause.title || ''}`.trimEnd());
      }
    }
  }
  process.exit(1);
}

const allowedPresent = Object.keys(vulnerabilities)
  .filter((name) => isBlockingSeverity(vulnerabilities[name]?.severity))
  .filter((name) => onlyAllowedUnpatchedChain(name));

if (allowedPresent.length > 0) {
  console.warn(
    'Production audit passed with a narrow temporary exception for the two unpatched image-size DoS advisories reached through the React Native/Metro wallet-adapter dependency chain.',
  );
  console.warn(`Allowed high-severity chain: ${allowedPresent.join(', ')}`);
}

const summary = report?.metadata?.vulnerabilities || {};
console.log(`npm audit gate passed (critical=${summary.critical || 0}, high=${summary.high || 0}, moderate=${summary.moderate || 0}).`);
