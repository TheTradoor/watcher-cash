import { concatBytes } from './keccak.mjs';
import {
  assertFieldV1,
  fieldFromLe32,
  fieldToLe32,
} from './field.mjs';
import {
  buildDepositWitnessFromChainV1,
  buildDepositWitnessV1,
  buildWithdrawWitnessFromChainV1,
} from './witness.mjs';
import {
  buildDepositInstructionV1,
  buildWithdrawInstructionV1,
  publicKeyBytesV1,
} from './instructions.mjs';

const textEncoder = new TextEncoder();

async function sha256FieldV1(domain, chunks) {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Web Crypto SHA-256 is unavailable');
  }
  const input = concatBytes(textEncoder.encode(domain), ...chunks);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', input));
  digest[31] &= 0x1f;
  return fieldFromLe32(digest, `${domain} binding`);
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

// Synchronous helper used by unit tests and offline callers. For an actual
// deposit, prepareUiDepositV1 always reads the current append state from chain.
export function buildDepositWitnessUiV1({
  registryAccountData,
  owner,
  nonce,
  amount,
  assetId = 1n,
}) {
  const built = buildDepositWitnessV1({
    ...(registryAccountData === undefined ? {} : { registryAccountData }),
    owner,
    nonce,
    amount,
    assetId,
  });
  return Object.freeze({
    ...built,
    note: Object.freeze({ ...built.note }),
    witness: Object.freeze({ ...built.witness }),
    commitmentBytes: built.commitment,
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
  commitment = 'confirmed',
}) {
  if (!connection || typeof connection.getAccountInfo !== 'function') {
    throw new TypeError('connection.getAccountInfo is required');
  }
  if (!accounts || typeof accounts !== 'object') throw new TypeError('accounts are required');
  if (!prover || typeof prover.proveDeposit !== 'function') {
    throw new TypeError('a Watcher browser prover is required');
  }

  // The proof carries OldRoot, NewRoot and LeafIndex. They must be derived from
  // the live registry immediately before proving, not from an assumed empty tree.
  const built = await buildDepositWitnessFromChainV1({
    connection,
    commitmentsAccount: accounts.commitments,
    commitment,
    owner,
    nonce,
    amount,
    assetId,
  });
  const proof = await prover.proveDeposit({
    witness: built.witness,
    expectedPublicInputs: built.publicInputs,
  });
  const instruction = buildDepositInstructionV1({
    ...accounts,
    commitment: built.commitment,
    amount: built.note.amount,
    proof: proof.proof,
    publicInputs: proof.publicInputs,
  });
  return Object.freeze({
    ...built,
    commitmentBytes: built.commitment,
    proof,
    instruction,
  });
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
  const proof = await prover.proveWithdraw({
    witness: built.witness,
    expectedPublicInputs: built.publicInputs,
  });
  const instruction = buildWithdrawInstructionV1({
    ...accounts,
    statement: built.statement,
    proof: proof.proof,
    publicInputs: proof.publicInputs,
  });
  return Object.freeze({ ...built, proof, instruction, contextBinding });
}
