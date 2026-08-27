package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"os"
	"path/filepath"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark-crypto/ecc/bn254/fr"
	nativemimc "github.com/consensys/gnark-crypto/ecc/bn254/fr/mimc"
	"github.com/consensys/gnark/backend/groth16"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/frontend/cs/r1cs"

	withdraw "watcher.cash/circuits/withdraw"
)

const (
	domainNote      = 91001
	domainNullifier = 91002
	domainMerkle    = 91003
	depth           = withdraw.MerkleDepthV1
)

var fixtureVaultPubkey = []byte{
	0x2b, 0x33, 0xe5, 0x98, 0xef, 0xa1, 0xe8, 0x79,
	0x99, 0xf0, 0x53, 0xa3, 0xee, 0xc6, 0x1a, 0x80,
	0xb8, 0x74, 0xda, 0x7f, 0x60, 0x85, 0xa0, 0xa1,
	0x98, 0xda, 0x89, 0xea, 0xe5, 0x47, 0x71, 0xfe,
}

func bi(value int64) *big.Int { return big.NewInt(value) }

func hash(values ...*big.Int) *big.Int {
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
	return hash(bi(domainNote), asset, amount, owner, nonce)
}

func nullifier(owner, nonce, commitment *big.Int) *big.Int {
	return hash(bi(domainNullifier), owner, nonce, commitment)
}

func parent(left, right *big.Int) *big.Int {
	return hash(bi(domainMerkle), left, right)
}

func fixed32(value byte) []byte {
	out := make([]byte, 32)
	for index := range out {
		out[index] = value
	}
	return out
}

func hashBytesToRustField(domain string, values ...[]byte) *big.Int {
	h := sha256.New()
	_, _ = h.Write([]byte(domain))
	for _, value := range values {
		_, _ = h.Write(value)
	}
	digest := h.Sum(nil)
	digest[31] &= 0x1f
	for left, right := 0, len(digest)-1; left < right; left, right = left+1, right-1 {
		digest[left], digest[right] = digest[right], digest[left]
	}
	return new(big.Int).SetBytes(digest)
}

func recipientBinding() *big.Int {
	return hashBytesToRustField("watcher-recipient-v1", fixed32(7))
}

func withdrawContextBinding() *big.Int {
	asset := make([]byte, 32)
	asset[0] = 1
	return hashBytesToRustField(
		"watcher-withdraw-context-v1",
		fixed32(42),
		fixed32(43),
		fixtureVaultPubkey,
		fixed32(44),
		fixed32(45),
		asset,
	)
}

type tree struct {
	levels [][]*big.Int
}

func makeTree(leaves []*big.Int) tree {
	levels := make([][]*big.Int, depth+1)
	levels[0] = leaves
	for treeDepth := 0; treeDepth < depth; treeDepth++ {
		next := make([]*big.Int, len(levels[treeDepth])/2)
		for index := range next {
			next[index] = parent(levels[treeDepth][2*index], levels[treeDepth][2*index+1])
		}
		levels[treeDepth+1] = next
	}
	return tree{levels: levels}
}

func (value tree) proof(index int) ([depth]frontend.Variable, [depth]frontend.Variable) {
	var path [depth]frontend.Variable
	var bits [depth]frontend.Variable
	position := index
	for treeDepth := 0; treeDepth < depth; treeDepth++ {
		if position%2 == 0 {
			path[treeDepth] = new(big.Int).Set(value.levels[treeDepth][position+1])
			bits[treeDepth] = 0
		} else {
			path[treeDepth] = new(big.Int).Set(value.levels[treeDepth][position-1])
			bits[treeDepth] = 1
		}
		position /= 2
	}
	return path, bits
}

func field32(value *big.Int) [32]byte {
	var element fr.Element
	element.SetBigInt(value)
	return element.Bytes()
}

func write(path string, value []byte) {
	if err := os.WriteFile(path, value, 0o644); err != nil {
		panic(err)
	}
}

type manifest struct {
	Curve                string   `json:"curve"`
	Scheme               string   `json:"scheme"`
	Circuit              string   `json:"circuit"`
	Warning              string   `json:"warning"`
	ProofRawBytes        int      `json:"proof_raw_bytes"`
	VerifyingKeyRawBytes int      `json:"verifying_key_raw_bytes"`
	PublicWitnessBytes   int      `json:"public_witness_bytes"`
	PublicInputCount     int      `json:"public_input_count"`
	PublicInputOrder     []string `json:"public_input_order"`
	ProofFormatNote      string   `json:"proof_format_note"`
	PublicHex            string   `json:"public_inputs_hex"`
}

