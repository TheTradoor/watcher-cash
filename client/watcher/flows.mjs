import { asBytes } from './keccak.mjs';
import { withdrawContextBindingV1 } from './field.mjs';
import {
  buildDepositInstructionV1,
  buildWithdrawInstructionV1,
} from './instructions.mjs';
import {
  proveDepositWithLocalProverV1,
  proveWithdrawWithLocalProverV1,
} from './prover.mjs';
import {
  buildDepositWitnessFromChainV1,
  buildDepositWitnessV1,
  buildWithdrawWitnessFromChainV1,
} from './witness.mjs';

function keyBytes(value, label) {
  let bytes;
  if (value && typeof value.toBytes === 'function') bytes = value.toBytes();
  else if (value && typeof value.toBuffer === 'function') bytes = value.toBuffer();
  else bytes = value;
  const normalized = asBytes(bytes, label);
  if (normalized.length !== 32) throw new RangeError(`${label} must be exactly 32 bytes`);
  return normalized;
}

function requireAccounts(accounts, names) {
  if (!accounts || typeof accounts !== 'object') throw new TypeError('accounts are required');
  for (const name of names) {
    if (accounts[name] === undefined || accounts[name] === null) {
      throw new TypeError(`accounts.${name} is required`);
    }
  }
}

function requireProver(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a proving function`);
  return value;
}

export async function prepareDepositV1({
  connection,
  accounts,
  owner,
  nonce,
  amount,
  assetId = 1n,
  rpcCommitment = 'confirmed',
  proverEndpoint,
  fetchImpl,
  proveDeposit = proveDepositWithLocalProverV1,
  proverOptions = {},
}) {
  requireAccounts(accounts, [
    'programId', 'depositor', 'config', 'commitments', 'rootHistory', 'vault', 'systemProgram',
  ]);
  const witness = connection && typeof connection.getAccountInfo === 'function'
    ? await buildDepositWitnessFromChainV1({
        connection,
        commitmentsAccount: accounts.commitments,
        commitment: rpcCommitment,
        owner,
        nonce,
        amount,
        assetId,
      })
    : buildDepositWitnessV1({ owner, nonce, amount, assetId });
  const generated = await requireProver(proveDeposit, 'proveDeposit')({
    endpoint: proverEndpoint,
    fetchImpl,
    witness: witness.witness,
    expectedPublicInputs: witness.publicInputs,
    ...proverOptions,
  });
  const instruction = buildDepositInstructionV1({
    ...accounts,
    commitment: witness.commitment,
    amount: witness.amount,
    proof: generated.proof,
    publicInputs: generated.publicInputs,
  });
  return {
    ...witness,
    proof: generated.proof,
    bundleDigest: generated.bundleDigest,
    instruction,
  };
}

export async function prepareWithdrawV1({
  connection,
  accounts,
  input0,
  input1,
  change,
  publicAmount,
  protocolFee = 0n,
  relayerFee = 0n,
  assetId = 1n,
  rpcCommitment = 'confirmed',
  proverEndpoint,
  fetchImpl,
  proveWithdraw = proveWithdrawWithLocalProverV1,
  proverOptions = {},
}) {
  if (!connection || typeof connection.getAccountInfo !== 'function') {
    throw new TypeError('connection.getAccountInfo is required');
  }
  requireAccounts(accounts, [
    'programId', 'config', 'commitments', 'nullifiers', 'rootHistory',
    'vault', 'recipient', 'relayer', 'treasury',
  ]);
  const contextBinding = await withdrawContextBindingV1({
    programId: keyBytes(accounts.programId, 'programId'),
    config: keyBytes(accounts.config, 'config'),
    vault: keyBytes(accounts.vault, 'vault'),
    relayer: keyBytes(accounts.relayer, 'relayer'),
    treasury: keyBytes(accounts.treasury, 'treasury'),
    assetId,
  });
  const witness = await buildWithdrawWitnessFromChainV1({
    connection,
    commitmentsAccount: accounts.commitments,
    commitment: rpcCommitment,
    input0,
    input1,
    change,
    publicAmount,
    protocolFee,
    relayerFee,
    recipient: keyBytes(accounts.recipient, 'recipient'),
    assetId,
    contextBinding,
  });
  const generated = await requireProver(proveWithdraw, 'proveWithdraw')({
    endpoint: proverEndpoint,
    fetchImpl,
    witness: witness.witness,
    expectedPublicInputs: witness.publicInputs,
    ...proverOptions,
  });
  const instruction = buildWithdrawInstructionV1({
    ...accounts,
    statement: witness.statement,
    proof: generated.proof,
    publicInputs: generated.publicInputs,
  });
  return {
    ...witness,
    contextBinding,
    proof: generated.proof,
    bundleDigest: generated.bundleDigest,
    instruction,
  };
}
