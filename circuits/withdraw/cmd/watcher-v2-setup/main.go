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

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark-crypto/ecc/bn254/fr"
	nativemimc "github.com/consensys/gnark-crypto/ecc/bn254/fr/mimc"
	"github.com/consensys/gnark/backend/groth16"
	bn254groth16 "github.com/consensys/gnark/backend/groth16/bn254"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/frontend/cs/r1cs"

	withdraw "watcher.cash/circuits/withdraw"
)

const (
	domainNoteV1      = 91_001
	domainNullifierV1 = 91_002
	domainMerkleV1    = 91_003
)

type manifest struct {
	Version              int               `json:"version"`
	Curve                string            `json:"curve"`
	Scheme               string            `json:"scheme"`
	MerkleDepth          int               `json:"merkleDepth"`
	MaxInputs            int               `json:"maxInputs"`
	DepositPublicInputs  int               `json:"depositPublicInputs"`
	WithdrawPublicInputs int               `json:"withdrawPublicInputs"`
	Files                map[string]string `json:"filesSha256"`
	Warning              string            `json:"warning"`
}

type circuitArtifacts struct {
	r1cs         []byte
	pk           []byte
	vk           []byte
	vkWire       []byte
	proofWire    []byte
	publicInputs []byte
}

type byteBuffer struct{ bytes []byte }

func (buffer *byteBuffer) Write(value []byte) (int, error) {
	buffer.bytes = append(buffer.bytes, value...)
	return len(value), nil
}

func writeToBytes(writer io.WriterTo) []byte {
	var buffer byteBuffer
	if _, err := writer.WriteTo(&buffer); err != nil {
		panic(err)
	}
	return buffer.bytes
}

func appendLE(output []byte, encoded [32]byte) []byte {
	for left, right := 0, len(encoded)-1; left < right; left, right = left+1, right-1 {
		encoded[left], encoded[right] = encoded[right], encoded[left]
	}
	return append(output, encoded[:]...)
}

func xarkVerifyingKey(verifyingKey groth16.VerifyingKey) ([]byte, error) {
	value, ok := verifyingKey.(*bn254groth16.VerifyingKey)
	if !ok {
		return nil, fmt.Errorf("unexpected verifying key type %T", verifyingKey)
	}
	output := make([]byte, 0, 64*(len(value.G1.K)+7))
	output = appendLE(output, value.G1.Alpha.X.Bytes())
	output = appendLE(output, value.G1.Alpha.Y.Bytes())
	for _, point := range []struct{ x0, x1, y0, y1 [32]byte }{
		{value.G2.Beta.X.A0.Bytes(), value.G2.Beta.X.A1.Bytes(), value.G2.Beta.Y.A0.Bytes(), value.G2.Beta.Y.A1.Bytes()},
		{value.G2.Gamma.X.A0.Bytes(), value.G2.Gamma.X.A1.Bytes(), value.G2.Gamma.Y.A0.Bytes(), value.G2.Gamma.Y.A1.Bytes()},
		{value.G2.Delta.X.A0.Bytes(), value.G2.Delta.X.A1.Bytes(), value.G2.Delta.Y.A0.Bytes(), value.G2.Delta.Y.A1.Bytes()},
	} {
		output = appendLE(output, point.x0)
		output = appendLE(output, point.x1)
		output = appendLE(output, point.y0)
		output = appendLE(output, point.y1)
	}
	for index := range value.G1.K {
		output = appendLE(output, value.G1.K[index].X.Bytes())
		output = appendLE(output, value.G1.K[index].Y.Bytes())
	}
	return output, nil
}

func hashNative(values ...*big.Int) *big.Int {
	h := nativemimc.NewMiMC()
	for _, value := range values {
		var element fr.Element
		element.SetBigInt(value)
		encoded := element.Bytes()
		if _, err := h.Write(encoded[:]); err != nil {
			panic(err)
		}
	}
	return new(big.Int).SetBytes(h.Sum(nil))
}

func note(asset, amount, owner, nonce *big.Int) *big.Int {
	return hashNative(big.NewInt(domainNoteV1), asset, amount, owner, nonce)
}

func nullifier(owner, nonce, commitment *big.Int) *big.Int {
	return hashNative(big.NewInt(domainNullifierV1), owner, nonce, commitment)
}

func parent(left, right *big.Int) *big.Int {
	return hashNative(big.NewInt(domainMerkleV1), left, right)
}

func zeroHashes() []*big.Int {
	zeros := make([]*big.Int, withdraw.MerkleDepthV2+1)
	zeros[0] = new(big.Int)
	for depth := 0; depth < withdraw.MerkleDepthV2; depth++ {
		zeros[depth+1] = parent(zeros[depth], zeros[depth])
	}
	return zeros
}

