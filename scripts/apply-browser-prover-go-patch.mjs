#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';

function replaceOnce(source, needle, replacement, label) {
  const first = source.indexOf(needle);
  if (first < 0) throw new Error(`missing ${label}`);
  if (source.indexOf(needle, first + needle.length) >= 0) {
    throw new Error(`${label} is not unique`);
  }
  return source.slice(0, first) + replacement + source.slice(first + needle.length);
}

function replaceRegexOnce(source, pattern, replacement, label) {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const matches = [...source.matchAll(new RegExp(pattern.source, flags))];
  if (matches.length !== 1) {
    throw new Error(`expected one ${label}, found ${matches.length}`);
  }
  return source.replace(pattern, replacement);
}

const proverPath = 'circuits/withdraw/prover_v1.go';
let prover = readFileSync(proverPath, 'utf8');
if (!prover.includes('LoadProverBundleBytesV1')) {
  const loader = `const proverBundleArtifactNamesV1 = "deposit.r1cs,deposit.pk,deposit.vk,withdraw.r1cs,withdraw.pk,withdraw.vk"

func proverBundleNamesV1() []string {
	return strings.Split(proverBundleArtifactNamesV1, ",")
}

func requiredArtifactV1(artifacts map[string][]byte, name string) ([]byte, error) {
	value, ok := artifacts[name]
	if !ok || len(value) == 0 {
		return nil, fmt.Errorf("prover bundle artifact %s is missing or empty", name)
	}
	return value, nil
}

func readArtifactBytesV1(data []byte, destination io.ReaderFrom) error {
	_, err := destination.ReadFrom(bytes.NewReader(data))
	return err
}

func bundleDigestBytesV1(artifacts map[string][]byte) (string, error) {
	hasher := sha256.New()
	for _, name := range proverBundleNamesV1() {
		data, err := requiredArtifactV1(artifacts, name)
		if err != nil {
			return "", err
		}
		_, _ = hasher.Write([]byte(name))
		_, _ = hasher.Write([]byte{0})
		_, _ = hasher.Write(data)
	}
	return hex.EncodeToString(hasher.Sum(nil)), nil
}

func loadCircuitArtifactsBytesV1(
	artifacts map[string][]byte,
	prefix string,
) (constraint.ConstraintSystem, groth16.ProvingKey, groth16.VerifyingKey, error) {
	ccs := groth16.NewCS(ecc.BN254)
	provingKey := groth16.NewProvingKey(ecc.BN254)
	verifyingKey := groth16.NewVerifyingKey(ecc.BN254)

	r1cs, err := requiredArtifactV1(artifacts, prefix+".r1cs")
	if err != nil {
		return nil, nil, nil, err
	}
	if err := readArtifactBytesV1(r1cs, ccs); err != nil {
		return nil, nil, nil, fmt.Errorf("load %s r1cs: %w", prefix, err)
	}
	pk, err := requiredArtifactV1(artifacts, prefix+".pk")
	if err != nil {
		return nil, nil, nil, err
	}
	if err := readArtifactBytesV1(pk, provingKey); err != nil {
		return nil, nil, nil, fmt.Errorf("load %s proving key: %w", prefix, err)
	}
	vk, err := requiredArtifactV1(artifacts, prefix+".vk")
	if err != nil {
		return nil, nil, nil, err
	}
	if err := readArtifactBytesV1(vk, verifyingKey); err != nil {
		return nil, nil, nil, fmt.Errorf("load %s verifying key: %w", prefix, err)
	}
	return ccs, provingKey, verifyingKey, nil
}

// LoadProverBundleBytesV1 loads the matched development bundle entirely from
// memory. The browser WebAssembly entrypoint uses this path so private witness
// data never leaves the user's device and no virtual filesystem is required.
func LoadProverBundleBytesV1(artifacts map[string][]byte) (*ProverBundleV1, error) {
	depositCS, depositPK, depositVK, err := loadCircuitArtifactsBytesV1(artifacts, "deposit")
	if err != nil {
		return nil, err
	}
	withdrawCS, withdrawPK, withdrawVK, err := loadCircuitArtifactsBytesV1(artifacts, "withdraw")
	if err != nil {
		return nil, err
	}
	if depositVK.NbPublicWitness() != 3 {
		return nil, fmt.Errorf("deposit verifying key expects %d public inputs, want 3", depositVK.NbPublicWitness())
	}
	if withdrawVK.NbPublicWitness() != 10 {
		return nil, fmt.Errorf("withdraw verifying key expects %d public inputs, want 10", withdrawVK.NbPublicWitness())
	}
	digest, err := bundleDigestBytesV1(artifacts)
	if err != nil {
		return nil, fmt.Errorf("hash prover bundle: %w", err)
	}
	return &ProverBundleV1{
		DepositCS: depositCS, DepositPK: depositPK, DepositVK: depositVK,
		WithdrawCS: withdrawCS, WithdrawPK: withdrawPK, WithdrawVK: withdrawVK,
		Digest: digest,
	}, nil
}

func LoadProverBundleV1(directory string) (*ProverBundleV1, error) {
	artifacts := make(map[string][]byte, 6)
	for _, name := range proverBundleNamesV1() {
		data, err := os.ReadFile(filepath.Join(directory, name))
		if err != nil {
			return nil, fmt.Errorf("read prover bundle artifact %s: %w", name, err)
		}
		artifacts[name] = data
	}
	return LoadProverBundleBytesV1(artifacts)
}

func appendCoordinateLittleEndianV1`;

  prover = replaceRegexOnce(
    prover,
    /func readArtifactV1\(path string, destination io\.ReaderFrom\) error \{[\s\S]*?\n\}\n\nfunc appendCoordinateLittleEndianV1/,
    loader,
    'prover bundle loader block',
  );
  writeFileSync(proverPath, prover);
}

