from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text()


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content)


def replace_once(path: str, old: str, new: str, label: str) -> None:
    content = read(path)
    count = content.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one match in {path}, found {count}")
    write(path, content.replace(old, new, 1))


def replace_regex(path: str, pattern: str, replacement: str, label: str) -> None:
    content = read(path)
    updated, count = re.subn(pattern, replacement, content, count=1, flags=re.S)
    if count != 1:
        raise RuntimeError(f"{label}: expected one regex match in {path}, found {count}")
    write(path, updated)


write("circuits/withdraw/deposit_v1.go", r'''package withdraw

import "github.com/consensys/gnark/frontend"

// DepositCircuitV1 proves both the private note opening and one append-only
// Merkle transition. The program therefore verifies a proof and adopts the
// proof-bound NewRoot instead of recomputing MiMC inside the Solana VM.
type DepositCircuitV1 struct {
	Owner frontend.Variable
	Nonce frontend.Variable
	Path  [MerkleDepthV1]frontend.Variable
	Index [MerkleDepthV1]frontend.Variable

	Commitment frontend.Variable `gnark:",public"`
	Amount     frontend.Variable `gnark:",public"`
	AssetID    frontend.Variable `gnark:",public"`
	OldRoot    frontend.Variable `gnark:",public"`
	NewRoot    frontend.Variable `gnark:",public"`
	LeafIndex  frontend.Variable `gnark:",public"`
}

func (c *DepositCircuitV1) Define(api frontend.API) error {
	api.ToBinary(c.Amount, 64)
	api.AssertIsDifferent(c.Amount, 0)
	api.AssertIsDifferent(c.AssetID, 0)
	api.AssertIsDifferent(c.Owner, 0)
	api.AssertIsDifferent(c.Nonce, 0)
	api.AssertIsDifferent(c.NewRoot, 0)

	commitment, err := noteCommitmentV1(api, c.AssetID, c.Amount, c.Owner, c.Nonce)
	if err != nil {
		return err
	}
	api.AssertIsEqual(commitment, c.Commitment)

	indexValue := merkleIndexValueV1(api, c.Index)
	api.AssertIsEqual(indexValue, c.LeafIndex)

	// The protocol represents the pre-deposit empty state with a zero sentinel.
	// For the first append, the index and every sibling must therefore be zero.
	// Every later append proves that the target leaf is still zero in OldRoot.
	computedOldRoot, err := merkleRootV1(api, 0, c.Path, c.Index)
	if err != nil {
		return err
	}
	isFirst := api.IsZero(c.LeafIndex)
	for i := 0; i < MerkleDepthV1; i++ {
		api.AssertIsEqual(api.Mul(isFirst, c.Path[i]), 0)
	}
	api.AssertIsEqual(api.Mul(isFirst, c.OldRoot), 0)
	api.AssertIsEqual(
		api.Mul(api.Sub(1, isFirst), api.Sub(computedOldRoot, c.OldRoot)),
		0,
	)

	computedNewRoot, err := merkleRootV1(api, commitment, c.Path, c.Index)
	if err != nil {
		return err
	}
	api.AssertIsEqual(computedNewRoot, c.NewRoot)
	return nil
}
''')

write("circuits/withdraw/circuit_v1.go", r'''package withdraw

import (
	"github.com/consensys/gnark/frontend"
	stdmimc "github.com/consensys/gnark/std/hash/mimc"
)

const MerkleDepthV1 = 4

const (
	domainNoteV1      = 91001
	domainNullifierV1 = 91002
	domainMerkleV1    = 91003
)

// CircuitV1 proves note ownership, membership in a recent spend root, value
// conservation, and a separate append transition from the current tree root to
// the new root containing the private change commitment.
type CircuitV1 struct {
	Input0Amount frontend.Variable
	Input0Owner  frontend.Variable
	Input0Nonce  frontend.Variable
	Input0Path   [MerkleDepthV1]frontend.Variable
	Input0Index  [MerkleDepthV1]frontend.Variable

	Input1Amount frontend.Variable
	Input1Owner  frontend.Variable
	Input1Nonce  frontend.Variable
	Input1Path   [MerkleDepthV1]frontend.Variable
	Input1Index  [MerkleDepthV1]frontend.Variable

	ChangeAmount frontend.Variable
	ChangeOwner  frontend.Variable
	ChangeNonce  frontend.Variable
	ChangePath   [MerkleDepthV1]frontend.Variable
	ChangeIndex  [MerkleDepthV1]frontend.Variable

	// MerkleRoot may be any accepted recent root used by the two input notes.
	MerkleRoot        frontend.Variable `gnark:",public"`
	Nullifier0        frontend.Variable `gnark:",public"`
	Nullifier1        frontend.Variable `gnark:",public"`
	ChangeCommitment  frontend.Variable `gnark:",public"`
	PublicAmount      frontend.Variable `gnark:",public"`
	ProtocolFee       frontend.Variable `gnark:",public"`
	RelayerFee        frontend.Variable `gnark:",public"`
	RecipientBinding  frontend.Variable `gnark:",public"`
	AssetID           frontend.Variable `gnark:",public"`
	ContextBinding    frontend.Variable `gnark:",public"`
	CurrentRoot       frontend.Variable `gnark:",public"`
	NewMerkleRoot     frontend.Variable `gnark:",public"`
	ChangeLeafIndex   frontend.Variable `gnark:",public"`
}

func hashV1(api frontend.API, values ...frontend.Variable) (frontend.Variable, error) {
	h, err := stdmimc.NewMiMC(api)
	if err != nil {
		return nil, err
	}
	h.Write(values...)
	return h.Sum(), nil
}

func noteCommitmentV1(api frontend.API, assetID, amount, owner, nonce frontend.Variable) (frontend.Variable, error) {
	return hashV1(api, domainNoteV1, assetID, amount, owner, nonce)
}

func nullifierV1(api frontend.API, owner, nonce, commitment frontend.Variable) (frontend.Variable, error) {
	return hashV1(api, domainNullifierV1, owner, nonce, commitment)
}

func merkleIndexValueV1(api frontend.API, bits [MerkleDepthV1]frontend.Variable) frontend.Variable {
	value := frontend.Variable(0)
	weight := 1
	for i := 0; i < MerkleDepthV1; i++ {
		api.AssertIsBoolean(bits[i])
		value = api.Add(value, api.Mul(bits[i], weight))
		weight <<= 1
	}
	return value
}

func merkleRootV1(api frontend.API, leaf frontend.Variable, path [MerkleDepthV1]frontend.Variable, index [MerkleDepthV1]frontend.Variable) (frontend.Variable, error) {
	current := leaf
	for i := 0; i < MerkleDepthV1; i++ {
		api.AssertIsBoolean(index[i])
		left := api.Select(index[i], path[i], current)
		right := api.Select(index[i], current, path[i])
		next, err := hashV1(api, domainMerkleV1, left, right)
		if err != nil {
			return nil, err
		}
		current = next
	}
	return current, nil
}

func (c *CircuitV1) Define(api frontend.API) error {
	api.ToBinary(c.Input0Amount, 64)
	api.ToBinary(c.Input1Amount, 64)
	api.ToBinary(c.ChangeAmount, 64)
	api.ToBinary(c.PublicAmount, 64)
	api.ToBinary(c.ProtocolFee, 64)
	api.ToBinary(c.RelayerFee, 64)

	api.AssertIsDifferent(c.AssetID, 0)
	api.AssertIsDifferent(c.RecipientBinding, 0)
	api.AssertIsDifferent(c.ContextBinding, 0)
	api.AssertIsDifferent(c.CurrentRoot, 0)
	api.AssertIsDifferent(c.NewMerkleRoot, 0)
	api.AssertIsDifferent(c.Input0Owner, 0)
	api.AssertIsDifferent(c.Input1Owner, 0)
	api.AssertIsDifferent(c.Input0Nonce, 0)
	api.AssertIsDifferent(c.Input1Nonce, 0)
	api.AssertIsDifferent(c.ChangeOwner, 0)
	api.AssertIsDifferent(c.ChangeNonce, 0)

	commitment0, err := noteCommitmentV1(api, c.AssetID, c.Input0Amount, c.Input0Owner, c.Input0Nonce)
	if err != nil {
		return err
	}
	commitment1, err := noteCommitmentV1(api, c.AssetID, c.Input1Amount, c.Input1Owner, c.Input1Nonce)
	if err != nil {
		return err
	}

	root0, err := merkleRootV1(api, commitment0, c.Input0Path, c.Input0Index)
	if err != nil {
		return err
	}
	root1, err := merkleRootV1(api, commitment1, c.Input1Path, c.Input1Index)
	if err != nil {
		return err
	}
	api.AssertIsEqual(root0, c.MerkleRoot)
	api.AssertIsEqual(root1, c.MerkleRoot)

	nullifier0, err := nullifierV1(api, c.Input0Owner, c.Input0Nonce, commitment0)
	if err != nil {
		return err
	}
	nullifier1, err := nullifierV1(api, c.Input1Owner, c.Input1Nonce, commitment1)
	if err != nil {
		return err
	}
	api.AssertIsEqual(nullifier0, c.Nullifier0)
	api.AssertIsEqual(nullifier1, c.Nullifier1)
	api.AssertIsDifferent(c.Nullifier0, c.Nullifier1)

	changeCommitment, err := noteCommitmentV1(api, c.AssetID, c.ChangeAmount, c.ChangeOwner, c.ChangeNonce)
	if err != nil {
		return err
	}
	api.AssertIsEqual(changeCommitment, c.ChangeCommitment)

	inputs := api.Add(c.Input0Amount, c.Input1Amount)
	outputs := api.Add(c.PublicAmount, c.ProtocolFee, c.RelayerFee, c.ChangeAmount)
	api.AssertIsEqual(inputs, outputs)

	changeIndexValue := merkleIndexValueV1(api, c.ChangeIndex)
	api.AssertIsEqual(changeIndexValue, c.ChangeLeafIndex)
	rootBeforeChange, err := merkleRootV1(api, 0, c.ChangePath, c.ChangeIndex)
	if err != nil {
		return err
	}
	api.AssertIsEqual(rootBeforeChange, c.CurrentRoot)
	rootAfterChange, err := merkleRootV1(api, changeCommitment, c.ChangePath, c.ChangeIndex)
	if err != nil {
		return err
	}
	api.AssertIsEqual(rootAfterChange, c.NewMerkleRoot)

	return nil
}
''')

