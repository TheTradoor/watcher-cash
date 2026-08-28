package withdraw

import (
	"math/big"
	"sync"
	"testing"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark/backend/groth16"
	"github.com/consensys/gnark/constraint"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/frontend/cs/r1cs"
)

type sparseTreeV2 struct {
	levels []map[int]*big.Int
	count  int
	rootV  *big.Int
}

func zeroHashesNativeV2() []*big.Int {
	zeros := make([]*big.Int, MerkleDepthV2+1)
	zeros[0] = new(big.Int)
	for depth := 0; depth < MerkleDepthV2; depth++ {
		zeros[depth+1] = parentNativeV1(zeros[depth], zeros[depth])
	}
	return zeros
}

func makeSparseTreeV2(leaves []*big.Int) sparseTreeV2 {
	if len(leaves) > 1<<MerkleDepthV2 {
		panic("too many V2 leaves")
	}
	zeros := zeroHashesNativeV2()
	levels := make([]map[int]*big.Int, MerkleDepthV2+1)
	for depth := range levels {
		levels[depth] = make(map[int]*big.Int)
	}
	for index, leaf := range leaves {
		levels[0][index] = new(big.Int).Set(leaf)
	}
	width := len(leaves)
	for depth := 0; depth < MerkleDepthV2; depth++ {
		parentCount := (width + 1) / 2
		if parentCount == 0 {
			break
		}
		for parent := 0; parent < parentCount; parent++ {
			left, ok := levels[depth][parent*2]
			if !ok {
				left = zeros[depth]
			}
			right, ok := levels[depth][parent*2+1]
			if !ok {
				right = zeros[depth]
			}
			levels[depth+1][parent] = parentNativeV1(left, right)
		}
		width = parentCount
	}
	root := new(big.Int)
	if len(leaves) > 0 {
		if value, ok := levels[MerkleDepthV2][0]; ok {
			root.Set(value)
		}
	}
	return sparseTreeV2{levels: levels, count: len(leaves), rootV: root}
}

func (tree sparseTreeV2) root() *big.Int {
	return new(big.Int).Set(tree.rootV)
}

func (tree sparseTreeV2) proof(index int) ([MerkleDepthV2]frontend.Variable, [MerkleDepthV2]frontend.Variable) {
	if index < 0 || index >= 1<<MerkleDepthV2 {
		panic("V2 proof index out of range")
	}
	zeros := zeroHashesNativeV2()
	var path [MerkleDepthV2]frontend.Variable
	var bits [MerkleDepthV2]frontend.Variable
	position := index
	for depth := 0; depth < MerkleDepthV2; depth++ {
		siblingIndex := position ^ 1
		sibling, ok := tree.levels[depth][siblingIndex]
		if !ok {
			sibling = zeros[depth]
		}
		path[depth] = new(big.Int).Set(sibling)
		bits[depth] = position & 1
		position /= 2
	}
	return path, bits
}

func withAppendedV2(tree sparseTreeV2, commitment *big.Int) sparseTreeV2 {
	leaves := make([]*big.Int, tree.count+1)
	for index := 0; index < tree.count; index++ {
		leaf, ok := tree.levels[0][index]
		if !ok {
			panic("missing populated V2 leaf")
		}
		leaves[index] = new(big.Int).Set(leaf)
	}
	leaves[tree.count] = new(big.Int).Set(commitment)
	return makeSparseTreeV2(leaves)
}

type v2Setup struct {
	ccs constraint.ConstraintSystem
	pk  groth16.ProvingKey
	vk  groth16.VerifyingKey
	err error
}

var (
	withdrawV2Once sync.Once
	withdrawV2Data v2Setup
)

func setupWithdrawV2(t *testing.T) v2Setup {
	t.Helper()
	withdrawV2Once.Do(func() {
		withdrawV2Data.ccs, withdrawV2Data.err = frontend.Compile(
			ecc.BN254.ScalarField(),
			r1cs.NewBuilder,
			&CircuitV2{},
		)
		if withdrawV2Data.err != nil {
			return
		}
		withdrawV2Data.pk, withdrawV2Data.vk, withdrawV2Data.err = groth16.Setup(withdrawV2Data.ccs)
	})
	if withdrawV2Data.err != nil {
		t.Fatal(withdrawV2Data.err)
	}
	return withdrawV2Data
}

