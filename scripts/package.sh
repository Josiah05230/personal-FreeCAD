#!/usr/bin/env bash
# Build a distributable, self-contained GWT-CAD - the end user installs nothing
# else (no separate FreeCAD download, no Python, no CLI).
#
#   scripts/package.sh linux    -> release/GWT-CAD-<ver>-<arch>.AppImage
#                                  release/GWT-CAD-<ver>-<arch>.deb
#   scripts/package.sh appimage -> just the AppImage
#   scripts/package.sh deb      -> just the .deb
#   scripts/package.sh win      -> release/GWT-CAD-Setup-<ver>.exe
#                                  (from Linux: needs wine in PATH)
#   scripts/package.sh dir      -> release/linux-unpacked/  (fast smoke build)
#
# The headless FreeCAD engine named in config.local.json is copied into
# app/resources/freecad/ (GUI-only pieces trimmed) so the installer is
# self-contained. Set GWTCAD_NO_TRIM=1 to bundle FreeCAD verbatim.
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

# Discover the FreeCAD root from the freecadcmd path:
#   Linux AppDir : <root>/usr/bin/freecadcmd
#   Win install  : <root>\bin\FreeCADCmd.exe
BIN_DIR=$(cd "$(dirname "$FCC")" && pwd)
case "$BIN_DIR" in
  */usr/bin) FREECAD_ROOT=$(cd "$BIN_DIR/../.." && pwd) ;;   # Linux AppDir
  */bin)     FREECAD_ROOT=$(cd "$BIN_DIR/.." && pwd) ;;       # Windows layout
  *)         FREECAD_ROOT=$(cd "$BIN_DIR/.." && pwd) ;;
esac

DEST=app/resources/freecad
echo "bundling FreeCAD from: $FREECAD_ROOT"
rm -rf "$DEST"
mkdir -p "$DEST"
cp -a "$FREECAD_ROOT"/. "$DEST"/

# --- trim GUI-only + unused weight (headless sidecar never loads the Qt front-
# end, FEM, BIM, CAM/Path, LLVM shader JIT or OpenVINO). Everything removed here
# was verified to leave Part / PartDesign / Sketcher / Mesh / MeshPart /
# TechDraw / Draft / Materials / Import intact by a headless import + a full
# sketch->extrude->scene->drawing round-trip. Set GWTCAD_NO_TRIM=1 to skip.
# Linux layout only (usr/...); a Windows bundle is shipped verbatim.
if [ "${GWTCAD_NO_TRIM:-0}" != "1" ] && [ -x "$DEST/usr/bin/freecadcmd" ]; then
  echo "trimming GUI-only + unused components (GWTCAD_NO_TRIM=1 to keep everything)..."
  ( cd "$DEST" && rm -rf \
      usr/bin/freecad usr/bin/FreeCAD \
      usr/lib/libFreeCADGui.so \
      usr/Mod/*/Gui \
      usr/share/doc usr/share/man usr/share/locale usr/man \
      usr/share/freecad/examples usr/share/freecad/translations usr/translations \
      usr/Mod/Start usr/Mod/Web usr/Mod/Inspection usr/Mod/AddonManager usr/Mod/Help \
      usr/Mod/BIM usr/Mod/Fem usr/Mod/CAM usr/Mod/OpenSCAD usr/Mod/Tux usr/Mod/Idf \
      usr/lib/openvino-2025.0.0 \
      usr/lib/libclang-cpp.so.20.1 usr/lib/libclang.so.13 \
      usr/lib/libLLVM.so.20.1 usr/lib/libLLVM.so.21.1
    find usr/lib/python3.11 -type d \( -name test -o -name tests \) -prune -exec rm -rf {} + 2>/dev/null || true
    find usr -type d -name __pycache__ -prune -exec rm -rf {} + 2>/dev/null || true
  )
  # the sidecar's full headless surface must still import after the trim
  if ! GWTCAD_HOST=127.0.0.1 GWTCAD_PORT=0 "$DEST/usr/bin/freecadcmd" \
        -c "import Part,PartDesign,Sketcher,Mesh,MeshPart,Import,Materials,TechDraw,Draft; print('trim ok')" \
        2>/dev/null | grep -q "trim ok"; then
    echo "WARNING: trimmed FreeCAD failed the headless import check - rebuilding untrimmed" >&2
    rm -rf "$DEST"; mkdir -p "$DEST"; cp -a "$FREECAD_ROOT"/. "$DEST"/
  fi
fi

echo "bundled size: $(du -sh "$DEST" | cut -f1)"

cd app
case "$TARGET" in
  linux)    npm run pack:linux ;;
  appimage) npm run pack:appimage ;;
  deb)      npm run pack:deb ;;
  win)
    command -v wine >/dev/null 2>&1 || {
      echo "note: building the Windows installer from Linux needs 'wine' in PATH." >&2
      echo "      On a Windows host just run:  npm run pack:win" >&2
    }
    npm run pack:win ;;
  dir)      npm run pack:dir ;;
  *) echo "unknown target: $TARGET" >&2; exit 1 ;;
esac

echo
echo "artifacts in app/release/:"
ls -lh release/ 2>/dev/null | grep -vE '^total|linux-unpacked|win-unpacked|\.blockmap|builder-' || true
