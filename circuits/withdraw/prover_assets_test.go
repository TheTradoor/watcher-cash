package withdraw

import (
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/consensys/gnark/backend/groth16"
	backendwitness "github.com/consensys/gnark/backend/witness"
	"github.com/consensys/gnark/constraint"
)

func writeSerializableFixtureV1(t *testing.T, path string, value io.WriterTo) {
	t.Helper()
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if _, err := value.WriteTo(file); err != nil {
		t.Fatal(err)
	}
}

func exportProverArtifactsV1(
	t *testing.T,
	prefix string,
	ccs constraint.ConstraintSystem,
	provingKey groth16.ProvingKey,
	verifyingKey groth16.VerifyingKey,
	proof groth16.Proof,
	publicWitness backendwitness.Witness,
) {
	t.Helper()
	if err := os.MkdirAll("fixture-out", 0o755); err != nil {
		t.Fatal(err)
	}
	writeSerializableFixtureV1(t, filepath.Join("fixture-out", prefix+".r1cs"), ccs)
	writeSerializableFixtureV1(t, filepath.Join("fixture-out", prefix+".pk"), provingKey)
	writeSerializableFixtureV1(t, filepath.Join("fixture-out", prefix+".vk"), verifyingKey)

	wireProof, err := XarkWireProofV1(proof)
	if err != nil {
		t.Fatal(err)
	}
	publicInputs, err := XarkPublicWitnessV1(publicWitness)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join("fixture-out", prefix+".proof.xark"), wireProof, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join("fixture-out", prefix+".public.xark"), publicInputs, 0o644); err != nil {
		t.Fatal(err)
	}
}