write("client/watcher/witness.mjs", r'''import {
  assertFieldV1,
  assertU64,
  fieldToLe32,
  noteCommitmentV1,
  nullifierV1,
  recipientBindingV1,
} from './field.mjs';
import {
  decodeCommitmentRegistryV1,
  encodeCommitmentRegistryV1,
  fetchCommitmentRegistryV1,
  findCommitmentIndexV1,
  getMerkleAppendTransitionV1,
  getMerkleProofV1,
} from './merkle.mjs';

export const DEPOSIT_PUBLIC_INPUT_COUNT_V1 = 6;
export const DEPOSIT_PUBLIC_INPUT_BYTES_V1 = DEPOSIT_PUBLIC_INPUT_COUNT_V1 * 32;
export const PUBLIC_INPUT_COUNT_V1 = 13;
export const PUBLIC_INPUT_BYTES_V1 = PUBLIC_INPUT_COUNT_V1 * 32;

export function encodeDepositPublicInputsV1(fields) {
  const ordered = Array.isArray(fields)
    ? fields
    : [
        fields.commitment,
        fields.amount,
        fields.assetId,
        fields.oldRoot,
        fields.newRoot,
        fields.leafIndex,
      ];
  if (ordered.length !== DEPOSIT_PUBLIC_INPUT_COUNT_V1) {
    throw new RangeError(`Deposit V1 requires ${DEPOSIT_PUBLIC_INPUT_COUNT_V1} public inputs`);
  }
  const output = new Uint8Array(DEPOSIT_PUBLIC_INPUT_BYTES_V1);
  ordered.forEach((value, index) => output.set(fieldToLe32(value), index * 32));
  return output;
}

export function encodePublicInputsV1(fields) {
  const ordered = Array.isArray(fields)
    ? fields
    : [
        fields.merkleRoot,
        fields.nullifier0,
        fields.nullifier1,
        fields.changeCommitment,
        fields.publicAmount,
        fields.protocolFee,
        fields.relayerFee,
        fields.recipientBinding,
        fields.assetId,
        fields.contextBinding,
        fields.currentRoot,
        fields.newMerkleRoot,
        fields.changeLeafIndex,
      ];
  if (ordered.length !== PUBLIC_INPUT_COUNT_V1) {
    throw new RangeError(`Circuit V1 requires ${PUBLIC_INPUT_COUNT_V1} public inputs`);
  }
  const output = new Uint8Array(PUBLIC_INPUT_BYTES_V1);
  ordered.forEach((value, index) => output.set(fieldToLe32(value), index * 32));
  return output;
}

function normalizeInputNote(note, label, assetId) {
  if (!note || typeof note !== 'object') throw new TypeError(`${label} is required`);
  const amount = assertU64(note.amount, `${label}.amount`);
  const owner = assertFieldV1(note.owner, `${label}.owner`);
  const nonce = assertFieldV1(note.nonce, `${label}.nonce`);
  if (amount === 0n) throw new RangeError(`${label}.amount must be non-zero`);
  if (owner === 0n) throw new RangeError(`${label}.owner must be non-zero`);
  if (nonce === 0n) throw new RangeError(`${label}.nonce must be non-zero`);
  return { amount, owner, nonce, commitment: noteCommitmentV1({ assetId, amount, owner, nonce }) };
}

function normalizeChangeNote(note, assetId) {
  if (!note || typeof note !== 'object') throw new TypeError('change is required');
  const amount = assertU64(note.amount, 'change.amount');
  const owner = assertFieldV1(note.owner, 'change.owner');
  const nonce = assertFieldV1(note.nonce, 'change.nonce');
  if (owner === 0n) throw new RangeError('change.owner must be non-zero');
  if (nonce === 0n) throw new RangeError('change.nonce must be non-zero');
  return { amount, owner, nonce, commitment: noteCommitmentV1({ assetId, amount, owner, nonce }) };
}

function decimals(values) {
  return values.map((value) => value.toString(10));
}

export function buildDepositWitnessV1({
  registryAccountData = encodeCommitmentRegistryV1([]),
  owner,
  nonce,
  amount,
  assetId = 1n,
}) {
  const registry = decodeCommitmentRegistryV1(registryAccountData);
  const asset = assertFieldV1(assetId, 'assetId');
  if (asset === 0n) throw new RangeError('assetId must be non-zero');
  const note = normalizeInputNote({ owner, nonce, amount }, 'deposit', asset);
  const transition = getMerkleAppendTransitionV1(registry.commitments, note.commitment);
  const leafIndex = BigInt(transition.index);
  const publicFields = {
    commitment: note.commitment,
    amount: note.amount,
    assetId: asset,
    oldRoot: transition.oldRoot,
    newRoot: transition.newRoot,
    leafIndex,
  };
  return {
    registry,
    transition,
    note,
    witness: {
      Owner: note.owner.toString(10),
      Nonce: note.nonce.toString(10),
      Path: decimals(transition.path),
      Index: transition.indexBits,
      Commitment: note.commitment.toString(10),
      Amount: note.amount.toString(10),
      AssetID: asset.toString(10),
      OldRoot: transition.oldRoot.toString(10),
      NewRoot: transition.newRoot.toString(10),
      LeafIndex: leafIndex.toString(10),
    },
    publicFields,
    publicInputs: encodeDepositPublicInputsV1(publicFields),
    commitment: fieldToLe32(note.commitment),
    amount: note.amount,
  };
}

export async function buildDepositWitnessFromChainV1({
  connection,
  commitmentsAccount,
  commitment = 'confirmed',
  ...witnessOptions
}) {
  const registry = await fetchCommitmentRegistryV1(connection, commitmentsAccount, commitment);
  return buildDepositWitnessV1({
    ...witnessOptions,
    registryAccountData: encodeCommitmentRegistryV1(registry.commitments),
  });
}

export async function buildWithdrawWitnessV1({
  registryAccountData,
  input0,
  input1,
  change,
  publicAmount,
  protocolFee = 0n,
  relayerFee = 0n,
  recipient,
  recipientBinding,
  assetId,
  contextBinding,
}) {
  const registry = decodeCommitmentRegistryV1(registryAccountData);
  if (registry.count === 0) throw new Error('cannot withdraw from an empty commitment registry');
  const asset = assertFieldV1(assetId, 'assetId');
  const context = assertFieldV1(contextBinding, 'contextBinding');
  if (asset === 0n) throw new RangeError('assetId must be non-zero');
  if (context === 0n) throw new RangeError('contextBinding must be non-zero');

  const first = normalizeInputNote(input0, 'input0', asset);
  const second = normalizeInputNote(input1, 'input1', asset);
  if (first.commitment === second.commitment) throw new Error('input notes must be different');
  const firstIndex = findCommitmentIndexV1(registry.commitments, first.commitment);
  const secondIndex = findCommitmentIndexV1(registry.commitments, second.commitment);
  const firstProof = getMerkleProofV1(registry.tree, firstIndex);
  const secondProof = getMerkleProofV1(registry.tree, secondIndex);

  const changeNote = normalizeChangeNote(change, asset);
  const transition = getMerkleAppendTransitionV1(registry.commitments, changeNote.commitment);
  const publicValue = assertU64(publicAmount, 'publicAmount');
  if (publicValue === 0n) throw new RangeError('publicAmount must be non-zero');
  const protocolValue = assertU64(protocolFee, 'protocolFee');
  const relayerValue = assertU64(relayerFee, 'relayerFee');
  const inputsTotal = first.amount + second.amount;
  const outputsTotal = publicValue + protocolValue + relayerValue + changeNote.amount;
  if (inputsTotal !== outputsTotal) {
    throw new Error(`value conservation failed: inputs=${inputsTotal} outputs=${outputsTotal}`);
  }

  const binding = recipientBinding === undefined
    ? await recipientBindingV1(recipient)
    : assertFieldV1(recipientBinding, 'recipientBinding');
  if (binding === 0n) throw new RangeError('recipientBinding must be non-zero');
  const nullifier0 = nullifierV1(first);
  const nullifier1 = nullifierV1(second);
  if (nullifier0 === nullifier1) throw new Error('input notes produce the same nullifier');
  const changeLeafIndex = BigInt(transition.index);

  const publicFields = {
    merkleRoot: registry.root,
    nullifier0,
    nullifier1,
    changeCommitment: changeNote.commitment,
    publicAmount: publicValue,
    protocolFee: protocolValue,
    relayerFee: relayerValue,
    recipientBinding: binding,
    assetId: asset,
    contextBinding: context,
    currentRoot: registry.root,
    newMerkleRoot: transition.newRoot,
    changeLeafIndex,
  };
  const witness = {
    Input0Amount: first.amount.toString(10),
    Input0Owner: first.owner.toString(10),
    Input0Nonce: first.nonce.toString(10),
    Input0Path: decimals(firstProof.path),
    Input0Index: firstProof.indexBits,
    Input1Amount: second.amount.toString(10),
    Input1Owner: second.owner.toString(10),
    Input1Nonce: second.nonce.toString(10),
    Input1Path: decimals(secondProof.path),
    Input1Index: secondProof.indexBits,
    ChangeAmount: changeNote.amount.toString(10),
    ChangeOwner: changeNote.owner.toString(10),
    ChangeNonce: changeNote.nonce.toString(10),
    ChangePath: decimals(transition.path),
    ChangeIndex: transition.indexBits,
    MerkleRoot: registry.root.toString(10),
    Nullifier0: nullifier0.toString(10),
    Nullifier1: nullifier1.toString(10),
    ChangeCommitment: changeNote.commitment.toString(10),
    PublicAmount: publicValue.toString(10),
    ProtocolFee: protocolValue.toString(10),
    RelayerFee: relayerValue.toString(10),
    RecipientBinding: binding.toString(10),
    AssetID: asset.toString(10),
    ContextBinding: context.toString(10),
    CurrentRoot: registry.root.toString(10),
    NewMerkleRoot: transition.newRoot.toString(10),
    ChangeLeafIndex: changeLeafIndex.toString(10),
  };
  return {
    registry,
    transition,
    depositIndices: { input0: firstIndex, input1: secondIndex },
    proofs: { input0: firstProof, input1: secondProof },
    witness,
    publicFields,
    publicInputs: encodePublicInputsV1(publicFields),
    statement: {
      nullifier0: fieldToLe32(nullifier0),
      nullifier1: fieldToLe32(nullifier1),
      changeCommitment: fieldToLe32(changeNote.commitment),
      publicAmount: publicValue,
      protocolFee: protocolValue,
      relayerFee: relayerValue,
    },
  };
}

export async function buildWithdrawWitnessFromChainV1({
  connection,
  commitmentsAccount,
  commitment = 'confirmed',
  ...witnessOptions
}) {
  const registry = await fetchCommitmentRegistryV1(connection, commitmentsAccount, commitment);
  return buildWithdrawWitnessV1({
    ...witnessOptions,
    registryAccountData: encodeCommitmentRegistryV1(registry.commitments),
  });
}
''')

write("client/watcher/flows.mjs", r'''import { asBytes } from './keccak.mjs';
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
''')

