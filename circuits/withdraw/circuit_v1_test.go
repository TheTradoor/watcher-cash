package withdraw

import (
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
		var e fr.Element
		e.SetBigInt(value)
		b := e.Bytes()
		if _, err := h.Write(b[:]); err != nil { panic(err) }
	}
	return new(big.Int).SetBytes(h.Sum(nil))
}

func bi(v int64) *big.Int { return big.NewInt(v) }

func noteNativeV1(asset, amount, owner, nonce *big.Int) *big.Int {
	return hashNativeV1(bi(domainNoteV1), asset, amount, owner, nonce)
}

func nullifierNativeV1(owner, nonce, commitment *big.Int) *big.Int {
	return hashNativeV1(bi(domainNullifierV1), owner, nonce, commitment)
}

func parentNativeV1(left, right *big.Int) *big.Int {
	return hashNativeV1(bi(domainMerkleV1), left, right)
}

type treeV1 struct {
	levels [][]*big.Int
}

func makeTreeV1(leaves []*big.Int) treeV1 {
	if len(leaves) != 1<<MerkleDepthV1 { panic("invalid leaf count") }
	levels := make([][]*big.Int, MerkleDepthV1+1)
	levels[0] = make([]*big.Int, len(leaves))
	for i, leaf := range leaves { levels[0][i] = new(big.Int).Set(leaf) }
	for d := 0; d < MerkleDepthV1; d++ {
		next := make([]*big.Int, len(levels[d])/2)
		for i := range next { next[i] = parentNativeV1(levels[d][2*i], levels[d][2*i+1]) }
		levels[d+1] = next
	}
	return treeV1{levels: levels}
}

func (t treeV1) root() *big.Int { return new(big.Int).Set(t.levels[MerkleDepthV1][0]) }

func (t treeV1) proof(index int) ([MerkleDepthV1]frontend.Variable, [MerkleDepthV1]frontend.Variable) {
	var path [MerkleDepthV1]frontend.Variable
	var bits [MerkleDepthV1]frontend.Variable
	pos := index
	for d := 0; d < MerkleDepthV1; d++ {
		if pos%2 == 0 {
			path[d] = new(big.Int).Set(t.levels[d][pos+1]); bits[d] = 0
		} else {
			path[d] = new(big.Int).Set(t.levels[d][pos-1]); bits[d] = 1
		}
		pos /= 2
	}
	return path, bits
}

func compileV1(t *testing.T) (constraint.ConstraintSystem, groth16.ProvingKey, groth16.VerifyingKey) {
	t.Helper()
	ccs, err := frontend.Compile(ecc.BN254.ScalarField(), r1cs.NewBuilder, &CircuitV1{})
	if err != nil { t.Fatal(err) }
	pk, vk, err := groth16.Setup(ccs)
	if err != nil { t.Fatal(err) }
	return ccs, pk, vk
}

func proveV1(t *testing.T, ccs constraint.ConstraintSystem, pk groth16.ProvingKey, assignment CircuitV1) error {
	t.Helper()
	w, err := frontend.NewWitness(&assignment, ecc.BN254.ScalarField())
	if err != nil { return err }
	_, err = groth16.Prove(ccs, pk, w)
	return err
}

func validV1() CircuitV1 {
	asset := bi(1)
	amount0, owner0, nonce0 := bi(8_000_000), bi(1111), bi(2222)
	amount1, owner1, nonce1 := bi(3_000_000), bi(3333), bi(4444)
	commitment0 := noteNativeV1(asset, amount0, owner0, nonce0)
	commitment1 := noteNativeV1(asset, amount1, owner1, nonce1)

	leaves := make([]*big.Int, 1<<MerkleDepthV1)
	for i := range leaves { leaves[i] = new(big.Int) }
	leaves[2] = commitment0
	leaves[7] = commitment1
	tree := makeTreeV1(leaves)
	path0, bits0 := tree.proof(2)
	path1, bits1 := tree.proof(7)

	changeAmount, changeOwner, changeNonce := bi(6_000_000), bi(5555), bi(6666)
	changeCommitment := noteNativeV1(asset, changeAmount, changeOwner, changeNonce)

	return CircuitV1{
		Input0Amount: amount0, Input0Owner: owner0, Input0Nonce: nonce0, Input0Path: path0, Input0Index: bits0,
		Input1Amount: amount1, Input1Owner: owner1, Input1Nonce: nonce1, Input1Path: path1, Input1Index: bits1,
		ChangeAmount: changeAmount, ChangeOwner: changeOwner, ChangeNonce: changeNonce,
		MerkleRoot: tree.root(),
		Nullifier0: nullifierNativeV1(owner0, nonce0, commitment0),
		Nullifier1: nullifierNativeV1(owner1, nonce1, commitment1),
		ChangeCommitment: changeCommitment,
		PublicAmount: 4_000_000, ProtocolFee: 500_000, RelayerFee: 500_000,
		RecipientBinding: 101, AssetID: 1, ContextBinding: 202,
	}
}

func TestV1ValidMembershipProvesAndVerifies(t *testing.T) {
	ccs, pk, vk := compileV1(t)
	a := validV1()
	w, err := frontend.NewWitness(&a, ecc.BN254.ScalarField()); if err != nil { t.Fatal(err) }
	pub, err := w.Public(); if err != nil { t.Fatal(err) }
	proof, err := groth16.Prove(ccs, pk, w); if err != nil { t.Fatal(err) }
	if err := groth16.Verify(proof, vk, pub); err != nil { t.Fatal(err) }
}

func TestV1RejectsWrongOwner(t *testing.T) {
	ccs, pk, _ := compileV1(t); a := validV1(); a.Input0Owner = 9999
	if err := proveV1(t, ccs, pk, a); err == nil { t.Fatal("expected wrong owner to fail membership") }
}

func TestV1RejectsWrongMerklePath(t *testing.T) {
	ccs, pk, _ := compileV1(t); a := validV1(); a.Input0Path[0] = 12345
	if err := proveV1(t, ccs, pk, a); err == nil { t.Fatal("expected wrong Merkle path to fail") }
}

func TestV1RejectsChangedNullifier(t *testing.T) {
	ccs, pk, _ := compileV1(t); a := validV1(); a.Nullifier0 = 12345
	if err := proveV1(t, ccs, pk, a); err == nil { t.Fatal("expected changed nullifier to fail") }
}

func TestV1RejectsDuplicateNullifier(t *testing.T) {
	ccs, pk, _ := compileV1(t); a := validV1(); a.Nullifier1 = a.Nullifier0
	if err := proveV1(t, ccs, pk, a); err == nil { t.Fatal("expected duplicate nullifiers to fail") }
}

func TestV1RejectsChangedChangeCommitment(t *testing.T) {
	ccs, pk, _ := compileV1(t); a := validV1(); a.ChangeCommitment = 12345
	if err := proveV1(t, ccs, pk, a); err == nil { t.Fatal("expected changed change commitment to fail") }
}

func TestV1RejectsValueCreation(t *testing.T) {
	ccs, pk, _ := compileV1(t); a := validV1(); a.PublicAmount = 4_000_001
	if err := proveV1(t, ccs, pk, a); err == nil { t.Fatal("expected value creation to fail") }
}

func TestV1RejectsAssetSubstitution(t *testing.T) {
	ccs, pk, _ := compileV1(t); a := validV1(); a.AssetID = 2
	if err := proveV1(t, ccs, pk, a); err == nil { t.Fatal("expected asset substitution to fail commitments") }
}
