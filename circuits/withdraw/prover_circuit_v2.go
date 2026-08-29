package withdraw

import (
	"encoding/hex"
	"fmt"
	"sync"

	"github.com/consensys/gnark/backend/groth16"
	"github.com/consensys/gnark/constraint"
)

// CircuitProverV2 is a circuit-scoped view of the existing V2 Groth16 setup.
// It intentionally reuses the exact same R1CS/proving/verifying key bytes and
// proof/public-input encoding as ProverBundleV2; the only difference is that a
// browser can deserialize deposit and withdrawal artifacts independently.
type CircuitProverV2 struct {
	Circuit string
	CS      constraint.ConstraintSystem
	PK      groth16.ProvingKey
	VK      groth16.VerifyingKey
	Digest  string
	mutex   sync.Mutex
}

func validateCircuitDigestV2(value string) error {
	decoded, err := hex.DecodeString(value)
	if err != nil || len(decoded) != 32 {
		return fmt.Errorf("V2 circuit prover digest must be a 32-byte SHA-256 hex digest")
	}
	return nil
}

// LoadCircuitProverBytesV2 deserializes only one circuit from an already
// integrity-checked artifact map. digest identifies the exact browser manifest
// that supplied those bytes; on-chain verification remains bound to the same
// committed V2/V3 verifying keys.
func LoadCircuitProverBytesV2(artifacts map[string][]byte, circuit, digest string) (*CircuitProverV2, error) {
	if err := validateCircuitDigestV2(digest); err != nil {
		return nil, err
	}
	if circuit != "deposit" && circuit != "withdraw" {
		return nil, fmt.Errorf("unsupported V2 circuit %q", circuit)
	}

	cs, pk, vk, err := loadCircuitArtifactsBytesV1(artifacts, circuit)
	if err != nil {
		return nil, err
	}
	expectedPublic := 8
	if circuit == "withdraw" {
		expectedPublic = 19
	}
	if vk.NbPublicWitness() != expectedPublic {
		return nil, fmt.Errorf("V2 %s verifying key expects %d public inputs, want %d", circuit, vk.NbPublicWitness(), expectedPublic)
	}

	return &CircuitProverV2{
		Circuit: circuit,
		CS:      cs,
		PK:      pk,
		VK:      vk,
		Digest:  digest,
	}, nil
}

func (prover *CircuitProverV2) ProveJSON(data []byte) (ProofResponseV1, error) {
	if prover == nil || prover.CS == nil || prover.PK == nil || prover.VK == nil {
		return ProofResponseV1{}, fmt.Errorf("V2 circuit prover is not loaded")
	}
	prover.mutex.Lock()
	defer prover.mutex.Unlock()

	switch prover.Circuit {
	case "deposit":
		assignment, err := depositAssignmentFromJSONV2(data)
		if err != nil {
			return ProofResponseV1{}, err
		}
		response, err := proveAssignmentV1("deposit-v2", prover.CS, prover.PK, prover.VK, &assignment, prover.Digest)
		if err != nil {
			return ProofResponseV1{}, err
		}
		if response.PublicInputBytes != DepositPublicInputBytesV2 {
			return ProofResponseV1{}, fmt.Errorf("V2 deposit public input length is %d, want %d", response.PublicInputBytes, DepositPublicInputBytesV2)
		}
		return response, nil
	case "withdraw":
		assignment, err := withdrawAssignmentFromJSONV2(data)
		if err != nil {
			return ProofResponseV1{}, err
		}
		response, err := proveAssignmentV1("withdraw-v2", prover.CS, prover.PK, prover.VK, &assignment, prover.Digest)
		if err != nil {
			return ProofResponseV1{}, err
		}
		if response.PublicInputBytes != WithdrawPublicInputBytesV2 {
			return ProofResponseV1{}, fmt.Errorf("V2 withdraw public input length is %d, want %d", response.PublicInputBytes, WithdrawPublicInputBytesV2)
		}
		return response, nil
	default:
		return ProofResponseV1{}, fmt.Errorf("unsupported V2 circuit %q", prover.Circuit)
	}
}