write("programs/watcher-protocol/src/public_inputs.rs", r'''use solana_program::{hash::hashv, pubkey::Pubkey};

use crate::{WatcherError, WithdrawalStatement, SOL_ASSET_ID_V1};

pub const FIELD_BYTES: usize = 32;
pub const DEPOSIT_V1_PUBLIC_INPUTS: usize = 6;
pub const DEPOSIT_V1_PUBLIC_INPUT_BYTES: usize = FIELD_BYTES * DEPOSIT_V1_PUBLIC_INPUTS;
pub const CIRCUIT_V1_PUBLIC_INPUTS: usize = 13;
pub const CIRCUIT_V1_PUBLIC_INPUT_BYTES: usize = FIELD_BYTES * CIRCUIT_V1_PUBLIC_INPUTS;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DepositV1PublicInputs {
    pub commitment: [u8; 32],
    pub amount: [u8; 32],
    pub asset_id: [u8; 32],
    pub old_root: [u8; 32],
    pub new_root: [u8; 32],
    pub leaf_index: [u8; 32],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CircuitV1PublicInputs {
    pub merkle_root: [u8; 32],
    pub nullifier_0: [u8; 32],
    pub nullifier_1: [u8; 32],
    pub change_commitment: [u8; 32],
    pub public_amount: [u8; 32],
    pub protocol_fee: [u8; 32],
    pub relayer_fee: [u8; 32],
    pub recipient_binding: [u8; 32],
    pub asset_id: [u8; 32],
    pub context_binding: [u8; 32],
    pub current_root: [u8; 32],
    pub new_merkle_root: [u8; 32],
    pub change_leaf_index: [u8; 32],
}

pub fn field_from_u64_v1(value: u64) -> [u8; 32] {
    let mut output = [0u8; 32];
    output[..8].copy_from_slice(&value.to_le_bytes());
    output
}

pub fn sol_asset_id_field_v1() -> [u8; 32] {
    field_from_u64_v1(SOL_ASSET_ID_V1)
}

pub fn recipient_binding_v1(recipient: &Pubkey) -> [u8; 32] {
    let digest = hashv(&[b"watcher-recipient-v1", recipient.as_ref()]);
    let mut output = digest.to_bytes();
    output[31] &= 0x1f;
    output
}

pub fn withdraw_context_binding_v1(
    program_id: &Pubkey,
    config: &Pubkey,
    vault: &Pubkey,
    relayer: &Pubkey,
    treasury: &Pubkey,
    asset_id: &[u8; 32],
) -> [u8; 32] {
    let digest = hashv(&[
        b"watcher-withdraw-context-v1",
        program_id.as_ref(),
        config.as_ref(),
        vault.as_ref(),
        relayer.as_ref(),
        treasury.as_ref(),
        asset_id,
    ]);
    let mut output = digest.to_bytes();
    output[31] &= 0x1f;
    output
}

pub fn validate_deposit_binding(
    commitment: &[u8; 32],
    amount: u64,
    expected_asset_id: &[u8; 32],
    expected_old_root: &[u8; 32],
    expected_leaf_index: u64,
    inputs: &DepositV1PublicInputs,
) -> Result<(), WatcherError> {
    if inputs.commitment != *commitment
        || inputs.amount != field_from_u64_v1(amount)
        || inputs.asset_id != *expected_asset_id
        || inputs.old_root != *expected_old_root
        || inputs.leaf_index != field_from_u64_v1(expected_leaf_index)
        || inputs.new_root == [0u8; 32]
    {
        return Err(WatcherError::PublicInputMismatch);
    }
    Ok(())
}

pub fn validate_statement_binding(
    statement: &WithdrawalStatement,
    trusted_spend_root: &[u8; 32],
    expected_current_root: &[u8; 32],
    expected_change_leaf_index: u64,
    expected_asset_id: &[u8; 32],
    expected_context_binding: &[u8; 32],
    inputs: &CircuitV1PublicInputs,
) -> Result<(), WatcherError> {
    if *trusted_spend_root == [0u8; 32] || inputs.merkle_root != *trusted_spend_root {
        return Err(WatcherError::PublicInputMismatch);
    }
    if *expected_current_root == [0u8; 32]
        || inputs.current_root != *expected_current_root
        || inputs.new_merkle_root == [0u8; 32]
        || inputs.change_leaf_index != field_from_u64_v1(expected_change_leaf_index)
    {
        return Err(WatcherError::PublicInputMismatch);
    }
    if inputs.recipient_binding != recipient_binding_v1(&statement.recipient) {
        return Err(WatcherError::PublicInputMismatch);
    }
    if inputs.asset_id != *expected_asset_id || inputs.context_binding != *expected_context_binding
    {
        return Err(WatcherError::PublicInputMismatch);
    }
    if inputs.nullifier_0 != statement.nullifier_0
        || inputs.nullifier_1 != statement.nullifier_1
        || inputs.change_commitment != statement.change_commitment
    {
        return Err(WatcherError::PublicInputMismatch);
    }
    if inputs.public_amount != field_from_u64_v1(statement.public_amount)
        || inputs.protocol_fee != field_from_u64_v1(statement.protocol_fee)
        || inputs.relayer_fee != field_from_u64_v1(statement.relayer_fee)
    {
        return Err(WatcherError::PublicInputMismatch);
    }
    Ok(())
}

impl DepositV1PublicInputs {
    pub fn decode(bytes: &[u8]) -> Result<Self, WatcherError> {
        if bytes.len() != DEPOSIT_V1_PUBLIC_INPUT_BYTES {
            return Err(WatcherError::InvalidPublicInputs);
        }
        let field =
            |index: usize| -> [u8; 32] { bytes[index * 32..(index + 1) * 32].try_into().unwrap() };
        Ok(Self {
            commitment: field(0),
            amount: field(1),
            asset_id: field(2),
            old_root: field(3),
            new_root: field(4),
            leaf_index: field(5),
        })
    }

    pub fn encode(&self) -> [u8; DEPOSIT_V1_PUBLIC_INPUT_BYTES] {
        let fields = [
            self.commitment,
            self.amount,
            self.asset_id,
            self.old_root,
            self.new_root,
            self.leaf_index,
        ];
        let mut output = [0u8; DEPOSIT_V1_PUBLIC_INPUT_BYTES];
        for (index, field) in fields.iter().enumerate() {
            output[index * 32..(index + 1) * 32].copy_from_slice(field);
        }
        output
    }
}

impl CircuitV1PublicInputs {
    pub fn decode(bytes: &[u8]) -> Result<Self, WatcherError> {
        if bytes.len() != CIRCUIT_V1_PUBLIC_INPUT_BYTES {
            return Err(WatcherError::InvalidPublicInputs);
        }
        let field =
            |index: usize| -> [u8; 32] { bytes[index * 32..(index + 1) * 32].try_into().unwrap() };
        Ok(Self {
            merkle_root: field(0),
            nullifier_0: field(1),
            nullifier_1: field(2),
            change_commitment: field(3),
            public_amount: field(4),
            protocol_fee: field(5),
            relayer_fee: field(6),
            recipient_binding: field(7),
            asset_id: field(8),
            context_binding: field(9),
            current_root: field(10),
            new_merkle_root: field(11),
            change_leaf_index: field(12),
        })
    }

    pub fn encode(&self) -> [u8; CIRCUIT_V1_PUBLIC_INPUT_BYTES] {
        let fields = [
            self.merkle_root,
            self.nullifier_0,
            self.nullifier_1,
            self.change_commitment,
            self.public_amount,
            self.protocol_fee,
            self.relayer_fee,
            self.recipient_binding,
            self.asset_id,
            self.context_binding,
            self.current_root,
            self.new_merkle_root,
            self.change_leaf_index,
        ];
        let mut output = [0u8; CIRCUIT_V1_PUBLIC_INPUT_BYTES];
        for (index, field) in fields.iter().enumerate() {
            output[index * 32..(index + 1) * 32].copy_from_slice(field);
        }
        output
    }
}

pub fn recipient_pubkey_bytes(recipient: &Pubkey) -> [u8; 32] {
    recipient.to_bytes()
}
''')

write("programs/watcher-protocol/src/dev_fixture.rs", r'''// GENERATED DEVELOPMENT FIXTURES ONLY. Replace after production ceremonies.
// Wire format: little-endian BN254 limbs. Proof A is pre-negated for the pairing equation.

pub const DEV_VK_BYTES: [u8; 1344] = include!("dev_vk_array.in");
pub const DEV_PROOF_BYTES: [u8; 256] = include!("dev_proof_array.in");
pub const DEV_PUBLIC_INPUT_BYTES: [u8; 416] = include!("dev_public_inputs_array.in");

pub const DEV_DEPOSIT_VK_BYTES: [u8; 896] = include!("dev_deposit_vk_array.in");
pub const DEV_DEPOSIT_PROOF_BYTES: [u8; 256] = include!("dev_deposit_proof_array.in");
pub const DEV_DEPOSIT_PUBLIC_INPUT_BYTES: [u8; 192] = include!("dev_deposit_public_inputs_array.in");
pub const DEV_DEPOSIT_PROOF_1_BYTES: [u8; 256] = include!("dev_deposit_proof_1_array.in");
pub const DEV_DEPOSIT_PUBLIC_INPUT_1_BYTES: [u8; 192] =
    include!("dev_deposit_public_inputs_1_array.in");
''')

