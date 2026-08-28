package withdraw

import (
	"fmt"
	"math/big"
	"sync"

	"github.com/consensys/gnark/backend/groth16"
	"github.com/consensys/gnark/constraint"
	"github.com/consensys/gnark/frontend"
)

const (
	DepositPublicInputBytesV2  = 8 * 32
	WithdrawPublicInputBytesV2 = 19 * 32
)

type depositWitnessJSONV2 struct {
	Owner          decimalV1   `json:"Owner"`
	Nonce          decimalV1   `json:"Nonce"`
	Path           []decimalV1 `json:"Path"`
	Index          []uint8     `json:"Index"`
	Commitment     decimalV1   `json:"Commitment"`
	Amount         decimalV1   `json:"Amount"`
	AssetID        decimalV1   `json:"AssetID"`
	Epoch          decimalV1   `json:"Epoch"`
	ContextBinding decimalV1   `json:"ContextBinding"`
	OldRoot        decimalV1   `json:"OldRoot"`
	NewRoot        decimalV1   `json:"NewRoot"`
	LeafIndex      decimalV1   `json:"LeafIndex"`
}

func parsePathV2(values []decimalV1, label string) ([MerkleDepthV2]frontend.Variable, error) {
	var output [MerkleDepthV2]frontend.Variable
	if len(values) != MerkleDepthV2 {
		return output, fmt.Errorf("%s must contain exactly %d siblings", label, MerkleDepthV2)
	}
	for index, value := range values {
		parsed, err := parseFieldV1(value, fmt.Sprintf("%s[%d]", label, index), false)
		if err != nil {
			return output, err
		}
		output[index] = parsed
	}
	return output, nil
}

func parseIndexV2(values []uint8, label string) ([MerkleDepthV2]frontend.Variable, error) {
	var output [MerkleDepthV2]frontend.Variable
	if len(values) != MerkleDepthV2 {
		return output, fmt.Errorf("%s must contain exactly %d bits", label, MerkleDepthV2)
	}
	for index, value := range values {
		if value > 1 {
			return output, fmt.Errorf("%s[%d] must be 0 or 1", label, index)
		}
		output[index] = value
	}
	return output, nil
}

func parseBoolV2(value uint8, label string) (frontend.Variable, error) {
	if value > 1 {
		return nil, fmt.Errorf("%s must be 0 or 1", label)
	}
	return value, nil
}

func depositAssignmentFromJSONV2(data []byte) (DepositCircuitV2, error) {
	var encoded depositWitnessJSONV2
	if err := decodeStrictJSONV1(data, &encoded); err != nil {
		return DepositCircuitV2{}, fmt.Errorf("decode V2 deposit witness: %w", err)
	}
	owner, err := parseFieldV1(encoded.Owner, "Owner", true)
	if err != nil {
		return DepositCircuitV2{}, err
	}
	nonce, err := parseFieldV1(encoded.Nonce, "Nonce", true)
	if err != nil {
		return DepositCircuitV2{}, err
	}
	path, err := parsePathV2(encoded.Path, "Path")
	if err != nil {
		return DepositCircuitV2{}, err
	}
	index, err := parseIndexV2(encoded.Index, "Index")
	if err != nil {
		return DepositCircuitV2{}, err
	}
	commitment, err := parseFieldV1(encoded.Commitment, "Commitment", true)
	if err != nil {
		return DepositCircuitV2{}, err
	}
	amount, err := parseU64V1(encoded.Amount, "Amount", true)
	if err != nil {
		return DepositCircuitV2{}, err
	}
	assetID, err := parseFieldV1(encoded.AssetID, "AssetID", true)
	if err != nil {
		return DepositCircuitV2{}, err
	}
	epoch, err := parseU64V1(encoded.Epoch, "Epoch", false)
	if err != nil {
		return DepositCircuitV2{}, err
	}
	contextBinding, err := parseFieldV1(encoded.ContextBinding, "ContextBinding", true)
	if err != nil {
		return DepositCircuitV2{}, err
	}
	oldRoot, err := parseFieldV1(encoded.OldRoot, "OldRoot", false)
	if err != nil {
		return DepositCircuitV2{}, err
	}
	newRoot, err := parseFieldV1(encoded.NewRoot, "NewRoot", true)
	if err != nil {
		return DepositCircuitV2{}, err
	}
	leafIndex, err := parseU64V1(encoded.LeafIndex, "LeafIndex", false)
	if err != nil {
		return DepositCircuitV2{}, err
	}
	return DepositCircuitV2{
		Owner: owner, Nonce: nonce, Path: path, Index: index,
		Commitment: commitment, Amount: amount, AssetID: assetID,
		Epoch: epoch, ContextBinding: contextBinding, OldRoot: oldRoot,
		NewRoot: newRoot, LeafIndex: leafIndex,
	}, nil
}

