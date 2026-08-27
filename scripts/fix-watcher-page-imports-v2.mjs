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

const wrongDirectImport = `import {
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

const correctDirectImports = `import { bytesToHex } from '../client/watcher/keccak.mjs';
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
} from '../client/watcher/instructions.mjs';`;

if (source.includes(barrelImport)) {
  source = source.replace(barrelImport, correctDirectImports);
} else if (source.includes(wrongDirectImport)) {
  source = source.replace(wrongDirectImport, correctDirectImports);
} else if (!source.includes("import { bytesToHex } from '../client/watcher/keccak.mjs';")) {
  throw new Error('Watcher page import layout is unknown; refusing a partial patch');
}

if (source.includes("bytesToHex,\n  noteCommitmentV1")
  || source.includes("from '../client/watcher/index.mjs';")) {
  throw new Error('Watcher page still contains the problematic client import graph');
}

writeFileSync(path, source);
