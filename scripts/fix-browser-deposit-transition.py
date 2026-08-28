from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

UI_FLOWS = r'''import { asBytes, concatBytes } from './keccak.mjs';
import {
  DOMAIN_MERKLE_V1,
  assertFieldV1,
  assertU64,
  fieldFromLe32,
  fieldToLe32,
  mimcHashV1,
  noteCommitmentV1,
} from './field.mjs';
import { buildWithdrawWitnessFromChainV1 } from './witness.mjs';
import {
  buildDepositInstructionV1,
  buildWithdrawInstructionV1,
  publicKeyBytesV1,
} from './instructions.mjs';

const textEncoder = new TextEncoder();
const STATE_VERSION_V1 = 1;
const REGISTRY_HEADER_LEN_V1 = 5;
const MERKLE_DEPTH_V1 = 4;
const MERKLE_LEAVES_V1 = 1 << MERKLE_DEPTH_V1;
const COMMITMENT_BYTES_V1 = 32;
const MIN_COMMITMENT_REGISTRY_BYTES_V1 =
  REGISTRY_HEADER_LEN_V1 + (MERKLE_LEAVES_V1 * COMMITMENT_BYTES_V1);

async function sha256FieldV1(domain, chunks) {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Web Crypto SHA-256 is unavailable');
  }
  const input = concatBytes(textEncoder.encode(domain), ...chunks);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', input));
  digest[31] &= 0x1f;
  return fieldFromLe32(digest, `${domain} binding`);
}

function readU32Le(bytes, offset) {
  return (
    bytes[offset]
    | (bytes[offset + 1] << 8)
    | (bytes[offset + 2] << 16)
    | (bytes[offset + 3] << 24)
  ) >>> 0;
}

function parentV1(left, right) {
  return mimcHashV1([DOMAIN_MERKLE_V1, left, right]);
}

function buildMerkleLevelsV1(leaves) {
  if (!Array.isArray(leaves) || leaves.length !== MERKLE_LEAVES_V1) {
    throw new RangeError(`Merkle tree requires exactly ${MERKLE_LEAVES_V1} leaves`);
  }
  const levels = [leaves.map((leaf, index) => assertFieldV1(leaf, `leaf[${index}]`))];
  for (let depth = 0; depth < MERKLE_DEPTH_V1; depth += 1) {
    const current = levels[depth];
    const next = [];
    for (let index = 0; index < current.length; index += 2) {
      next.push(parentV1(current[index], current[index + 1]));
    }
    levels.push(next);
  }
  return levels;
}

function decodeCommitmentLeavesUiV1(registryData) {
  const bytes = asBytes(registryData, 'commitment registry');
  if (bytes.length < MIN_COMMITMENT_REGISTRY_BYTES_V1) {
    throw new RangeError(
      `commitment registry must be at least ${MIN_COMMITMENT_REGISTRY_BYTES_V1} bytes`,
    );
  }
  if (bytes[0] !== STATE_VERSION_V1) {
    throw new Error(`unsupported commitment registry version: ${bytes[0]}`);
  }
  const count = readU32Le(bytes, 1);
  if (count > MERKLE_LEAVES_V1) {
    throw new RangeError(`commitment registry count exceeds ${MERKLE_LEAVES_V1} leaves`);
  }
  const leaves = Array(MERKLE_LEAVES_V1).fill(0n);
  for (let index = 0; index < count; index += 1) {
    const offset = REGISTRY_HEADER_LEN_V1 + (index * COMMITMENT_BYTES_V1);
    leaves[index] = fieldFromLe32(
      bytes.slice(offset, offset + COMMITMENT_BYTES_V1),
      `commitment[${index}]`,
    );
  }
  return { bytes, count, leaves };
}

export function buildDepositAppendTransitionUiV1({ registryData, commitment }) {
  const commitmentField = assertFieldV1(commitment, 'commitment');
  if (commitmentField === 0n) throw new RangeError('commitment must be non-zero');

  const decoded = decodeCommitmentLeavesUiV1(registryData);
  if (decoded.count >= MERKLE_LEAVES_V1) {
    throw new RangeError('commitment Merkle tree is full');
  }
  if (decoded.leaves.slice(0, decoded.count).includes(commitmentField)) {
    throw new Error('commitment already exists in the registry');
  }

  const oldLevels = buildMerkleLevelsV1(decoded.leaves);
  const leafIndex = decoded.count;
  const path = [];
  const indexBits = [];
  let position = leafIndex;
  for (let depth = 0; depth < MERKLE_DEPTH_V1; depth += 1) {
    path.push(oldLevels[depth][position ^ 1]);
    indexBits.push(position & 1);
    position >>= 1;
  }

  const nextLeaves = [...decoded.leaves];
  nextLeaves[leafIndex] = commitmentField;
  const newLevels = buildMerkleLevelsV1(nextLeaves);

  return Object.freeze({
    count: decoded.count,
    leafIndex,
    path: Object.freeze(path),
    indexBits: Object.freeze(indexBits),
    oldRoot: decoded.count === 0 ? 0n : oldLevels[MERKLE_DEPTH_V1][0],
    newRoot: newLevels[MERKLE_DEPTH_V1][0],
  });
}

export async function withdrawContextBindingUiV1({
  programId,
  config,
  vault,
  relayer,
  treasury,
  assetId,
}) {
  const asset = assertFieldV1(assetId, 'assetId');
  return sha256FieldV1('watcher-withdraw-context-v1', [
    publicKeyBytesV1(programId, 'programId'),
    publicKeyBytesV1(config, 'config'),
    publicKeyBytesV1(vault, 'vault'),
    publicKeyBytesV1(relayer, 'relayer'),
    publicKeyBytesV1(treasury, 'treasury'),
    fieldToLe32(asset),
  ]);
}

export function buildDepositWitnessUiV1({
  owner,
  nonce,
  amount,
  assetId = 1n,
  registryData,
}) {
  const ownerField = assertFieldV1(owner, 'owner');
  const nonceField = assertFieldV1(nonce, 'nonce');
  const amountValue = assertU64(amount, 'amount');
  const asset = assertFieldV1(assetId, 'assetId');
  if (ownerField === 0n || nonceField === 0n) {
    throw new RangeError('owner and nonce must be non-zero');
  }
  if (amountValue === 0n || asset === 0n) {
    throw new RangeError('amount and assetId must be non-zero');
  }
  const commitment = noteCommitmentV1({
    assetId: asset,
    amount: amountValue,
    owner: ownerField,
    nonce: nonceField,
  });
  const transition = buildDepositAppendTransitionUiV1({ registryData, commitment });
  const leafIndexField = BigInt(transition.leafIndex);
  const publicInputs = concatBytes(
    fieldToLe32(commitment),
    fieldToLe32(amountValue),
    fieldToLe32(asset),
    fieldToLe32(transition.oldRoot),
    fieldToLe32(transition.newRoot),
    fieldToLe32(leafIndexField),
  );
  return Object.freeze({
    note: Object.freeze({
      amount: amountValue,
      owner: ownerField,
      nonce: nonceField,
      assetId: asset,
      commitment,
    }),
    transition,
    witness: Object.freeze({
      Owner: ownerField.toString(10),
      Nonce: nonceField.toString(10),
      Path: transition.path.map((value) => value.toString(10)),
      Index: [...transition.indexBits],
      Commitment: commitment.toString(10),
      Amount: amountValue.toString(10),
      AssetID: asset.toString(10),
      OldRoot: transition.oldRoot.toString(10),
      NewRoot: transition.newRoot.toString(10),
      LeafIndex: leafIndexField.toString(10),
    }),
    publicInputs,
    commitmentBytes: fieldToLe32(commitment),
  });
}

export async function prepareUiDepositV1({
  connection,
  accounts,
  owner,
  nonce,
  amount,
  assetId = 1n,
  prover,
  rpcCommitment = 'confirmed',
  registryData,
}) {
  if (!accounts || typeof accounts !== 'object') throw new TypeError('accounts are required');
  if (!prover || typeof prover.proveDeposit !== 'function') {
    throw new TypeError('a Watcher browser prover is required');
  }

  let currentRegistry = registryData;
  if (currentRegistry === undefined) {
    if (!connection || typeof connection.getAccountInfo !== 'function') {
      throw new TypeError('connection.getAccountInfo is required for a proof-bound deposit');
    }
    const accountInfo = await connection.getAccountInfo(accounts.commitments, rpcCommitment);
    if (!accountInfo?.data) throw new Error('commitment registry account was not found');
    currentRegistry = accountInfo.data;
  }

  const built = buildDepositWitnessUiV1({
    owner,
    nonce,
    amount,
    assetId,
    registryData: currentRegistry,
  });
  const proof = await prover.proveDeposit(built.witness, built.publicInputs);
  const instruction = buildDepositInstructionV1({
    ...accounts,
    commitment: built.commitmentBytes,
    amount: built.note.amount,
    proof: proof.proof,
    publicInputs: proof.publicInputs,
  });
  return Object.freeze({ ...built, proof, instruction });
}

export async function prepareUiWithdrawV1({
  connection,
  accounts,
  input0,
  input1,
  change,
  publicAmount,
  protocolFee = 0n,
  relayerFee = 0n,
  assetId = 1n,
  prover,
  commitment = 'confirmed',
}) {
  if (!accounts || typeof accounts !== 'object') throw new TypeError('accounts are required');
  if (!prover || typeof prover.proveWithdraw !== 'function') {
    throw new TypeError('a Watcher browser prover is required');
  }
  const contextBinding = await withdrawContextBindingUiV1({
    programId: accounts.programId,
    config: accounts.config,
    vault: accounts.vault,
    relayer: accounts.relayer,
    treasury: accounts.treasury,
    assetId,
  });
  const built = await buildWithdrawWitnessFromChainV1({
    connection,
    commitmentsAccount: accounts.commitments,
    commitment,
    input0,
    input1,
    change,
    publicAmount,
    protocolFee,
    relayerFee,
    recipient: publicKeyBytesV1(accounts.recipient, 'recipient'),
    assetId,
    contextBinding,
  });
  const proof = await prover.proveWithdraw(built.witness, built.publicInputs);
  const instruction = buildWithdrawInstructionV1({
    ...accounts,
    statement: built.statement,
    proof: proof.proof,
    publicInputs: proof.publicInputs,
  });
  return Object.freeze({ ...built, proof, instruction, contextBinding });
}
'''

