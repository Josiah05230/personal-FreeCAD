#!/usr/bin/env bash
# Fixtures for _drive_ecad_import.js: scratch registry + mechanical + ECAD
# repos (real git repos) and /tmp/ecad_import_test/upload.zip containing
#   proj/board.kicad_pcb                 - a real board (built with pcbnew) whose
#                                          one footprint references L_0603_1608Metric
#   proj/shapes/L_0603_1608Metric.step   - that footprint's own 3D model (must be
#                                          classified "part of the board")
#   enclosure.step                       - an unrelated real STEP (must be
#                                          classified "separate mechanical part")
# Never touches real company data.
set -euo pipefail
cd "$(dirname "$0")/../../.."
ROOT=/tmp/ecad_import_test

rm -rf "$ROOT"
mkdir -p "$ROOT/registry" "$ROOT/ecad-cad-files" "$ROOT/pn-cad-files" "$ROOT/stage/proj/shapes"

cat > "$ROOT/registry/registry.csv" <<'EOF'
pn,pn_seq,project,type,seq,rev,name,description,reason,mfg,mfg_pn,purchasing_link,status,lifecycle,rev_date,created,repo_relpath
EOF
cat > "$ROOT/registry/types.yaml" <<'EOF'
C: Connector
F: PCB Assembly
G: PCB Component
EOF
for repo in registry ecad-cad-files pn-cad-files; do
  ( cd "$ROOT/$repo"
    git init -q -b main
    git config user.email test@example.com
    git config user.name Test
    [ "$repo" = registry ] || touch .gitkeep
    git add -A
    git commit -q -m init
    # a real (bare) remote, like the real company repos have - auto-push
    # only runs against a repo with an upstream
    git init -q --bare -b main "$ROOT/remotes/$repo.git"
    git remote add origin "$ROOT/remotes/$repo.git"
    git push -q -u origin main
  )
done

python3 sidecar/tests/_build_kicad_test_board.py "$ROOT/stage/proj/board.kicad_pcb" 2>/dev/null
cp /usr/share/kicad/3dmodels/Inductor_SMD.3dshapes/L_0603_1608Metric.step "$ROOT/stage/proj/shapes/"
cp /usr/share/kicad/3dmodels/Fuse.3dshapes/Fuse_0603_1608Metric.step "$ROOT/stage/enclosure.step"
( cd "$ROOT/stage" && python3 -m zipfile -c "$ROOT/upload.zip" proj enclosure.step )
echo "built $ROOT/upload.zip"
