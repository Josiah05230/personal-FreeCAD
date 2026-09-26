#!/usr/bin/env bash
# Runs the sidecar's Python test suite, both tiers:
#   1. Plain pytest, for every module with no FreeCAD import-time
#      dependency (partnumbers.py, registry.py) - fast, no FreeCAD needed.
#   2. The bundled freecadcmd's Python, for modules that DO import
#      FreeCAD/Part at the top (supplier_models.py) - slower to start, but
#      exercises real FreeCAD-dependent code paths.
#
# First-time setup (creates sidecar/.venv, only needed once):
#   python3 -m venv sidecar/.venv
#   sidecar/.venv/bin/pip install -r sidecar/requirements-dev.txt
set -eu
cd "$(dirname "$0")/../.."   # repo root
ROOT="$(pwd)"

VENV="$ROOT/sidecar/.venv"
if [ ! -x "$VENV/bin/python" ]; then
  echo "[test] sidecar/.venv not found - run:" >&2
  echo "  python3 -m venv sidecar/.venv && sidecar/.venv/bin/pip install -r sidecar/requirements-dev.txt" >&2
  exit 1
fi

FREECADCMD="$ROOT/app/resources/freecad/usr/bin/freecadcmd"
SITE_PACKAGES="$(echo "$VENV"/lib/python*/site-packages)"

echo "[test] tier 1: plain pytest (no FreeCAD needed)"
PYTHONPATH="$ROOT/sidecar" "$VENV/bin/python" -m pytest \
  --ignore="$ROOT/sidecar/tests/test_supplier_models_paths.py" \
  "$ROOT/sidecar/tests" "$@"

echo
echo "[test] tier 2: FreeCAD-dependent modules (via bundled freecadcmd)"
GWTCAD_TEST_SIDECAR_DIR="$ROOT/sidecar" \
GWTCAD_TEST_SITE_PACKAGES="$SITE_PACKAGES" \
GWTCAD_TEST_TARGET="$ROOT/sidecar/tests/test_supplier_models_paths.py" \
  "$FREECADCMD" "$ROOT/sidecar/scripts/_run_freecad_tests.py"
