package withdraw

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark-crypto/ecc/bn254/fr"
	"github.com/consensys/gnark/backend/groth16"
	bn254groth16 "github.com/consensys/gnark/backend/groth16/bn254"
	backendwitness "github.com/consensys/gnark/backend/witness"
	"github.com/consensys/gnark/constraint"
	"github.com/consensys/gnark/frontend"
)

const (
	XarkProofBytesV1           = 256
	DepositPublicInputBytesV1  = 6 * 32
	WithdrawPublicInputBytesV1 = 13 * 32
)

var errTrailingJSON = errors.New("request contains trailing JSON data")

type decimalV1 string

func (value *decimalV1) UnmarshalJSON(raw []byte) error {
	text := strings.TrimSpace(string(raw))
	if text == "" || text == "null" {
		return errors.New("decimal value is required")
	}
	if strings.HasPrefix(text, "\"") {
		var decoded string
		if err := json.Unmarshal(raw, &decoded); err != nil {
			return err
		}
		text = decoded
	}
	if text == "" {
		return errors.New("decimal value is empty")
	}
	for _, character := range text {
		if character < '0' || character > '9' {
			return fmt.Errorf("invalid unsigned decimal %q", text)
		}
	}
	*value = decimalV1(text)
	return nil
}

func (value decimalV1) bigInt(label string) (*big.Int, error) {
	parsed, ok := new(big.Int).SetString(string(value), 10)
	if !ok {
		return nil, fmt.Errorf("%s is not a decimal integer", label)
	}
	return parsed, nil
}

func parseFieldV1(value decimalV1, label string, nonZero bool) (*big.Int, error) {
	parsed, err := value.bigInt(label)
	if err != nil {
		return nil, err
	}
	if parsed.Sign() < 0 || parsed.Cmp(ecc.BN254.ScalarField()) >= 0 {
		return nil, fmt.Errorf("%s is not a canonical BN254 scalar", label)
	}
	if nonZero && parsed.Sign() == 0 {
		return nil, fmt.Errorf("%s must be non-zero", label)
	}
	return parsed, nil
}

func parseU64V1(value decimalV1, label string, nonZero bool) (*big.Int, error) {
	parsed, err := value.bigInt(label)
	if err != nil {
		return nil, err
	}
	if parsed.Sign() < 0 || parsed.BitLen() > 64 {
		return nil, fmt.Errorf("%s must fit in an unsigned 64-bit integer", label)
	}
	if nonZero && parsed.Sign() == 0 {
		return nil, fmt.Errorf("%s must be non-zero", label)
	}
	return parsed, nil
}

func decodeStrictJSONV1(data []byte, destination any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return errTrailingJSON
		}
		return err
	}
	return nil
}

type depositWitnessJSONV1 struct {
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
	if err != nil {
		return DepositCircuitV1{}, err
	}
	nonce, err := parseFieldV1(encoded.Nonce, "Nonce", true)
	if err != nil {
		return DepositCircuitV1{}, err
	}
	path, err := parsePathV1(encoded.Path, "Path")
	if err != nil {
		return DepositCircuitV1{}, err
	}
	index, err := parseIndexV1(encoded.Index, "Index")
	if err != nil {
		return DepositCircuitV1{}, err
	}
	commitment, err := parseFieldV1(encoded.Commitment, "Commitment", true)
	if err != nil {
		return DepositCircuitV1{}, err
	}
	amount, err := parseU64V1(encoded.Amount, "Amount", true)
	if err != nil {
		return DepositCircuitV1{}, err
	}
	assetID, err := parseFieldV1(encoded.AssetID, "AssetID", true)
	if err != nil {
		return DepositCircuitV1{}, err
	}
	oldRoot, err := parseFieldV1(encoded.OldRoot, "OldRoot", false)
	if err != nil {
		return DepositCircuitV1{}, err
	}
	newRoot, err := parseFieldV1(encoded.NewRoot, "NewRoot", true)
	if err != nil {
		return DepositCircuitV1{}, err
	}
	leafIndex, err := parseU64V1(encoded.LeafIndex, "LeafIndex", false)
	if err != nil {
		return DepositCircuitV1{}, err
	}
	return DepositCircuitV1{
		Owner: owner, Nonce: nonce, Path: path, Index: index,
		Commitment: commitment, Amount: amount, AssetID: assetID,
		OldRoot: oldRoot, NewRoot: newRoot, LeafIndex: leafIndex,
	}, nil
}