type inputWitnessJSONV2 struct {
	Enabled   uint8       `json:"Enabled"`
	Amount    decimalV1   `json:"Amount"`
	Owner     decimalV1   `json:"Owner"`
	Nonce     decimalV1   `json:"Nonce"`
	Path      []decimalV1 `json:"Path"`
	Index     []uint8     `json:"Index"`
	Root      decimalV1   `json:"Root"`
	Nullifier decimalV1   `json:"Nullifier"`
}

type changeWitnessJSONV2 struct {
	Enabled uint8       `json:"Enabled"`
	Amount  decimalV1   `json:"Amount"`
	Owner   decimalV1   `json:"Owner"`
	Nonce   decimalV1   `json:"Nonce"`
	Path    []decimalV1 `json:"Path"`
	Index   []uint8     `json:"Index"`
}

type withdrawWitnessJSONV2 struct {
	Inputs []inputWitnessJSONV2 `json:"Inputs"`
	Change changeWitnessJSONV2  `json:"Change"`

	InputCount       decimalV1 `json:"InputCount"`
	ChangeCommitment decimalV1 `json:"ChangeCommitment"`
	PublicAmount     decimalV1 `json:"PublicAmount"`
	ProtocolFee      decimalV1 `json:"ProtocolFee"`
	RelayerFee       decimalV1 `json:"RelayerFee"`
	RecipientBinding decimalV1 `json:"RecipientBinding"`
	AssetID          decimalV1 `json:"AssetID"`
	ContextBinding   decimalV1 `json:"ContextBinding"`
	CurrentRoot      decimalV1 `json:"CurrentRoot"`
	NewMerkleRoot    decimalV1 `json:"NewMerkleRoot"`
	ChangeLeafIndex  decimalV1 `json:"ChangeLeafIndex"`
}

func zeroBig() *big.Int { return new(big.Int) }

