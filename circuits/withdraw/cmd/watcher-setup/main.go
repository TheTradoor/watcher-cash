package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math/big"
	"os"
	"path/filepath"
	"sort"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark-crypto/ecc/bn254/fr"
	nativemimc "github.com/consensys/gnark-crypto/ecc/bn254/fr/mimc"
	"github.com/consensys/gnark/backend/groth16"
	bn254groth16 "github.com/consensys/gnark/backend/groth16/bn254"
	"github.com/consensys/gnark/backend/witness"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/frontend/cs/r1cs"

	withdraw "watcher.cash/circuits/withdraw"
)

const (
	domainNote      = 91_001
	domainNullifier = 91_002
	domainMerkle    = 91_003
)

var (
	baseFieldModulus = mustBigInt("21888242871839275222246405745257275088696311157297823662689037894645226208583")
	fixtureVault     = []byte{
		0x53, 0x00, 0x97, 0x5d, 0xd0, 0xc0, 0x7b, 0x8b,
		0xc9, 0x07, 0x1d, 0x94, 0xad, 0x6f, 0xcd, 0x4d,
		0x6e, 0x87, 0xb5, 0xf1, 0xef, 0x54, 0xe1, 0x8d,
		0xd9, 0x6f, 0x65, 0x42, 0xba, 0x55, 0x31, 0xf1,
	}
)

type treeV1 struct {
	levels [][]*big.Int
}

type bundleManifest struct {
	Version              int               `json:"version"`
	Curve                string            `json:"curve"`
	Scheme               string            `json:"scheme"`
	Gnark                string            `json:"gnark"`
	MerkleDepth          int               `json:"merkle_depth"`
	DepositPublicInputs  int               `json:"deposit_public_inputs"`
	WithdrawPublicInputs int               `json:"withdraw_public_inputs"`
	Files                map[string]string `json:"files_sha256"`
	Warning              string            `json:"warning"`
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "watcher-setup:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	flags := flag.NewFlagSet("watcher-setup", flag.ContinueOnError)
	bundleOutput := flags.String("bundle-out", "fixture-out/prover-bundle", "output directory for proving keys and fixtures")
	rustOutput := flags.String("rust-out", "", "optional watcher program src directory for generated verifier arrays")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *bundleOutput == "" {
		return errors.New("--bundle-out must not be empty")
	}
	if err := os.MkdirAll(*bundleOutput, 0o700); err != nil {
		return err
	}
	if *rustOutput != "" {
		if err := os.MkdirAll(*rustOutput, 0o755); err != nil {
			return err
		}
	}

	fixture := makeFixture()
	withdrawal, err := buildWithdrawalSetup(fixture)
	if err != nil {
		return err
	}
	deposits, err := buildDepositSetup(fixture)
	if err != nil {
		return err
	}

	files := map[string][]byte{
		"withdraw.r1cs":                      withdrawal.constraintSystem,
		"withdraw.pk":                        withdrawal.provingKey,
		"withdraw.vk":                        withdrawal.verifyingKey,
		"sample-withdraw-witness.json":       withdrawal.witnessJSON,
		"sample-withdraw-proof.bin":          withdrawal.proof,
		"sample-withdraw-public-inputs.bin":  withdrawal.publicInputs,
		"deposit.r1cs":                       deposits.constraintSystem,
		"deposit.pk":                         deposits.provingKey,
		"deposit.vk":                         deposits.verifyingKey,
		"sample-deposit-0-witness.json":      deposits.witness0JSON,
		"sample-deposit-0-proof.bin":         deposits.proof0,
		"sample-deposit-0-public-inputs.bin": deposits.publicInputs0,
		"sample-deposit-1-witness.json":      deposits.witness1JSON,
		"sample-deposit-1-proof.bin":         deposits.proof1,
		"sample-deposit-1-public-inputs.bin": deposits.publicInputs1,
	}
	for name, value := range files {
		if err := writeAtomic(filepath.Join(*bundleOutput, name), value, 0o600); err != nil {
			return err
		}
	}

	manifest := bundleManifest{
		Version:              1,
		Curve:                "BN254",
		Scheme:               "Groth16",
		Gnark:                "v0.14.x",
		MerkleDepth:          withdraw.MerkleDepthV1,
		DepositPublicInputs:  6,
		WithdrawPublicInputs: 13,
		Files:                make(map[string]string, len(files)),
		Warning:              "DEVELOPMENT SINGLE-PARTY SETUP ONLY. Never use this bundle with production funds.",
	}
	for name, value := range files {
		manifest.Files[name] = sha256Hex(value)
	}
	manifestBytes, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return err
	}
	manifestBytes = append(manifestBytes, '\n')
	if err := writeAtomic(filepath.Join(*bundleOutput, "manifest.json"), manifestBytes, 0o600); err != nil {
		return err
	}

	if *rustOutput != "" {
		rustFiles := map[string][]byte{
			"dev_vk_array.in":                      rustArray(withdrawal.verifierWire),
			"dev_proof_array.in":                   rustArray(withdrawal.proof),
			"dev_public_inputs_array.in":           rustArray(withdrawal.publicInputs),
			"dev_deposit_vk_array.in":              rustArray(deposits.verifierWire),
			"dev_deposit_proof_array.in":           rustArray(deposits.proof0),
			"dev_deposit_public_inputs_array.in":   rustArray(deposits.publicInputs0),
			"dev_deposit_proof_1_array.in":         rustArray(deposits.proof1),
			"dev_deposit_public_inputs_1_array.in": rustArray(deposits.publicInputs1),
		}
		for name, value := range rustFiles {
			if err := writeAtomic(filepath.Join(*rustOutput, name), value, 0o644); err != nil {
				return err
			}
		}
		programManifest := map[string]any{
			"version":                1,
			"bundle_manifest_sha256": sha256Hex(manifestBytes),
			"withdraw_vk_sha256":     sha256Hex(withdrawal.verifierWire),
			"deposit_vk_sha256":      sha256Hex(deposits.verifierWire),
			"warning":                manifest.Warning,
		}
		encoded, err := json.MarshalIndent(programManifest, "", "  ")
		if err != nil {
			return err
		}
		encoded = append(encoded, '\n')
		if err := writeAtomic(filepath.Join(*rustOutput, "development_prover_manifest.json"), encoded, 0o644); err != nil {
			return err
		}
	}

	fmt.Printf("generated matched development bundle at %s\n", *bundleOutput)
	return nil
}

