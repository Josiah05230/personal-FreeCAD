#!/usr/bin/env bash
# End-to-end UI tests: build the app, then for each scenario launch the real
# Electron app (real component tree + IPC + FreeCAD sidecar) with --e2e and let
# the scenario drive it through window.__gwtcad. Exit non-zero if any fail.
set -u
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
APP="$ROOT/app"

unset ELECTRON_RUN_AS_NODE
export ELECTRON_DISABLE_SANDBOX=1
: "${DISPLAY:=:1}"
export DISPLAY

echo "[e2e] building app..."
( cd "$APP" && ./node_modules/.bin/electron-vite build >/tmp/gwtcad-e2e-build.log 2>&1 ) || {
  echo "[e2e] build FAILED - see /tmp/gwtcad-e2e-build.log"; tail -20 /tmp/gwtcad-e2e-build.log; exit 1;
}

# resolve scenario args to absolute paths (main reads them relative to app/ cwd)
SCENARIOS=()
for a in "$@"; do
  case "$a" in
    /*) SCENARIOS+=("$a") ;;
    *)  SCENARIOS+=("$ROOT/$a") ;;
  esac
done
if [ ${#SCENARIOS[@]} -eq 0 ]; then
  SCENARIOS=("$ROOT"/test/e2e/scenarios/*.js)
fi

kill_strays() {
  for p in $(pgrep -f 'GWT-CAD/app/node_modules/electron/dist/electron' 2>/dev/null) \
           $(pgrep -f 'GWT-CAD/sidecar/server.py' 2>/dev/null); do
    kill -9 "$p" 2>/dev/null
  done
  sleep 1
}

fail=0
for sc in "${SCENARIOS[@]}"; do
  echo
  echo "=============================================================="
  echo "[e2e] $sc"
  echo "=============================================================="
  kill_strays
  # one instance at a time (kill_strays above) so the rootless display's GPU is
  # not contended; the app still needs software WebGL for its viewport, so do
  # NOT pass --disable-software-rasterizer
  ( cd "$APP" && timeout "${E2E_TIMEOUT:-240}" ./node_modules/.bin/electron --no-sandbox . --e2e "$sc" 2>&1 ) \
    | grep -vE '^\[.*\] sidecar |Download the React|GLib-GObject|^\[sidecar\]|GPU process|zygote|command_buffer' || true
  rc=${PIPESTATUS[0]}
  if [ "$rc" -ne 0 ]; then
    echo "[e2e] SCENARIO FAILED (exit $rc): $sc"
    fail=1
  fi
done
kill_strays

echo
if [ "$fail" -eq 0 ]; then echo "[e2e] ALL SCENARIOS PASSED"; else echo "[e2e] SOME SCENARIOS FAILED"; fi
exit $fail
