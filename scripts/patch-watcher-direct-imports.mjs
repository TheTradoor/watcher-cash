import { readFileSync, writeFileSync } from 'node:fs';

const path = 'app/watcher-protocol-page.jsx';
let source = readFileSync(path, 'utf8');

const barrelImport = `import {
  BN254_SCALAR_MODULUS,
  bytesToBigIntLE,
  bytesToHex,
  CONFIG_ACCOUNT_LEN_V1,
  COMMITMENT_REGISTRY_LEN_V1,
  deriveVaultAddressV1,
  buildInitializeInstructionV1,
  NULLIFIER_REGISTRY_LEN_V1,
  ROOT_HISTORY_ACCOUNT_LEN_V1,
  VAULT_ACCOUNT_LEN_V1,
  noteCommitmentV1,
  nullifierV1,
} from '../client/watcher/index.mjs';`;

const directImports = `import {
  BN254_SCALAR_MODULUS,
  bytesToBigIntLE,
  bytesToHex,
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
} from '../client/watcher/instructions.mjs';`;

if (source.includes(barrelImport)) {
  source = source.replace(barrelImport, directImports);
} else if (!source.includes("from '../client/watcher/field.mjs';")) {
  throw new Error('Watcher page import block was not found');
}

writeFileSync(path, source);
