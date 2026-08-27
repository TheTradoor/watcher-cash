package withdraw

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark/backend/groth16"
	"github.com/consensys/gnark/constraint"
)

type ProverBundleBytesV1 struct {
	DepositR1CS  []byte
	DepositPK    []byte
	DepositVK    []byte
	WithdrawR1CS []byte
	WithdrawPK   []byte
	WithdrawVK   []byte
}

func readArtifactBytesV1(data []byte, destination io.ReaderFrom) error {
	if len(data) == 0 {
		return fmt.Errorf("artifact is empty")
	}
	if _, err := destination.ReadFrom(bytes.NewReader(data)); err != nil {
		return err
	}
	return nil
}

func loadCircuitArtifactBytesV1(
	prefix string,
	r1csBytes []byte,
	provingKeyBytes []byte,
	verifyingKeyBytes []byte,
) (constraint.ConstraintSystem, groth16.ProvingKey, groth16.VerifyingKey, error) {
	ccs := groth16.NewCS(ecc.BN254)
	provingKey := groth16.NewProvingKey(ecc.BN254)
	verifyingKey := groth16.NewVerifyingKey(ecc.BN254)
	if err := readArtifactBytesV1(r1csBytes, ccs); err != nil {
		return nil, nil, nil, fmt.Errorf("load %s r1cs: %w", prefix, err)
	}
	if err := readArtifactBytesV1(provingKeyBytes, provingKey); err != nil {
		return nil, nil, nil, fmt.Errorf("load %s proving key: %w", prefix, err)
	}
	if err := readArtifactBytesV1(verifyingKeyBytes, verifyingKey); err != nil {
		return nil, nil, nil, fmt.Errorf("load %s verifying key: %w", prefix, err)
	}
	return ccs, provingKey, verifyingKey, nil
}

func bundleDigestBytesV1(bundle ProverBundleBytesV1) string {
	named := []struct {
		name string
		data []byte
	}{
		{"deposit.r1cs", bundle.DepositR1CS},
		{"deposit.pk", bundle.DepositPK},
		{"deposit.vk", bundle.DepositVK},
		{"withdraw.r1cs", bundle.WithdrawR1CS},
		{"withdraw.pk", bundle.WithdrawPK},
		{"withdraw.vk", bundle.WithdrawVK},
	}
	hasher := sha256.New()
	for _, artifact := range named {
		_, _ = hasher.Write([]byte(artifact.name))
		_, _ = hasher.Write([]byte{0})
		_, _ = hasher.Write(artifact.data)
	}
	return hex.EncodeToString(hasher.Sum(nil))
}

func LoadProverBundleBytesV1(encoded ProverBundleBytesV1) (*ProverBundleV1, error) {
	depositCS, depositPK, depositVK, err := loadCircuitArtifactBytesV1(
		"deposit",
		encoded.DepositR1CS,
		encoded.DepositPK,
		encoded.DepositVK,
	)
	if err != nil {
		return nil, err
	}
	withdrawCS, withdrawPK, withdrawVK, err := loadCircuitArtifactBytesV1(
		"withdraw",
		encoded.WithdrawR1CS,
		encoded.WithdrawPK,
		encoded.WithdrawVK,
	)
	if err != nil {
		return nil, err
	}
	if depositVK.NbPublicWitness() != 3 {
		return nil, fmt.Errorf(
			"deposit verifying key expects %d public inputs, want 3",
			depositVK.NbPublicWitness(),
		)
	}
	if withdrawVK.NbPublicWitness() != 10 {
		return nil, fmt.Errorf(
			"withdraw verifying key expects %d public inputs, want 10",
			withdrawVK.NbPublicWitness(),
		)
	}
	return &ProverBundleV1{
		DepositCS:  depositCS,
		DepositPK:  depositPK,
		DepositVK:  depositVK,
		WithdrawCS: withdrawCS,
		WithdrawPK: withdrawPK,
		WithdrawVK: withdrawVK,
		Digest:     bundleDigestBytesV1(encoded),
	}, nil
}
