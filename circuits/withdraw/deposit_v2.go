package withdraw

import "github.com/consensys/gnark/frontend"

// DepositCircuitV2 appends a V1-compatible note commitment into a depth-16 V2
// tree epoch. Epoch and ContextBinding are public so one proof cannot be moved
// between protocol deployments or silently reused for another active epoch.
type DepositCircuitV2 struct {
	Owner frontend.Variable
	Nonce frontend.Variable
	Path  [MerkleDepthV2]frontend.Variable
	Index [MerkleDepthV2]frontend.Variable

	Commitment    frontend.Variable `gnark:",public"`
	Amount        frontend.Variable `gnark:",public"`
	AssetID       frontend.Variable `gnark:",public"`
	Epoch         frontend.Variable `gnark:",public"`
	ContextBinding frontend.Variable `gnark:",public"`
	OldRoot       frontend.Variable `gnark:",public"`
	NewRoot       frontend.Variable `gnark:",public"`
	LeafIndex     frontend.Variable `gnark:",public"`
}

func (c *DepositCircuitV2) Define(api frontend.API) error {
	api.ToBinary(c.Amount, 64)
	api.ToBinary(c.Epoch, 64)
	api.AssertIsDifferent(c.Amount, 0)
	api.AssertIsDifferent(c.AssetID, 0)
	api.AssertIsDifferent(c.Owner, 0)
	api.AssertIsDifferent(c.Nonce, 0)
	api.AssertIsDifferent(c.ContextBinding, 0)
	api.AssertIsDifferent(c.NewRoot, 0)

	commitment, err := noteCommitmentV1(api, c.AssetID, c.Amount, c.Owner, c.Nonce)
	if err != nil {
		return err
	}
	api.AssertIsDifferent(commitment, 0)
	api.AssertIsEqual(commitment, c.Commitment)

	indexValue := merkleIndexValueV2(api, c.Index)
	api.AssertIsEqual(indexValue, c.LeafIndex)

	computedOldRoot, err := merkleRootV2(api, 0, c.Path, c.Index)
	if err != nil {
		return err
	}

	// Empty active epochs use a zero sentinel rather than exposing the
	// mathematical empty-tree root. The first append must therefore carry the
	// exact deterministic empty path and leaf index zero.
	isFirst := api.IsZero(c.LeafIndex)
	emptySibling := frontend.Variable(0)
	for i := 0; i < MerkleDepthV2; i++ {
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

	computedNewRoot, err := merkleRootV2(api, commitment, c.Path, c.Index)
	if err != nil {
		return err
	}
	api.AssertIsEqual(computedNewRoot, c.NewRoot)
	return nil
}
