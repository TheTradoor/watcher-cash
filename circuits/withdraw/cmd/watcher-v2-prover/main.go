package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"

	"github.com/consensys/gnark/logger"

	withdraw "watcher.cash/circuits/withdraw"
)

func main() {
	// The CLI is consumed by browser/E2E transports. Keep stdout reserved for
	// the proof response instead of mixing zerolog progress output with JSON.
	logger.Disable()

	bundleDir := flag.String("bundle", "fixture-out/v2", "V2 proving bundle directory")
	circuit := flag.String("circuit", "", "deposit or withdraw")
	witnessPath := flag.String("witness", "", "witness JSON file; defaults to stdin")
	flag.Parse()
	if *circuit != "deposit" && *circuit != "withdraw" {
		fmt.Fprintln(os.Stderr, "--circuit must be deposit or withdraw")
		os.Exit(2)
	}
	bundle, err := withdraw.LoadProverBundleV2(*bundleDir)
	if err != nil {
		fmt.Fprintln(os.Stderr, "load V2 prover bundle:", err)
		os.Exit(1)
	}
	var data []byte
	if *witnessPath == "" {
		data, err = io.ReadAll(os.Stdin)
	} else {
		data, err = os.ReadFile(*witnessPath)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "read witness:", err)
		os.Exit(1)
	}
	var response withdraw.ProofResponseV1
	if *circuit == "deposit" {
		response, err = bundle.ProveDepositJSON(data)
	} else {
		response, err = bundle.ProveWithdrawJSON(data)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "prove V2", *circuit+":", err)
		os.Exit(1)
	}
	encoder := json.NewEncoder(os.Stdout)
	if err := encoder.Encode(response); err != nil {
		fmt.Fprintln(os.Stderr, "encode response:", err)
		os.Exit(1)
	}
}
