//go:build js && wasm

package main

import (
	"encoding/json"
	"fmt"
	"syscall/js"

	withdraw "watcher.cash/circuits/withdraw"
)

var (
	circuits   = map[string]*withdraw.CircuitProverV2{}
	registered []js.Func
)

func jsonResult(value any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return `{"error":"failed to encode V3 WebAssembly prover response"}`
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

func loadCircuit(_ js.Value, arguments []js.Value) any {
	if len(arguments) != 3 || arguments[0].Type() != js.TypeString || arguments[1].Type() != js.TypeObject || arguments[2].Type() != js.TypeString {
		return errorResult(fmt.Errorf("watcherProverV3LoadCircuit expects circuit, asset object, and manifest digest"))
	}
	circuit := arguments[0].String()
	if circuit != "deposit" && circuit != "withdraw" {
		return errorResult(fmt.Errorf("unsupported V3 circuit %q", circuit))
	}
	if existing := circuits[circuit]; existing != nil {
		return jsonResult(map[string]any{
			"status":  "ready",
			"version": 3,
			"circuit": circuit,
			"digest":  existing.Digest,
			"cached":  true,
		})
	}

	assets := make(map[string][]byte, 3)
	for _, suffix := range []string{"r1cs", "pk", "vk"} {
		name := circuit + "." + suffix
		value, err := bytesFromJS(arguments[1].Get(name), name)
		if err != nil {
			return errorResult(err)
		}
		assets[name] = value
	}
	loaded, err := withdraw.LoadCircuitProverBytesV2(assets, circuit, arguments[2].String())
	if err != nil {
		return errorResult(err)
	}
	circuits[circuit] = loaded
	return jsonResult(map[string]any{
		"status":  "ready",
		"curve":   "BN254",
		"scheme":  "Groth16",
		"version": 3,
		"circuit": circuit,
		"digest":  loaded.Digest,
		"cached":  false,
	})
}

func prove(circuit string, arguments []js.Value) any {
	loaded := circuits[circuit]
	if loaded == nil {
		return errorResult(fmt.Errorf("V3 %s proving circuit is not loaded", circuit))
	}
	if len(arguments) != 1 || arguments[0].Type() != js.TypeString {
		return errorResult(fmt.Errorf("V3 %s prover expects one JSON string", circuit))
	}
	result, err := loaded.ProveJSON([]byte(arguments[0].String()))
	if err != nil {
		return errorResult(err)
	}
	return jsonResult(result)
}

func proveDeposit(_ js.Value, arguments []js.Value) any {
	return prove("deposit", arguments)
}

func proveWithdraw(_ js.Value, arguments []js.Value) any {
	return prove("withdraw", arguments)
}

func register(name string, callback func(js.Value, []js.Value) any) {
	function := js.FuncOf(callback)
	registered = append(registered, function)
	js.Global().Set(name, function)
}

func main() {
	register("watcherProverV3LoadCircuit", loadCircuit)
	register("watcherProverV3ProveDeposit", proveDeposit)
	register("watcherProverV3ProveWithdraw", proveWithdraw)
	js.Global().Set("watcherProverV3RuntimeReady", true)
	select {}
}
