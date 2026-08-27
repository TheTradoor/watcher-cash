package withdraw

import "github.com/consensys/gnark/frontend"

// CircuitV0 is intentionally a value/binding prototype, not the final privacy circuit.
// Merkle membership, commitment hashing and nullifier derivation are added only after
// the hash construction is frozen and independently reviewed.
type CircuitV0 struct {
	// Private witness
	Input0 frontend.Variable
	Input1 frontend.Variable
	Change frontend.Variable

	// Public statement
	PublicAmount frontend.Variable `gnark:",public"`
	ProtocolFee frontend.Variable `gnark:",public"`
	RelayerFee frontend.Variable `gnark:",public"`
	RecipientBinding frontend.Variable `gnark:",public"`
	AssetID frontend.Variable `gnark:",public"`
	ContextBinding frontend.Variable `gnark:",public"`
}

func (c *CircuitV0) Define(api frontend.API) error {
	// Prototype range: unsigned 64-bit base units. This prevents field wraparound
	// from being used as an apparent valid monetary equation.
	api.ToBinary(c.Input0, 64)
	api.ToBinary(c.Input1, 64)
	api.ToBinary(c.Change, 64)
	api.ToBinary(c.PublicAmount, 64)
	api.ToBinary(c.ProtocolFee, 64)
	api.ToBinary(c.RelayerFee, 64)

	inputs := api.Add(c.Input0, c.Input1)
	outputs := api.Add(c.PublicAmount, c.ProtocolFee, c.RelayerFee, c.Change)
	api.AssertIsEqual(inputs, outputs)

	// Binding fields must be non-zero in v0. Their cryptographic derivation is
	// deliberately outside this prototype until the hash design is frozen.
	api.AssertIsDifferent(c.RecipientBinding, 0)
	api.AssertIsDifferent(c.AssetID, 0)
	api.AssertIsDifferent(c.ContextBinding, 0)
	return nil
}
