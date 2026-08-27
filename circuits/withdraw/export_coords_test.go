package withdraw

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark-crypto/ecc/bn254/fr"
	"github.com/consensys/gnark/backend/groth16"
	bn254groth16 "github.com/consensys/gnark/backend/groth16/bn254"
	"github.com/consensys/gnark/frontend"
)

type coordFixture struct {
	Proof        map[string]string `json:"proof"`
	VK           map[string]any    `json:"vk"`
	PublicInputs []string          `json:"public_inputs"`
}

func hx(value interface{ Bytes() [32]byte }) string {
	encoded := value.Bytes()
	return hex.EncodeToString(encoded[:])
}

// The proof, proving key, and verifying key exported here are intentionally
// produced by the same Setup call. Never mix artifacts from separate CI runs:
// development Groth16 setup is randomized.
func TestExportCoordinateFixture(t *testing.T) {
	if os.Getenv("WATCHER_EXPORT_COORDS") != "1" {
		t.Skip("set WATCHER_EXPORT_COORDS=1")
	}

	ccs, provingKey, verifyingKey := compileV1(t)
	assignment := validV1()
	witness, err := frontend.NewWitness(&assignment, ecc.BN254.ScalarField())
	if err != nil {
		t.Fatal(err)
	}
	publicWitness, err := witness.Public()
	if err != nil {
		t.Fatal(err)
	}
	proof, err := groth16.Prove(ccs, provingKey, witness)
	if err != nil {
		t.Fatal(err)
	}
	if err := groth16.Verify(proof, verifyingKey, publicWitness); err != nil {
		t.Fatal(err)
	}

	bnProof, ok := proof.(*bn254groth16.Proof)
	if !ok {
		t.Fatalf("unexpected proof type %T", proof)
	}
	bnVK, ok := verifyingKey.(*bn254groth16.VerifyingKey)
	if !ok {
		t.Fatalf("unexpected vk type %T", verifyingKey)
	}

	proofCoordinates := map[string]string{
		"a_x": hx(&bnProof.Ar.X), "a_y": hx(&bnProof.Ar.Y),
		"b_x0": hx(&bnProof.Bs.X.A0), "b_x1": hx(&bnProof.Bs.X.A1),
		"b_y0": hx(&bnProof.Bs.Y.A0), "b_y1": hx(&bnProof.Bs.Y.A1),
		"c_x": hx(&bnProof.Krs.X), "c_y": hx(&bnProof.Krs.Y),
	}
	verifyingKeyCoordinates := map[string]any{
		"alpha_x": hx(&bnVK.G1.Alpha.X), "alpha_y": hx(&bnVK.G1.Alpha.Y),
		"beta_x0": hx(&bnVK.G2.Beta.X.A0), "beta_x1": hx(&bnVK.G2.Beta.X.A1),
		"beta_y0": hx(&bnVK.G2.Beta.Y.A0), "beta_y1": hx(&bnVK.G2.Beta.Y.A1),
		"gamma_x0": hx(&bnVK.G2.Gamma.X.A0), "gamma_x1": hx(&bnVK.G2.Gamma.X.A1),
		"gamma_y0": hx(&bnVK.G2.Gamma.Y.A0), "gamma_y1": hx(&bnVK.G2.Gamma.Y.A1),
		"delta_x0": hx(&bnVK.G2.Delta.X.A0), "delta_x1": hx(&bnVK.G2.Delta.X.A1),
		"delta_y0": hx(&bnVK.G2.Delta.Y.A0), "delta_y1": hx(&bnVK.G2.Delta.Y.A1),
	}
	ic := make([]map[string]string, len(bnVK.G1.K))
	for index := range bnVK.G1.K {
		ic[index] = map[string]string{
			"x": hx(&bnVK.G1.K[index].X),
			"y": hx(&bnVK.G1.K[index].Y),
		}
	}
	verifyingKeyCoordinates["ic"] = ic

	vector, ok := publicWitness.Vector().(fr.Vector)
	if !ok {
		t.Fatalf("unexpected public vector type %T", publicWitness.Vector())
	}
	publicInputs := make([]string, len(vector))
	for index := range vector {
		encoded := vector[index].Bytes()
		publicInputs[index] = hex.EncodeToString(encoded[:])
	}

	fixture := coordFixture{
		Proof: proofCoordinates,
		VK: verifyingKeyCoordinates,
		PublicInputs: publicInputs,
	}
	encoded, err := json.MarshalIndent(fixture, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll("fixture-out", 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join("fixture-out", "coordinates.json"), encoded, 0o644); err != nil {
		t.Fatal(err)
	}
	exportProverArtifactsV1(t, "withdraw", ccs, provingKey, verifyingKey, proof, publicWitness)
	t.Logf("exported matched withdrawal proof, prover bundle, %d IC points, and %d public inputs", len(ic), len(publicInputs))
}