func firstLeafPath() ([withdraw.MerkleDepthV2]frontend.Variable, [withdraw.MerkleDepthV2]frontend.Variable) {
	zeros := zeroHashes()
	var path [withdraw.MerkleDepthV2]frontend.Variable
	var bits [withdraw.MerkleDepthV2]frontend.Variable
	for depth := 0; depth < withdraw.MerkleDepthV2; depth++ {
		path[depth] = new(big.Int).Set(zeros[depth])
		bits[depth] = 0
	}
	return path, bits
}

func rootForFirstLeaf(leaf *big.Int) *big.Int {
	zeros := zeroHashes()
	current := new(big.Int).Set(leaf)
	for depth := 0; depth < withdraw.MerkleDepthV2; depth++ {
		current = parent(current, zeros[depth])
	}
	return current
}

func sampleDeposit() withdraw.DepositCircuitV2 {
	asset := big.NewInt(1)
	amount := big.NewInt(8_000_000)
	owner := big.NewInt(1111)
	nonce := big.NewInt(2222)
	commitment := note(asset, amount, owner, nonce)
	path, bits := firstLeafPath()
	return withdraw.DepositCircuitV2{
		Owner: owner,
		Nonce: nonce,
		Path: path,
		Index: bits,
		Commitment: commitment,
		Amount: amount,
		AssetID: asset,
		Epoch: 0,
		ContextBinding: 777,
		OldRoot: 0,
		NewRoot: rootForFirstLeaf(commitment),
		LeafIndex: 0,
	}
}

func sampleWithdraw() withdraw.CircuitV2 {
	asset := big.NewInt(1)
	amount := big.NewInt(8_000_000)
	owner := big.NewInt(1111)
	nonce := big.NewInt(2222)
	commitment := note(asset, amount, owner, nonce)
	path, bits := firstLeafPath()
	root := rootForFirstLeaf(commitment)

	var value withdraw.CircuitV2
	value.InputEnabled[0] = 1
	value.InputAmount[0] = amount
	value.InputOwner[0] = owner
	value.InputNonce[0] = nonce
	value.InputPath[0] = path
	value.InputIndex[0] = bits
	value.InputRoots[0] = root
	value.Nullifiers[0] = nullifier(owner, nonce, commitment)
	for index := 1; index < withdraw.MaxInputsV2; index++ {
		value.InputEnabled[index] = 0
		value.InputAmount[index] = 0
		value.InputOwner[index] = 0
		value.InputNonce[index] = 0
		value.InputRoots[index] = 0
		value.Nullifiers[index] = 0
		for depth := 0; depth < withdraw.MerkleDepthV2; depth++ {
			value.InputPath[index][depth] = 0
			value.InputIndex[index][depth] = 0
		}
	}
	value.ChangeEnabled = 0
	value.ChangeAmount = 0
	value.ChangeOwner = 0
	value.ChangeNonce = 0
	for depth := 0; depth < withdraw.MerkleDepthV2; depth++ {
		value.ChangePath[depth] = 0
		value.ChangeIndex[depth] = 0
	}
	value.InputCount = 1
	value.ChangeCommitment = 0
	value.PublicAmount = 7_999_000
	value.ProtocolFee = 0
	value.RelayerFee = 1_000
	value.RecipientBinding = 888
	value.AssetID = asset
	value.ContextBinding = 999
	value.CurrentRoot = 0
	value.NewMerkleRoot = 0
	value.ChangeLeafIndex = 0
	return value
}

