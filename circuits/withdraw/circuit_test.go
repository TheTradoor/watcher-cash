package withdraw

import (
	"testing"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark/backend/groth16"
	"github.com/consensys/gnark/constraint"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/frontend/cs/r1cs"
)

func compileAndSetup(t *testing.T) (constraint.ConstraintSystem, groth16.ProvingKey, groth16.VerifyingKey) {
	t.Helper()
	ccs, err := frontend.Compile(ecc.BN254.ScalarField(), r1cs.NewBuilder, &CircuitV0{})
	if err != nil { t.Fatal(err) }
	pk, vk, err := groth16.Setup(ccs)
	if err != nil { t.Fatal(err) }
	return ccs, pk, vk
}

func prove(t *testing.T, ccs constraint.ConstraintSystem, pk groth16.ProvingKey, assignment CircuitV0) error {
	t.Helper()
	w, err := frontend.NewWitness(&assignment, ecc.BN254.ScalarField())
	if err != nil { return err }
	_, err = groth16.Prove(ccs, pk, w)
	return err
}

func valid() CircuitV0 {
	return CircuitV0{
		Input0: 8_000_000, Input1: 3_000_000,
		PublicAmount: 4_000_000, ProtocolFee: 500_000, RelayerFee: 500_000, Change: 6_000_000,
		RecipientBinding: 101, AssetID: 1, ContextBinding: 202,
	}
}

func TestValidWitnessProvesAndVerifies(t *testing.T) {
	ccs, pk, vk := compileAndSetup(t)
	a := valid()
	w, err := frontend.NewWitness(&a, ecc.BN254.ScalarField())
	if err != nil { t.Fatal(err) }
	pub, err := w.Public(); if err != nil { t.Fatal(err) }
	proof, err := groth16.Prove(ccs, pk, w); if err != nil { t.Fatal(err) }
	if err := groth16.Verify(proof, vk, pub); err != nil { t.Fatal(err) }
}

func TestRejectsValueCreation(t *testing.T) {
	ccs, pk, _ := compileAndSetup(t)
	a := valid(); a.PublicAmount = 4_000_001
	if err := prove(t, ccs, pk, a); err == nil { t.Fatal("expected value creation to fail") }
}

func TestRejectsFeeManipulation(t *testing.T) {
	ccs, pk, _ := compileAndSetup(t)
	a := valid(); a.ProtocolFee = 1
	if err := prove(t, ccs, pk, a); err == nil { t.Fatal("expected inconsistent fee to fail conservation") }
}

func TestRejectsZeroRecipientBinding(t *testing.T) {
	ccs, pk, _ := compileAndSetup(t)
	a := valid(); a.RecipientBinding = 0
	if err := prove(t, ccs, pk, a); err == nil { t.Fatal("expected zero recipient binding to fail") }
}

func TestRejectsZeroAsset(t *testing.T) {
	ccs, pk, _ := compileAndSetup(t)
	a := valid(); a.AssetID = 0
	if err := prove(t, ccs, pk, a); err == nil { t.Fatal("expected zero asset id to fail") }
}

func TestRejectsOutOfRangeAmount(t *testing.T) {
	ccs, pk, _ := compileAndSetup(t)
	a := valid(); a.Input0 = "18446744073709551616" // 2^64
	if err := prove(t, ccs, pk, a); err == nil { t.Fatal("expected 65-bit input to fail") }
}