write("programs/watcher-protocol/src/verifier.rs", r'''use crate::{
    dev_fixture::{DEV_DEPOSIT_VK_BYTES, DEV_VK_BYTES},
    public_inputs::{
        validate_deposit_binding, validate_statement_binding, CircuitV1PublicInputs,
        DepositV1PublicInputs,
    },
    WatcherError, WithdrawalStatement,
};
use groth16_solana::groth16::{Groth16Verifier, Groth16Verifyingkey};

pub const GROTH16_BN254_PROOF_BYTES: usize = 256;

const fn reverse_field_from<const SOURCE: usize>(source: &[u8; SOURCE], start: usize) -> [u8; 32] {
    let mut output = [0u8; 32];
    let mut index = 0usize;
    while index < 32 {
        output[index] = source[start + 31 - index];
        index += 1;
    }
    output
}

const fn copy_field<const OUTPUT: usize>(
    output: &mut [u8; OUTPUT],
    output_start: usize,
    field: &[u8; 32],
) {
    let mut index = 0usize;
    while index < 32 {
        output[output_start + index] = field[index];
        index += 1;
    }
}

const fn g1_xark_le_to_gnark_be<const SOURCE: usize>(
    source: &[u8; SOURCE],
    start: usize,
) -> [u8; 64] {
    let mut output = [0u8; 64];
    let x = reverse_field_from(source, start);
    let y = reverse_field_from(source, start + 32);
    copy_field(&mut output, 0, &x);
    copy_field(&mut output, 32, &y);
    output
}

const fn g2_xark_le_to_gnark_be<const SOURCE: usize>(
    source: &[u8; SOURCE],
    start: usize,
) -> [u8; 128] {
    let mut output = [0u8; 128];
    let x_a1 = reverse_field_from(source, start + 32);
    let x_a0 = reverse_field_from(source, start);
    let y_a1 = reverse_field_from(source, start + 96);
    let y_a0 = reverse_field_from(source, start + 64);
    copy_field(&mut output, 0, &x_a1);
    copy_field(&mut output, 32, &x_a0);
    copy_field(&mut output, 64, &y_a1);
    copy_field(&mut output, 96, &y_a0);
    output
}

const fn g1_points_xark_le_to_gnark_be<const SOURCE: usize, const POINTS: usize>(
    source: &[u8; SOURCE],
    start: usize,
) -> [[u8; 64]; POINTS] {
    let mut output = [[0u8; 64]; POINTS];
    let mut point = 0usize;
    while point < POINTS {
        output[point] = g1_xark_le_to_gnark_be(source, start + point * 64);
        point += 1;
    }
    output
}

static DEV_DEPOSIT_IC_BE: [[u8; 64]; 7] =
    g1_points_xark_le_to_gnark_be::<896, 7>(&DEV_DEPOSIT_VK_BYTES, 448);
static DEV_WITHDRAW_IC_BE: [[u8; 64]; 14] =
    g1_points_xark_le_to_gnark_be::<1344, 14>(&DEV_VK_BYTES, 448);

static DEV_DEPOSIT_VERIFYING_KEY: Groth16Verifyingkey<'static> = Groth16Verifyingkey {
    nr_pubinputs: 6,
    vk_alpha_g1: g1_xark_le_to_gnark_be(&DEV_DEPOSIT_VK_BYTES, 0),
    vk_beta_g2: g2_xark_le_to_gnark_be(&DEV_DEPOSIT_VK_BYTES, 64),
    vk_gamma_g2: g2_xark_le_to_gnark_be(&DEV_DEPOSIT_VK_BYTES, 192),
    vk_delta_g2: g2_xark_le_to_gnark_be(&DEV_DEPOSIT_VK_BYTES, 320),
    vk_ic: &DEV_DEPOSIT_IC_BE,
    vk_commitment: None,
};

static DEV_WITHDRAW_VERIFYING_KEY: Groth16Verifyingkey<'static> = Groth16Verifyingkey {
    nr_pubinputs: 13,
    vk_alpha_g1: g1_xark_le_to_gnark_be(&DEV_VK_BYTES, 0),
    vk_beta_g2: g2_xark_le_to_gnark_be(&DEV_VK_BYTES, 64),
    vk_gamma_g2: g2_xark_le_to_gnark_be(&DEV_VK_BYTES, 192),
    vk_delta_g2: g2_xark_le_to_gnark_be(&DEV_VK_BYTES, 320),
    vk_ic: &DEV_WITHDRAW_IC_BE,
    vk_commitment: None,
};

fn reverse_field_into(output: &mut [u8], output_start: usize, source: &[u8], source_start: usize) {
    let mut index = 0usize;
    while index < 32 {
        output[output_start + index] = source[source_start + 31 - index];
        index += 1;
    }
}

#[inline(never)]
fn proof_xark_le_to_gnark_be(
    proof: &[u8],
) -> Result<[u8; GROTH16_BN254_PROOF_BYTES], WatcherError> {
    if proof.len() != GROTH16_BN254_PROOF_BYTES {
        return Err(WatcherError::InvalidProofEncoding);
    }
    let mut output = [0u8; GROTH16_BN254_PROOF_BYTES];
    reverse_field_into(&mut output, 0, proof, 0);
    reverse_field_into(&mut output, 32, proof, 32);
    reverse_field_into(&mut output, 64, proof, 96);
    reverse_field_into(&mut output, 96, proof, 64);
    reverse_field_into(&mut output, 128, proof, 160);
    reverse_field_into(&mut output, 160, proof, 128);
    reverse_field_into(&mut output, 192, proof, 192);
    reverse_field_into(&mut output, 224, proof, 224);
    Ok(output)
}

fn field_le_to_be(field_le: &[u8; 32]) -> [u8; 32] {
    let mut output = [0u8; 32];
    let mut index = 0usize;
    while index < 32 {
        output[index] = field_le[31 - index];
        index += 1;
    }
    output
}

#[inline(never)]
fn deposit_public_inputs_be(inputs: &DepositV1PublicInputs) -> [[u8; 32]; 6] {
    [
        field_le_to_be(&inputs.commitment),
        field_le_to_be(&inputs.amount),
        field_le_to_be(&inputs.asset_id),
        field_le_to_be(&inputs.old_root),
        field_le_to_be(&inputs.new_root),
        field_le_to_be(&inputs.leaf_index),
    ]
}

#[inline(never)]
fn withdraw_public_inputs_be(inputs: &CircuitV1PublicInputs) -> [[u8; 32]; 13] {
    [
        field_le_to_be(&inputs.merkle_root),
        field_le_to_be(&inputs.nullifier_0),
        field_le_to_be(&inputs.nullifier_1),
        field_le_to_be(&inputs.change_commitment),
        field_le_to_be(&inputs.public_amount),
        field_le_to_be(&inputs.protocol_fee),
        field_le_to_be(&inputs.relayer_fee),
        field_le_to_be(&inputs.recipient_binding),
        field_le_to_be(&inputs.asset_id),
        field_le_to_be(&inputs.context_binding),
        field_le_to_be(&inputs.current_root),
        field_le_to_be(&inputs.new_merkle_root),
        field_le_to_be(&inputs.change_leaf_index),
    ]
}

#[inline(never)]
fn verify_native<const INPUTS: usize>(
    verifying_key: &'static Groth16Verifyingkey<'static>,
    proof_le: &[u8],
    public_inputs_be: &[[u8; 32]; INPUTS],
) -> Result<(), WatcherError> {
    let proof_be = proof_xark_le_to_gnark_be(proof_le)?;
    let proof_a: &[u8; 64] = proof_be[0..64]
        .try_into()
        .map_err(|_| WatcherError::InvalidProofEncoding)?;
    let proof_b: &[u8; 128] = proof_be[64..192]
        .try_into()
        .map_err(|_| WatcherError::InvalidProofEncoding)?;
    let proof_c: &[u8; 64] = proof_be[192..256]
        .try_into()
        .map_err(|_| WatcherError::InvalidProofEncoding)?;
    let mut verifier =
        Groth16Verifier::<INPUTS>::new(proof_a, proof_b, proof_c, public_inputs_be, verifying_key)
            .map_err(|_| WatcherError::InvalidGroth16Proof)?;
    verifier
        .verify()
        .map_err(|_| WatcherError::InvalidGroth16Proof)
}

#[inline(never)]
pub fn verify_deposit_v1(
    commitment: &[u8; 32],
    amount: u64,
    expected_asset_id: &[u8; 32],
    expected_old_root: &[u8; 32],
    expected_leaf_index: u64,
    proof: &[u8],
    public_input_bytes: &[u8],
) -> Result<(), WatcherError> {
    let inputs = DepositV1PublicInputs::decode(public_input_bytes)?;
    validate_deposit_binding(
        commitment,
        amount,
        expected_asset_id,
        expected_old_root,
        expected_leaf_index,
        &inputs,
    )?;
    let public_inputs_be = deposit_public_inputs_be(&inputs);
    verify_native(&DEV_DEPOSIT_VERIFYING_KEY, proof, &public_inputs_be)
}

#[inline(never)]
pub fn verify_circuit_v1(
    statement: &WithdrawalStatement,
    trusted_spend_root: &[u8; 32],
    expected_current_root: &[u8; 32],
    expected_change_leaf_index: u64,
    expected_asset_id: &[u8; 32],
    expected_context_binding: &[u8; 32],
    proof: &[u8],
    public_input_bytes: &[u8],
) -> Result<(), WatcherError> {
    let inputs = CircuitV1PublicInputs::decode(public_input_bytes)?;
    validate_statement_binding(
        statement,
        trusted_spend_root,
        expected_current_root,
        expected_change_leaf_index,
        expected_asset_id,
        expected_context_binding,
        &inputs,
    )?;
    let public_inputs_be = withdraw_public_inputs_be(&inputs);
    verify_native(&DEV_WITHDRAW_VERIFYING_KEY, proof, &public_inputs_be)
}
''')

write("circuits/withdraw/deposit_v1_test.go", r'''package withdraw

import (
	"math/big"
	"testing"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark/backend/groth16"
	"github.com/consensys/gnark/constraint"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/frontend/cs/r1cs"
)

func compileDepositV1(t *testing.T) (constraint.ConstraintSystem, groth16.ProvingKey, groth16.VerifyingKey) {
	t.Helper()
	ccs, err := frontend.Compile(ecc.BN254.ScalarField(), r1cs.NewBuilder, &DepositCircuitV1{})
	if err != nil {
		t.Fatal(err)
	}
	pk, vk, err := groth16.Setup(ccs)
	if err != nil {
		t.Fatal(err)
	}
	return ccs, pk, vk
}

func depositFixtureAssignmentsV1() (DepositCircuitV1, DepositCircuitV1) {
	asset := bi(1)
	amount0, owner0, nonce0 := bi(8_000_000), bi(1111), bi(2222)
	amount1, owner1, nonce1 := bi(3_000_000), bi(3333), bi(4444)
	commitment0 := noteNativeV1(asset, amount0, owner0, nonce0)
	commitment1 := noteNativeV1(asset, amount1, owner1, nonce1)
	leaves := make([]*big.Int, 1<<MerkleDepthV1)
	for index := range leaves {
		leaves[index] = new(big.Int)
	}
	emptyTree := makeTreeV1(leaves)
	path0, bits0 := emptyTree.proof(0)
	leaves[0] = commitment0
	treeAfter0 := makeTreeV1(leaves)
	path1, bits1 := treeAfter0.proof(1)
	leaves[1] = commitment1
	treeAfter1 := makeTreeV1(leaves)
	return DepositCircuitV1{
		Owner: owner0, Nonce: nonce0, Path: path0, Index: bits0,
		Commitment: commitment0, Amount: amount0, AssetID: asset,
		OldRoot: 0, NewRoot: treeAfter0.root(), LeafIndex: 0,
	}, DepositCircuitV1{
		Owner: owner1, Nonce: nonce1, Path: path1, Index: bits1,
		Commitment: commitment1, Amount: amount1, AssetID: asset,
		OldRoot: treeAfter0.root(), NewRoot: treeAfter1.root(), LeafIndex: 1,
	}
}

func validDepositV1() DepositCircuitV1 {
	first, _ := depositFixtureAssignmentsV1()
	return first
}

func secondDepositV1() DepositCircuitV1 {
	_, second := depositFixtureAssignmentsV1()
	return second
}

func proveDepositV1(t *testing.T, ccs constraint.ConstraintSystem, pk groth16.ProvingKey, assignment DepositCircuitV1) error {
	t.Helper()
	witness, err := frontend.NewWitness(&assignment, ecc.BN254.ScalarField())
	if err != nil {
		return err
	}
	_, err = groth16.Prove(ccs, pk, witness)
	return err
}

func TestDepositV1ValidCommitmentAmountAndRootTransition(t *testing.T) {
	ccs, pk, vk := compileDepositV1(t)
	assignment := validDepositV1()
	witness, err := frontend.NewWitness(&assignment, ecc.BN254.ScalarField())
	if err != nil {
		t.Fatal(err)
	}
	publicWitness, err := witness.Public()
	if err != nil {
		t.Fatal(err)
	}
	proof, err := groth16.Prove(ccs, pk, witness)
	if err != nil {
		t.Fatal(err)
	}
	if err := groth16.Verify(proof, vk, publicWitness); err != nil {
		t.Fatal(err)
	}
}

func TestDepositV1RejectsAmountDifferentFromCommitment(t *testing.T) {
	ccs, pk, _ := compileDepositV1(t)
	assignment := validDepositV1()
	assignment.Amount = 7_999_999
	if err := proveDepositV1(t, ccs, pk, assignment); err == nil {
		t.Fatal("expected amount/commitment mismatch to fail")
	}
}

func TestDepositV1RejectsMutatedCommitment(t *testing.T) {
	ccs, pk, _ := compileDepositV1(t)
	assignment := validDepositV1()
	assignment.Commitment = 12345
	if err := proveDepositV1(t, ccs, pk, assignment); err == nil {
		t.Fatal("expected mutated commitment to fail")
	}
}

func TestDepositV1RejectsWrongOldOrNewRoot(t *testing.T) {
	ccs, pk, _ := compileDepositV1(t)
	assignment := secondDepositV1()
	assignment.OldRoot = 123
	if err := proveDepositV1(t, ccs, pk, assignment); err == nil {
		t.Fatal("expected wrong old root to fail")
	}
	assignment = secondDepositV1()
	assignment.NewRoot = 456
	if err := proveDepositV1(t, ccs, pk, assignment); err == nil {
		t.Fatal("expected wrong new root to fail")
	}
}
''')

