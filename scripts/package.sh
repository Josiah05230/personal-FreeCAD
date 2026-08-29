#!/usr/bin/env bash
# Build a distributable GWT-CAD.
#
#   scripts/package.sh linux   -> release/GWT-CAD-<ver>-<arch>.AppImage
#   scripts/package.sh win     -> release/GWT-CAD-Setup-<ver>.exe  (needs wine or a Windows host)
#   scripts/package.sh dir     -> release/linux-unpacked/  (fast, unpacked, for smoke testing)
#
# Bundles the headless FreeCAD engine from config.local.json into
# app/resources/freecad/ so the installer is self-contained.
set -euo pipefail
cd "$(dirname "$0")/.."
TARGET="${1:-dir}"

CFG=config.local.json
[ -f "$CFG" ] || CFG=config.example.json
FCC=$(python3 -c "import json,os;print(os.path.expanduser(json.load(open('$CFG'))['freecadcmd']))")

if [ ! -x "$FCC" ]; then
  echo "freecadcmd not found: $FCC  (edit $CFG)" >&2
  exit 1
fi

# freecadcmd lives at <FreeCAD>/usr/bin/freecadcmd (Linux AppDir layout)
FREECAD_ROOT=$(cd "$(dirname "$FCC")/../.." && pwd)
DEST=app/resources/freecad
echo "bundling FreeCAD from: $FREECAD_ROOT"
rm -rf "$DEST"
mkdir -p "$DEST"
cp -a "$FREECAD_ROOT"/. "$DEST"/

cd app
case "$TARGET" in
  linux) npm run pack:linux ;;
  win)   npm run pack:win ;;
  dir)   npm run pack:dir ;;
  *) echo "unknown target: $TARGET" >&2; exit 1 ;;
esac
echo "output in app/release/"
