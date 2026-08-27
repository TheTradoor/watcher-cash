import { readFileSync, writeFileSync } from 'node:fs';

const path = 'app/watcher-protocol-page.jsx';
let source = readFileSync(path, 'utf8');

function replaceOnce(needle, replacement, label) {
  const first = source.indexOf(needle);
  if (first === -1) throw new Error(`missing ${label} patch point`);
  if (source.indexOf(needle, first + needle.length) !== -1) {
    throw new Error(`${label} patch point is not unique`);
  }
  source = source.slice(0, first) + replacement + source.slice(first + needle.length);
}

if (!source.includes('DEVNET_GENESIS_HASH')) {
  replaceOnce(
    'const MAX_COMPUTE_UNITS = 1_200_000;\n',
    "const MAX_COMPUTE_UNITS = 1_200_000;\nconst DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1';\n",
    'devnet constant',
  );

  replaceOnce(
    "function formatSol(lamports, maximumFractionDigits = 6) {\n",
    "function parseOptionalSol(value, label = 'amount') {\n  const text = String(value ?? '').trim();\n  if (text === '' || /^0+(?:\\.0{0,9})?$/.test(text)) return 0n;\n  return parseSol(text, label);\n}\n\nasync function assertDevnetConnection(connection) {\n  const genesisHash = await connection.getGenesisHash();\n  if (genesisHash !== DEVNET_GENESIS_HASH) {\n    throw new Error('Watcher Protocol development UI is hard-locked to Solana devnet');\n  }\n}\n\nfunction formatSol(lamports, maximumFractionDigits = 6) {\n",
    'network guard helpers',
  );

  replaceOnce(
    "    const programId = publicKey(settings.programId, 'program id');\n    setBusy('bootstrap');",
    "    const programId = publicKey(settings.programId, 'program id');\n    await assertDevnetConnection(connection);\n    setBusy('bootstrap');",
    'bootstrap guard',
  );

  replaceOnce(
    "    const amount = parseSol(depositAmount, 'deposit amount');\n    setBusy('deposit');",
    "    const amount = parseSol(depositAmount, 'deposit amount');\n    await assertDevnetConnection(connection);\n    setBusy('deposit');",
    'deposit guard',
  );

  replaceOnce(
    "    const relayerValue = parseSol(relayerFee, 'relayer fee');",
    "    const relayerValue = parseOptionalSol(relayerFee, 'relayer fee');",
    'zero relayer fee support',
  );

  replaceOnce(
    "    const recipientKey = publicKey(recipient, 'recipient');\n    setBusy('withdraw');",
    "    const recipientKey = publicKey(recipient, 'recipient');\n    await assertDevnetConnection(connection);\n    setBusy('withdraw');",
    'withdraw guard',
  );
}

writeFileSync(path, source);
