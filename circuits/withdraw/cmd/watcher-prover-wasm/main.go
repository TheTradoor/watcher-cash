//go:build js && wasm

package main

import (
	"encoding/json"
	"fmt"
	"syscall/js"

	withdraw "watcher.cash/circuits/withdraw"
)

var (
	bundle     *withdraw.ProverBundleV1
	registered []js.Func
)

func jsonResult(value any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return `{"error":"failed to encode WebAssembly prover response"}`
	}
	return string(encoded)
}

func errorResult(err error) string {
	return jsonResult(map[string]string{"error": err.Error()})
}

func bytesFromJS(value js.Value, label string) ([]byte, error) {
	if value.Type() == js.TypeUndefined || value.Type() == js.TypeNull {
		return nil, fmt.Errorf("%s is missing", label)
	}
	length := value.Get("byteLength").Int()
	if length <= 0 {
		return nil, fmt.Errorf("%s is empty", label)
	}
	result := make([]byte, length)
	if copied := js.CopyBytesToGo(result, value); copied != length {
		return nil, fmt.Errorf("copied %d of %d bytes for %s", copied, length, label)
	}
	return result, nil
}

func loadBundle(_ js.Value, arguments []js.Value) any {
	if len(arguments) != 1 || arguments[0].Type() != js.TypeObject {
		return errorResult(fmt.Errorf("watcherProverLoadBundle expects one asset object"))
	}
	assets := make(map[string][]byte, 6)
	for _, name := range []string{
		"deposit.r1cs", "deposit.pk", "deposit.vk",
		"withdraw.r1cs", "withdraw.pk", "withdraw.vk",
	} {
		value, err := bytesFromJS(arguments[0].Get(name), name)
		if err != nil {
			return errorResult(err)
		}
		assets[name] = value
	}
	loaded, err := withdraw.LoadProverBundleBytesV1(assets)
	if err != nil {
		return errorResult(err)
	}
	bundle = loaded
	return jsonResult(map[string]any{
		"status":       "ready",
		"curve":        "BN254",
		"scheme":       "Groth16",
		"bundleDigest": loaded.Digest,
		"circuits":     []string{"deposit-v1", "withdraw-v1"},
	})
}

func proveDeposit(_ js.Value, arguments []js.Value) any {
	if bundle == nil {
		return errorResult(fmt.Errorf("browser proving bundle is not loaded"))
	}
	if len(arguments) != 1 || arguments[0].Type() != js.TypeString {
		return errorResult(fmt.Errorf("watcherProverProveDeposit expects one JSON string"))
	}
	result, err := bundle.ProveDepositJSON([]byte(arguments[0].String()))
	if err != nil {
		return errorResult(err)
	}
	return jsonResult(result)
}

func proveWithdraw(_ js.Value, arguments []js.Value) any {
	if bundle == nil {
		return errorResult(fmt.Errorf("browser proving bundle is not loaded"))
	}
	if len(arguments) != 1 || arguments[0].Type() != js.TypeString {
		return errorResult(fmt.Errorf("watcherProverProveWithdraw expects one JSON string"))
	}
	result, err := bundle.ProveWithdrawJSON([]byte(arguments[0].String()))
	if err != nil {
		return errorResult(err)
	}
	return jsonResult(result)
}

func register(name string, callback func(js.Value, []js.Value) any) {
	function := js.FuncOf(callback)
	registered = append(registered, function)
	js.Global().Set(name, function)
}

func main() {
	register("watcherProverLoadBundle", loadBundle)
	register("watcherProverProveDeposit", proveDeposit)
	register("watcherProverProveWithdraw", proveWithdraw)
	js.Global().Set("watcherProverRuntimeReady", true)
	select {}
}
