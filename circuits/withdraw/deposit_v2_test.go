package withdraw

import (
	"sync"
	"testing"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark/backend/groth16"
	"github.com/consensys/gnark/constraint"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/frontend/cs/r1cs"
)

var (
	depositV2Once sync.Once
	depositV2Data v2Setup
)

func setupDepositV2(t *testing.T) v2Setup {
	t.Helper()
	depositV2Once.Do(func() {
		depositV2Data.ccs, depositV2Data.err = frontend.Compile(
			ecc.BN254.ScalarField(),
			r1cs.NewBuilder,
			&DepositCircuitV2{},
		)
		if depositV2Data.err != nil {
			return
		}
		depositV2Data.pk, depositV2Data.vk, depositV2Data.err = groth16.Setup(depositV2Data.ccs)
	})
	if depositV2Data.err != nil {
		t.Fatal(depositV2Data.err)
	}
	return depositV2Data
}

func proveDepositV2(t *testing.T, assignment DepositCircuitV2) error {
	t.Helper()
	setup := setupDepositV2(t)
	witness, err := frontend.NewWitness(&assignment, ecc.BN254.ScalarField())
	if err != nil {
		return err
	}
	_, err = groth16.Prove(setup.ccs, setup.pk, witness)
	return err
}

func validFirstDepositV2() DepositCircuitV2 {
	owner, nonce, amount, asset := bi(1111), bi(2222), bi(8_000_000), bi(1)
	commitment := noteNativeV1(asset, amount, owner, nonce)
	empty := makeSparseTreeV2(nil)
	path, bits := empty.proof(0)
	next := makeSparseTreeV2([]*big.Int{commitment})
	return DepositCircuitV2{
		Owner: owner,
		Nonce: nonce,
		Path: path,
		Index: bits,
		Commitment: commitment,
		Amount: amount,
		AssetID: asset,
		Epoch: 0,
		ContextBinding: fixtureWithdrawContextBinding(),
		OldRoot: 0,
		NewRoot: next.root(),
		LeafIndex: 0,
	}
}

func TestDepositCircuitV2FirstAppendProvesAndVerifies(t *testing.T) {
	assignment := validFirstDepositV2()
	setup := setupDepositV2(t)
	witness, err := frontend.NewWitness(&assignment, ecc.BN254.ScalarField())
	if err != nil {
		t.Fatal(err)
	}
	publicWitness, err := witness.Public()
	if err != nil {
		t.Fatal(err)
	}
	proof, err := groth16.Prove(setup.ccs, setup.pk, witness)
	if err != nil {
		t.Fatal(err)
	}
	if err := groth16.Verify(proof, setup.vk, publicWitness); err != nil {
		t.Fatal(err)
	}
}

func TestDepositCircuitV2SecondAppendProves(t *testing.T) {
	asset := bi(1)
	first := noteNativeV1(asset, bi(8_000_000), bi(1111), bi(2222))
	second := noteNativeV1(asset, bi(3_000_000), bi(3333), bi(4444))
	before := makeSparseTreeV2([]*big.Int{first})
	path, bits := before.proof(1)
	after := makeSparseTreeV2([]*big.Int{first, second})
	assignment := DepositCircuitV2{
		Owner: bi(3333),
		Nonce: bi(4444),
		Path: path,
		Index: bits,
		Commitment: second,
		Amount: bi(3_000_000),
		AssetID: asset,
		Epoch: 7,
		ContextBinding: fixtureWithdrawContextBinding(),
		OldRoot: before.root(),
		NewRoot: after.root(),
		LeafIndex: 1,
	}
	if err := proveDepositV2(t, assignment); err != nil {
		t.Fatal(err)
	}
}

func TestDepositCircuitV2RejectsWrongOldRoot(t *testing.T) {
	assignment := validFirstDepositV2()
	assignment.LeafIndex = 1
	assignment.OldRoot = 12345
	if err := proveDepositV2(t, assignment); err == nil {
		t.Fatal("expected invalid append root to fail")
	}
}

func TestDepositCircuitV2RejectsFakeFirstAppendPath(t *testing.T) {
	assignment := validFirstDepositV2()
	assignment.Path[0] = 12345
	if err := proveDepositV2(t, assignment); err == nil {
		t.Fatal("expected first append to require deterministic empty path")
	}
}