func proveWithdrawV2(t *testing.T, assignment CircuitV2) error {
	t.Helper()
	setup := setupWithdrawV2(t)
	witness, err := frontend.NewWitness(&assignment, ecc.BN254.ScalarField())
	if err != nil {
		return err
	}
	_, err = groth16.Prove(setup.ccs, setup.pk, witness)
	return err
}

type v2Note struct {
	amount, owner, nonce, commitment *big.Int
	path                             [MerkleDepthV2]frontend.Variable
	bits                             [MerkleDepthV2]frontend.Variable
	root                             *big.Int
}

func makeV2Notes() ([MaxInputsV2]v2Note, sparseTreeV2, sparseTreeV2) {
	asset := bi(1)
	amounts := []*big.Int{bi(8_000_000), bi(3_000_000), bi(2_000_000), bi(1_000_000)}
	owners := []*big.Int{bi(1111), bi(3333), bi(7777), bi(9999)}
	nonces := []*big.Int{bi(2222), bi(4444), bi(8888), bi(10_101)}
	commitments := make([]*big.Int, MaxInputsV2)
	for i := 0; i < MaxInputsV2; i++ {
		commitments[i] = noteNativeV1(asset, amounts[i], owners[i], nonces[i])
	}

	// Two independent epochs prove that one V2 withdrawal can aggregate notes
	// without requiring every input to share one Merkle root.
	epochA := makeSparseTreeV2(commitments[:2])
	epochB := makeSparseTreeV2(commitments[2:])
	var notes [MaxInputsV2]v2Note
	for i := 0; i < 2; i++ {
		path, bits := epochA.proof(i)
		notes[i] = v2Note{amounts[i], owners[i], nonces[i], commitments[i], path, bits, epochA.root()}
	}
	for i := 2; i < MaxInputsV2; i++ {
		path, bits := epochB.proof(i - 2)
		notes[i] = v2Note{amounts[i], owners[i], nonces[i], commitments[i], path, bits, epochB.root()}
	}
	return notes, epochA, epochB
}

func zeroV2Arrays(assignment *CircuitV2) {
	for i := 0; i < MaxInputsV2; i++ {
		assignment.InputEnabled[i] = 0
		assignment.InputAmount[i] = 0
		assignment.InputOwner[i] = 0
		assignment.InputNonce[i] = 0
		assignment.InputRoots[i] = 0
		assignment.Nullifiers[i] = 0
		for depth := 0; depth < MerkleDepthV2; depth++ {
			assignment.InputPath[i][depth] = 0
			assignment.InputIndex[i][depth] = 0
		}
	}
	assignment.ChangeEnabled = 0
	assignment.ChangeAmount = 0
	assignment.ChangeOwner = 0
	assignment.ChangeNonce = 0
	assignment.ChangeCommitment = 0
	assignment.ChangeLeafIndex = 0
	for depth := 0; depth < MerkleDepthV2; depth++ {
		assignment.ChangePath[depth] = 0
		assignment.ChangeIndex[depth] = 0
	}
}

func validV2(inputCount int, changeAmount int64) CircuitV2 {
	if inputCount < 1 || inputCount > MaxInputsV2 {
		panic("invalid V2 input count")
	}
	notes, epochA, epochB := makeV2Notes()
	assignment := CircuitV2{}
	zeroV2Arrays(&assignment)
	assignment.InputCount = inputCount
	assignment.RecipientBinding = fixtureRecipientBinding()
	assignment.AssetID = 1
	assignment.ContextBinding = fixtureWithdrawContextBinding()
	assignment.ProtocolFee = 0
	assignment.RelayerFee = 0

	total := int64(0)
	for i := 0; i < inputCount; i++ {
		note := notes[i]
		assignment.InputEnabled[i] = 1
		assignment.InputAmount[i] = note.amount
		assignment.InputOwner[i] = note.owner
		assignment.InputNonce[i] = note.nonce
		assignment.InputPath[i] = note.path
		assignment.InputIndex[i] = note.bits
		assignment.InputRoots[i] = note.root
		assignment.Nullifiers[i] = nullifierNativeV1(note.owner, note.nonce, note.commitment)
		total += note.amount.Int64()
	}

	if changeAmount > 0 {
		assignment.ChangeEnabled = 1
		assignment.ChangeAmount = changeAmount
		assignment.ChangeOwner = 12_345
		assignment.ChangeNonce = 54_321
		changeCommitment := noteNativeV1(bi(1), bi(changeAmount), bi(12_345), bi(54_321))
		assignment.ChangeCommitment = changeCommitment

		// For one/two-input cases append into epoch A. Four-input cases append
		// into epoch B, proving that spend roots and append root are independent.
		target := epochA
		if inputCount > 2 {
			target = epochB
		}
		path, bits := target.proof(target.count)
		assignment.ChangePath = path
		assignment.ChangeIndex = bits
		assignment.ChangeLeafIndex = target.count
		assignment.CurrentRoot = target.root()
		assignment.NewMerkleRoot = withAppendedV2(target, changeCommitment).root()
	} else {
		assignment.ChangeEnabled = 0
		assignment.ChangeAmount = 0
		assignment.ChangeCommitment = 0
		assignment.ChangeLeafIndex = 0
		assignment.CurrentRoot = epochA.root()
		assignment.NewMerkleRoot = epochA.root()
	}

	assignment.PublicAmount = total - changeAmount
	return assignment
}