write("programs/watcher-protocol/tests/merkle_frontier.rs", r'''use watcher_protocol_program::{
    codec::{append_unique_32, contains_32, REGISTRY_HEADER_LEN},
    processor::COMMITMENT_REGISTRY_ACCOUNT_LEN,
    WatcherError, STATE_VERSION,
};

fn commitment(value: u8) -> [u8; 32] {
    let mut output = [0u8; 32];
    output[0] = value;
    output
}

#[test]
fn append_only_registry_keeps_exact_leaf_order_and_capacity() {
    let mut registry = vec![0u8; COMMITMENT_REGISTRY_ACCOUNT_LEN];
    registry[0] = STATE_VERSION;
    for value in 1..=16u8 {
        append_unique_32(&mut registry, commitment(value)).unwrap();
    }
    assert_eq!(u32::from_le_bytes(registry[1..5].try_into().unwrap()), 16);
    for index in 0..16usize {
        let start = REGISTRY_HEADER_LEN + index * 32;
        assert_eq!(registry[start..start + 32], commitment((index + 1) as u8));
    }
    assert!(contains_32(&registry, &commitment(7)).unwrap());
}

#[test]
fn duplicate_append_fails_without_mutating_registry() {
    let mut registry = vec![0u8; COMMITMENT_REGISTRY_ACCOUNT_LEN];
    registry[0] = STATE_VERSION;
    append_unique_32(&mut registry, commitment(7)).unwrap();
    let before = registry.clone();
    assert_eq!(
        append_unique_32(&mut registry, commitment(7)),
        Err(WatcherError::DuplicateCommitment)
    );
    assert_eq!(registry, before);
}
''')

# Merkle client: preserve a complete zero tree for insertion proofs, then add a
# helper that returns the old root, new root, append index, path, and bits.
replace_once(
    "client/watcher/merkle.mjs",
    """  if (commitments.length === 0) {\n    return {\n      depth: MERKLE_DEPTH_V1,\n      levels: [new Array(MERKLE_LEAVES_V1).fill(0n)],\n      root: 0n,\n      commitmentCount: 0,\n    };\n  }""",
    """  if (commitments.length === 0) {\n    const empty = buildMerkleTreeFromLeavesV1(new Array(MERKLE_LEAVES_V1).fill(0n));\n    return { ...empty, root: 0n, commitmentCount: 0 };\n  }""",
    "complete empty Merkle levels",
)
replace_once(
    "client/watcher/merkle.mjs",
    "export function getMerkleProofV1(treeOrCommitments, index) {",
    r'''export function getMerkleAppendTransitionV1(commitments, rawCommitment) {
  if (!Array.isArray(commitments)) throw new TypeError('commitments must be an array');
  if (commitments.length >= MERKLE_LEAVES_V1) {
    throw new RangeError(`Circuit V1 tree is full at ${MERKLE_LEAVES_V1} commitments`);
  }
  const commitment = assertFieldV1(rawCommitment, 'new commitment');
  if (commitment === 0n) throw new RangeError('new commitment must be non-zero');
  const tree = buildMerkleTreeV1(commitments);
  if (commitments.some((value, index) => assertFieldV1(value, `commitment ${index}`) === commitment)) {
    throw new Error('new commitment is already present in the registry');
  }
  const index = commitments.length;
  const path = [];
  const indexBits = [];
  let position = index;
  for (let depth = 0; depth < MERKLE_DEPTH_V1; depth += 1) {
    path.push(tree.levels[depth][position ^ 1]);
    indexBits.push(position & 1);
    position = Math.floor(position / 2);
  }
  const nextLeaves = tree.levels[0].slice();
  nextLeaves[index] = commitment;
  const nextTree = buildMerkleTreeFromLeavesV1(nextLeaves);
  return {
    index,
    path,
    indexBits,
    oldRoot: tree.root,
    newRoot: nextTree.root,
  };
}

export function getMerkleProofV1(treeOrCommitments, index) {''',
    "append transition helper",
)

# Public instruction payload sizes follow the expanded proof statements.
replace_once(
    "client/watcher/instructions.mjs",
    "export const DEPOSIT_INSTRUCTION_PUBLIC_INPUT_BYTES_V1 = 96;",
    "export const DEPOSIT_INSTRUCTION_PUBLIC_INPUT_BYTES_V1 = 192;",
    "deposit instruction public bytes",
)
replace_once(
    "client/watcher/instructions.mjs",
    "export const WITHDRAW_PUBLIC_INPUT_BYTES_V1 = 320;",
    "export const WITHDRAW_PUBLIC_INPUT_BYTES_V1 = 416;",
    "withdraw instruction public bytes",
)

# Browser and RPC deposits must build the transition from the actual registry.
replace_once(
    "app/page.jsx",
    """      const prepared = await prepareDepositV1({\n        accounts: {""",
    """      const prepared = await prepareDepositV1({\n        connection,\n        accounts: {""",
    "browser deposit connection",
)
replace_once(
    "scripts/watcher-devnet-e2e.mjs",
    """  const firstDeposit = await prepareDepositV1({\n    accounts: sharedDepositAccounts,""",
    """  const firstDeposit = await prepareDepositV1({\n    connection,\n    accounts: sharedDepositAccounts,""",
    "first RPC deposit connection",
)
replace_once(
    "scripts/watcher-devnet-e2e.mjs",
    """  const secondDeposit = await prepareDepositV1({\n    accounts: sharedDepositAccounts,""",
    """  const secondDeposit = await prepareDepositV1({\n    connection,\n    accounts: sharedDepositAccounts,""",
    "second RPC deposit connection",
)

# Remove MiMC arithmetic from the deployed processor. Host-side circuit and JS
# tests remain the source of truth for the hash; the program only adopts roots
# that the Groth16 transition proof binds.
processor = read("programs/watcher-protocol/src/processor.rs")
processor = processor.replace("use ark_bn254::Fr;\nuse ark_ff::{AdditiveGroup, BigInteger, Field, PrimeField};\n", "")
processor = processor.replace(
    "        append_unique_32, contains_32, ConfigAccount, VaultAccount, WatcherInstruction,\n",
    "        append_unique_32, contains_32, ConfigAccount, VaultAccount, WatcherInstruction,\n",
)
processor = processor.replace(
    "    public_inputs::{sol_asset_id_field_v1, withdraw_context_binding_v1, CircuitV1PublicInputs},\n",
    "    public_inputs::{\n        sol_asset_id_field_v1, withdraw_context_binding_v1, CircuitV1PublicInputs,\n        DepositV1PublicInputs,\n    },\n",
)
processor = re.sub(
    r"const DOMAIN_NOTE_V1: u64 = 91_001;\nconst DOMAIN_MERKLE_V1: u64 = 91_003;\n",
    "",
    processor,
)
processor = re.sub(
    r"const COMMITMENT_FRONTIER_OFFSET_V1:[\s\S]*?\n\];\n\n",
    "",
    processor,
    count=1,
)
processor = re.sub(
    r"pub fn mimc_hash_v1\([\s\S]*?\nfn commitment_count\(",
    "fn commitment_count(",
    processor,
    count=1,
)
processor = re.sub(
    r"/// Append one commitment[\s\S]*?\nfn validate_root_state\(",
    "fn validate_root_state(",
    processor,
    count=1,
)
processor = processor.replace("    fr_from_canonical_le32(&commitment)?;\n\n", "")
processor = processor.replace(
    """    let mut parsed_config = ConfigAccount::unpack(&config_data)?;\n    validate_root_state(&parsed_config, &root_history_data)?;""",
    """    let mut parsed_config = ConfigAccount::unpack(&config_data)?;\n    validate_root_state(&parsed_config, &root_history_data)?;\n    let append_index = commitment_count(&commitments_data)?;\n    if append_index >= MERKLE_LEAVES_V1 {\n        return Err(WatcherError::MerkleTreeFull.into());\n    }\n    let decoded_inputs = DepositV1PublicInputs::decode(public_inputs)?;""",
    1,
)
processor = processor.replace(
    """    verify_deposit_v1(&commitment, amount, &asset_id, proof, public_inputs)?;\n\n    if commitment_count(&commitments_data)? >= MERKLE_LEAVES_V1 {\n        return Err(WatcherError::MerkleTreeFull.into());\n    }\n\n    let mut next_commitments = commitments_data;\n    let new_root = append_commitment_v1(&mut next_commitments, commitment)?;""",
    """    verify_deposit_v1(\n        &commitment,\n        amount,\n        &asset_id,\n        &parsed_config.merkle_root,\n        append_index as u64,\n        proof,\n        public_inputs,\n    )?;\n\n    let mut next_commitments = commitments_data;\n    append_unique_32(&mut next_commitments, commitment)?;\n    let new_root = decoded_inputs.new_root;""",
    1,
)
processor = processor.replace(
    """    statement.validate_development()?;\n    if statement.change_commitment != [0u8; 32] {\n        fr_from_canonical_le32(&statement.change_commitment)?;\n    }\n\n    let decoded_inputs""",
    """    statement.validate_development()?;\n\n    let decoded_inputs""",
    1,
)
processor = processor.replace(
    """    if statement.change_commitment != [0u8; 32]\n        && commitment_count(&commitments_data)? >= MERKLE_LEAVES_V1\n    {\n        return Err(WatcherError::MerkleTreeFull.into());\n    }""",
    """    let append_index = commitment_count(&commitments_data)?;\n    if statement.change_commitment != [0u8; 32] && append_index >= MERKLE_LEAVES_V1 {\n        return Err(WatcherError::MerkleTreeFull.into());\n    }""",
    1,
)
processor = processor.replace(
    """        &decoded_inputs.merkle_root,\n        &asset_id,""",
    """        &decoded_inputs.merkle_root,\n        &parsed_config.merkle_root,\n        append_index as u64,\n        &asset_id,""",
    1,
)
processor = processor.replace(
    """    if statement.change_commitment != [0u8; 32] {\n        let new_root = append_commitment_v1(&mut next_commitments, statement.change_commitment)?;\n        push_root(&mut next_root_history, new_root)?;""",
    """    if statement.change_commitment != [0u8; 32] {\n        append_unique_32(&mut next_commitments, statement.change_commitment)?;\n        let new_root = decoded_inputs.new_merkle_root;\n        push_root(&mut next_root_history, new_root)?;""",
    1,
)
processor = re.sub(
    r"\n    #\[test\]\n    fn rust_mimc_tree_matches_sequential_circuit_v1_fixture_root\(\) \{[\s\S]*?\n    \}\n",
    "\n",
    processor,
    count=1,
)
for forbidden in ("append_commitment_v1", "mimc_hash_v1", "fr_from_canonical_le32", "ark_bn254"):
    if forbidden in processor:
        raise RuntimeError(f"processor still contains removed runtime symbol {forbidden}")