func withdrawAssignmentFromJSONV2(data []byte) (CircuitV2, error) {
	var encoded withdrawWitnessJSONV2
	if err := decodeStrictJSONV1(data, &encoded); err != nil {
		return CircuitV2{}, fmt.Errorf("decode V2 withdrawal witness: %w", err)
	}
	if len(encoded.Inputs) != MaxInputsV2 {
		return CircuitV2{}, fmt.Errorf("Inputs must contain exactly %d slots", MaxInputsV2)
	}

	var assignment CircuitV2
	for index, input := range encoded.Inputs {
		enabled, err := parseBoolV2(input.Enabled, fmt.Sprintf("Inputs[%d].Enabled", index))
		if err != nil {
			return CircuitV2{}, err
		}
		amount, err := parseU64V1(input.Amount, fmt.Sprintf("Inputs[%d].Amount", index), input.Enabled == 1)
		if err != nil {
			return CircuitV2{}, err
		}
		owner, err := parseFieldV1(input.Owner, fmt.Sprintf("Inputs[%d].Owner", index), input.Enabled == 1)
		if err != nil {
			return CircuitV2{}, err
		}
		nonce, err := parseFieldV1(input.Nonce, fmt.Sprintf("Inputs[%d].Nonce", index), input.Enabled == 1)
		if err != nil {
			return CircuitV2{}, err
		}
		path, err := parsePathV2(input.Path, fmt.Sprintf("Inputs[%d].Path", index))
		if err != nil {
			return CircuitV2{}, err
		}
		bits, err := parseIndexV2(input.Index, fmt.Sprintf("Inputs[%d].Index", index))
		if err != nil {
			return CircuitV2{}, err
		}
		root, err := parseFieldV1(input.Root, fmt.Sprintf("Inputs[%d].Root", index), input.Enabled == 1)
		if err != nil {
			return CircuitV2{}, err
		}
		nullifier, err := parseFieldV1(input.Nullifier, fmt.Sprintf("Inputs[%d].Nullifier", index), input.Enabled == 1)
		if err != nil {
			return CircuitV2{}, err
		}
		if input.Enabled == 0 && (amount.Sign() != 0 || owner.Sign() != 0 || nonce.Sign() != 0 || root.Sign() != 0 || nullifier.Sign() != 0) {
			return CircuitV2{}, fmt.Errorf("Inputs[%d] disabled slot must use zero amount/owner/nonce/root/nullifier", index)
		}
		assignment.InputEnabled[index] = enabled
		assignment.InputAmount[index] = amount
		assignment.InputOwner[index] = owner
		assignment.InputNonce[index] = nonce
		assignment.InputPath[index] = path
		assignment.InputIndex[index] = bits
		assignment.InputRoots[index] = root
		assignment.Nullifiers[index] = nullifier
	}

	changeEnabled, err := parseBoolV2(encoded.Change.Enabled, "Change.Enabled")
	if err != nil {
		return CircuitV2{}, err
	}
	changeAmount, err := parseU64V1(encoded.Change.Amount, "Change.Amount", encoded.Change.Enabled == 1)
	if err != nil {
		return CircuitV2{}, err
	}
	changeOwner, err := parseFieldV1(encoded.Change.Owner, "Change.Owner", encoded.Change.Enabled == 1)
	if err != nil {
		return CircuitV2{}, err
	}
	changeNonce, err := parseFieldV1(encoded.Change.Nonce, "Change.Nonce", encoded.Change.Enabled == 1)
	if err != nil {
		return CircuitV2{}, err
	}
	changePath, err := parsePathV2(encoded.Change.Path, "Change.Path")
	if err != nil {
		return CircuitV2{}, err
	}
	changeIndex, err := parseIndexV2(encoded.Change.Index, "Change.Index")
	if err != nil {
		return CircuitV2{}, err
	}
	if encoded.Change.Enabled == 0 && (changeAmount.Sign() != 0 || changeOwner.Sign() != 0 || changeNonce.Sign() != 0) {
		return CircuitV2{}, fmt.Errorf("disabled Change must use zero amount/owner/nonce")
	}

	inputCount, err := parseU64V1(encoded.InputCount, "InputCount", true)
	if err != nil || inputCount.Uint64() > MaxInputsV2 {
		if err != nil {
			return CircuitV2{}, err
		}
		return CircuitV2{}, fmt.Errorf("InputCount must be between 1 and %d", MaxInputsV2)
	}
	changeCommitment, err := parseFieldV1(encoded.ChangeCommitment, "ChangeCommitment", encoded.Change.Enabled == 1)
	if err != nil {
		return CircuitV2{}, err
	}
	publicAmount, err := parseU64V1(encoded.PublicAmount, "PublicAmount", true)
	if err != nil {
		return CircuitV2{}, err
	}
	protocolFee, err := parseU64V1(encoded.ProtocolFee, "ProtocolFee", false)
	if err != nil {
		return CircuitV2{}, err
	}
	relayerFee, err := parseU64V1(encoded.RelayerFee, "RelayerFee", false)
	if err != nil {
		return CircuitV2{}, err
	}
	recipientBinding, err := parseFieldV1(encoded.RecipientBinding, "RecipientBinding", true)
	if err != nil {
		return CircuitV2{}, err
	}
	assetID, err := parseFieldV1(encoded.AssetID, "AssetID", true)
	if err != nil {
		return CircuitV2{}, err
	}
	contextBinding, err := parseFieldV1(encoded.ContextBinding, "ContextBinding", true)
	if err != nil {
		return CircuitV2{}, err
	}
	currentRoot, err := parseFieldV1(encoded.CurrentRoot, "CurrentRoot", encoded.Change.Enabled == 1)
	if err != nil {
		return CircuitV2{}, err
	}
	newMerkleRoot, err := parseFieldV1(encoded.NewMerkleRoot, "NewMerkleRoot", encoded.Change.Enabled == 1)
	if err != nil {
		return CircuitV2{}, err
	}
	changeLeafIndex, err := parseU64V1(encoded.ChangeLeafIndex, "ChangeLeafIndex", false)
	if err != nil {
		return CircuitV2{}, err
	}
	if encoded.Change.Enabled == 0 && (changeCommitment.Sign() != 0 || currentRoot.Sign() != 0 || newMerkleRoot.Sign() != 0 || changeLeafIndex.Sign() != 0) {
		return CircuitV2{}, fmt.Errorf("exact withdrawal append fields must use zero sentinels")
	}

	assignment.ChangeEnabled = changeEnabled
	assignment.ChangeAmount = changeAmount
	assignment.ChangeOwner = changeOwner
	assignment.ChangeNonce = changeNonce
	assignment.ChangePath = changePath
	assignment.ChangeIndex = changeIndex
	assignment.InputCount = inputCount
	assignment.ChangeCommitment = changeCommitment
	assignment.PublicAmount = publicAmount
	assignment.ProtocolFee = protocolFee
	assignment.RelayerFee = relayerFee
	assignment.RecipientBinding = recipientBinding
	assignment.AssetID = assetID
	assignment.ContextBinding = contextBinding
	assignment.CurrentRoot = currentRoot
	assignment.NewMerkleRoot = newMerkleRoot
	assignment.ChangeLeafIndex = changeLeafIndex
	return assignment, nil
}