func TestCircuitV2OneInputExactWithdrawalProves(t *testing.T) {
	assignment := validV2(1, 0)
	setup := setupWithdrawV2(t)
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

func TestCircuitV2FourInputsAcrossEpochRootsProve(t *testing.T) {
	assignment := validV2(4, 3_000_000)
	if err := proveWithdrawV2(t, assignment); err != nil {
		t.Fatal(err)
	}
	left := assignment.InputRoots[0].(*big.Int)
	right := assignment.InputRoots[2].(*big.Int)
	if left.Cmp(right) == 0 {
		t.Fatal("fixture must exercise distinct epoch roots")
	}
}

func TestCircuitV2RejectsInputGap(t *testing.T) {
	assignment := validV2(2, 1_000_000)
	assignment.InputEnabled[1] = 0
	assignment.InputEnabled[2] = 1
	assignment.InputAmount[2] = assignment.InputAmount[1]
	assignment.InputOwner[2] = assignment.InputOwner[1]
	assignment.InputNonce[2] = assignment.InputNonce[1]
	assignment.InputPath[2] = assignment.InputPath[1]
	assignment.InputIndex[2] = assignment.InputIndex[1]
	assignment.InputRoots[2] = assignment.InputRoots[1]
	assignment.Nullifiers[2] = assignment.Nullifiers[1]
	assignment.InputAmount[1] = 0
	assignment.InputOwner[1] = 0
	assignment.InputNonce[1] = 0
	assignment.InputRoots[1] = 0
	assignment.Nullifiers[1] = 0
	if err := proveWithdrawV2(t, assignment); err == nil {
		t.Fatal("expected non-prefix enabled inputs to fail")
	}
}

func TestCircuitV2RejectsDuplicateActiveNullifier(t *testing.T) {
	assignment := validV2(2, 1_000_000)
	assignment.InputAmount[1] = assignment.InputAmount[0]
	assignment.InputOwner[1] = assignment.InputOwner[0]
	assignment.InputNonce[1] = assignment.InputNonce[0]
	assignment.InputPath[1] = assignment.InputPath[0]
	assignment.InputIndex[1] = assignment.InputIndex[0]
	assignment.InputRoots[1] = assignment.InputRoots[0]
	assignment.Nullifiers[1] = assignment.Nullifiers[0]
	// Preserve conservation after replacing the second note with the first.
	assignment.PublicAmount = 15_000_000
	if err := proveWithdrawV2(t, assignment); err == nil {
		t.Fatal("expected duplicate active nullifier to fail")
	}
}

func TestCircuitV2RejectsWrongInputRoot(t *testing.T) {
	assignment := validV2(2, 1_000_000)
	assignment.InputRoots[0] = 12345
	if err := proveWithdrawV2(t, assignment); err == nil {
		t.Fatal("expected wrong membership root to fail")
	}
}

func TestCircuitV2RejectsValueCreation(t *testing.T) {
	assignment := validV2(2, 1_000_000)
	assignment.PublicAmount = 10_000_001
	if err := proveWithdrawV2(t, assignment); err == nil {
		t.Fatal("expected value creation to fail")
	}
}

func TestCircuitV2RejectsNonZeroDisabledSlot(t *testing.T) {
	assignment := validV2(1, 0)
	assignment.InputAmount[1] = 1
	if err := proveWithdrawV2(t, assignment); err == nil {
		t.Fatal("expected disabled input value to be zero")
	}
}

func TestCircuitV2RejectsFakeNoChangeRootTransition(t *testing.T) {
	assignment := validV2(1, 0)
	assignment.NewMerkleRoot = 12345
	if err := proveWithdrawV2(t, assignment); err == nil {
		t.Fatal("expected disabled change to preserve current root")
	}
}