write("programs/watcher-protocol/src/processor.rs", processor)

# Arkworks was only needed by the removed on-chain MiMC reference path.
cargo = read("programs/watcher-protocol/Cargo.toml")
cargo = cargo.replace('ark-bn254 = "0.6"\n', '').replace('ark-ff = "0.6"\n', '')
write("programs/watcher-protocol/Cargo.toml", cargo)

# Go prover JSON adapters.
replace_once(
    "circuits/withdraw/prover_v1.go",
    """\tXarkProofBytesV1           = 256\n\tDepositPublicInputBytesV1  = 3 * 32\n\tWithdrawPublicInputBytesV1 = 10 * 32""",
    """\tXarkProofBytesV1           = 256\n\tDepositPublicInputBytesV1  = 6 * 32\n\tWithdrawPublicInputBytesV1 = 13 * 32""",
    "Go prover public input counts",
)
replace_regex(
    "circuits/withdraw/prover_v1.go",
    r"type depositWitnessJSONV1 struct \{[\s\S]*?\n\}\n\nfunc depositAssignmentFromJSONV1\(data \[\]byte\) \(DepositCircuitV1, error\) \{[\s\S]*?\n\}\n\ntype withdrawWitnessJSONV1",
    r'''type depositWitnessJSONV1 struct {
	Owner      decimalV1   `json:"Owner"`
	Nonce      decimalV1   `json:"Nonce"`
	Path       []decimalV1 `json:"Path"`
	Index      []uint8     `json:"Index"`
	Commitment decimalV1   `json:"Commitment"`
	Amount     decimalV1   `json:"Amount"`
	AssetID    decimalV1   `json:"AssetID"`
	OldRoot    decimalV1   `json:"OldRoot"`
	NewRoot    decimalV1   `json:"NewRoot"`
	LeafIndex  decimalV1   `json:"LeafIndex"`
}

func depositAssignmentFromJSONV1(data []byte) (DepositCircuitV1, error) {
	var encoded depositWitnessJSONV1
	if err := decodeStrictJSONV1(data, &encoded); err != nil {
		return DepositCircuitV1{}, fmt.Errorf("decode deposit witness: %w", err)
	}
	owner, err := parseFieldV1(encoded.Owner, "Owner", true)
	if err != nil { return DepositCircuitV1{}, err }
	nonce, err := parseFieldV1(encoded.Nonce, "Nonce", true)
	if err != nil { return DepositCircuitV1{}, err }
	path, err := parsePathV1(encoded.Path, "Path")
	if err != nil { return DepositCircuitV1{}, err }
	index, err := parseIndexV1(encoded.Index, "Index")
	if err != nil { return DepositCircuitV1{}, err }
	commitment, err := parseFieldV1(encoded.Commitment, "Commitment", true)
	if err != nil { return DepositCircuitV1{}, err }
	amount, err := parseU64V1(encoded.Amount, "Amount", true)
	if err != nil { return DepositCircuitV1{}, err }
	assetID, err := parseFieldV1(encoded.AssetID, "AssetID", true)
	if err != nil { return DepositCircuitV1{}, err }
	oldRoot, err := parseFieldV1(encoded.OldRoot, "OldRoot", false)
	if err != nil { return DepositCircuitV1{}, err }
	newRoot, err := parseFieldV1(encoded.NewRoot, "NewRoot", true)
	if err != nil { return DepositCircuitV1{}, err }
	leafIndex, err := parseU64V1(encoded.LeafIndex, "LeafIndex", false)
	if err != nil { return DepositCircuitV1{}, err }
	return DepositCircuitV1{
		Owner: owner, Nonce: nonce, Path: path, Index: index,
		Commitment: commitment, Amount: amount, AssetID: assetID,
		OldRoot: oldRoot, NewRoot: newRoot, LeafIndex: leafIndex,
	}, nil
}

type withdrawWitnessJSONV1''',
    "deposit JSON adapter",
)
replace_once(
    "circuits/withdraw/prover_v1.go",
    """\tChangeAmount decimalV1 `json:\"ChangeAmount\"`\n\tChangeOwner  decimalV1 `json:\"ChangeOwner\"`\n\tChangeNonce  decimalV1 `json:\"ChangeNonce\"`""",
    """\tChangeAmount decimalV1   `json:\"ChangeAmount\"`\n\tChangeOwner  decimalV1   `json:\"ChangeOwner\"`\n\tChangeNonce  decimalV1   `json:\"ChangeNonce\"`\n\tChangePath   []decimalV1 `json:\"ChangePath\"`\n\tChangeIndex  []uint8     `json:\"ChangeIndex\"`""",
    "withdraw change path JSON fields",
)
replace_once(
    "circuits/withdraw/prover_v1.go",
    """\tRecipientBinding decimalV1 `json:\"RecipientBinding\"`\n\tAssetID          decimalV1 `json:\"AssetID\"`\n\tContextBinding   decimalV1 `json:\"ContextBinding\"`""",
    """\tRecipientBinding decimalV1 `json:\"RecipientBinding\"`\n\tAssetID          decimalV1 `json:\"AssetID\"`\n\tContextBinding   decimalV1 `json:\"ContextBinding\"`\n\tCurrentRoot      decimalV1 `json:\"CurrentRoot\"`\n\tNewMerkleRoot    decimalV1 `json:\"NewMerkleRoot\"`\n\tChangeLeafIndex  decimalV1 `json:\"ChangeLeafIndex\"`""",
    "withdraw transition JSON fields",
)
replace_once(
    "circuits/withdraw/prover_v1.go",
    """\tchangeNonce, err := parseFieldV1(encoded.ChangeNonce, \"ChangeNonce\", true)\n\tif err != nil {\n\t\treturn CircuitV1{}, err\n\t}\n\n\tmerkleRoot""",
    """\tchangeNonce, err := parseFieldV1(encoded.ChangeNonce, \"ChangeNonce\", true)\n\tif err != nil {\n\t\treturn CircuitV1{}, err\n\t}\n\tchangePath, err := parsePathV1(encoded.ChangePath, \"ChangePath\")\n\tif err != nil {\n\t\treturn CircuitV1{}, err\n\t}\n\tchangeIndex, err := parseIndexV1(encoded.ChangeIndex, \"ChangeIndex\")\n\tif err != nil {\n\t\treturn CircuitV1{}, err\n\t}\n\n\tmerkleRoot""",
    "parse withdrawal transition path",
)
replace_once(
    "circuits/withdraw/prover_v1.go",
    """\tcontextBinding, err := parseFieldV1(encoded.ContextBinding, \"ContextBinding\", true)\n\tif err != nil {\n\t\treturn CircuitV1{}, err\n\t}\n\n\treturn CircuitV1{""",
    """\tcontextBinding, err := parseFieldV1(encoded.ContextBinding, \"ContextBinding\", true)\n\tif err != nil {\n\t\treturn CircuitV1{}, err\n\t}\n\tcurrentRoot, err := parseFieldV1(encoded.CurrentRoot, \"CurrentRoot\", true)\n\tif err != nil {\n\t\treturn CircuitV1{}, err\n\t}\n\tnewMerkleRoot, err := parseFieldV1(encoded.NewMerkleRoot, \"NewMerkleRoot\", true)\n\tif err != nil {\n\t\treturn CircuitV1{}, err\n\t}\n\tchangeLeafIndex, err := parseU64V1(encoded.ChangeLeafIndex, \"ChangeLeafIndex\", false)\n\tif err != nil {\n\t\treturn CircuitV1{}, err\n\t}\n\n\treturn CircuitV1{""",
    "parse withdrawal public transition",
)
replace_once(
    "circuits/withdraw/prover_v1.go",
    """\t\tChangeAmount: changeAmount, ChangeOwner: changeOwner, ChangeNonce: changeNonce,\n\t\tMerkleRoot: merkleRoot, Nullifier0: nullifier0, Nullifier1: nullifier1,""",
    """\t\tChangeAmount: changeAmount, ChangeOwner: changeOwner, ChangeNonce: changeNonce,\n\t\tChangePath: changePath, ChangeIndex: changeIndex,\n\t\tMerkleRoot: merkleRoot, Nullifier0: nullifier0, Nullifier1: nullifier1,""",
    "assign withdrawal transition path",
)
replace_once(
    "circuits/withdraw/prover_v1.go",
    """\t\tRecipientBinding: recipientBinding, AssetID: assetID, ContextBinding: contextBinding,\n\t}, nil""",
    """\t\tRecipientBinding: recipientBinding, AssetID: assetID, ContextBinding: contextBinding,\n\t\tCurrentRoot: currentRoot, NewMerkleRoot: newMerkleRoot, ChangeLeafIndex: changeLeafIndex,\n\t}, nil""",
    "assign withdrawal transition public fields",
)
replace_once(
    "circuits/withdraw/prover_v1.go",
    'if depositVK.NbPublicWitness() != 3 {',
    'if depositVK.NbPublicWitness() != 6 {',
    "deposit VK public arity",
)
replace_once(
    "circuits/withdraw/prover_v1.go",
    'want 3", depositVK.NbPublicWitness())',
    'want 6", depositVK.NbPublicWitness())',
    "deposit VK expected message",
)
replace_once(
    "circuits/withdraw/prover_v1.go",
    'if withdrawVK.NbPublicWitness() != 10 {',
    'if withdrawVK.NbPublicWitness() != 13 {',
    "withdraw VK public arity",
)
replace_once(
    "circuits/withdraw/prover_v1.go",
    'want 10", withdrawVK.NbPublicWitness())',
    'want 13", withdrawVK.NbPublicWitness())',
    "withdraw VK expected message",
)

