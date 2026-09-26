"""_part_folder() - the exact fix for the bug an audit caught after the
pn-cad-files layout migration: supplier_models.py hardcoded
<repo>/<pn>/<pn>.* for a part's .stp/.FCStd/meta files, which silently
broke once parts moved to <project>/<type>/<pn>/. This module imports
FreeCAD/Part at the top (needed for the rest of supplier_models.py's real
work), so these tests only collect when that import succeeds - run them
with the bundled freecadcmd's Python, not plain pytest:

    <repo>/app/resources/freecad/usr/bin/freecadcmd -c \
        "import sys; sys.path.insert(0, 'sidecar'); sys.path.insert(0, 'sidecar/.venv/lib/python3.12/site-packages'); \
         import pytest; sys.exit(pytest.main(['sidecar/tests/test_supplier_models_paths.py']))"

or more simply via sidecar/scripts/run_tests.sh, which handles this for
both tiers.
"""
import os

import pytest

freecad_or_skip = pytest.importorskip("FreeCAD")

from gwtcad import partnumbers as pn
from gwtcad import supplier_models as sm


def _row(pn_seq, rev, repo_relpath=""):
    return {
        "pn": "%s%d" % (pn_seq, rev), "pn_seq": pn_seq, "project": pn_seq[:2],
        "type": pn_seq[2:3], "seq": pn_seq[3:], "rev": str(rev),
        "name": "", "description": "", "reason": "", "mfg": "", "mfg_pn": "",
        "purchasing_link": "", "status": "active", "lifecycle": "in_work",
        "rev_date": "", "created": "", "repo_relpath": repo_relpath,
    }


def test_part_folder_uses_repo_relpath_hint_when_valid(tmp_path):
    real_dir = tmp_path / "CM" / "C" / "CMC0010"
    real_dir.mkdir(parents=True)
    (real_dir / "CMC0010.FCStd").write_text("x")
    row = _row("CMC001", 0, repo_relpath=os.path.join("CM", "C", "CMC0010", "CMC0010.FCStd"))

    folder = sm._part_folder({}, str(tmp_path), "CMC0010", row=row)
    assert folder == str(real_dir)


def test_part_folder_self_heals_when_hint_is_stale(tmp_path):
    # exactly the bug: the row's cached hint still says the OLD flat
    # location, but the file actually lives at the new nested one (e.g.
    # after a migration like this session's pn-cad-files reorg).
    real_dir = tmp_path / "CM" / "C" / "CMC0010"
    real_dir.mkdir(parents=True)
    (real_dir / "CMC0010.FCStd").write_text("x")
    row = _row("CMC001", 0, repo_relpath="CMC0010.FCStd")  # stale flat hint

    folder = sm._part_folder({}, str(tmp_path), "CMC0010", row=row)
    assert folder == str(real_dir)


def test_part_folder_falls_back_to_new_convention_when_file_does_not_exist_yet(tmp_path):
    # sync_supplier_models' first-time case: nothing on disk yet at all.
    row = _row("CMC001", 0)
    folder = sm._part_folder({}, str(tmp_path), "CMC0010", row=row)
    assert folder == os.path.join(str(tmp_path), "CM", "C", "CMC0010")


def test_part_folder_looks_up_row_itself_when_not_given(tmp_path, monkeypatch):
    config_path = tmp_path / "company.json"
    monkeypatch.setattr(pn, "_CONFIG_PATH", str(config_path))
    registry_dir = tmp_path / "registry"
    registry_dir.mkdir()
    cfg = {"registryPath": str(registry_dir), "projects": {}}
    pn._save_config(cfg)
    rows = [_row("CMC001", 0)]
    pn._write_registry(cfg, rows)

    folder = sm._part_folder(cfg, str(tmp_path), "CMC0010")  # row=None -> looks it up
    assert folder == os.path.join(str(tmp_path), "CM", "C", "CMC0010")


