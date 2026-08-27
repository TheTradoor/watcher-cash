import { concatBytes } from './keccak.mjs';
import {
  assertFieldV1,
  assertU64,
  fieldFromLe32,
  fieldToLe32,
  noteCommitmentV1,
} from './field.mjs';
import { buildWithdrawWitnessFromChainV1 } from './witness.mjs';
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

export function buildDepositWitnessUiV1({ owner, nonce, amount, assetId = 1n }) {
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
  const publicInputs = concatBytes(
    fieldToLe32(commitment),
    fieldToLe32(amountValue),
    fieldToLe32(asset),
  );
  return Object.freeze({
    note: Object.freeze({
      amount: amountValue,
      owner: ownerField,
      nonce: nonceField,
      assetId: asset,
      commitment,
    }),
    witness: Object.freeze({
      Owner: ownerField.toString(10),
      Nonce: nonceField.toString(10),
      Commitment: commitment.toString(10),
      Amount: amountValue.toString(10),
      AssetID: asset.toString(10),
    }),
    publicInputs,
    commitmentBytes: fieldToLe32(commitment),
  });
}

export async function prepareUiDepositV1({
  accounts,
  owner,
  nonce,
  amount,
  assetId = 1n,
  prover,
}) {
  if (!accounts || typeof accounts !== 'object') throw new TypeError('accounts are required');
  if (!prover || typeof prover.proveDeposit !== 'function') {
    throw new TypeError('a Watcher browser prover is required');
  }
  const built = buildDepositWitnessUiV1({ owner, nonce, amount, assetId });
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