# Setup generator: build sequential append transitions and expanded public wires.
replace_once(
    "circuits/withdraw/cmd/watcher-setup/main.go",
    """\t\tDepositPublicInputs:  3,\n\t\tWithdrawPublicInputs: 10,""",
    """\t\tDepositPublicInputs:  6,\n\t\tWithdrawPublicInputs: 13,""",
    "setup manifest public counts",
)
replace_regex(
    "circuits/withdraw/cmd/watcher-setup/main.go",
    r"type fixtureValues struct \{[\s\S]*?\n\}\n\nfunc makeFixture\(\) fixtureValues \{[\s\S]*?\n\}\n\ntype setupResult",
    r'''type fixtureValues struct {
	asset                         *big.Int
	amount0, owner0, nonce0       *big.Int
	amount1, owner1, nonce1       *big.Int
	commitment0, commitment1      *big.Int
	changeAmount, changeOwner     *big.Int
	changeNonce, changeCommitment *big.Int
	treeAfter0, treeAfter1        treeV1
	treeAfterChange               treeV1
	path0, path1                  [withdraw.MerkleDepthV1]frontend.Variable
	bits0, bits1                  [withdraw.MerkleDepthV1]frontend.Variable
	depositPath0, depositPath1    [withdraw.MerkleDepthV1]frontend.Variable
	depositBits0, depositBits1    [withdraw.MerkleDepthV1]frontend.Variable
	changePath, changeBits        [withdraw.MerkleDepthV1]frontend.Variable
}

func makeFixture() fixtureValues {
	asset := big.NewInt(1)
	amount0, owner0, nonce0 := big.NewInt(8_000_000), big.NewInt(1111), big.NewInt(2222)
	amount1, owner1, nonce1 := big.NewInt(3_000_000), big.NewInt(3333), big.NewInt(4444)
	commitment0 := note(asset, amount0, owner0, nonce0)
	commitment1 := note(asset, amount1, owner1, nonce1)
	changeAmount, changeOwner, changeNonce := big.NewInt(6_000_000), big.NewInt(5555), big.NewInt(6666)
	changeCommitment := note(asset, changeAmount, changeOwner, changeNonce)
	leaves := make([]*big.Int, 1<<withdraw.MerkleDepthV1)
	for index := range leaves { leaves[index] = new(big.Int) }
	emptyTree := makeTree(leaves)
	depositPath0, depositBits0 := emptyTree.proof(0)
	leaves[0] = commitment0
	treeAfter0 := makeTree(leaves)
	depositPath1, depositBits1 := treeAfter0.proof(1)
	leaves[1] = commitment1
	treeAfter1 := makeTree(leaves)
	path0, bits0 := treeAfter1.proof(0)
	path1, bits1 := treeAfter1.proof(1)
	changePath, changeBits := treeAfter1.proof(2)
	leaves[2] = changeCommitment
	treeAfterChange := makeTree(leaves)
	return fixtureValues{
		asset: asset,
		amount0: amount0, owner0: owner0, nonce0: nonce0,
		amount1: amount1, owner1: owner1, nonce1: nonce1,
		commitment0: commitment0, commitment1: commitment1,
		changeAmount: changeAmount, changeOwner: changeOwner, changeNonce: changeNonce,
		changeCommitment: changeCommitment,
		treeAfter0: treeAfter0, treeAfter1: treeAfter1, treeAfterChange: treeAfterChange,
		path0: path0, bits0: bits0, path1: path1, bits1: bits1,
		depositPath0: depositPath0, depositBits0: depositBits0,
		depositPath1: depositPath1, depositBits1: depositBits1,
		changePath: changePath, changeBits: changeBits,
	}
}

type setupResult''',
    "setup fixture transitions",
)
replace_regex(
    "circuits/withdraw/cmd/watcher-setup/main.go",
    r"func buildWithdrawalSetup\(fixture fixtureValues\) \(setupResult, error\) \{[\s\S]*?\n\}\n\ntype depositSetupResult",
    r'''func buildWithdrawalSetup(fixture fixtureValues) (setupResult, error) {
	assignment := withdraw.CircuitV1{
		Input0Amount: fixture.amount0, Input0Owner: fixture.owner0, Input0Nonce: fixture.nonce0,
		Input0Path: fixture.path0, Input0Index: fixture.bits0,
		Input1Amount: fixture.amount1, Input1Owner: fixture.owner1, Input1Nonce: fixture.nonce1,
		Input1Path: fixture.path1, Input1Index: fixture.bits1,
		ChangeAmount: fixture.changeAmount, ChangeOwner: fixture.changeOwner, ChangeNonce: fixture.changeNonce,
		ChangePath: fixture.changePath, ChangeIndex: fixture.changeBits,
		MerkleRoot: fixture.treeAfter1.root(),
		Nullifier0: nullifier(fixture.owner0, fixture.nonce0, fixture.commitment0),
		Nullifier1: nullifier(fixture.owner1, fixture.nonce1, fixture.commitment1),
		ChangeCommitment: fixture.changeCommitment,
		PublicAmount: 4_000_000, ProtocolFee: 0, RelayerFee: 1_000_000,
		RecipientBinding: recipientBinding(), AssetID: 1, ContextBinding: withdrawContextBinding(),
		CurrentRoot: fixture.treeAfter1.root(), NewMerkleRoot: fixture.treeAfterChange.root(), ChangeLeafIndex: 2,
	}
	ccs, err := frontend.Compile(ecc.BN254.ScalarField(), r1cs.NewBuilder, &withdraw.CircuitV1{})
	if err != nil { return setupResult{}, err }
	pk, vk, err := groth16.Setup(ccs)
	if err != nil { return setupResult{}, err }
	fullWitness, err := frontend.NewWitness(&assignment, ecc.BN254.ScalarField())
	if err != nil { return setupResult{}, err }
	publicWitness, err := fullWitness.Public()
	if err != nil { return setupResult{}, err }
	proof, err := groth16.Prove(ccs, pk, fullWitness)
	if err != nil { return setupResult{}, err }
	if err := groth16.Verify(proof, vk, publicWitness); err != nil { return setupResult{}, err }
	proofWire, err := xarkProof(proof)
	if err != nil { return setupResult{}, err }
	vkWire, err := xarkVerifyingKey(vk)
	if err != nil { return setupResult{}, err }
	publicWire, err := publicInputWire(publicWitness)
	if err != nil { return setupResult{}, err }
	if len(vkWire) != 1344 || len(publicWire) != 416 {
		return setupResult{}, errors.New("unexpected withdrawal wire length")
	}
	witnessJSON, err := json.MarshalIndent(withdrawWitnessMap(assignment), "", "  ")
	if err != nil { return setupResult{}, err }
	witnessJSON = append(witnessJSON, '\n')
	return setupResult{
		constraintSystem: writeToBytes(ccs),
		provingKey: writeToBytes(pk), verifyingKey: writeToBytes(vk), verifierWire: vkWire,
		proof: proofWire, publicInputs: publicWire, witnessJSON: witnessJSON,
	}, nil
}

type depositSetupResult''',
    "setup withdrawal circuit",
)
replace_regex(
    "circuits/withdraw/cmd/watcher-setup/main.go",
    r"func buildDepositSetup\(fixture fixtureValues\) \(depositSetupResult, error\) \{[\s\S]*?\n\}\n\nfunc writeToBytes",
    r'''func buildDepositSetup(fixture fixtureValues) (depositSetupResult, error) {
	ccs, err := frontend.Compile(ecc.BN254.ScalarField(), r1cs.NewBuilder, &withdraw.DepositCircuitV1{})
	if err != nil { return depositSetupResult{}, err }
	pk, vk, err := groth16.Setup(ccs)
	if err != nil { return depositSetupResult{}, err }
	assignments := []withdraw.DepositCircuitV1{
		{
			Owner: fixture.owner0, Nonce: fixture.nonce0,
			Path: fixture.depositPath0, Index: fixture.depositBits0,
			Commitment: fixture.commitment0, Amount: fixture.amount0, AssetID: fixture.asset,
			OldRoot: 0, NewRoot: fixture.treeAfter0.root(), LeafIndex: 0,
		},
		{
			Owner: fixture.owner1, Nonce: fixture.nonce1,
			Path: fixture.depositPath1, Index: fixture.depositBits1,
			Commitment: fixture.commitment1, Amount: fixture.amount1, AssetID: fixture.asset,
			OldRoot: fixture.treeAfter0.root(), NewRoot: fixture.treeAfter1.root(), LeafIndex: 1,
		},
	}
	proofs := make([][]byte, 2)
	publicInputs := make([][]byte, 2)
	witnessJSON := make([][]byte, 2)
	for index := range assignments {
		fullWitness, err := frontend.NewWitness(&assignments[index], ecc.BN254.ScalarField())
		if err != nil { return depositSetupResult{}, err }
		publicWitness, err := fullWitness.Public()
		if err != nil { return depositSetupResult{}, err }
		proof, err := groth16.Prove(ccs, pk, fullWitness)
		if err != nil { return depositSetupResult{}, err }
		if err := groth16.Verify(proof, vk, publicWitness); err != nil { return depositSetupResult{}, err }
		proofs[index], err = xarkProof(proof)
		if err != nil { return depositSetupResult{}, err }
		publicInputs[index], err = publicInputWire(publicWitness)
		if err != nil { return depositSetupResult{}, err }
		witnessJSON[index], err = json.MarshalIndent(depositWitnessMap(assignments[index]), "", "  ")
		if err != nil { return depositSetupResult{}, err }
		witnessJSON[index] = append(witnessJSON[index], '\n')
	}
	vkWire, err := xarkVerifyingKey(vk)
	if err != nil { return depositSetupResult{}, err }
	if len(vkWire) != 896 || len(publicInputs[0]) != 192 || len(publicInputs[1]) != 192 {
		return depositSetupResult{}, errors.New("unexpected deposit wire length")
	}
	return depositSetupResult{
		constraintSystem: writeToBytes(ccs),
		provingKey: writeToBytes(pk), verifyingKey: writeToBytes(vk), verifierWire: vkWire,
		proof0: proofs[0], publicInputs0: publicInputs[0], witness0JSON: witnessJSON[0],
		proof1: proofs[1], publicInputs1: publicInputs[1], witness1JSON: witnessJSON[1],
	}, nil
}

func writeToBytes''',
    "setup deposit circuit",
)
replace_regex(
    "circuits/withdraw/cmd/watcher-setup/main.go",
    r"func withdrawWitnessMap\(value withdraw.CircuitV1\) map\[string\]any \{[\s\S]*?\n\}\nfunc depositWitnessMap\(value withdraw.DepositCircuitV1\) map\[string\]any \{[\s\S]*?\n\}",
    r'''func withdrawWitnessMap(value withdraw.CircuitV1) map[string]any {
	return map[string]any{
		"Input0Amount": variableString(value.Input0Amount), "Input0Owner": variableString(value.Input0Owner), "Input0Nonce": variableString(value.Input0Nonce), "Input0Path": variableStrings(value.Input0Path), "Input0Index": variableStrings(value.Input0Index),
		"Input1Amount": variableString(value.Input1Amount), "Input1Owner": variableString(value.Input1Owner), "Input1Nonce": variableString(value.Input1Nonce), "Input1Path": variableStrings(value.Input1Path), "Input1Index": variableStrings(value.Input1Index),
		"ChangeAmount": variableString(value.ChangeAmount), "ChangeOwner": variableString(value.ChangeOwner), "ChangeNonce": variableString(value.ChangeNonce), "ChangePath": variableStrings(value.ChangePath), "ChangeIndex": variableStrings(value.ChangeIndex),
		"MerkleRoot": variableString(value.MerkleRoot), "Nullifier0": variableString(value.Nullifier0), "Nullifier1": variableString(value.Nullifier1), "ChangeCommitment": variableString(value.ChangeCommitment),
		"PublicAmount": variableString(value.PublicAmount), "ProtocolFee": variableString(value.ProtocolFee), "RelayerFee": variableString(value.RelayerFee), "RecipientBinding": variableString(value.RecipientBinding), "AssetID": variableString(value.AssetID), "ContextBinding": variableString(value.ContextBinding),
		"CurrentRoot": variableString(value.CurrentRoot), "NewMerkleRoot": variableString(value.NewMerkleRoot), "ChangeLeafIndex": variableString(value.ChangeLeafIndex),
	}
}
func depositWitnessMap(value withdraw.DepositCircuitV1) map[string]any {
	return map[string]any{
		"Owner": variableString(value.Owner), "Nonce": variableString(value.Nonce),
		"Path": variableStrings(value.Path), "Index": variableStrings(value.Index),
		"Commitment": variableString(value.Commitment), "Amount": variableString(value.Amount), "AssetID": variableString(value.AssetID),
		"OldRoot": variableString(value.OldRoot), "NewRoot": variableString(value.NewRoot), "LeafIndex": variableString(value.LeafIndex),
	}
}''',
    "setup witness maps",
)