UI_TESTS = r'''import test from 'node:test';
import assert from 'node:assert/strict';

import { bytesToHex } from './keccak.mjs';
import { fieldToLe32, noteCommitmentV1 } from './field.mjs';
import {
  buildDepositWitnessUiV1,
  prepareUiDepositV1,
} from './ui-flows.mjs';

const COMMITMENT_REGISTRY_LEN = 5 + (32 * 16) + (32 * 4);

function key(value) {
  return { toBytes() { return new Uint8Array(32).fill(value); } };
}

function registry(commitments = []) {
  const data = new Uint8Array(COMMITMENT_REGISTRY_LEN);
  data[0] = 1;
  const count = commitments.length;
  data[1] = count & 0xff;
  data[2] = (count >>> 8) & 0xff;
  data[3] = (count >>> 16) & 0xff;
  data[4] = (count >>> 24) & 0xff;
  commitments.forEach((commitment, index) => {
    data.set(fieldToLe32(commitment), 5 + (index * 32));
  });
  return data;
}

function accounts() {
  return {
    programId: key(1), depositor: key(2), config: key(3), commitments: key(4),
    rootHistory: key(5), vault: key(6), systemProgram: key(7),
  };
}

test('browser deposit flow binds the exact six-field proof response to the instruction', async () => {
  let witnessed;
  let requestedAccount;
  const protocolAccounts = accounts();
  const connection = {
    async getAccountInfo(account, commitment) {
      requestedAccount = { account, commitment };
      return { data: registry() };
    },
  };
  const prover = {
    async proveDeposit(witness, expectedPublicInputs) {
      witnessed = witness;
      return {
        proof: new Uint8Array(256).fill(9),
        publicInputs: new Uint8Array(expectedPublicInputs),
        bundleDigest: 'test-bundle',
      };
    },
  };
  const result = await prepareUiDepositV1({
    connection,
    accounts: protocolAccounts,
    owner: 1111n,
    nonce: 2222n,
    amount: 8_000_000n,
    assetId: 1n,
    prover,
  });

  assert.equal(requestedAccount.account, protocolAccounts.commitments);
  assert.equal(requestedAccount.commitment, 'confirmed');
  assert.equal(witnessed.Owner, '1111');
  assert.equal(witnessed.Nonce, '2222');
  assert.equal(witnessed.Amount, '8000000');
  assert.equal(witnessed.AssetID, '1');
  assert.equal(witnessed.Commitment, result.note.commitment.toString(10));
  assert.equal(witnessed.OldRoot, '0');
  assert.equal(witnessed.LeafIndex, '0');
  assert.equal(witnessed.Path.length, 4);
  assert.deepEqual(witnessed.Index, [0, 0, 0, 0]);
  assert.equal(result.transition.newRoot.toString(10), witnessed.NewRoot);
  assert.equal(result.publicInputs.length, 192);
  assert.equal(result.instruction.keys.length, 6);
  assert.equal(result.instruction.data[0], 1);
  assert.equal(result.instruction.data.length, 1 + 32 + 8 + 2 + 256 + 2 + 192);
  assert.equal(
    bytesToHex(result.instruction.data.slice(1, 33)),
    bytesToHex(result.commitmentBytes),
  );
});

test('browser deposit witness advances the append index and old root', () => {
  const firstCommitment = noteCommitmentV1({
    assetId: 1n, amount: 3_000_000n, owner: 3333n, nonce: 4444n,
  });
  const next = buildDepositWitnessUiV1({
    owner: 1111n,
    nonce: 2222n,
    amount: 8_000_000n,
    assetId: 1n,
    registryData: registry([firstCommitment]),
  });

  assert.equal(next.transition.leafIndex, 1);
  assert.notEqual(next.transition.oldRoot, 0n);
  assert.equal(next.witness.LeafIndex, '1');
  assert.deepEqual(next.witness.Index, [1, 0, 0, 0]);
  assert.equal(next.publicInputs.length, 192);
});

test('browser deposit flow rejects a prover that changes public inputs', async () => {
  const prover = {
    async proveDeposit(_witness, expectedPublicInputs) {
      const changed = new Uint8Array(expectedPublicInputs);
      changed[0] ^= 1;
      if (bytesToHex(changed) !== bytesToHex(expectedPublicInputs)) {
        throw new Error('deposit prover public inputs do not match the browser-built statement');
      }
      return { proof: new Uint8Array(256), publicInputs: changed };
    },
  };
  await assert.rejects(
    prepareUiDepositV1({
      connection: { async getAccountInfo() { return { data: registry() }; } },
      accounts: accounts(),
      owner: 11n,
      nonce: 22n,
      amount: 10n,
      prover,
    }),
    /public inputs do not match/,
  );
});
'''


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content)


