package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	withdraw "watcher.cash/circuits/withdraw"
)

const maxWitnessRequestBytes = 256 << 10

type server struct {
	bundle         *withdraw.ProverBundleV1
	allowedOrigins map[string]struct{}
}

func environmentOr(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func parseOrigins(value string) map[string]struct{} {
	result := make(map[string]struct{})
	for _, item := range strings.Split(value, ",") {
		origin := strings.TrimSpace(item)
		if origin != "" {
			result[origin] = struct{}{}
		}
	}
	return result
}

func (service *server) applyCORS(response http.ResponseWriter, request *http.Request) bool {
	origin := request.Header.Get("Origin")
	if origin == "" {
		return true
	}
	if _, allowed := service.allowedOrigins[origin]; !allowed {
		http.Error(response, "origin is not allowed by local prover", http.StatusForbidden)
		return false
	}
	response.Header().Set("Access-Control-Allow-Origin", origin)
	response.Header().Set("Vary", "Origin")
	response.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	response.Header().Set("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
	return true
}

func writeJSON(response http.ResponseWriter, status int, value any) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	if err := json.NewEncoder(response).Encode(value); err != nil {
		log.Printf("encode response: %v", err)
	}
}

func (service *server) health(response http.ResponseWriter, request *http.Request) {
	if !service.applyCORS(response, request) {
		return
	}
	if request.Method == http.MethodOptions {
		response.WriteHeader(http.StatusNoContent)
		return
	}
	if request.Method != http.MethodGet {
		http.Error(response, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{
		"status": "ready",
		"curve": "BN254",
		"scheme": "Groth16",
		"bundleDigest": service.bundle.Digest,
		"circuits": []string{"deposit-v1", "withdraw-v1"},
	})
}

func readWitness(response http.ResponseWriter, request *http.Request) ([]byte, error) {
	request.Body = http.MaxBytesReader(response, request.Body, maxWitnessRequestBytes)
	defer request.Body.Close()
	data, err := io.ReadAll(request.Body)
	if err != nil {
		return nil, err
	}
	if len(data) == 0 {
		return nil, fmt.Errorf("empty witness request")
	}
	return data, nil
}

func (service *server) prove(
	response http.ResponseWriter,
	request *http.Request,
	prove func([]byte) (withdraw.ProofResponseV1, error),
) {
	if !service.applyCORS(response, request) {
		return
	}
	if request.Method == http.MethodOptions {
		response.WriteHeader(http.StatusNoContent)
		return
	}
	if request.Method != http.MethodPost {
		http.Error(response, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	data, err := readWitness(response, request)
	if err != nil {
		writeJSON(response, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	// Witness bytes are deliberately never logged. The local process is the only
	// component that sees owner, nonce, amount, and Merkle path secrets.
	result, err := prove(data)
	if err != nil {
		writeJSON(response, http.StatusUnprocessableEntity, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(response, http.StatusOK, result)
}

func main() {
	assets := flag.String(
		"assets",
		environmentOr("WATCHER_PROVER_ASSETS", "fixture-out"),
		"directory containing matched .r1cs, .pk, and .vk files",
	)
	listen := flag.String(
		"listen",
		environmentOr("WATCHER_PROVER_LISTEN", "127.0.0.1:8090"),
		"local HTTP listen address",
	)
	origins := flag.String(
		"origins",
		environmentOr("WATCHER_PROVER_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000"),
		"comma-separated browser origins allowed to call this local prover",
	)
	flag.Parse()

	bundle, err := withdraw.LoadProverBundleV1(*assets)
	if err != nil {
		log.Fatalf("load prover bundle: %v", err)
	}
	service := &server{bundle: bundle, allowedOrigins: parseOrigins(*origins)}
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", service.health)
	mux.HandleFunc("/v1/prove/deposit", func(response http.ResponseWriter, request *http.Request) {
		service.prove(response, request, bundle.ProveDepositJSON)
	})
	mux.HandleFunc("/v1/prove/withdraw", func(response http.ResponseWriter, request *http.Request) {
		service.prove(response, request, bundle.ProveWithdrawJSON)
	})

	httpServer := &http.Server{
		Addr: *listen,
		Handler: mux,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout: 30 * time.Second,
		WriteTimeout: 10 * time.Minute,
		IdleTimeout: 30 * time.Second,
	}
	log.Printf("Watcher local prover ready on http://%s (bundle %s)", *listen, bundle.Digest)
	if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
