package withdraw

import "github.com/consensys/gnark/frontend"

// MerkleDepthV2 raises one tree epoch from 16 leaves to 65,536 leaves.
// V2 is designed to rotate/seal epochs instead of growing one unbounded tree.
const MerkleDepthV2 = 16

// MaxInputsV2 keeps browser proving and Solana verification bounded while
// removing the V1 requirement for exactly two notes.
const MaxInputsV2 = 4

// CircuitV2 keeps the V1 note/nullifier domains so existing private note
// openings can be migrated into a V2 tree without being re-issued. The circuit
// version changes the membership and spend statement, not the note primitive.
type CircuitV2 struct {
	InputEnabled [MaxInputsV2]frontend.Variable
	InputAmount  [MaxInputsV2]frontend.Variable
	InputOwner   [MaxInputsV2]frontend.Variable
	InputNonce   [MaxInputsV2]frontend.Variable
	InputPath    [MaxInputsV2][MerkleDepthV2]frontend.Variable
	InputIndex   [MaxInputsV2][MerkleDepthV2]frontend.Variable

	ChangeEnabled frontend.Variable
	ChangeAmount  frontend.Variable
	ChangeOwner   frontend.Variable
	ChangeNonce   frontend.Variable
	ChangePath    [MerkleDepthV2]frontend.Variable
	ChangeIndex   [MerkleDepthV2]frontend.Variable

	// Each active input carries its own accepted root. This lets one withdrawal
	// aggregate notes from different sealed tree epochs.
	InputRoots  [MaxInputsV2]frontend.Variable `gnark:",public"`
	Nullifiers  [MaxInputsV2]frontend.Variable `gnark:",public"`
	InputCount  frontend.Variable              `gnark:",public"`

	ChangeCommitment frontend.Variable `gnark:",public"`
	PublicAmount     frontend.Variable `gnark:",public"`
	ProtocolFee      frontend.Variable `gnark:",public"`
	RelayerFee       frontend.Variable `gnark:",public"`
	RecipientBinding frontend.Variable `gnark:",public"`
	AssetID          frontend.Variable `gnark:",public"`
	ContextBinding   frontend.Variable `gnark:",public"`

	// The optional private change note always targets the current active tree.
	// When ChangeCommitment is zero, no tree append occurs and NewMerkleRoot must
	// equal CurrentRoot.
	CurrentRoot     frontend.Variable `gnark:",public"`
	NewMerkleRoot   frontend.Variable `gnark:",public"`
	ChangeLeafIndex frontend.Variable `gnark:",public"`
}

func merkleIndexValueV2(api frontend.API, bits [MerkleDepthV2]frontend.Variable) frontend.Variable {
	value := frontend.Variable(0)
	weight := 1
	for i := 0; i < MerkleDepthV2; i++ {
		api.AssertIsBoolean(bits[i])
		value = api.Add(value, api.Mul(bits[i], weight))
		weight <<= 1
	}
	return value
}

