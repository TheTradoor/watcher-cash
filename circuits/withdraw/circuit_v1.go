package withdraw

import (
	"github.com/consensys/gnark/frontend"
	stdmimc "github.com/consensys/gnark/std/hash/mimc"
)

const MerkleDepthV1 = 4

// Domain constants are Watcher-owned prototype constants. They are intentionally
// explicit so different logical hashes cannot be confused with each other.
const (
	domainNoteV1      = 91001
	domainNullifierV1 = 91002
	domainMerkleV1    = 91003
)

// CircuitV1 adds actual private-note membership and stable nullifiers to the
// value-conservation prototype. It is still a development circuit and must not
// be used with production funds before independent review and final setup.
type CircuitV1 struct {
	// Input note 0 witness.
	Input0Amount frontend.Variable
	Input0Owner  frontend.Variable
	Input0Nonce  frontend.Variable
	Input0Path   [MerkleDepthV1]frontend.Variable
	Input0Index  [MerkleDepthV1]frontend.Variable

	// Input note 1 witness.
	Input1Amount frontend.Variable
	Input1Owner  frontend.Variable
	Input1Nonce  frontend.Variable
	Input1Path   [MerkleDepthV1]frontend.Variable
	Input1Index  [MerkleDepthV1]frontend.Variable

	// Private change note witness.
	ChangeAmount frontend.Variable
	ChangeOwner  frontend.Variable
	ChangeNonce  frontend.Variable

	// Public statement.
	MerkleRoot        frontend.Variable `gnark:",public"`
	Nullifier0        frontend.Variable `gnark:",public"`
	Nullifier1        frontend.Variable `gnark:",public"`
	ChangeCommitment  frontend.Variable `gnark:",public"`
	PublicAmount      frontend.Variable `gnark:",public"`
	ProtocolFee       frontend.Variable `gnark:",public"`
	RelayerFee        frontend.Variable `gnark:",public"`
	RecipientBinding  frontend.Variable `gnark:",public"`
	AssetID           frontend.Variable `gnark:",public"`
	ContextBinding    frontend.Variable `gnark:",public"`
}

func hashV1(api frontend.API, values ...frontend.Variable) (frontend.Variable, error) {
	h, err := stdmimc.NewMiMC(api)
	if err != nil {
		return nil, err
	}
	h.Write(values...)
	return h.Sum(), nil
}

func noteCommitmentV1(api frontend.API, assetID, amount, owner, nonce frontend.Variable) (frontend.Variable, error) {
	return hashV1(api, domainNoteV1, assetID, amount, owner, nonce)
}

func nullifierV1(api frontend.API, owner, nonce, commitment frontend.Variable) (frontend.Variable, error) {
	// The nullifier deliberately does NOT contain recipient/context. It must be a
	// stable identifier for a note across all attempted spends, otherwise the same
	// note could be spent twice with two different withdrawal contexts.
	return hashV1(api, domainNullifierV1, owner, nonce, commitment)
}

func merkleRootV1(api frontend.API, leaf frontend.Variable, path [MerkleDepthV1]frontend.Variable, index [MerkleDepthV1]frontend.Variable) (frontend.Variable, error) {
	current := leaf
	for i := 0; i < MerkleDepthV1; i++ {
		api.AssertIsBoolean(index[i])
		left := api.Select(index[i], path[i], current)
		right := api.Select(index[i], current, path[i])
		next, err := hashV1(api, domainMerkleV1, left, right)
		if err != nil {
			return nil, err
		}
		current = next
	}
	return current, nil
}

func (c *CircuitV1) Define(api frontend.API) error {
	// Monetary values are unsigned 64-bit base units. Range constraints prevent
	// modular-field wraparound from satisfying conservation equations.
	api.ToBinary(c.Input0Amount, 64)
	api.ToBinary(c.Input1Amount, 64)
	api.ToBinary(c.ChangeAmount, 64)
	api.ToBinary(c.PublicAmount, 64)
	api.ToBinary(c.ProtocolFee, 64)
	api.ToBinary(c.RelayerFee, 64)

	api.AssertIsDifferent(c.AssetID, 0)
	api.AssertIsDifferent(c.RecipientBinding, 0)
	api.AssertIsDifferent(c.ContextBinding, 0)
	api.AssertIsDifferent(c.Input0Owner, 0)
	api.AssertIsDifferent(c.Input1Owner, 0)
	api.AssertIsDifferent(c.Input0Nonce, 0)
	api.AssertIsDifferent(c.Input1Nonce, 0)
	api.AssertIsDifferent(c.ChangeOwner, 0)
	api.AssertIsDifferent(c.ChangeNonce, 0)

	commitment0, err := noteCommitmentV1(api, c.AssetID, c.Input0Amount, c.Input0Owner, c.Input0Nonce)
	if err != nil { return err }
	commitment1, err := noteCommitmentV1(api, c.AssetID, c.Input1Amount, c.Input1Owner, c.Input1Nonce)
	if err != nil { return err }

	root0, err := merkleRootV1(api, commitment0, c.Input0Path, c.Input0Index)
	if err != nil { return err }
	root1, err := merkleRootV1(api, commitment1, c.Input1Path, c.Input1Index)
	if err != nil { return err }
	api.AssertIsEqual(root0, c.MerkleRoot)
	api.AssertIsEqual(root1, c.MerkleRoot)

	nullifier0, err := nullifierV1(api, c.Input0Owner, c.Input0Nonce, commitment0)
	if err != nil { return err }
	nullifier1, err := nullifierV1(api, c.Input1Owner, c.Input1Nonce, commitment1)
	if err != nil { return err }
	api.AssertIsEqual(nullifier0, c.Nullifier0)
	api.AssertIsEqual(nullifier1, c.Nullifier1)
	api.AssertIsDifferent(c.Nullifier0, c.Nullifier1)

	changeCommitment, err := noteCommitmentV1(api, c.AssetID, c.ChangeAmount, c.ChangeOwner, c.ChangeNonce)
	if err != nil { return err }
	api.AssertIsEqual(changeCommitment, c.ChangeCommitment)

	inputs := api.Add(c.Input0Amount, c.Input1Amount)
	outputs := api.Add(c.PublicAmount, c.ProtocolFee, c.RelayerFee, c.ChangeAmount)
	api.AssertIsEqual(inputs, outputs)

	return nil
}