type withdrawWitnessJSONV1 struct {
	Input0Amount decimalV1   `json:"Input0Amount"`
	Input0Owner  decimalV1   `json:"Input0Owner"`
	Input0Nonce  decimalV1   `json:"Input0Nonce"`
	Input0Path   []decimalV1 `json:"Input0Path"`
	Input0Index  []uint8     `json:"Input0Index"`

	Input1Amount decimalV1   `json:"Input1Amount"`
	Input1Owner  decimalV1   `json:"Input1Owner"`
	Input1Nonce  decimalV1   `json:"Input1Nonce"`
	Input1Path   []decimalV1 `json:"Input1Path"`
	Input1Index  []uint8     `json:"Input1Index"`

	ChangeAmount decimalV1   `json:"ChangeAmount"`
	ChangeOwner  decimalV1   `json:"ChangeOwner"`
	ChangeNonce  decimalV1   `json:"ChangeNonce"`
	ChangePath   []decimalV1 `json:"ChangePath"`
	ChangeIndex  []uint8     `json:"ChangeIndex"`

	MerkleRoot       decimalV1 `json:"MerkleRoot"`
	Nullifier0       decimalV1 `json:"Nullifier0"`
	Nullifier1       decimalV1 `json:"Nullifier1"`
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

func parsePathV1(values []decimalV1, label string) ([MerkleDepthV1]frontend.Variable, error) {
	var output [MerkleDepthV1]frontend.Variable
	if len(values) != MerkleDepthV1 {
		return output, fmt.Errorf("%s must contain exactly %d siblings", label, MerkleDepthV1)
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

func parseIndexV1(values []uint8, label string) ([MerkleDepthV1]frontend.Variable, error) {
	var output [MerkleDepthV1]frontend.Variable
	if len(values) != MerkleDepthV1 {
		return output, fmt.Errorf("%s must contain exactly %d bits", label, MerkleDepthV1)
	}
	for index, value := range values {
		if value > 1 {
			return output, fmt.Errorf("%s[%d] must be 0 or 1", label, index)
		}
		output[index] = value
	}
	return output, nil
}

func withdrawAssignmentFromJSONV1(data []byte) (CircuitV1, error) {
	var encoded withdrawWitnessJSONV1
	if err := decodeStrictJSONV1(data, &encoded); err != nil {
		return CircuitV1{}, fmt.Errorf("decode withdrawal witness: %w", err)
	}
	input0Amount, err := parseU64V1(encoded.Input0Amount, "Input0Amount", true)
	if err != nil {
		return CircuitV1{}, err
	}
	input0Owner, err := parseFieldV1(encoded.Input0Owner, "Input0Owner", true)
	if err != nil {
		return CircuitV1{}, err
	}
	input0Nonce, err := parseFieldV1(encoded.Input0Nonce, "Input0Nonce", true)
	if err != nil {
		return CircuitV1{}, err
	}
	input0Path, err := parsePathV1(encoded.Input0Path, "Input0Path")
	if err != nil {
		return CircuitV1{}, err
	}
	input0Index, err := parseIndexV1(encoded.Input0Index, "Input0Index")
	if err != nil {
		return CircuitV1{}, err
	}

	input1Amount, err := parseU64V1(encoded.Input1Amount, "Input1Amount", true)
	if err != nil {
		return CircuitV1{}, err
	}
	input1Owner, err := parseFieldV1(encoded.Input1Owner, "Input1Owner", true)
	if err != nil {
		return CircuitV1{}, err
	}
	input1Nonce, err := parseFieldV1(encoded.Input1Nonce, "Input1Nonce", true)
	if err != nil {
		return CircuitV1{}, err
	}
	input1Path, err := parsePathV1(encoded.Input1Path, "Input1Path")
	if err != nil {
		return CircuitV1{}, err
	}
	input1Index, err := parseIndexV1(encoded.Input1Index, "Input1Index")
	if err != nil {
		return CircuitV1{}, err
	}

	changeAmount, err := parseU64V1(encoded.ChangeAmount, "ChangeAmount", false)
	if err != nil {
		return CircuitV1{}, err
	}
	changeOwner, err := parseFieldV1(encoded.ChangeOwner, "ChangeOwner", true)
	if err != nil {
		return CircuitV1{}, err
	}
	changeNonce, err := parseFieldV1(encoded.ChangeNonce, "ChangeNonce", true)
	if err != nil {
		return CircuitV1{}, err
	}
	changePath, err := parsePathV1(encoded.ChangePath, "ChangePath")
	if err != nil {
		return CircuitV1{}, err
	}
	changeIndex, err := parseIndexV1(encoded.ChangeIndex, "ChangeIndex")
	if err != nil {
		return CircuitV1{}, err
	}

	merkleRoot, err := parseFieldV1(encoded.MerkleRoot, "MerkleRoot", true)
	if err != nil {
		return CircuitV1{}, err
	}
	nullifier0, err := parseFieldV1(encoded.Nullifier0, "Nullifier0", true)
	if err != nil {
		return CircuitV1{}, err
	}
	nullifier1, err := parseFieldV1(encoded.Nullifier1, "Nullifier1", true)
	if err != nil {
		return CircuitV1{}, err
	}
	changeCommitment, err := parseFieldV1(encoded.ChangeCommitment, "ChangeCommitment", true)
	if err != nil {
		return CircuitV1{}, err
	}
	publicAmount, err := parseU64V1(encoded.PublicAmount, "PublicAmount", true)
	if err != nil {
		return CircuitV1{}, err
	}
	protocolFee, err := parseU64V1(encoded.ProtocolFee, "ProtocolFee", false)
	if err != nil {
		return CircuitV1{}, err
	}
	relayerFee, err := parseU64V1(encoded.RelayerFee, "RelayerFee", false)
	if err != nil {
		return CircuitV1{}, err
	}
	recipientBinding, err := parseFieldV1(encoded.RecipientBinding, "RecipientBinding", true)
	if err != nil {
		return CircuitV1{}, err
	}
	assetID, err := parseFieldV1(encoded.AssetID, "AssetID", true)
	if err != nil {
		return CircuitV1{}, err
	}
	contextBinding, err := parseFieldV1(encoded.ContextBinding, "ContextBinding", true)
	if err != nil {
		return CircuitV1{}, err
	}
	currentRoot, err := parseFieldV1(encoded.CurrentRoot, "CurrentRoot", true)
	if err != nil {
		return CircuitV1{}, err
	}
	newMerkleRoot, err := parseFieldV1(encoded.NewMerkleRoot, "NewMerkleRoot", true)
	if err != nil {
		return CircuitV1{}, err
	}
	changeLeafIndex, err := parseU64V1(encoded.ChangeLeafIndex, "ChangeLeafIndex", false)
	if err != nil {
		return CircuitV1{}, err
	}

	return CircuitV1{
		Input0Amount: input0Amount, Input0Owner: input0Owner, Input0Nonce: input0Nonce,
		Input0Path: input0Path, Input0Index: input0Index,
		Input1Amount: input1Amount, Input1Owner: input1Owner, Input1Nonce: input1Nonce,
		Input1Path: input1Path, Input1Index: input1Index,
		ChangeAmount: changeAmount, ChangeOwner: changeOwner, ChangeNonce: changeNonce,
		ChangePath: changePath, ChangeIndex: changeIndex,
		MerkleRoot: merkleRoot, Nullifier0: nullifier0, Nullifier1: nullifier1,
		ChangeCommitment: changeCommitment, PublicAmount: publicAmount,
		ProtocolFee: protocolFee, RelayerFee: relayerFee,
		RecipientBinding: recipientBinding, AssetID: assetID, ContextBinding: contextBinding,
		CurrentRoot: currentRoot, NewMerkleRoot: newMerkleRoot, ChangeLeafIndex: changeLeafIndex,
	}, nil
}

type ProverBundleV1 struct {
	DepositCS  constraint.ConstraintSystem
	DepositPK  groth16.ProvingKey
	DepositVK  groth16.VerifyingKey
	WithdrawCS constraint.ConstraintSystem
	WithdrawPK groth16.ProvingKey
	WithdrawVK groth16.VerifyingKey
	Digest     string
	mutex      sync.Mutex
}

type ProofResponseV1 struct {
	Circuit          string `json:"circuit"`
	ProofHex         string `json:"proofHex"`
	PublicInputsHex  string `json:"publicInputsHex"`
	ProofBytes       int    `json:"proofBytes"`
	PublicInputBytes int    `json:"publicInputBytes"`
	BundleDigest     string `json:"bundleDigest"`
}

const proverBundleArtifactNamesV1 = "deposit.r1cs,deposit.pk,deposit.vk,withdraw.r1cs,withdraw.pk,withdraw.vk"

func proverBundleNamesV1() []string {
	return strings.Split(proverBundleArtifactNamesV1, ",")
}

func requiredArtifactV1(artifacts map[string][]byte, name string) ([]byte, error) {
	value, ok := artifacts[name]
	if !ok || len(value) == 0 {
		return nil, fmt.Errorf("prover bundle artifact %s is missing or empty", name)
	}
	return value, nil
}

func readArtifactBytesV1(data []byte, destination io.ReaderFrom) error {
	_, err := destination.ReadFrom(bytes.NewReader(data))
	return err
}

func bundleDigestBytesV1(artifacts map[string][]byte) (string, error) {
	hasher := sha256.New()
	for _, name := range proverBundleNamesV1() {
		data, err := requiredArtifactV1(artifacts, name)
		if err != nil {
			return "", err
		}
		_, _ = hasher.Write([]byte(name))
		_, _ = hasher.Write([]byte{0})
		_, _ = hasher.Write(data)
	}
	return hex.EncodeToString(hasher.Sum(nil)), nil
}

func loadCircuitArtifactsBytesV1(
	artifacts map[string][]byte,
	prefix string,
) (constraint.ConstraintSystem, groth16.ProvingKey, groth16.VerifyingKey, error) {
	ccs := groth16.NewCS(ecc.BN254)
	provingKey := groth16.NewProvingKey(ecc.BN254)
	verifyingKey := groth16.NewVerifyingKey(ecc.BN254)

	r1cs, err := requiredArtifactV1(artifacts, prefix+".r1cs")
	if err != nil {
		return nil, nil, nil, err
	}
	if err := readArtifactBytesV1(r1cs, ccs); err != nil {
		return nil, nil, nil, fmt.Errorf("load %s r1cs: %w", prefix, err)
	}
	pk, err := requiredArtifactV1(artifacts, prefix+".pk")
	if err != nil {
		return nil, nil, nil, err
	}
	if err := readArtifactBytesV1(pk, provingKey); err != nil {
		return nil, nil, nil, fmt.Errorf("load %s proving key: %w", prefix, err)
	}
	vk, err := requiredArtifactV1(artifacts, prefix+".vk")
	if err != nil {
		return nil, nil, nil, err
	}
	if err := readArtifactBytesV1(vk, verifyingKey); err != nil {
		return nil, nil, nil, fmt.Errorf("load %s verifying key: %w", prefix, err)
	}
	return ccs, provingKey, verifyingKey, nil
}

// LoadProverBundleBytesV1 loads the matched development bundle entirely from
// memory. The browser WebAssembly entrypoint uses this path so private witness
// data never leaves the user's device and no virtual filesystem is required.
func LoadProverBundleBytesV1(artifacts map[string][]byte) (*ProverBundleV1, error) {
	depositCS, depositPK, depositVK, err := loadCircuitArtifactsBytesV1(artifacts, "deposit")
	if err != nil {
		return nil, err
	}
	withdrawCS, withdrawPK, withdrawVK, err := loadCircuitArtifactsBytesV1(artifacts, "withdraw")
	if err != nil {
		return nil, err
	}
	if depositVK.NbPublicWitness() != 6 {
		return nil, fmt.Errorf("deposit verifying key expects %d public inputs, want 6", depositVK.NbPublicWitness())
	}
	if withdrawVK.NbPublicWitness() != 13 {
		return nil, fmt.Errorf("withdraw verifying key expects %d public inputs, want 13", withdrawVK.NbPublicWitness())
	}
	digest, err := bundleDigestBytesV1(artifacts)
	if err != nil {
		return nil, fmt.Errorf("hash prover bundle: %w", err)
	}
	return &ProverBundleV1{
		DepositCS: depositCS, DepositPK: depositPK, DepositVK: depositVK,
		WithdrawCS: withdrawCS, WithdrawPK: withdrawPK, WithdrawVK: withdrawVK,
		Digest: digest,
	}, nil
}

func LoadProverBundleV1(directory string) (*ProverBundleV1, error) {
	artifacts := make(map[string][]byte, 6)
	for _, name := range proverBundleNamesV1() {
		data, err := os.ReadFile(filepath.Join(directory, name))
		if err != nil {
			return nil, fmt.Errorf("read prover bundle artifact %s: %w", name, err)
		}
		artifacts[name] = data
	}
	return LoadProverBundleBytesV1(artifacts)
}

func appendCoordinateLittleEndianV1(destination []byte, value interface{ Bytes() [32]byte }) []byte {
	encoded := value.Bytes()
	for index := len(encoded) - 1; index >= 0; index-- {
		destination = append(destination, encoded[index])
	}
	return destination
}

// XarkWireProofV1 converts gnark's BN254 proof into the exact 256-byte layout
// consumed by xark-verifier: little-endian coordinates with proof A negated.
func XarkWireProofV1(proof groth16.Proof) ([]byte, error) {
	bnProof, ok := proof.(*bn254groth16.Proof)
	if !ok {
		return nil, fmt.Errorf("unexpected proof type %T", proof)
	}
	negativeAY := bnProof.Ar.Y
	negativeAY.Neg(&negativeAY)
	output := make([]byte, 0, XarkProofBytesV1)
	output = appendCoordinateLittleEndianV1(output, &bnProof.Ar.X)
	output = appendCoordinateLittleEndianV1(output, &negativeAY)
	output = appendCoordinateLittleEndianV1(output, &bnProof.Bs.X.A0)
	output = appendCoordinateLittleEndianV1(output, &bnProof.Bs.X.A1)
	output = appendCoordinateLittleEndianV1(output, &bnProof.Bs.Y.A0)
	output = appendCoordinateLittleEndianV1(output, &bnProof.Bs.Y.A1)
	output = appendCoordinateLittleEndianV1(output, &bnProof.Krs.X)
	output = appendCoordinateLittleEndianV1(output, &bnProof.Krs.Y)
	if len(output) != XarkProofBytesV1 {
		return nil, fmt.Errorf("xark proof length is %d, want %d", len(output), XarkProofBytesV1)
	}
	return output, nil
}

func XarkPublicWitnessV1(publicWitness backendwitness.Witness) ([]byte, error) {
	vector, ok := publicWitness.Vector().(fr.Vector)
	if !ok {
		return nil, fmt.Errorf("unexpected public witness vector type %T", publicWitness.Vector())
	}
	output := make([]byte, 0, len(vector)*32)
	for index := range vector {
		output = appendCoordinateLittleEndianV1(output, &vector[index])
	}
	return output, nil
}

func proveAssignmentV1(
	circuit string,
	ccs constraint.ConstraintSystem,
	provingKey groth16.ProvingKey,
	verifyingKey groth16.VerifyingKey,
	assignment frontend.Circuit,
	bundleDigest string,
) (ProofResponseV1, error) {
	fullWitness, err := frontend.NewWitness(assignment, ecc.BN254.ScalarField())
	if err != nil {
		return ProofResponseV1{}, fmt.Errorf("build %s witness: %w", circuit, err)
	}
	publicWitness, err := fullWitness.Public()
	if err != nil {
		return ProofResponseV1{}, fmt.Errorf("extract %s public witness: %w", circuit, err)
	}
	proof, err := groth16.Prove(ccs, provingKey, fullWitness)
	if err != nil {
		return ProofResponseV1{}, fmt.Errorf("prove %s: %w", circuit, err)
	}
	if err := groth16.Verify(proof, verifyingKey, publicWitness); err != nil {
		return ProofResponseV1{}, fmt.Errorf("self-verify %s proof: %w", circuit, err)
	}
	wireProof, err := XarkWireProofV1(proof)
	if err != nil {
		return ProofResponseV1{}, err
	}
	publicInputs, err := XarkPublicWitnessV1(publicWitness)
	if err != nil {
		return ProofResponseV1{}, err
	}
	return ProofResponseV1{
		Circuit:          circuit,
		ProofHex:         hex.EncodeToString(wireProof),
		PublicInputsHex:  hex.EncodeToString(publicInputs),
		ProofBytes:       len(wireProof),
		PublicInputBytes: len(publicInputs),
		BundleDigest:     bundleDigest,
	}, nil
}

func (bundle *ProverBundleV1) ProveDepositJSON(data []byte) (ProofResponseV1, error) {
	assignment, err := depositAssignmentFromJSONV1(data)
	if err != nil {
		return ProofResponseV1{}, err
	}
	bundle.mutex.Lock()
	defer bundle.mutex.Unlock()
	response, err := proveAssignmentV1("deposit-v1", bundle.DepositCS, bundle.DepositPK, bundle.DepositVK, &assignment, bundle.Digest)
	if err != nil {
		return ProofResponseV1{}, err
	}
	if response.PublicInputBytes != DepositPublicInputBytesV1 {
		return ProofResponseV1{}, fmt.Errorf("deposit public input length is %d, want %d", response.PublicInputBytes, DepositPublicInputBytesV1)
	}
	return response, nil
}

func (bundle *ProverBundleV1) ProveWithdrawJSON(data []byte) (ProofResponseV1, error) {
	assignment, err := withdrawAssignmentFromJSONV1(data)
	if err != nil {
		return ProofResponseV1{}, err
	}
	bundle.mutex.Lock()
	defer bundle.mutex.Unlock()
	response, err := proveAssignmentV1("withdraw-v1", bundle.WithdrawCS, bundle.WithdrawPK, bundle.WithdrawVK, &assignment, bundle.Digest)
	if err != nil {
		return ProofResponseV1{}, err
	}
	if response.PublicInputBytes != WithdrawPublicInputBytesV1 {
		return ProofResponseV1{}, fmt.Errorf("withdraw public input length is %d, want %d", response.PublicInputBytes, WithdrawPublicInputBytesV1)
	}
	return response, nil
}