type fixtureValues struct {
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
	for index := range leaves {
		leaves[index] = new(big.Int)
	}
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
		asset:   asset,
		amount0: amount0, owner0: owner0, nonce0: nonce0,
		amount1: amount1, owner1: owner1, nonce1: nonce1,
		commitment0: commitment0, commitment1: commitment1,
		changeAmount: changeAmount, changeOwner: changeOwner, changeNonce: changeNonce,
		changeCommitment: changeCommitment,
		treeAfter0:       treeAfter0, treeAfter1: treeAfter1, treeAfterChange: treeAfterChange,
		path0: path0, bits0: bits0, path1: path1, bits1: bits1,
		depositPath0: depositPath0, depositBits0: depositBits0,
		depositPath1: depositPath1, depositBits1: depositBits1,
		changePath: changePath, changeBits: changeBits,
	}
}

type setupResult struct {
	constraintSystem         []byte
	provingKey, verifyingKey []byte
	verifierWire             []byte
	proof, publicInputs      []byte
	witnessJSON              []byte
}

func buildWithdrawalSetup(fixture fixtureValues) (setupResult, error) {
	assignment := withdraw.CircuitV1{
		Input0Amount: fixture.amount0, Input0Owner: fixture.owner0, Input0Nonce: fixture.nonce0,
		Input0Path: fixture.path0, Input0Index: fixture.bits0,
		Input1Amount: fixture.amount1, Input1Owner: fixture.owner1, Input1Nonce: fixture.nonce1,
		Input1Path: fixture.path1, Input1Index: fixture.bits1,
		ChangeAmount: fixture.changeAmount, ChangeOwner: fixture.changeOwner, ChangeNonce: fixture.changeNonce,
		ChangePath: fixture.changePath, ChangeIndex: fixture.changeBits,
		MerkleRoot:       fixture.treeAfter1.root(),
		Nullifier0:       nullifier(fixture.owner0, fixture.nonce0, fixture.commitment0),
		Nullifier1:       nullifier(fixture.owner1, fixture.nonce1, fixture.commitment1),
		ChangeCommitment: fixture.changeCommitment,
		PublicAmount:     4_000_000, ProtocolFee: 0, RelayerFee: 1_000_000,
		RecipientBinding: recipientBinding(), AssetID: 1, ContextBinding: withdrawContextBinding(),
		CurrentRoot: fixture.treeAfter1.root(), NewMerkleRoot: fixture.treeAfterChange.root(), ChangeLeafIndex: 2,
	}
	ccs, err := frontend.Compile(ecc.BN254.ScalarField(), r1cs.NewBuilder, &withdraw.CircuitV1{})
	if err != nil {
		return setupResult{}, err
	}
	pk, vk, err := groth16.Setup(ccs)
	if err != nil {
		return setupResult{}, err
	}
	fullWitness, err := frontend.NewWitness(&assignment, ecc.BN254.ScalarField())
	if err != nil {
		return setupResult{}, err
	}
	publicWitness, err := fullWitness.Public()
	if err != nil {
		return setupResult{}, err
	}
	proof, err := groth16.Prove(ccs, pk, fullWitness)
	if err != nil {
		return setupResult{}, err
	}
	if err := groth16.Verify(proof, vk, publicWitness); err != nil {
		return setupResult{}, err
	}
	proofWire, err := xarkProof(proof)
	if err != nil {
		return setupResult{}, err
	}
	vkWire, err := xarkVerifyingKey(vk)
	if err != nil {
		return setupResult{}, err
	}
	publicWire, err := publicInputWire(publicWitness)
	if err != nil {
		return setupResult{}, err
	}
	if len(vkWire) != 1344 || len(publicWire) != 416 {
		return setupResult{}, errors.New("unexpected withdrawal wire length")
	}
	witnessJSON, err := json.MarshalIndent(withdrawWitnessMap(assignment), "", "  ")
	if err != nil {
		return setupResult{}, err
	}
	witnessJSON = append(witnessJSON, '\n')
	return setupResult{
		constraintSystem: writeToBytes(ccs),
		provingKey:       writeToBytes(pk), verifyingKey: writeToBytes(vk), verifierWire: vkWire,
		proof: proofWire, publicInputs: publicWire, witnessJSON: witnessJSON,
	}, nil
}

