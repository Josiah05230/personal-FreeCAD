"""kicad.importStep: real per-component STEP import from a .kicad_pcb via
kicad-cli, falling back to the outline+placeholder tier (kicad.import) when
kicad-cli is unavailable or produces nothing usable. This module imports
FreeCAD/Part at the top, so run it under the bundled freecadcmd, not plain
pytest - see sidecar/scripts/run_tests.sh.

The test fixture board is built by _build_kicad_test_board.py, run as a
SEPARATE subprocess under system python3 - confirmed FreeCAD's own bundled
Python has no `pcbnew` module at all (that's KiCad's own scripting module,
installed into system Python's site-packages only), so building the board
and running kicad_import_step against it can never happen in the same
Python process.
"""
import os
import shutil
import subprocess

import pytest

freecad_or_skip = pytest.importorskip("FreeCAD")

import FreeCAD as App

from gwtcad import kicad, session


def _kicad_cli_available():
    return shutil.which("kicad-cli") is not None


@pytest.fixture
def real_board_with_component(tmp_path):
    pcb_path = str(tmp_path / "test.kicad_pcb")
    builder = os.path.join(os.path.dirname(__file__), "_build_kicad_test_board.py")
    # NOT sys.executable: under freecadcmd that resolves to freecadcmd
    # itself (confirmed - it has no pcbnew either), not a real system
    # python3. pcbnew is installed into system Python's site-packages by
    # the kicad-libraries/kicad-python packaging, a genuinely separate
    # interpreter from both FreeCAD's bundled one and (on some systems)
    # from whatever "python3" a dev's own tooling might shadow.
    system_python = shutil.which("python3") or "python3"
    r = subprocess.run([system_python, builder, pcb_path], capture_output=True, text=True, timeout=60)
    if r.returncode == 2:
        pytest.skip(r.stderr.strip() or "system KiCad footprint library not installed")
    if r.returncode != 0 or not os.path.isfile(pcb_path):
        pytest.skip("could not build the test fixture board (pcbnew not installed?): " + (r.stderr or r.stdout))
    return pcb_path


@pytest.fixture(autouse=True)
def close_session_doc():
    yield
    try:
        d = session.doc(create=False)
        if d is not None:
            App.closeDocument(d.Name)
    except Exception:
        pass


@pytest.mark.skipif(not _kicad_cli_available(), reason="kicad-cli not installed on this machine")
def test_import_step_produces_separate_component_and_board_bodies(real_board_with_component):
    session.reset()
    result = kicad.kicad_import_step(real_board_with_component)

    assert result["kicad"]["stepImport"] is True
    assert result["kicad"]["componentCount"] >= 2  # the board + at least the one real component

    d = session.doc(create=False)
    part_features = [o for o in d.Objects if o.TypeId == "Part::Feature"]
    labels = [o.Label for o in part_features]
    assert any("L_0603_1608Metric" in lbl for lbl in labels), \
        f"expected the inductor's own body as a SEPARATE Part::Feature, got: {labels}"
    assert any("PCB" in lbl for lbl in labels), \
        f"expected the bare board as its own separate Part::Feature too, got: {labels}"


@pytest.mark.skipif(not _kicad_cli_available(), reason="kicad-cli not installed on this machine")
def test_reimport_replaces_rather_than_duplicates(real_board_with_component):
    session.reset()
    kicad.kicad_import_step(real_board_with_component)
    d = session.doc(create=False)
    count_after_first = len(d.Objects)

    kicad.kicad_import_step(real_board_with_component)
    count_after_second = len(d.Objects)

    assert count_after_second == count_after_first, (
        "re-importing the SAME board must replace the previous import's objects, "
        "not leave them behind - Import.insert never reuses object names across "
        "calls, so a naive cleanup that only removes .Group children (not "
        "everything reachable via OutList, which is where an App::Part's own "
        "Origin/axes/planes actually live) silently leaks a growing set of "
        "orphaned objects on every re-import."
    )


def test_import_step_falls_back_when_kicad_cli_missing(monkeypatch, real_board_with_component):
    monkeypatch.setattr(kicad, "KICAD_CLI", "/nonexistent/kicad-cli-definitely-not-here")
    session.reset()

    result = kicad.kicad_import_step(real_board_with_component)

    assert result["kicad"]["stepImport"] is False
    assert "kicad-cli not found" in result["kicad"]["stepImportReason"]
    # must still produce a usable result (the outline+placeholder tier),
    # never raise just because the richer tier isn't available.
    d = session.doc(create=False)
    assert len(d.Objects) > 0
