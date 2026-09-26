#!/usr/bin/env bash
# Builds the scratch fixtures _drive_ecad_open.js needs: an isolated
# registry + ECAD repo (both real git repos) plus a real .kicad_sch (copied
# from a system KiCad template, patched to add a GWT_PN custom field on one
# placed symbol instance) - run this once before driving that scenario.
# Never touches real company data; everything lives under /tmp/ecad_open_test.
set -euo pipefail

ROOT=/tmp/ecad_open_test
TEMPLATE_SCH=/usr/share/kicad/template/Arduino_Nano/Arduino_Nano.kicad_sch

rm -rf "$ROOT"
mkdir -p "$ROOT/registry" "$ROOT/ecad-cad-files/CM/F/CMF0010" "$ROOT/pn-cad-files"

cat > "$ROOT/registry/registry.csv" <<'EOF'
pn,pn_seq,project,type,seq,rev,name,description,reason,mfg,mfg_pn,purchasing_link,status,lifecycle,rev_date,created,repo_relpath
EOF
cat > "$ROOT/registry/types.yaml" <<'EOF'
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
  )
done

if [ ! -f "$TEMPLATE_SCH" ]; then
  echo "warning: $TEMPLATE_SCH not found (kicad-templates package not installed?) - the schematic-BOM assertions in _drive_ecad_open.js will fail" >&2
  exit 0
fi

python3 - "$TEMPLATE_SCH" "$ROOT/ecad-cad-files/CM/F/CMF0010/board.kicad_sch" <<'PYEOF'
import sys
template_path, out_path = sys.argv[1], sys.argv[2]
content = open(template_path).read()

def patch(content, ref, gwt_pn):
    marker = '(property "Reference" "%s"' % ref
    idx = content.find(marker)
    assert idx >= 0, ref
    start_paren = content.find('(', idx)
    depth = 1
    i = start_paren + 1
    while depth > 0:
        if content[i] == '(':
            depth += 1
        elif content[i] == ')':
            depth -= 1
        i += 1
    addition = (
        '\n\t\t(property "GWT_PN" "%s"\n\t\t\t(at 0 0 0)\n\t\t\t(effects\n\t\t\t\t'
        '(font\n\t\t\t\t\t(size 1.27 1.27)\n\t\t\t\t)\n\t\t\t\t(hide yes)\n\t\t\t)\n\t\t)'
    ) % gwt_pn
    return content[:i] + addition + content[i:]

# J1 gets GWT_PN=CMG0010 (the real component _drive_ecad_open.js reserves) -
# J2 deliberately left untouched, so the BOM correctly contains only one item.
content = patch(content, 'J1', 'CMG0010')
open(out_path, 'w').write(content)
print('built %s with GWT_PN=CMG0010 on J1' % out_path)
PYEOF