# Circuit test fixture gains the change append transition.
replace_regex(
    "circuits/withdraw/circuit_v1_test.go",
    r"func validV1\(\) CircuitV1 \{[\s\S]*?\n\}\n\nfunc TestV1ValidMembershipProvesAndVerifies",
    r'''func validV1() CircuitV1 {
	asset := bi(1)
	amount0, owner0, nonce0 := bi(8_000_000), bi(1111), bi(2222)
	amount1, owner1, nonce1 := bi(3_000_000), bi(3333), bi(4444)
	commitment0 := noteNativeV1(asset, amount0, owner0, nonce0)
	commitment1 := noteNativeV1(asset, amount1, owner1, nonce1)
	leaves := make([]*big.Int, 1<<MerkleDepthV1)
	for index := range leaves { leaves[index] = new(big.Int) }
	leaves[0] = commitment0
	leaves[1] = commitment1
	tree := makeTreeV1(leaves)
	path0, bits0 := tree.proof(0)
	path1, bits1 := tree.proof(1)
	changeAmount, changeOwner, changeNonce := bi(6_000_000), bi(5555), bi(6666)
	changeCommitment := noteNativeV1(asset, changeAmount, changeOwner, changeNonce)
	changePath, changeBits := tree.proof(2)
	leaves[2] = changeCommitment
	newTree := makeTreeV1(leaves)
	return CircuitV1{
		Input0Amount: amount0, Input0Owner: owner0, Input0Nonce: nonce0, Input0Path: path0, Input0Index: bits0,
		Input1Amount: amount1, Input1Owner: owner1, Input1Nonce: nonce1, Input1Path: path1, Input1Index: bits1,
		ChangeAmount: changeAmount, ChangeOwner: changeOwner, ChangeNonce: changeNonce,
		ChangePath: changePath, ChangeIndex: changeBits,
		MerkleRoot: tree.root(), Nullifier0: nullifierNativeV1(owner0, nonce0, commitment0), Nullifier1: nullifierNativeV1(owner1, nonce1, commitment1),
		ChangeCommitment: changeCommitment, PublicAmount: 4_000_000, ProtocolFee: 0, RelayerFee: 1_000_000,
		RecipientBinding: fixtureRecipientBinding(), AssetID: 1, ContextBinding: fixtureWithdrawContextBinding(),
		CurrentRoot: tree.root(), NewMerkleRoot: newTree.root(), ChangeLeafIndex: 2,
	}
}

func TestV1ValidMembershipProvesAndVerifies''',
    "circuit test transition fixture",
)

# Keep the invalid-index parser test focused on the intended field by supplying
# syntactically valid transition fields.
replace_once(
    "circuits/withdraw/prover_v1_test.go",
    """\t\tChangeAmount: \"6\", ChangeOwner: \"15\", ChangeNonce: \"16\",\n\t\tMerkleRoot: \"17\", Nullifier0: \"18\", Nullifier1: \"19\",\n\t\tChangeCommitment: \"20\", PublicAmount: \"4\", ProtocolFee: \"0\",\n\t\tRelayerFee: \"1\", RecipientBinding: \"21\", AssetID: \"1\", ContextBinding: \"22\",""",
    """\t\tChangeAmount: \"6\", ChangeOwner: \"15\", ChangeNonce: \"16\",\n\t\tChangePath: []decimalV1{\"0\", \"0\", \"0\", \"0\"},\n\t\tChangeIndex: []uint8{0, 0, 0, 0},\n\t\tMerkleRoot: \"17\", Nullifier0: \"18\", Nullifier1: \"19\",\n\t\tChangeCommitment: \"20\", PublicAmount: \"4\", ProtocolFee: \"0\",\n\t\tRelayerFee: \"1\", RecipientBinding: \"21\", AssetID: \"1\", ContextBinding: \"22\",\n\t\tCurrentRoot: \"23\", NewMerkleRoot: \"24\", ChangeLeafIndex: \"2\",""",
    "prover invalid index fixture",
)

# Replace the circuit workflow with one canonical setup pipeline. It generates
# the exact prover bundle and Rust verifier arrays from the same Setup calls.
write(".github/workflows/watcher-circuit.yml", r'''name: Watcher Protocol Circuit CI

on:
  push:
    branches: [watcher-protocol]
    paths:
      - 'circuits/withdraw/**'
      - 'programs/watcher-protocol/src/dev_fixture.rs'
      - '.github/workflows/watcher-circuit.yml'
  pull_request:
    paths:
      - 'circuits/withdraw/**'
      - 'programs/watcher-protocol/src/dev_fixture.rs'
      - '.github/workflows/watcher-circuit.yml'

permissions:
  contents: write

jobs:
  test-and-publish-matched-setup:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-go@v5
        with:
          go-version: '1.25.x'
          cache-dependency-path: circuits/withdraw/go.sum
      - uses: dtolnay/rust-toolchain@stable

      - name: Test circuits and prover adapters
        working-directory: circuits/withdraw
        run: |
          go mod tidy
          go test ./...

      - name: Generate one matched proof bundle and verifier arrays
        working-directory: circuits/withdraw
        run: |
          rm -rf fixture-out/matched
          go run ./cmd/watcher-setup \
            --bundle-out fixture-out/matched \
            --rust-out ../../programs/watcher-protocol/src

      - name: Validate generated bundle and round-trip proofs
        working-directory: circuits/withdraw
        env:
          WATCHER_PROVER_ASSETS: fixture-out/matched
        run: |
          go test -run TestExportedProverBundleRoundTrip -v
          python - <<'PY'
          import json, pathlib
          root = pathlib.Path('fixture-out/matched')
          manifest = json.loads((root / 'manifest.json').read_text())
          assert manifest['deposit_public_inputs'] == 6
          assert manifest['withdraw_public_inputs'] == 13
          for name in ('deposit.r1cs','deposit.pk','deposit.vk','withdraw.r1cs','withdraw.pk','withdraw.vk'):
              assert (root / name).stat().st_size > 0
          assert (root / 'sample-deposit-0-proof.bin').stat().st_size == 256
          assert (root / 'sample-deposit-0-public-inputs.bin').stat().st_size == 192
          assert (root / 'sample-withdraw-proof.bin').stat().st_size == 256
          assert (root / 'sample-withdraw-public-inputs.bin').stat().st_size == 416
          PY

      - name: Test the exact generated Rust verifier fixtures
        working-directory: programs/watcher-protocol
        run: |
          cargo fmt --check
          cargo test --all-targets

      - name: Build local prover binary and manifest
        working-directory: circuits/withdraw
        run: |
          go build -trimpath -o fixture-out/matched/watcher-prover-linux-amd64 ./cmd/watcher-prover
          python - <<'PY'
          import hashlib, json, os, pathlib
          root = pathlib.Path('fixture-out/matched')
          names = ['deposit.r1cs','deposit.pk','deposit.vk','withdraw.r1cs','withdraw.pk','withdraw.vk','watcher-prover-linux-amd64']
          files = {}
          for name in names:
              data = (root / name).read_bytes()
              files[name] = {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
          manifest = {
              'version': 2,
              'curve': 'BN254',
              'scheme': 'Groth16',
              'sourceCommit': os.environ.get('GITHUB_SHA',''),
              'publicInputs': {'deposit-v1': 6, 'withdraw-v1': 13},
              'warning': 'DEVELOPMENT SETUP ONLY. Do not use with production funds.',
              'files': files,
          }
          (root / 'prover-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
          PY

      - name: Publish matched verifier arrays
        if: github.event_name == 'push'
        run: |
          git config user.name 'github-actions[bot]'
          git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
          git add programs/watcher-protocol/src/dev_*_array.in programs/watcher-protocol/src/development_prover_manifest.json circuits/withdraw/go.sum
          if git diff --cached --quiet; then
            echo 'Matched arrays unchanged.'
          else
            git commit -m 'Sync proof-carried root transition fixtures [skip circuit]'
            git pull --rebase origin watcher-protocol
            git push origin HEAD:watcher-protocol
          fi

      - name: Upload matched local prover bundle
        uses: actions/upload-artifact@v4
        with:
          name: watcher-local-prover-v1-dev
          path: |
            circuits/withdraw/fixture-out/matched/deposit.r1cs
            circuits/withdraw/fixture-out/matched/deposit.pk
            circuits/withdraw/fixture-out/matched/deposit.vk
            circuits/withdraw/fixture-out/matched/withdraw.r1cs
            circuits/withdraw/fixture-out/matched/withdraw.pk
            circuits/withdraw/fixture-out/matched/withdraw.vk
            circuits/withdraw/fixture-out/matched/watcher-prover-linux-amd64
            circuits/withdraw/fixture-out/matched/prover-manifest.json
          if-no-files-found: error
          retention-days: 7
''')

print("Applied proof-carried append transitions to circuits, client, and Solana program.")
