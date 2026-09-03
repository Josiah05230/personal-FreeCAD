#!/usr/bin/env bash
# Run the interaction fuzzer over and over with fresh random seeds until it
# finds a failure (or you Ctrl-C). Builds the app once, then each iteration is
# just a fresh Electron launch + random walk. On a failure the run's report
# (seed + step + action + trace tail) is in test/e2e/report-fuzz.txt and this
# script stops non-zero.
#
#   bash test/e2e/fuzz-loop.sh                     # forever, 60 steps/run
#   FUZZ_STEPS=200 RUNS=30 bash test/e2e/fuzz-loop.sh
set -u
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
APP="$ROOT/app"
RUNS="${RUNS:-100000}"
export FUZZ_STEPS="${FUZZ_STEPS:-60}"

unset ELECTRON_RUN_AS_NODE
export ELECTRON_DISABLE_SANDBOX=1
: "${DISPLAY:=:1}"; export DISPLAY

echo "[fuzz-loop] building app once..."
( cd "$APP" && ./node_modules/.bin/electron-vite build >/tmp/gwtcad-fuzz-build.log 2>&1 ) || {
  echo "[fuzz-loop] build FAILED"; tail -20 /tmp/gwtcad-fuzz-build.log; exit 1; }

kill_strays() {
  for p in $(pgrep -f 'GWT-CAD/app/node_modules/electron/dist/electron' 2>/dev/null) \
           $(pgrep -f 'GWT-CAD/sidecar/server.py' 2>/dev/null); do kill -9 "$p" 2>/dev/null; done
  sleep 1
}

for i in $(seq 1 "$RUNS"); do
  seed=$(( (RANDOM << 15 | RANDOM) ))
  echo
  echo "############ fuzz run $i/$RUNS  seed=$seed  steps=$FUZZ_STEPS ############"
  kill_strays
  ( cd "$APP" && FUZZ_SEED="$seed" timeout 600 ./node_modules/.bin/electron --no-sandbox . \
      --e2e "$ROOT/test/e2e/scenarios/fuzz.js" 2>&1 ) \
    | grep -vE '^\[.*\] \[trace |^\[trace |Download the React|GLib-GObject|GPU process|zygote|command_buffer'
  rc=${PIPESTATUS[0]}
  if [ "$rc" -ne 0 ]; then
    echo
    echo "############ FUZZ FOUND A FAILURE on run $i (seed=$seed, exit $rc) ############"
    echo "full report: test/e2e/report-fuzz.txt"
    kill_strays
    exit 1
  fi
done
kill_strays
echo "all $RUNS fuzz runs clean"