write('client/watcher/ui-flows.mjs', UI_FLOWS)
write('client/watcher/ui-flows.test.mjs', UI_TESTS)

# The live page already owns a Solana Connection for refresh and withdrawal.
# Ensure every browser-deposit call passes that same connection so the proof is
# derived from the actual append index and current commitment registry.
for folder_name in ('app', 'components'):
    folder = ROOT / folder_name
    if not folder.exists():
        continue
    for path in folder.rglob('*'):
        if path.suffix not in {'.js', '.jsx', '.mjs', '.ts', '.tsx'}:
            continue
        text = path.read_text()
        needle = 'prepareUiDepositV1({' 
        cursor = 0
        insertions = []
        while True:
            start = text.find(needle, cursor)
            if start < 0:
                break
            brace = start + len('prepareUiDepositV1(')
            depth = 0
            end = None
            quote = None
            escaped = False
            for index in range(brace, len(text)):
                char = text[index]
                if quote is not None:
                    if escaped:
                        escaped = False
                    elif char == '\\':
                        escaped = True
                    elif char == quote:
                        quote = None
                    continue
                if char in {'\'', '"', '`'}:
                    quote = char
                elif char == '{':
                    depth += 1
                elif char == '}':
                    depth -= 1
                    if depth == 0:
                        end = index + 1
                        break
            if end is None:
                raise RuntimeError(f'unbalanced prepareUiDepositV1 call in {path}')
            block = text[brace:end]
            if 'connection' not in block:
                insertions.append(brace + 1)
            cursor = end
        for position in reversed(insertions):
            text = text[:position] + '\n      connection,' + text[position:]
        if insertions:
            path.write_text(text)

print('Browser deposit transition repair applied.')