const setupPath = 'circuits/withdraw/cmd/watcher-setup/main.go';
let setup = readFileSync(setupPath, 'utf8');
if (!setup.includes('"withdraw.r1cs"')) {
  setup = replaceOnce(
    setup,
    'files := map[string][]byte{\n\t\t"withdraw.pk":',
    'files := map[string][]byte{\n\t\t"withdraw.r1cs":                       withdrawal.constraintSystem,\n\t\t"withdraw.pk":',
    'withdraw R1CS bundle entry',
  );
  setup = replaceOnce(
    setup,
    '\t\t"deposit.pk":',
    '\t\t"deposit.r1cs":                        deposits.constraintSystem,\n\t\t"deposit.pk":',
    'deposit R1CS bundle entry',
  );
  setup = replaceOnce(
    setup,
    'type setupResult struct {\n\tprovingKey, verifyingKey []byte',
    'type setupResult struct {\n\tconstraintSystem        []byte\n\tprovingKey, verifyingKey []byte',
    'withdraw setup result R1CS field',
  );
  setup = replaceOnce(
    setup,
    'type depositSetupResult struct {\n\tprovingKey, verifyingKey []byte',
    'type depositSetupResult struct {\n\tconstraintSystem        []byte\n\tprovingKey, verifyingKey []byte',
    'deposit setup result R1CS field',
  );
  setup = replaceOnce(
    setup,
    'return setupResult{\n\t\tprovingKey: writeToBytes(pk), verifyingKey: writeToBytes(vk), verifierWire: vkWire,',
    'return setupResult{\n\t\tconstraintSystem: writeToBytes(ccs),\n\t\tprovingKey: writeToBytes(pk), verifyingKey: writeToBytes(vk), verifierWire: vkWire,',
    'withdraw setup result assignment',
  );
  setup = replaceOnce(
    setup,
    'return depositSetupResult{\n\t\tprovingKey: writeToBytes(pk), verifyingKey: writeToBytes(vk), verifierWire: vkWire,',
    'return depositSetupResult{\n\t\tconstraintSystem: writeToBytes(ccs),\n\t\tprovingKey: writeToBytes(pk), verifyingKey: writeToBytes(vk), verifierWire: vkWire,',
    'deposit setup result assignment',
  );
  writeFileSync(setupPath, setup);
}

console.log('Browser prover Go patch applied.');
