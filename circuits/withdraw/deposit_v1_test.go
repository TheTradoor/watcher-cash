package withdraw

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
