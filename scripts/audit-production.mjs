#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const ALLOWED_UNPATCHED = new Set([
  'GHSA-W3RX-R6R6-PGPR',
  'GHSA-5P2G-FCMC-QVQQ',
]);

// npm propagates image-size's severity up through Metro/React Native. These
// package names are allowed only when they have no direct high/critical
// advisory of their own. This keeps the exception narrow and fail-closed if a
// new advisory lands on any parent package.
const ALLOWED_TRANSITIVE_CHAIN = new Set([
  '@react-native/community-cli-plugin',
  '@react-native/virtualized-lists',
  'metro',
  'metro-config',
  'metro-transform-worker',
  'react-native',
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

function isBlockingSeverity(value) {
  return value === 'high' || value === 'critical';
}

function advisoryId(entry) {
  const text = `${entry?.url || ''} ${entry?.source || ''}`;
  const match = text.match(/GHSA-[0-9a-z-]+/i);
  return match ? match[0].toUpperCase() : '';
}

function directBlockingAdvisories(vulnerability) {
  return (vulnerability?.via || [])
    .filter((cause) => typeof cause === 'object' && cause && isBlockingSeverity(cause.severity));
}

function isAllowedUnpatchedNode(name) {
  const vulnerability = vulnerabilities[name];
  if (!vulnerability || !isBlockingSeverity(vulnerability.severity)) return false;

  const direct = directBlockingAdvisories(vulnerability);

  if (name === 'image-size') {
    return direct.length > 0
      && direct.every((cause) => ALLOWED_UNPATCHED.has(advisoryId(cause)));
  }

  if (!ALLOWED_TRANSITIVE_CHAIN.has(name)) return false;

  // Parent packages may inherit `high` from a vulnerable dependency, but they
  // must not have a direct high/critical advisory of their own.
  if (direct.length > 0) return false;

  const inheritedBlockingNames = (vulnerability.via || [])
    .filter((cause) => typeof cause === 'string')
    .filter((cause) => isBlockingSeverity(vulnerabilities[cause]?.severity));

  return inheritedBlockingNames.length > 0
    && inheritedBlockingNames.every(
      (cause) => cause === 'image-size' || ALLOWED_TRANSITIVE_CHAIN.has(cause),
    );
}

const blockingNames = Object.keys(vulnerabilities)
  .filter((name) => isBlockingSeverity(vulnerabilities[name]?.severity));
const blockers = blockingNames.filter((name) => !isAllowedUnpatchedNode(name));

if (blockers.length > 0) {
  console.error('Blocking production dependency vulnerabilities remain:');
  for (const name of blockers) {
    const vulnerability = vulnerabilities[name];
    console.error(`- ${name}: ${vulnerability.severity}`);
    for (const cause of directBlockingAdvisories(vulnerability)) {
      console.error(`  ${advisoryId(cause) || cause.source || 'advisory'} ${cause.title || ''}`.trimEnd());
    }
  }
  process.exit(1);
}

const allowedPresent = blockingNames.filter((name) => isAllowedUnpatchedNode(name));
if (allowedPresent.length > 0) {
  console.warn(
    'Production audit passed with a narrow temporary exception for the two unpatched image-size DoS advisories and their exact Metro/React Native inherited chain.',
  );
  console.warn(`Allowed high-severity chain: ${allowedPresent.join(', ')}`);
}

const summary = report?.metadata?.vulnerabilities || {};
console.log(`npm audit gate passed (critical=${summary.critical || 0}, high=${summary.high || 0}, moderate=${summary.moderate || 0}).`);
