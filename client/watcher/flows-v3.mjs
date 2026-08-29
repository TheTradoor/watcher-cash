import { fieldToLe32 } from './field.mjs';
import { prepareDepositV2, prepareWithdrawV2 } from './flows-v2.mjs';
import {
  buildWithdrawInstructionV3,
  deriveNullifierShardForSpendV3,
} from './instructions-v3.mjs';

const ZERO_FIELD_BYTES = new Uint8Array(32);

// V3 deliberately keeps the proven V2 deposit circuit/instruction. The version
// boundary is the withdrawal replay store, not the commitment construction.
export const prepareDepositV3 = prepareDepositV2;

export async function prepareWithdrawV3(options) {
  const preparedV2 = await prepareWithdrawV2(options);
  const {
    markerAccounts: _markerAccounts,
    instruction: _v2Instruction,
    ...proofBound
  } = preparedV2;

  const protocolFee = BigInt(options.protocolFee ?? 0n);
  const relayerFee = BigInt(options.relayerFee ?? 0n);
  const publicAmount = BigInt(options.publicAmount);
  const changeCommitment = preparedV2.changeNote
    ? fieldToLe32(preparedV2.changeNote.commitment)
    : ZERO_FIELD_BYTES;
  const newRoot = preparedV2.append
    ? fieldToLe32(preparedV2.append.newRoot)
    : ZERO_FIELD_BYTES;

  const instruction = buildWithdrawInstructionV3({
    ...options.accounts,
    inputCount: preparedV2.activeInputs.length,
    inputRoots: preparedV2.inputRoots,
    nullifiers: preparedV2.nullifiers,
    changeCommitment,
    publicAmount,
    protocolFee,
    relayerFee,
    newRoot,
    proof: preparedV2.proof,
    sealedRootAccounts: options.sealedRootAccounts || [],
  });

  const shardRoutes = preparedV2.activeInputs.map(({ nullifier }) =>
    deriveNullifierShardForSpendV3({
      programId: options.accounts.programId,
      config: options.accounts.config,
      nullifier: fieldToLe32(nullifier),
    }));

  return Object.freeze({
    ...proofBound,
    shardAccounts: Object.freeze([...instruction.shardAccounts]),
    shardRoutes: Object.freeze(shardRoutes),
    instruction,
  });
}
