import { readFileSync, writeFileSync } from 'node:fs';

const path = 'app/watcher-protocol-page.jsx';
let source = readFileSync(path, 'utf8');

const modulePaths = [
  '../client/watcher/index.mjs',
  '../client/watcher/keccak.mjs',
  '../client/watcher/field.mjs',
  '../client/watcher/instructions.mjs',
];

for (const modulePath of modulePaths) {
  const escaped = modulePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`import\\s*\\{[^}]*\\}\\s*from ['"]${escaped}['"];?\\n?`, 'g');
  source = source.replace(pattern, '');
}

const anchor = "import { createWatcherBrowserProverV1 } from '../client/watcher/ui-prover.mjs';";
if (!source.includes(anchor)) {
  throw new Error('Watcher browser prover import anchor is missing');
}

const directImports = `import { bytesToHex } from '../client/watcher/keccak.mjs';
import {
  BN254_SCALAR_MODULUS,
  bytesToBigIntLE,
  noteCommitmentV1,
  nullifierV1,
} from '../client/watcher/field.mjs';
import {
  CONFIG_ACCOUNT_LEN_V1,
  COMMITMENT_REGISTRY_LEN_V1,
  deriveVaultAddressV1,
  buildInitializeInstructionV1,
  NULLIFIER_REGISTRY_LEN_V1,
  ROOT_HISTORY_ACCOUNT_LEN_V1,
  VAULT_ACCOUNT_LEN_V1,
} from '../client/watcher/instructions.mjs';
`;
source = source.replace(anchor, `${directImports}${anchor}`);

const required = [
  "import { bytesToHex } from '../client/watcher/keccak.mjs';",
  "from '../client/watcher/field.mjs';",
  "from '../client/watcher/instructions.mjs';",
];
for (const value of required) {
  if (!source.includes(value)) throw new Error(`required direct import is missing: ${value}`);
}
if (source.includes("from '../client/watcher/index.mjs'")) {
  throw new Error('Watcher page still imports the client barrel');
}

writeFileSync(path, source);