type depositSetupResult struct {
	constraintSystem           []byte
	provingKey, verifyingKey   []byte
	verifierWire               []byte
	proof0, publicInputs0      []byte
	proof1, publicInputs1      []byte
	witness0JSON, witness1JSON []byte
}

func buildDepositSetup(fixture fixtureValues) (depositSetupResult, error) {
	ccs, err := frontend.Compile(ecc.BN254.ScalarField(), r1cs.NewBuilder, &withdraw.DepositCircuitV1{})
	if err != nil {
		return depositSetupResult{}, err
	}
	pk, vk, err := groth16.Setup(ccs)
	if err != nil {
		return depositSetupResult{}, err
	}
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
		if err != nil {
			return depositSetupResult{}, err
		}
		publicWitness, err := fullWitness.Public()
		if err != nil {
			return depositSetupResult{}, err
		}
		proof, err := groth16.Prove(ccs, pk, fullWitness)
		if err != nil {
			return depositSetupResult{}, err
		}
		if err := groth16.Verify(proof, vk, publicWitness); err != nil {
			return depositSetupResult{}, err
		}
		proofs[index], err = xarkProof(proof)
		if err != nil {
			return depositSetupResult{}, err
		}
		publicInputs[index], err = publicInputWire(publicWitness)
		if err != nil {
			return depositSetupResult{}, err
		}
		witnessJSON[index], err = json.MarshalIndent(depositWitnessMap(assignments[index]), "", "  ")
		if err != nil {
			return depositSetupResult{}, err
		}
		witnessJSON[index] = append(witnessJSON[index], '\n')
	}
	vkWire, err := xarkVerifyingKey(vk)
	if err != nil {
		return depositSetupResult{}, err
	}
	if len(vkWire) != 896 || len(publicInputs[0]) != 192 || len(publicInputs[1]) != 192 {
		return depositSetupResult{}, errors.New("unexpected deposit wire length")
	}
	return depositSetupResult{
		constraintSystem: writeToBytes(ccs),
		provingKey:       writeToBytes(pk), verifyingKey: writeToBytes(vk), verifierWire: vkWire,
		proof0: proofs[0], publicInputs0: publicInputs[0], witness0JSON: witnessJSON[0],
		proof1: proofs[1], publicInputs1: publicInputs[1], witness1JSON: witnessJSON[1],
	}, nil
}

