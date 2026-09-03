#!/usr/bin/env bash
# Run the interaction fuzzer over and over with fresh random seeds until it
# finds a failure (or you Ctrl-C). Each run is a full app launch. On a failure
# the run's report (seed + step + action + trace tail) is left in
# test/e2e/report-fuzz.txt and this script stops non-zero.
#
#   bash test/e2e/fuzz-loop.sh            # forever, 160 steps/run
#   FUZZ_STEPS=400 RUNS=20 bash test/e2e/fuzz-loop.sh
set -u
cd "$(dirname "$0")/../.."
RUNS="${RUNS:-100000}"
export FUZZ_STEPS="${FUZZ_STEPS:-160}"

for i in $(seq 1 "$RUNS"); do
  seed=$(( (RANDOM << 15 | RANDOM) ))
  echo
  echo "############ fuzz run $i/$RUNS  seed=$seed  steps=$FUZZ_STEPS ############"
  FUZZ_SEED="$seed" bash test/e2e/run.sh test/e2e/scenarios/fuzz.js
  rc=$?
  if [ "$rc" -ne 0 ]; then
    echo
    echo "############ FUZZ FOUND A FAILURE on run $i (seed=$seed) ############"
    echo "report: test/e2e/report-fuzz.txt"
    exit 1
  fi
done
echo "all $RUNS fuzz runs clean"
