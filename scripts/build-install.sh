#!/usr/bin/env bash
# One command to build a real, self-contained GWT-CAD and put it on this machine
# as an installed app you can launch from the menu / pin to the dock.
#
#   scripts/build-install.sh              # dir build + install (fast, default)
#   scripts/build-install.sh --deb        # build + `sudo apt install` the .deb
#   scripts/build-install.sh --appimage   # build the AppImage + integrate it
#   scripts/build-install.sh --e2e        # run the full E2E suite first
#   scripts/build-install.sh --no-launch  # do not open the app at the end
#
# Flags combine, e.g.  scripts/build-install.sh --deb --e2e
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
APP="$ROOT/app"

MODE=dir
RUN_E2E=0
LAUNCH=1
for a in "$@"; do
  case "$a" in
    --deb) MODE=deb ;;
    --appimage) MODE=appimage ;;
    --dir) MODE=dir ;;
    --e2e) RUN_E2E=1 ;;
    --no-launch) LAUNCH=0 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown flag: $a" >&2; exit 1 ;;
  esac
done

say() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }

# ---------------------------------------------------------------- 1. typecheck
say "typechecking"
( cd "$APP" && npx tsc --noEmit -p tsconfig.json && npx tsc --noEmit -p tsconfig.node.json )

# ---------------------------------------------------------------- 2. E2E (source tree)
if [ "$RUN_E2E" = 1 ]; then
  say "running the E2E suite (source build)"
  DISPLAY="${DISPLAY:-:1}" bash test/e2e/run.sh
fi

# ---------------------------------------------------------------- 3. package
if [ "$MODE" = deb ]; then
  # apt only re-installs a .deb if its version string is actually newer, and
  # ours (from app/package.json) had stayed a hand-set "0.1.0" across every
  # rebuild - so `apt install some.deb` silently no-ops on an updated build
  # ("gwt-cad is already the newest version"), even though the file changed.
  # electron-builder requires strict 3-segment semver in package.json (a 4th
  # build-number segment is rejected outright), so bump the PATCH number on
  # every --deb build instead - still valid semver, and apt's version compare
  # sees it as newer so a plain `apt install` always picks up the latest.
  PKG_JSON="$APP/package.json"
  NEW_VER=$(node -e "
    const v=require('$PKG_JSON').version.split('.').map(Number);
    v[2]=(v[2]||0)+1;
    console.log(v.join('.'));
  ")
  OLD_VER=$(node -e "console.log(require('$PKG_JSON').version)")
  say "bumping .deb version $OLD_VER -> $NEW_VER (so apt install always updates)"
  node -e "
    const fs=require('fs'); const p='$PKG_JSON';
    const j=JSON.parse(fs.readFileSync(p,'utf8'));
    j.version='$NEW_VER';
    fs.writeFileSync(p, JSON.stringify(j,null,2)+'\n');
  "
fi

say "packaging ($MODE) - bundles the trimmed headless FreeCAD engine"
bash scripts/package.sh "$MODE"

UNPACKED="$APP/release/linux-unpacked"

# ---------------------------------------------------------------- 4. smoke-test the packaged binary
say "smoke-testing the packaged binary"
(
  cd "$UNPACKED"
  unset ELECTRON_RUN_AS_NODE
  export DISPLAY="${DISPLAY:-:1}"
  timeout 40 ./gwt-cad --no-sandbox >/tmp/gwtcad-pkg-smoke.log 2>&1 &
  pid=$!
  ok=0
  for _ in $(seq 1 30); do
    if grep -q "sidecar ready on" /tmp/gwtcad-pkg-smoke.log 2>/dev/null; then ok=1; break; fi
    sleep 1
  done
  kill "$pid" 2>/dev/null || true
  pkill -f "$UNPACKED/resources/sidecar/server.py" 2>/dev/null || true
  if [ "$ok" = 1 ]; then
    echo "  packaged app booted its bundled FreeCAD sidecar OK"
  else
    echo "  !! packaged app did not report a ready sidecar - see /tmp/gwtcad-pkg-smoke.log" >&2
    tail -20 /tmp/gwtcad-pkg-smoke.log >&2
    exit 1
  fi
)

# ---------------------------------------------------------------- 5. install
case "$MODE" in
  deb)
    DEB=$(ls -t "$APP"/release/*.deb | head -1)
    say "installing $DEB (sudo)"
    sudo apt install --reinstall -y "$DEB"
    say "installed - launch it from the app menu (search 'GWT-CAD') or run: gwt-cad"
    [ "$LAUNCH" = 1 ] && { setsid gwt-cad >/dev/null 2>&1 & disown || true; }
    ;;
  appimage)
    IMG=$(ls -t "$APP"/release/*.AppImage | head -1)
    DEST="$HOME/.local/bin/GWT-CAD.AppImage"
    mkdir -p "$HOME/.local/bin" "$HOME/.local/share/applications" "$HOME/.local/share/icons"
    cp "$IMG" "$DEST"; chmod +x "$DEST"
    cp "$APP/build/icon.png" "$HOME/.local/share/icons/gwt-cad.png"
    cat > "$HOME/.local/share/applications/gwt-cad.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=GWT-CAD
Comment=Fusion-360-style CAD, self-contained
Exec=$DEST %U
Icon=gwt-cad
Categories=Graphics;Engineering;
StartupWMClass=GWT-CAD
Terminal=false
EOF
    update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
    say "installed to $DEST + a menu entry - search 'GWT-CAD', then right-click its dock icon to pin it"
    [ "$LAUNCH" = 1 ] && { setsid "$DEST" >/dev/null 2>&1 & disown || true; }
    ;;
  dir)
    say "dir build only (no system install). Run it with:"
    echo "    cd $UNPACKED && ./gwt-cad"
    if [ "$LAUNCH" = 1 ]; then
      ( cd "$UNPACKED"; unset ELECTRON_RUN_AS_NODE; setsid ./gwt-cad >/dev/null 2>&1 & disown || true )
    fi
    ;;
esac

say "done"