func main() {
	asset := bi(1)
	amount0, owner0, nonce0 := bi(8_000_000), bi(1111), bi(2222)
	amount1, owner1, nonce1 := bi(3_000_000), bi(3333), bi(4444)
	commitment0 := note(asset, amount0, owner0, nonce0)
	commitment1 := note(asset, amount1, owner1, nonce1)
	leaves := make([]*big.Int, 1<<depth)
	for index := range leaves {
		leaves[index] = new(big.Int)
	}
	leaves[0] = commitment0
	leaves[1] = commitment1
	merkleTree := makeTree(leaves)
	path0, bits0 := merkleTree.proof(0)
	path1, bits1 := merkleTree.proof(1)

	changeAmount, changeOwner, changeNonce := bi(6_000_000), bi(5555), bi(6666)
	changeCommitment := note(asset, changeAmount, changeOwner, changeNonce)
	assignment := withdraw.CircuitV1{
		Input0Amount: amount0, Input0Owner: owner0, Input0Nonce: nonce0, Input0Path: path0, Input0Index: bits0,
		Input1Amount: amount1, Input1Owner: owner1, Input1Nonce: nonce1, Input1Path: path1, Input1Index: bits1,
		ChangeAmount: changeAmount, ChangeOwner: changeOwner, ChangeNonce: changeNonce,
		MerkleRoot: merkleTree.levels[depth][0], Nullifier0: nullifier(owner0, nonce0, commitment0), Nullifier1: nullifier(owner1, nonce1, commitment1),
		ChangeCommitment: changeCommitment, PublicAmount: 4_000_000, ProtocolFee: 0, RelayerFee: 1_000_000,
		RecipientBinding: recipientBinding(), AssetID: 1, ContextBinding: withdrawContextBinding(),
	}

	ccs, err := frontend.Compile(ecc.BN254.ScalarField(), r1cs.NewBuilder, &withdraw.CircuitV1{})
	if err != nil {
		panic(err)
	}
	provingKey, verifyingKey, err := groth16.Setup(ccs)
	if err != nil {
		panic(err)
	}
	witness, err := frontend.NewWitness(&assignment, ecc.BN254.ScalarField())
	if err != nil {
		panic(err)
	}
	publicWitness, err := witness.Public()
	if err != nil {
		panic(err)
	}
	proof, err := groth16.Prove(ccs, provingKey, witness)
	if err != nil {
		panic(err)
	}
	if err := groth16.Verify(proof, verifyingKey, publicWitness); err != nil {
		panic(err)
	}

	var proofBuffer, vkBuffer bytes.Buffer
	if _, err := proof.WriteRawTo(&proofBuffer); err != nil {
		panic(err)
	}
	if _, err := verifyingKey.WriteRawTo(&vkBuffer); err != nil {
		panic(err)
	}

	ordered := []*big.Int{
		merkleTree.levels[depth][0],
		nullifier(owner0, nonce0, commitment0),
		nullifier(owner1, nonce1, commitment1),
		changeCommitment,
		bi(4_000_000),
		bi(0),
		bi(1_000_000),
		recipientBinding(),
		bi(1),
		withdrawContextBinding(),
	}
	publicRaw := make([]byte, 0, 32*len(ordered))
	for _, value := range ordered {
		encoded := field32(value)
		publicRaw = append(publicRaw, encoded[:]...)
	}

	outputDirectory := "testdata/v1_fixture"
	if err := os.MkdirAll(outputDirectory, 0o755); err != nil {
		panic(err)
	}
	write(filepath.Join(outputDirectory, "proof.raw"), proofBuffer.Bytes())
	write(filepath.Join(outputDirectory, "vk.raw"), vkBuffer.Bytes())
	write(filepath.Join(outputDirectory, "public_inputs.bin"), publicRaw)

	result := manifest{
		Curve: "BN254", Scheme: "Groth16", Circuit: "Watcher CircuitV1",
		Warning: "DEVELOPMENT FIXTURE ONLY. groth16.Setup here is not a production ceremony.",
		ProofRawBytes: proofBuffer.Len(), VerifyingKeyRawBytes: vkBuffer.Len(), PublicWitnessBytes: len(publicRaw), PublicInputCount: 10,
		PublicInputOrder: []string{"MerkleRoot", "Nullifier0", "Nullifier1", "ChangeCommitment", "PublicAmount", "ProtocolFee", "RelayerFee", "RecipientBinding", "AssetID", "ContextBinding"},
		ProofFormatNote: "gnark Proof.WriteRawTo output; exact point layout must be decoded before Solana verifier use",
		PublicHex:       hex.EncodeToString(publicRaw),
	}
	encodedManifest, _ := json.MarshalIndent(result, "", "  ")
	write(filepath.Join(outputDirectory, "manifest.json"), append(encodedManifest, '\n'))
	fmt.Printf("generated fixture: proof=%d vk=%d public=%d\n", proofBuffer.Len(), vkBuffer.Len(), len(publicRaw))
}
