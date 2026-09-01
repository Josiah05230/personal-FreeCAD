#!/usr/bin/env bash
# Run the GWT-CAD GUI on the current X display with all output (main + renderer
# console + sidecar + [GUI-ERR] markers) teed to a log a watcher can tail.
set -u
cd "$(dirname "$0")/../app"

# this shell profile exports ELECTRON_RUN_AS_NODE=1, which makes electron run the
# main script as plain node (electron.app === undefined). The GUI needs it off.
unset ELECTRON_RUN_AS_NODE
# rootless / container display usually needs the sandbox disabled
export ELECTRON_DISABLE_SANDBOX=1

LOG="${GWTCAD_RUNLOG:-/tmp/gwtcad-run.log}"
: > "$LOG"
echo "[dev-watch] display=${DISPLAY:-none}  log=$LOG  $(date)" | tee -a "$LOG"
exec ./node_modules/.bin/electron-vite dev -- --no-sandbox 2>&1 | tee -a "$LOG"
