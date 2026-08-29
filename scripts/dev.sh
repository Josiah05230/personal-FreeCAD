#!/usr/bin/env bash
# Run the full app in dev mode (Vite HMR for the renderer + Electron main).
# The Electron main process spawns the FreeCAD sidecar itself using
# config.local.json at the repo root.
set -euo pipefail
cd "$(dirname "$0")/../app"

[ -d node_modules ] || npm install

# Some shells (and the Claude Code harness) export ELECTRON_RUN_AS_NODE=1, which
# makes the electron binary behave as plain Node and never open a window.
exec env -u ELECTRON_RUN_AS_NODE npx electron-vite dev "$@"