func merkleRootV2(
	api frontend.API,
	leaf frontend.Variable,
	path [MerkleDepthV2]frontend.Variable,
	index [MerkleDepthV2]frontend.Variable,
) (frontend.Variable, error) {
	current := leaf
	for i := 0; i < MerkleDepthV2; i++ {
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

func assertEnabledNonZeroV2(api frontend.API, enabled, value frontend.Variable) {
	api.AssertIsEqual(api.Mul(enabled, api.IsZero(value)), 0)
}

func (c *CircuitV2) Define(api frontend.API) error {
	api.AssertIsDifferent(c.AssetID, 0)
	api.AssertIsDifferent(c.RecipientBinding, 0)
	api.AssertIsDifferent(c.ContextBinding, 0)
	api.AssertIsDifferent(c.PublicAmount, 0)
	api.ToBinary(c.PublicAmount, 64)
	api.ToBinary(c.ProtocolFee, 64)
	api.ToBinary(c.RelayerFee, 64)
	api.ToBinary(c.InputCount, 3)

	inputTotal := frontend.Variable(0)
	enabledTotal := frontend.Variable(0)

	for i := 0; i < MaxInputsV2; i++ {
		enabled := c.InputEnabled[i]
		api.AssertIsBoolean(enabled)
		api.ToBinary(c.InputAmount[i], 64)

		// Active slots are a compact prefix. There are no hidden gaps such as
		// enabled=[1,0,1,0], which gives the statement one canonical layout.
		if i > 0 {
			api.AssertIsEqual(
				api.Mul(enabled, api.Sub(1, c.InputEnabled[i-1])),
				0,
			)
		}

		// Inactive slots carry no value or private opening. Their path may be any
		// valid boolean-indexed dummy path because it is not bound to a root.
		inactive := api.Sub(1, enabled)
		api.AssertIsEqual(api.Mul(inactive, c.InputAmount[i]), 0)
		api.AssertIsEqual(api.Mul(inactive, c.InputOwner[i]), 0)
		api.AssertIsEqual(api.Mul(inactive, c.InputNonce[i]), 0)
		assertEnabledNonZeroV2(api, enabled, c.InputAmount[i])
		assertEnabledNonZeroV2(api, enabled, c.InputOwner[i])
		assertEnabledNonZeroV2(api, enabled, c.InputNonce[i])

		commitment, err := noteCommitmentV1(
			api,
			c.AssetID,
			c.InputAmount[i],
			c.InputOwner[i],
			c.InputNonce[i],
		)
		if err != nil {
			return err
		}
		assertEnabledNonZeroV2(api, enabled, commitment)

		root, err := merkleRootV2(api, commitment, c.InputPath[i], c.InputIndex[i])
		if err != nil {
			return err
		}
		// Active input -> computed membership root must equal its public root.
		api.AssertIsEqual(api.Mul(enabled, api.Sub(root, c.InputRoots[i])), 0)
		// Inactive input -> public root is the zero sentinel.
		api.AssertIsEqual(api.Mul(inactive, c.InputRoots[i]), 0)
		assertEnabledNonZeroV2(api, enabled, c.InputRoots[i])

		nullifier, err := nullifierV1(api, c.InputOwner[i], c.InputNonce[i], commitment)
		if err != nil {
			return err
		}
		// A disabled slot exposes a zero nullifier, so the program can process
		// exactly InputCount entries without ambiguity.
		api.AssertIsEqual(c.Nullifiers[i], api.Mul(enabled, nullifier))
		assertEnabledNonZeroV2(api, enabled, c.Nullifiers[i])

		inputTotal = api.Add(inputTotal, api.Mul(enabled, c.InputAmount[i]))
		enabledTotal = api.Add(enabledTotal, enabled)
	}

	api.AssertIsEqual(enabledTotal, c.InputCount)
	api.AssertIsDifferent(c.InputCount, 0)

	// No active note may be listed twice in one proof.
	for left := 0; left < MaxInputsV2; left++ {
		for right := left + 1; right < MaxInputsV2; right++ {
			bothEnabled := api.Mul(c.InputEnabled[left], c.InputEnabled[right])
			sameNullifier := api.IsZero(api.Sub(c.Nullifiers[left], c.Nullifiers[right]))
			api.AssertIsEqual(api.Mul(bothEnabled, sameNullifier), 0)
		}
	}

	api.AssertIsBoolean(c.ChangeEnabled)
	api.ToBinary(c.ChangeAmount, 64)
	changeDisabled := api.Sub(1, c.ChangeEnabled)
	api.AssertIsEqual(api.Mul(changeDisabled, c.ChangeAmount), 0)
	api.AssertIsEqual(api.Mul(changeDisabled, c.ChangeOwner), 0)
	api.AssertIsEqual(api.Mul(changeDisabled, c.ChangeNonce), 0)
	assertEnabledNonZeroV2(api, c.ChangeEnabled, c.ChangeAmount)
	assertEnabledNonZeroV2(api, c.ChangeEnabled, c.ChangeOwner)
	assertEnabledNonZeroV2(api, c.ChangeEnabled, c.ChangeNonce)

	changeCommitment, err := noteCommitmentV1(
		api,
		c.AssetID,
		c.ChangeAmount,
		c.ChangeOwner,
		c.ChangeNonce,
	)
	if err != nil {
		return err
	}
	assertEnabledNonZeroV2(api, c.ChangeEnabled, changeCommitment)
	api.AssertIsEqual(c.ChangeCommitment, api.Mul(c.ChangeEnabled, changeCommitment))

	outputs := api.Add(c.PublicAmount, c.ProtocolFee, c.RelayerFee, c.ChangeAmount)
	api.AssertIsEqual(inputTotal, outputs)

	changeIndexValue := merkleIndexValueV2(api, c.ChangeIndex)
	api.AssertIsEqual(changeIndexValue, c.ChangeLeafIndex)

	rootBeforeChange, err := merkleRootV2(api, 0, c.ChangePath, c.ChangeIndex)
	if err != nil {
		return err
	}
	rootAfterChange, err := merkleRootV2(api, changeCommitment, c.ChangePath, c.ChangeIndex)
	if err != nil {
		return err
	}

	// First append in a fresh epoch uses the same zero-root sentinel as V1
	// deposits. Bind the entire path to the deterministic empty-tree siblings.
	isFirstChange := api.IsZero(c.ChangeLeafIndex)
	firstEnabled := api.Mul(c.ChangeEnabled, isFirstChange)
	emptySibling := frontend.Variable(0)
	for i := 0; i < MerkleDepthV2; i++ {
		api.AssertIsEqual(
			api.Mul(firstEnabled, api.Sub(c.ChangePath[i], emptySibling)),
			0,
		)
		emptySibling, err = hashV1(api, domainMerkleV1, emptySibling, emptySibling)
		if err != nil {
			return err
		}
	}
	api.AssertIsEqual(api.Mul(firstEnabled, c.CurrentRoot), 0)

	// For every non-first change append, prove the target leaf is still empty in
	// the exact latest active-tree root.
	notFirst := api.Sub(1, isFirstChange)
	nonFirstEnabled := api.Mul(c.ChangeEnabled, notFirst)
	api.AssertIsEqual(
		api.Mul(nonFirstEnabled, api.Sub(rootBeforeChange, c.CurrentRoot)),
		0,
	)

	// Enabled change appends one leaf; disabled change leaves tree state untouched.
	api.AssertIsEqual(
		api.Mul(c.ChangeEnabled, api.Sub(rootAfterChange, c.NewMerkleRoot)),
		0,
	)
	api.AssertIsEqual(
		api.Mul(changeDisabled, api.Sub(c.NewMerkleRoot, c.CurrentRoot)),
		0,
	)
	api.AssertIsEqual(api.Mul(changeDisabled, c.ChangeLeafIndex), 0)
	assertEnabledNonZeroV2(api, c.ChangeEnabled, c.NewMerkleRoot)

	return nil
}