func build(circuit frontend.Circuit, assignment frontend.Circuit, expectedPublicInputs int) (circuitArtifacts, error) {
	ccs, err := frontend.Compile(ecc.BN254.ScalarField(), r1cs.NewBuilder, circuit)
	if err != nil {
		return circuitArtifacts{}, err
	}
	pk, vk, err := groth16.Setup(ccs)
	if err != nil {
		return circuitArtifacts{}, err
	}
	if vk.NbPublicWitness() != expectedPublicInputs {
		return circuitArtifacts{}, fmt.Errorf("verifying key public input count is %d, want %d", vk.NbPublicWitness(), expectedPublicInputs)
	}
	fullWitness, err := frontend.NewWitness(assignment, ecc.BN254.ScalarField())
	if err != nil {
		return circuitArtifacts{}, err
	}
	publicWitness, err := fullWitness.Public()
	if err != nil {
		return circuitArtifacts{}, err
	}
	proof, err := groth16.Prove(ccs, pk, fullWitness)
	if err != nil {
		return circuitArtifacts{}, err
	}
	if err := groth16.Verify(proof, vk, publicWitness); err != nil {
		return circuitArtifacts{}, fmt.Errorf("self-verify sample proof: %w", err)
	}
	proofWire, err := withdraw.XarkWireProofV1(proof)
	if err != nil {
		return circuitArtifacts{}, err
	}
	publicWire, err := withdraw.XarkPublicWitnessV1(publicWitness)
	if err != nil {
		return circuitArtifacts{}, err
	}
	vkWire, err := xarkVerifyingKey(vk)
	if err != nil {
		return circuitArtifacts{}, err
	}
	return circuitArtifacts{
		r1cs: writeToBytes(ccs),
		pk: writeToBytes(pk),
		vk: writeToBytes(vk),
		vkWire: vkWire,
		proofWire: proofWire,
		publicInputs: publicWire,
	}, nil
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
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
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

func sha(value []byte) string {
	digest := sha256.Sum256(value)
	return hex.EncodeToString(digest[:])
}

func main() {
	bundleOut := flag.String("bundle-out", "fixture-out/v2", "V2 prover bundle output directory")
	rustOut := flag.String("rust-out", "", "optional V2 Rust source directory for generated verifier fixtures")
	flag.Parse()
	if *bundleOut == "" {
		panic("--bundle-out must not be empty")
	}

	deposit, err := build(&withdraw.DepositCircuitV2{}, &[]withdraw.DepositCircuitV2{sampleDeposit()}[0], 8)
	if err != nil {
		panic(err)
	}
	withdrawalSample := sampleWithdraw()
	withdrawal, err := build(&withdraw.CircuitV2{}, &withdrawalSample, 19)
	if err != nil {
		panic(err)
	}
	if len(deposit.vkWire) != 1024 || len(withdrawal.vkWire) != 1728 {
		panic(errors.New("unexpected V2 verifying-key wire length"))
	}
	if len(deposit.proofWire) != 256 || len(withdrawal.proofWire) != 256 {
		panic(errors.New("unexpected V2 proof wire length"))
	}
	if len(deposit.publicInputs) != 256 || len(withdrawal.publicInputs) != 608 {
		panic(errors.New("unexpected V2 public-input wire length"))
	}

	files := map[string][]byte{
		"deposit.r1cs": deposit.r1cs,
		"deposit.pk": deposit.pk,
		"deposit.vk": deposit.vk,
		"withdraw.r1cs": withdrawal.r1cs,
		"withdraw.pk": withdrawal.pk,
		"withdraw.vk": withdrawal.vk,
		"sample-deposit-proof.xark": deposit.proofWire,
		"sample-deposit-public.xark": deposit.publicInputs,
		"sample-withdraw-proof.xark": withdrawal.proofWire,
		"sample-withdraw-public.xark": withdrawal.publicInputs,
	}
	for name, data := range files {
		if err := writeAtomic(filepath.Join(*bundleOut, name), data, 0o600); err != nil {
			panic(err)
		}
	}

	metadata := manifest{
		Version: 2,
		Curve: "BN254",
		Scheme: "Groth16",
		MerkleDepth: withdraw.MerkleDepthV2,
		MaxInputs: withdraw.MaxInputsV2,
		DepositPublicInputs: 8,
		WithdrawPublicInputs: 19,
		Files: map[string]string{},
		Warning: "DEVELOPMENT SINGLE-PARTY SETUP ONLY. Never use this bundle with production funds.",
	}
	for name, data := range files {
		metadata.Files[name] = sha(data)
	}
	manifestBytes, err := json.MarshalIndent(metadata, "", "  ")
	if err != nil {
		panic(err)
	}
	manifestBytes = append(manifestBytes, '\n')
	if err := writeAtomic(filepath.Join(*bundleOut, "manifest.json"), manifestBytes, 0o600); err != nil {
		panic(err)
	}

	if *rustOut != "" {
		rustFiles := map[string][]byte{
			"dev_deposit_vk_array.in": rustArray(deposit.vkWire),
			"dev_withdraw_vk_array.in": rustArray(withdrawal.vkWire),
			"dev_deposit_proof_array.in": rustArray(deposit.proofWire),
			"dev_deposit_public_inputs_array.in": rustArray(deposit.publicInputs),
			"dev_withdraw_proof_array.in": rustArray(withdrawal.proofWire),
			"dev_withdraw_public_inputs_array.in": rustArray(withdrawal.publicInputs),
		}
		for name, data := range rustFiles {
			if err := writeAtomic(filepath.Join(*rustOut, name), data, 0o644); err != nil {
				panic(err)
			}
		}
		programManifest := map[string]any{
			"version": 2,
			"depositVkSha256": sha(deposit.vkWire),
			"withdrawVkSha256": sha(withdrawal.vkWire),
			"warning": metadata.Warning,
		}
		encoded, err := json.MarshalIndent(programManifest, "", "  ")
		if err != nil {
			panic(err)
		}
		encoded = append(encoded, '\n')
		if err := writeAtomic(filepath.Join(*rustOut, "development_prover_manifest_v2.json"), encoded, 0o644); err != nil {
			panic(err)
		}
	}

	fmt.Printf("generated matched V2 Groth16 bundle at %s\n", *bundleOut)
}
