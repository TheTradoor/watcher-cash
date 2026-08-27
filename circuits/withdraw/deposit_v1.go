package withdraw

import "github.com/consensys/gnark/frontend"

// DepositCircuitV1 proves that a public note commitment encodes the exact
// public SOL amount being transferred into the Watcher vault. Owner and nonce
// remain private. Without this proof, a caller could deposit a tiny amount while
// registering a commitment that later opens to a much larger note.
type DepositCircuitV1 struct {
	Owner frontend.Variable
	Nonce frontend.Variable

	Commitment frontend.Variable `gnark:",public"`
	Amount     frontend.Variable `gnark:",public"`
	AssetID    frontend.Variable `gnark:",public"`
}

func (c *DepositCircuitV1) Define(api frontend.API) error {
	api.ToBinary(c.Amount, 64)
	api.AssertIsDifferent(c.Amount, 0)
	api.AssertIsDifferent(c.AssetID, 0)
	api.AssertIsDifferent(c.Owner, 0)
	api.AssertIsDifferent(c.Nonce, 0)

	commitment, err := noteCommitmentV1(api, c.AssetID, c.Amount, c.Owner, c.Nonce)
	if err != nil {
		return err
	}
	api.AssertIsEqual(commitment, c.Commitment)
	return nil
}