type ProverBundleV2 struct {
	DepositCS  constraint.ConstraintSystem
	DepositPK  groth16.ProvingKey
	DepositVK  groth16.VerifyingKey
	WithdrawCS constraint.ConstraintSystem
	WithdrawPK groth16.ProvingKey
	WithdrawVK groth16.VerifyingKey
	Digest     string
	mutex      sync.Mutex
}

func LoadProverBundleBytesV2(artifacts map[string][]byte) (*ProverBundleV2, error) {
	depositCS, depositPK, depositVK, err := loadCircuitArtifactsBytesV1(artifacts, "deposit")
	if err != nil {
		return nil, err
	}
	withdrawCS, withdrawPK, withdrawVK, err := loadCircuitArtifactsBytesV1(artifacts, "withdraw")
	if err != nil {
		return nil, err
	}
	if depositVK.NbPublicWitness() != 8 {
		return nil, fmt.Errorf("V2 deposit verifying key expects %d public inputs, want 8", depositVK.NbPublicWitness())
	}
	if withdrawVK.NbPublicWitness() != 19 {
		return nil, fmt.Errorf("V2 withdraw verifying key expects %d public inputs, want 19", withdrawVK.NbPublicWitness())
	}
	digest, err := bundleDigestBytesV1(artifacts)
	if err != nil {
		return nil, fmt.Errorf("hash V2 prover bundle: %w", err)
	}
	return &ProverBundleV2{
		DepositCS: depositCS, DepositPK: depositPK, DepositVK: depositVK,
		WithdrawCS: withdrawCS, WithdrawPK: withdrawPK, WithdrawVK: withdrawVK,
		Digest: digest,
	}, nil
}

func LoadProverBundleV2(directory string) (*ProverBundleV2, error) {
	artifacts := make(map[string][]byte, len(proverBundleNamesV1()))
	for _, name := range proverBundleNamesV1() {
		data, err := os.ReadFile(filepath.Join(directory, name))
		if err != nil {
			return nil, fmt.Errorf("read V2 prover bundle artifact %s: %w", name, err)
		}
		artifacts[name] = data
	}
	return LoadProverBundleBytesV2(artifacts)
}

func (bundle *ProverBundleV2) ProveDepositJSON(data []byte) (ProofResponseV1, error) {
	assignment, err := depositAssignmentFromJSONV2(data)
	if err != nil {
		return ProofResponseV1{}, err
	}
	bundle.mutex.Lock()
	defer bundle.mutex.Unlock()
	response, err := proveAssignmentV1("deposit-v2", bundle.DepositCS, bundle.DepositPK, bundle.DepositVK, &assignment, bundle.Digest)
	if err != nil {
		return ProofResponseV1{}, err
	}
	if response.PublicInputBytes != DepositPublicInputBytesV2 {
		return ProofResponseV1{}, fmt.Errorf("V2 deposit public input length is %d, want %d", response.PublicInputBytes, DepositPublicInputBytesV2)
	}
	return response, nil
}

func (bundle *ProverBundleV2) ProveWithdrawJSON(data []byte) (ProofResponseV1, error) {
	assignment, err := withdrawAssignmentFromJSONV2(data)
	if err != nil {
		return ProofResponseV1{}, err
	}
	bundle.mutex.Lock()
	defer bundle.mutex.Unlock()
	response, err := proveAssignmentV1("withdraw-v2", bundle.WithdrawCS, bundle.WithdrawPK, bundle.WithdrawVK, &assignment, bundle.Digest)
	if err != nil {
		return ProofResponseV1{}, err
	}
	if response.PublicInputBytes != WithdrawPublicInputBytesV2 {
		return ProofResponseV1{}, fmt.Errorf("V2 withdraw public input length is %d, want %d", response.PublicInputBytes, WithdrawPublicInputBytesV2)
	}
	return response, nil
}

// Silence staticcheck false-positive in js/wasm builds when only zero values are
// needed while parsing disabled proof slots.
var _ = zeroBig