func writeToBytes(writer io.WriterTo) []byte {
	var buffer byteBuffer
	if _, err := writer.WriteTo(&buffer); err != nil {
		panic(err)
	}
	return buffer.bytes
}

type byteBuffer struct{ bytes []byte }

func (buffer *byteBuffer) Write(value []byte) (int, error) {
	buffer.bytes = append(buffer.bytes, value...)
	return len(value), nil
}

func xarkProof(proof groth16.Proof) ([]byte, error) {
	value, ok := proof.(*bn254groth16.Proof)
	if !ok {
		return nil, fmt.Errorf("unexpected proof type %T", proof)
	}
	output := make([]byte, 0, 256)
	appendLE := func(encoded [32]byte) {
		for left, right := 0, 31; left < right; left, right = left+1, right-1 {
			encoded[left], encoded[right] = encoded[right], encoded[left]
		}
		output = append(output, encoded[:]...)
	}
	appendLE(value.Ar.X.Bytes())
	y := value.Ar.Y.Bytes()
	yInt := new(big.Int).SetBytes(y[:])
	negative := new(big.Int).Sub(baseFieldModulus, yInt)
	negative.Mod(negative, baseFieldModulus)
	var negativeBytes [32]byte
	negative.FillBytes(negativeBytes[:])
	appendLE(negativeBytes)
	appendLE(value.Bs.X.A0.Bytes())
	appendLE(value.Bs.X.A1.Bytes())
	appendLE(value.Bs.Y.A0.Bytes())
	appendLE(value.Bs.Y.A1.Bytes())
	appendLE(value.Krs.X.Bytes())
	appendLE(value.Krs.Y.Bytes())
	return output, nil
}

func xarkVerifyingKey(verifyingKey groth16.VerifyingKey) ([]byte, error) {
	value, ok := verifyingKey.(*bn254groth16.VerifyingKey)
	if !ok {
		return nil, fmt.Errorf("unexpected verifying key type %T", verifyingKey)
	}
	output := make([]byte, 0, 64*(len(value.G1.K)+7))
	appendLE := func(encoded [32]byte) {
		for left, right := 0, 31; left < right; left, right = left+1, right-1 {
			encoded[left], encoded[right] = encoded[right], encoded[left]
		}
		output = append(output, encoded[:]...)
	}
	appendLE(value.G1.Alpha.X.Bytes())
	appendLE(value.G1.Alpha.Y.Bytes())
	for _, point := range []struct{ x0, x1, y0, y1 [32]byte }{
		{value.G2.Beta.X.A0.Bytes(), value.G2.Beta.X.A1.Bytes(), value.G2.Beta.Y.A0.Bytes(), value.G2.Beta.Y.A1.Bytes()},
		{value.G2.Gamma.X.A0.Bytes(), value.G2.Gamma.X.A1.Bytes(), value.G2.Gamma.Y.A0.Bytes(), value.G2.Gamma.Y.A1.Bytes()},
		{value.G2.Delta.X.A0.Bytes(), value.G2.Delta.X.A1.Bytes(), value.G2.Delta.Y.A0.Bytes(), value.G2.Delta.Y.A1.Bytes()},
	} {
		appendLE(point.x0)
		appendLE(point.x1)
		appendLE(point.y0)
		appendLE(point.y1)
	}
	for index := range value.G1.K {
		appendLE(value.G1.K[index].X.Bytes())
		appendLE(value.G1.K[index].Y.Bytes())
	}
	return output, nil
}

func publicInputWire(publicWitness witness.Witness) ([]byte, error) {
	vector, ok := publicWitness.Vector().(fr.Vector)
	if !ok {
		return nil, fmt.Errorf("unexpected public vector type %T", publicWitness.Vector())
	}
	output := make([]byte, 0, len(vector)*32)
	for index := range vector {
		encoded := vector[index].Bytes()
		for left, right := 0, 31; left < right; left, right = left+1, right-1 {
			encoded[left], encoded[right] = encoded[right], encoded[left]
		}
		output = append(output, encoded[:]...)
	}
	return output, nil
}

func hash(values ...*big.Int) *big.Int {
	hasher := nativemimc.NewMiMC()
	for _, value := range values {
		var element fr.Element
		element.SetBigInt(value)
		encoded := element.Bytes()
		if _, err := hasher.Write(encoded[:]); err != nil {
			panic(err)
		}
	}
	return new(big.Int).SetBytes(hasher.Sum(nil))
}

