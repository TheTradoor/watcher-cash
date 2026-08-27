package withdraw

import (
	"crypto/sha256"
	"math/big"
	"testing"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark-crypto/ecc/bn254/fr"
	nativemimc "github.com/consensys/gnark-crypto/ecc/bn254/fr/mimc"
	"github.com/consensys/gnark/backend/groth16"
	"github.com/consensys/gnark/constraint"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/frontend/cs/r1cs"
)

func hashNativeV1(values ...*big.Int) *big.Int {
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

func bi(value int64) *big.Int { return big.NewInt(value) }

func noteNativeV1(asset, amount, owner, nonce *big.Int) *big.Int {
	return hashNativeV1(bi(domainNoteV1), asset, amount, owner, nonce)
}

func nullifierNativeV1(owner, nonce, commitment *big.Int) *big.Int {
	return hashNativeV1(bi(domainNullifierV1), owner, nonce, commitment)
}

func parentNativeV1(left, right *big.Int) *big.Int {
	return hashNativeV1(bi(domainMerkleV1), left, right)
}

func fixed32(value byte) []byte {
	out := make([]byte, 32)
	for index := range out {
		out[index] = value
	}
	return out
}

var fixtureVaultPubkey = []byte{
	0x2b, 0x33, 0xe5, 0x98, 0xef, 0xa1, 0xe8, 0x79,
	0x99, 0xf0, 0x53, 0xa3, 0xee, 0xc6, 0x1a, 0x80,
	0xb8, 0x74, 0xda, 0x7f, 0x60, 0x85, 0xa0, 0xa1,
	0x98, 0xda, 0x89, 0xea, 0xe5, 0x47, 0x71, 0xfe,
}

func hashBytesToRustFieldV1(domain string, values ...[]byte) *big.Int {
	h := sha256.New()
	_, _ = h.Write([]byte(domain))
	for _, value := range values {
		_, _ = h.Write(value)
	}
	digest := h.Sum(nil)
	// Rust/xark scalar bytes are little-endian. Masking the last byte constrains
	// the raw digest to 253 bits before reversing it for big.Int.
	digest[31] &= 0x1f
	for left, right := 0, len(digest)-1; left < right; left, right = left+1, right-1 {
		digest[left], digest[right] = digest[right], digest[left]
	}
	return new(big.Int).SetBytes(digest)
}

// Must match programs/watcher-protocol/src/public_inputs.rs recipient_binding_v1.
func fixtureRecipientBinding() *big.Int {
	return hashBytesToRustFieldV1("watcher-recipient-v1", fixed32(7))
}

// Must match programs/watcher-protocol/src/public_inputs.rs
// withdraw_context_binding_v1. The fixed keys are used only by the development
// custody fixture and program-test harness.
func fixtureWithdrawContextBinding() *big.Int {
	asset := make([]byte, 32)
	asset[0] = 1
	return hashBytesToRustFieldV1(
		"watcher-withdraw-context-v1",
		fixed32(42), // program id
		fixed32(43), // config account
		fixtureVaultPubkey,
		fixed32(44), // relayer account
		fixed32(45), // treasury account
		asset,
	)
}

type treeV1 struct {
	levels [][]*big.Int
}

func makeTreeV1(leaves []*big.Int) treeV1 {
	if len(leaves) != 1<<MerkleDepthV1 {
		panic("invalid leaf count")
	}
	levels := make([][]*big.Int, MerkleDepthV1+1)
	levels[0] = make([]*big.Int, len(leaves))
	for index, leaf := range leaves {
		levels[0][index] = new(big.Int).Set(leaf)
	}
	for depth := 0; depth < MerkleDepthV1; depth++ {
		next := make([]*big.Int, len(levels[depth])/2)
		for index := range next {
			next[index] = parentNativeV1(levels[depth][2*index], levels[depth][2*index+1])
		}
		levels[depth+1] = next
	}
	return treeV1{levels: levels}
}

func (tree treeV1) root() *big.Int {
	return new(big.Int).Set(tree.levels[MerkleDepthV1][0])
}

func (tree treeV1) proof(index int) ([MerkleDepthV1]frontend.Variable, [MerkleDepthV1]frontend.Variable) {
	var path [MerkleDepthV1]frontend.Variable
	var bits [MerkleDepthV1]frontend.Variable
	position := index
	for depth := 0; depth < MerkleDepthV1; depth++ {
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

func compileV1(t *testing.T) (constraint.ConstraintSystem, groth16.ProvingKey, groth16.VerifyingKey) {
	t.Helper()
	ccs, err := frontend.Compile(ecc.BN254.ScalarField(), r1cs.NewBuilder, &CircuitV1{})
	if err != nil {
		t.Fatal(err)
	}
	pk, vk, err := groth16.Setup(ccs)
	if err != nil {
		t.Fatal(err)
	}
	return ccs, pk, vk
}

func proveV1(t *testing.T, ccs constraint.ConstraintSystem, pk groth16.ProvingKey, assignment CircuitV1) error {
	t.Helper()
	witness, err := frontend.NewWitness(&assignment, ecc.BN254.ScalarField())
	if err != nil {
		return err
	}
	_, err = groth16.Prove(ccs, pk, witness)
	return err
}

func validV1() CircuitV1 {
	asset := bi(1)
	amount0, owner0, nonce0 := bi(8_000_000), bi(1111), bi(2222)
	amount1, owner1, nonce1 := bi(3_000_000), bi(3333), bi(4444)
	commitment0 := noteNativeV1(asset, amount0, owner0, nonce0)
	commitment1 := noteNativeV1(asset, amount1, owner1, nonce1)
	leaves := make([]*big.Int, 1<<MerkleDepthV1)
	for index := range leaves {
		leaves[index] = new(big.Int)
	}
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

func TestV1ValidMembershipProvesAndVerifies(t *testing.T) {
	ccs, pk, vk := compileV1(t)
	assignment := validV1()
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

func TestV1RejectsWrongOwner(t *testing.T) {
	ccs, pk, _ := compileV1(t)
	assignment := validV1()
	assignment.Input0Owner = 9999
	if err := proveV1(t, ccs, pk, assignment); err == nil {
		t.Fatal("expected wrong owner to fail membership")
	}
}

func TestV1RejectsWrongMerklePath(t *testing.T) {
	ccs, pk, _ := compileV1(t)
	assignment := validV1()
	assignment.Input0Path[0] = 12345
	if err := proveV1(t, ccs, pk, assignment); err == nil {
		t.Fatal("expected wrong Merkle path to fail")
	}
}

func TestV1RejectsChangedNullifier(t *testing.T) {
	ccs, pk, _ := compileV1(t)
	assignment := validV1()
	assignment.Nullifier0 = 12345
	if err := proveV1(t, ccs, pk, assignment); err == nil {
		t.Fatal("expected changed nullifier to fail")
	}
}

func TestV1RejectsDuplicateNullifier(t *testing.T) {
	ccs, pk, _ := compileV1(t)
	assignment := validV1()
	assignment.Nullifier1 = assignment.Nullifier0
	if err := proveV1(t, ccs, pk, assignment); err == nil {
		t.Fatal("expected duplicate nullifiers to fail")
	}
}

func TestV1RejectsChangedChangeCommitment(t *testing.T) {
	ccs, pk, _ := compileV1(t)
	assignment := validV1()
	assignment.ChangeCommitment = 12345
	if err := proveV1(t, ccs, pk, assignment); err == nil {
		t.Fatal("expected changed change commitment to fail")
	}
}

func TestV1RejectsValueCreation(t *testing.T) {
	ccs, pk, _ := compileV1(t)
	assignment := validV1()
	assignment.PublicAmount = 4_000_001
	if err := proveV1(t, ccs, pk, assignment); err == nil {
		t.Fatal("expected value creation to fail")
	}
}

func TestV1RejectsAssetSubstitution(t *testing.T) {
	ccs, pk, _ := compileV1(t)
	assignment := validV1()
	assignment.AssetID = 2
	if err := proveV1(t, ccs, pk, assignment); err == nil {
		t.Fatal("expected asset substitution to fail commitments")
	}
}
