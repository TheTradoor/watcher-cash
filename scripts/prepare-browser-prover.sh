#!/usr/bin/env bash
set -euo pipefail

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${GH_TOKEN:?GH_TOKEN is required}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="$(mktemp -d)"
ARTIFACT_ZIP="$(mktemp)"
OUTPUT_DIR="$ROOT/public/watcher-prover-v1"
trap 'rm -rf "$SOURCE_DIR" "$ARTIFACT_ZIP"' EXIT

runs_json="$(gh api "/repos/${GITHUB_REPOSITORY}/actions/workflows/watcher-circuit.yml/runs?branch=watcher-protocol&status=success&per_page=30")"
run_id="$(RUNS_JSON="$runs_json" python - <<'PY'
import json, os
runs = json.loads(os.environ['RUNS_JSON']).get('workflow_runs', [])
if not runs:
    raise SystemExit('no successful Watcher Circuit CI run was found')
print(runs[0]['id'])
PY
)"

artifacts_json="$(gh api "/repos/${GITHUB_REPOSITORY}/actions/runs/${run_id}/artifacts?per_page=100")"
artifact_id="$(ARTIFACTS_JSON="$artifacts_json" python - <<'PY'
import json, os
artifacts = [a for a in json.loads(os.environ['ARTIFACTS_JSON']).get('artifacts', []) if not a.get('expired')]
preferred = [a for a in artifacts if 'prover' in a.get('name', '').lower()]
if not preferred:
    preferred = [a for a in artifacts if 'fixture' in a.get('name', '').lower()]
if not preferred:
    raise SystemExit('the latest Circuit CI run has no live prover artifact')
print(preferred[0]['id'])
PY
)"

curl --fail --silent --show-error --location \
  -H "Authorization: Bearer ${GH_TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/artifacts/${artifact_id}/zip" \
  --output "$ARTIFACT_ZIP"

unzip -q "$ARTIFACT_ZIP" -d "$SOURCE_DIR"
while IFS= read -r nested; do
  nested_dir="${nested%.zip}-expanded"
  mkdir -p "$nested_dir"
  unzip -q "$nested" -d "$nested_dir" || true
done < <(find "$SOURCE_DIR" -type f -name '*.zip')

rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

required=(
  deposit.r1cs
  deposit.pk
  deposit.vk
  withdraw.r1cs
  withdraw.pk
  withdraw.vk
)
for name in "${required[@]}"; do
  source_file="$(find "$SOURCE_DIR" -type f -name "$name" -print -quit)"
  if [[ -z "$source_file" ]]; then
    echo "missing required prover artifact: $name" >&2
    find "$SOURCE_DIR" -maxdepth 4 -type f -print >&2
    exit 1
  fi
  cp "$source_file" "$OUTPUT_DIR/$name"
done

manifest="$(find "$SOURCE_DIR" -type f \( -name 'prover-manifest.json' -o -name 'manifest.json' \) -print -quit || true)"
if [[ -n "$manifest" ]]; then
  cp "$manifest" "$OUTPUT_DIR/prover-manifest.json"
fi

pushd "$ROOT/circuits/withdraw" >/dev/null
GOOS=js GOARCH=wasm go build -trimpath \
  -o "$OUTPUT_DIR/watcher-prover.wasm" \
  ./cmd/watcher-prover-wasm
popd >/dev/null

GOROOT="$(go env GOROOT)"
wasm_exec=''
for candidate in "$GOROOT/lib/wasm/wasm_exec.js" "$GOROOT/misc/wasm/wasm_exec.js"; do
  if [[ -f "$candidate" ]]; then
    wasm_exec="$candidate"
    break
  fi
done
if [[ -z "$wasm_exec" ]]; then
  echo 'wasm_exec.js was not found in the Go installation' >&2
  exit 1
fi
cp "$wasm_exec" "$OUTPUT_DIR/wasm_exec.js"

RUN_ID="$run_id" ARTIFACT_ID="$artifact_id" OUTPUT_DIR="$OUTPUT_DIR" GITHUB_SHA="${GITHUB_SHA:-unknown}" python - <<'PY'
import hashlib, json, os
from pathlib import Path
output = Path(os.environ['OUTPUT_DIR'])
files = {}
for path in sorted(output.iterdir()):
    if not path.is_file() or path.name == 'browser-manifest.json':
        continue
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    files[path.name] = {'bytes': path.stat().st_size, 'sha256': digest}
manifest = {
    'version': 1,
    'network': 'development-only',
    'sourceCircuitRunId': int(os.environ['RUN_ID']),
    'sourceArtifactId': int(os.environ['ARTIFACT_ID']),
    'siteBuildCommit': os.environ['GITHUB_SHA'],
    'files': files,
    'warning': 'Development Groth16 setup. Do not use production funds.',
}
(output / 'browser-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps(manifest, indent=2))
PY

echo "Browser prover assets prepared in $OUTPUT_DIR"
