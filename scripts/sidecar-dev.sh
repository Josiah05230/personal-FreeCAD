#!/usr/bin/env bash
# Launch the sidecar standalone (no Electron) for smoke testing with curl.
# Reads freecadcmd path from config.local.json (falls back to config.example.json).
set -euo pipefail
cd "$(dirname "$0")/.."

CFG=config.local.json
[ -f "$CFG" ] || CFG=config.example.json

FCC=$(python3 -c "import json,os,sys; p=json.load(open('$CFG'))['freecadcmd']; print(os.path.expanduser(p))")
PORT="${1:-8765}"

if [ ! -x "$FCC" ]; then
  echo "freecadcmd not found or not executable: $FCC" >&2
  echo "edit $CFG" >&2
  exit 1
fi

echo "starting sidecar via: $FCC"
echo "port: $PORT   (Ctrl+C to stop)"
exec env GWTCAD_PORT="$PORT" "$FCC" sidecar/server.py
