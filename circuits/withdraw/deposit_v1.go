package withdraw

import "github.com/consensys/gnark/frontend"

// DepositCircuitV1 proves both the private note opening and one append-only
// Merkle transition. The program therefore verifies a proof and adopts the
// proof-bound NewRoot instead of recomputing MiMC inside the Solana VM.
type DepositCircuitV1 struct {
	Owner frontend.Variable
	Nonce frontend.Variable
	Path  [MerkleDepthV1]frontend.Variable
	Index [MerkleDepthV1]frontend.Variable

	Commitment frontend.Variable `gnark:",public"`
	Amount     frontend.Variable `gnark:",public"`
	AssetID    frontend.Variable `gnark:",public"`
	OldRoot    frontend.Variable `gnark:",public"`
	NewRoot    frontend.Variable `gnark:",public"`
	LeafIndex  frontend.Variable `gnark:",public"`
}

func (c *DepositCircuitV1) Define(api frontend.API) error {
	api.ToBinary(c.Amount, 64)
	api.AssertIsDifferent(c.Amount, 0)
	api.AssertIsDifferent(c.AssetID, 0)
	api.AssertIsDifferent(c.Owner, 0)
	api.AssertIsDifferent(c.Nonce, 0)
	api.AssertIsDifferent(c.NewRoot, 0)

	commitment, err := noteCommitmentV1(api, c.AssetID, c.Amount, c.Owner, c.Nonce)
	if err != nil {
		return err
	}
	api.AssertIsEqual(commitment, c.Commitment)

	indexValue := merkleIndexValueV1(api, c.Index)
	api.AssertIsEqual(indexValue, c.LeafIndex)

	// The protocol represents the pre-deposit empty state with a zero sentinel.
	// For the first append, the index and every sibling must therefore be zero.
	// Every later append proves that the target leaf is still zero in OldRoot.
	computedOldRoot, err := merkleRootV1(api, 0, c.Path, c.Index)
	if err != nil {
		return err
	}
	isFirst := api.IsZero(c.LeafIndex)
	emptySibling := frontend.Variable(0)
	for i := 0; i < MerkleDepthV1; i++ {
		api.AssertIsEqual(api.Mul(isFirst, api.Sub(c.Path[i], emptySibling)), 0)
		emptySibling, err = hashV1(api, domainMerkleV1, emptySibling, emptySibling)
		if err != nil {
			return err
		}
	}
	api.AssertIsEqual(api.Mul(isFirst, c.OldRoot), 0)
	api.AssertIsEqual(
		api.Mul(api.Sub(1, isFirst), api.Sub(computedOldRoot, c.OldRoot)),
		0,
	)

	computedNewRoot, err := merkleRootV1(api, commitment, c.Path, c.Index)
	if err != nil {
		return err
	}
	api.AssertIsEqual(computedNewRoot, c.NewRoot)
	return nil
}