func note(asset, amount, owner, nonce *big.Int) *big.Int {
	return hash(big.NewInt(domainNote), asset, amount, owner, nonce)
}
func nullifier(owner, nonce, commitment *big.Int) *big.Int {
	return hash(big.NewInt(domainNullifier), owner, nonce, commitment)
}
func parent(left, right *big.Int) *big.Int { return hash(big.NewInt(domainMerkle), left, right) }

func makeTree(leaves []*big.Int) treeV1 {
	levels := make([][]*big.Int, withdraw.MerkleDepthV1+1)
	levels[0] = make([]*big.Int, len(leaves))
	for index := range leaves {
		levels[0][index] = new(big.Int).Set(leaves[index])
	}
	for depth := 0; depth < withdraw.MerkleDepthV1; depth++ {
		next := make([]*big.Int, len(levels[depth])/2)
		for index := range next {
			next[index] = parent(levels[depth][2*index], levels[depth][2*index+1])
		}
		levels[depth+1] = next
	}
	return treeV1{levels: levels}
}

func (tree treeV1) root() *big.Int { return new(big.Int).Set(tree.levels[withdraw.MerkleDepthV1][0]) }
func (tree treeV1) proof(index int) ([withdraw.MerkleDepthV1]frontend.Variable, [withdraw.MerkleDepthV1]frontend.Variable) {
	var path [withdraw.MerkleDepthV1]frontend.Variable
	var bits [withdraw.MerkleDepthV1]frontend.Variable
	position := index
	for depth := 0; depth < withdraw.MerkleDepthV1; depth++ {
		if position%2 == 0 {
			path[depth] = new(big.Int).Set(tree.levels[depth][position+1])
			bits[depth] = 0
		} else {
			path[depth] = new(big.Int).Set(tree.levels[depth][position-1])
			bits[depth] = 1
		}
		position /= 2
	}
	return path, bits
}

func fixed(value byte) []byte {
	output := make([]byte, 32)
	for index := range output {
		output[index] = value
	}
	return output
}
func hashBytesToField(domain string, values ...[]byte) *big.Int {
	hasher := sha256.New()
	_, _ = hasher.Write([]byte(domain))
	for _, value := range values {
		_, _ = hasher.Write(value)
	}
	digest := hasher.Sum(nil)
	digest[31] &= 0x1f
	for left, right := 0, 31; left < right; left, right = left+1, right-1 {
		digest[left], digest[right] = digest[right], digest[left]
	}
	return new(big.Int).SetBytes(digest)
}
func recipientBinding() *big.Int { return hashBytesToField("watcher-recipient-v1", fixed(7)) }
func withdrawContextBinding() *big.Int {
	asset := make([]byte, 32)
	asset[0] = 1
	return hashBytesToField("watcher-withdraw-context-v1", fixed(42), fixed(43), fixtureVault, fixed(44), fixed(45), asset)
}

func variableString(value frontend.Variable) string {
	switch typed := value.(type) {
	case *big.Int:
		return typed.String()
	case big.Int:
		return typed.String()
	case int:
		return fmt.Sprintf("%d", typed)
	case int64:
		return fmt.Sprintf("%d", typed)
	case uint64:
		return fmt.Sprintf("%d", typed)
	case string:
		return typed
	default:
		return fmt.Sprint(typed)
	}
}
func variableStrings(values [withdraw.MerkleDepthV1]frontend.Variable) []string {
	output := make([]string, len(values))
	for index := range values {
		output[index] = variableString(values[index])
	}
	return output
}
func withdrawWitnessMap(value withdraw.CircuitV1) map[string]any {
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
}

func rustArray(value []byte) []byte {
	output := make([]byte, 0, len(value)*5+4)
	output = append(output, '[')
	for index, current := range value {
		if index > 0 {
			output = append(output, ',')
		}
		output = append(output, fmt.Sprintf("0x%02x", current)...)
	}
	output = append(output, ']', '\n')
	return output
}

func writeAtomic(path string, value []byte, mode os.FileMode) error {
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, value, mode); err != nil {
		return err
	}
	if err := os.Rename(temporary, path); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	return nil
}
func sha256Hex(value []byte) string {
	digest := sha256.Sum256(value)
	return hex.EncodeToString(digest[:])
}
func mustBigInt(value string) *big.Int {
	result, ok := new(big.Int).SetString(value, 10)
	if !ok {
		panic(value)
	}
	return result
}

func sortedKeys(values map[string]string) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
