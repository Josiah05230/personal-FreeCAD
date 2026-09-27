#!/usr/bin/env bash
# Pure-node unit tests for app-side TypeScript that has no Electron/DOM
# dependency (e.g. the Data Panel's file filter). Each *.test.ts is bundled
# with the app's own esbuild (so extensionless TS imports resolve) into a
# temp dir and run with node's built-in test runner.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
ESBUILD="$ROOT/app/node_modules/.bin/esbuild"
OUT="$(mktemp -d "${TMPDIR:-/tmp}/gwtcad-unit-XXXXXX")"
trap 'rm -rf "$OUT"' EXIT

TESTS=("$@")
if [ ${#TESTS[@]} -eq 0 ]; then
  TESTS=("$ROOT"/test/unit/*.test.ts)
fi
BUILT=()
for t in "${TESTS[@]}"; do
  out="$OUT/$(basename "${t%.ts}").mjs"
  "$ESBUILD" "$t" --bundle --platform=node --format=esm --log-level=warning --outfile="$out"
  BUILT+=("$out")
done
node --test "${BUILT[@]}"
