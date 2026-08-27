package withdraw

import (
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

func validDepositV1() DepositCircuitV1 {
	asset := bi(1)
	amount := bi(8_000_000)
	owner := bi(1111)
	nonce := bi(2222)
	return DepositCircuitV1{
		Owner:      owner,
		Nonce:      nonce,
		Commitment: noteNativeV1(asset, amount, owner, nonce),
		Amount:     amount,
		AssetID:    asset,
	}
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

func TestDepositV1ValidCommitmentAmountBinding(t *testing.T) {
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
