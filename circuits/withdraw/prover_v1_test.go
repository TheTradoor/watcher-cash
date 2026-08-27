package withdraw

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDepositWitnessJSONRejectsUnknownFields(t *testing.T) {
	_, err := depositAssignmentFromJSONV1([]byte(`{
		"Owner":"1","Nonce":"2","Commitment":"3","Amount":"4","AssetID":"1","Unknown":"5"
	}`))
	if err == nil || !strings.Contains(err.Error(), "unknown field") {
		t.Fatalf("expected unknown-field rejection, got %v", err)
	}
}

func TestWithdrawWitnessJSONRejectsInvalidIndexBit(t *testing.T) {
	assignment := validV1()
	encoded, err := json.Marshal(assignment)
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	if err := json.Unmarshal(encoded, &payload); err != nil {
		t.Fatal(err)
	}
	payload["Input0Index"] = []int{0, 2, 0, 0}
	encoded, err = json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	_, err = withdrawAssignmentFromJSONV1(encoded)
	if err == nil || !strings.Contains(err.Error(), "must be 0 or 1") {
		t.Fatalf("expected index-bit rejection, got %v", err)
	}
}

func TestExportedProverBundleRoundTrip(t *testing.T) {
	directory := os.Getenv("WATCHER_PROVER_ASSETS")
	if directory == "" {
		t.Skip("set WATCHER_PROVER_ASSETS to exported fixture-out directory")
	}
	bundle, err := LoadProverBundleV1(directory)
	if err != nil {
		t.Fatal(err)
	}
	if len(bundle.Digest) != 64 {
		t.Fatalf("unexpected bundle digest %q", bundle.Digest)
	}

	depositJSON, err := json.Marshal(validDepositV1())
	if err != nil {
		t.Fatal(err)
	}
	depositProof, err := bundle.ProveDepositJSON(depositJSON)
	if err != nil {
		t.Fatal(err)
	}
	if depositProof.ProofBytes != XarkProofBytesV1 || depositProof.PublicInputBytes != DepositPublicInputBytesV1 {
		t.Fatalf("unexpected deposit response lengths: %+v", depositProof)
	}
	depositPublic, err := hex.DecodeString(depositProof.PublicInputsHex)
	if err != nil {
		t.Fatal(err)
	}
	expectedDepositPublic, err := os.ReadFile(filepath.Join(directory, "deposit.public.xark"))
	if err != nil {
		t.Fatal(err)
	}
	if string(depositPublic) != string(expectedDepositPublic) {
		t.Fatal("deposit prover public inputs do not match exported fixture")
	}

	withdrawJSON, err := json.Marshal(validV1())
	if err != nil {
		t.Fatal(err)
	}
	withdrawProof, err := bundle.ProveWithdrawJSON(withdrawJSON)
	if err != nil {
		t.Fatal(err)
	}
	if withdrawProof.ProofBytes != XarkProofBytesV1 || withdrawProof.PublicInputBytes != WithdrawPublicInputBytesV1 {
		t.Fatalf("unexpected withdrawal response lengths: %+v", withdrawProof)
	}
	withdrawPublic, err := hex.DecodeString(withdrawProof.PublicInputsHex)
	if err != nil {
		t.Fatal(err)
	}
	expectedWithdrawPublic, err := os.ReadFile(filepath.Join(directory, "withdraw.public.xark"))
	if err != nil {
		t.Fatal(err)
	}
	if string(withdrawPublic) != string(expectedWithdrawPublic) {
		t.Fatal("withdraw prover public inputs do not match exported fixture")
	}
}
