#!/usr/bin/env bash
# Builds the scratch repo _drive_git_auto_sync_ui.js needs: a bare remote and
# one clone holding two real (empty) parts, UITEST and UITEST2. Never touches
# real company data; everything lives under /tmp/sync_ui_test.
set -euo pipefail
ROOT=/tmp/sync_ui_test
FREECADCMD="$(cd "$(dirname "$0")/../../.." && pwd)/app/resources/freecad/usr/bin/freecadcmd"
rm -rf "$ROOT"
mkdir -p "$ROOT"
git init -q --bare -b main "$ROOT/remote.git"
git clone -q "$ROOT/remote.git" "$ROOT/cloneA" 2>/dev/null
mkdir -p "$ROOT/cloneA/UITEST" "$ROOT/cloneA/UITEST2"
cat > "$ROOT/mk.py" <<PY
import FreeCAD as App
for n in ("UITEST", "UITEST2"):
    p = "$ROOT/cloneA/%s/%s.FCStd" % (n, n)
    import os
    if not os.path.exists(p):
        d = App.newDocument(n)
        d.saveAs(p)
        App.closeDocument(d.Name)
PY
"$FREECADCMD" "$ROOT/mk.py" >/dev/null 2>&1
( cd "$ROOT/cloneA"
  git config user.email a@example.com
  git config user.name A
  git add -A
  git commit -q -m init
  git push -q -u origin main )
echo "ready: $ROOT"
