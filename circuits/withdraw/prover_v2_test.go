package withdraw

import (
	"encoding/json"
	"fmt"
	"math/big"
	"testing"
)

func decimalStringV2(value any) string {
	switch typed := value.(type) {
	case *big.Int:
		return typed.String()
	case big.Int:
		return typed.String()
	case int:
		return fmt.Sprintf("%d", typed)
	case int64:
		return fmt.Sprintf("%d", typed)
	case uint64:
		return fmt.Sprintf("%d", typed)
	case uint8:
		return fmt.Sprintf("%d", typed)
	case nil:
		return "0"
	default:
		return fmt.Sprint(value)
	}
}

func pathStringsV2(values [MerkleDepthV2]frontend.Variable) []string {
	output := make([]string, MerkleDepthV2)
	for index, value := range values {
		output[index] = decimalStringV2(value)
	}
	return output
}

func bitValuesV2(values [MerkleDepthV2]frontend.Variable) []uint8 {
	output := make([]uint8, MerkleDepthV2)
	for index, value := range values {
		switch typed := value.(type) {
		case int:
			output[index] = uint8(typed)
		case uint8:
			output[index] = typed
		case *big.Int:
			output[index] = uint8(typed.Uint64())
		default:
			panic(fmt.Sprintf("unsupported bit fixture type %T", value))
		}
	}
	return output
}

func depositJSONV2(t *testing.T) []byte {
	t.Helper()
	assignment := validFirstDepositV2()
	encoded := map[string]any{
		"Owner": decimalStringV2(assignment.Owner),
		"Nonce": decimalStringV2(assignment.Nonce),
		"Path": pathStringsV2(assignment.Path),
		"Index": bitValuesV2(assignment.Index),
		"Commitment": decimalStringV2(assignment.Commitment),
		"Amount": decimalStringV2(assignment.Amount),
		"AssetID": decimalStringV2(assignment.AssetID),
		"Epoch": decimalStringV2(assignment.Epoch),
		"ContextBinding": decimalStringV2(assignment.ContextBinding),
		"OldRoot": decimalStringV2(assignment.OldRoot),
		"NewRoot": decimalStringV2(assignment.NewRoot),
		"LeafIndex": decimalStringV2(assignment.LeafIndex),
	}
	data, err := json.Marshal(encoded)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func withdrawJSONV2(t *testing.T, inputCount int, changeAmount int64) []byte {
	t.Helper()
	assignment := validV2(inputCount, changeAmount)
	inputs := make([]map[string]any, MaxInputsV2)
	for index := 0; index < MaxInputsV2; index++ {
		inputs[index] = map[string]any{
			"Enabled": assignment.InputEnabled[index],
			"Amount": decimalStringV2(assignment.InputAmount[index]),
			"Owner": decimalStringV2(assignment.InputOwner[index]),
			"Nonce": decimalStringV2(assignment.InputNonce[index]),
			"Path": pathStringsV2(assignment.InputPath[index]),
			"Index": bitValuesV2(assignment.InputIndex[index]),
			"Root": decimalStringV2(assignment.InputRoots[index]),
			"Nullifier": decimalStringV2(assignment.Nullifiers[index]),
		}
	}
	encoded := map[string]any{
		"Inputs": inputs,
		"Change": map[string]any{
			"Enabled": assignment.ChangeEnabled,
			"Amount": decimalStringV2(assignment.ChangeAmount),
			"Owner": decimalStringV2(assignment.ChangeOwner),
			"Nonce": decimalStringV2(assignment.ChangeNonce),
			"Path": pathStringsV2(assignment.ChangePath),
			"Index": bitValuesV2(assignment.ChangeIndex),
		},
		"InputCount": decimalStringV2(assignment.InputCount),
		"ChangeCommitment": decimalStringV2(assignment.ChangeCommitment),
		"PublicAmount": decimalStringV2(assignment.PublicAmount),
		"ProtocolFee": decimalStringV2(assignment.ProtocolFee),
		"RelayerFee": decimalStringV2(assignment.RelayerFee),
		"RecipientBinding": decimalStringV2(assignment.RecipientBinding),
		"AssetID": decimalStringV2(assignment.AssetID),
		"ContextBinding": decimalStringV2(assignment.ContextBinding),
		"CurrentRoot": decimalStringV2(assignment.CurrentRoot),
		"NewMerkleRoot": decimalStringV2(assignment.NewMerkleRoot),
		"ChangeLeafIndex": decimalStringV2(assignment.ChangeLeafIndex),
	}
	data, err := json.Marshal(encoded)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestProverV2ParsesDepth16DepositWitness(t *testing.T) {
	assignment, err := depositAssignmentFromJSONV2(depositJSONV2(t))
	if err != nil {
		t.Fatal(err)
	}
	if len(assignment.Path) != MerkleDepthV2 || len(assignment.Index) != MerkleDepthV2 {
		t.Fatal("V2 deposit witness did not retain depth-16 path")
	}
}

func TestProverV2ParsesOneInputExactWithdrawal(t *testing.T) {
	assignment, err := withdrawAssignmentFromJSONV2(withdrawJSONV2(t, 1, 0))
	if err != nil {
		t.Fatal(err)
	}
	if decimalStringV2(assignment.InputCount) != "1" {
		t.Fatalf("unexpected input count %v", assignment.InputCount)
	}
	if decimalStringV2(assignment.ChangeCommitment) != "0"
		|| decimalStringV2(assignment.CurrentRoot) != "0"
		|| decimalStringV2(assignment.NewMerkleRoot) != "0" {
		t.Fatal("exact V2 withdrawal parser must retain zero append sentinels")
	}
}

func TestProverV2ParsesFourInputChangeWithdrawal(t *testing.T) {
	assignment, err := withdrawAssignmentFromJSONV2(withdrawJSONV2(t, 4, 3_000_000))
	if err != nil {
		t.Fatal(err)
	}
	if decimalStringV2(assignment.InputCount) != "4" {
		t.Fatalf("unexpected input count %v", assignment.InputCount)
	}
	if decimalStringV2(assignment.ChangeCommitment) == "0" {
		t.Fatal("expected private change commitment")
	}
}

func TestProverV2RejectsNonCanonicalInactiveSlot(t *testing.T) {
	var encoded map[string]any
	if err := json.Unmarshal(withdrawJSONV2(t, 1, 0), &encoded); err != nil {
		t.Fatal(err)
	}
	inputs := encoded["Inputs"].([]any)
	inputs[2].(map[string]any)["Amount"] = "1"
	data, err := json.Marshal(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := withdrawAssignmentFromJSONV2(data); err == nil {
		t.Fatal("expected non-canonical inactive slot to fail")
	}
}

func TestProverV2RejectsShortMerklePath(t *testing.T) {
	var encoded map[string]any
	if err := json.Unmarshal(depositJSONV2(t), &encoded); err != nil {
		t.Fatal(err)
	}
	encoded["Path"] = encoded["Path"].([]any)[:MerkleDepthV2-1]
	data, err := json.Marshal(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := depositAssignmentFromJSONV2(data); err == nil {
		t.Fatal("expected short V2 Merkle path to fail")
	}
}
