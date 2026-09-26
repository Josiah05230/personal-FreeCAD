"""Crash-recovery: the pure path-hashing/mtime-comparison logic in
recovery.py, plus a real end-to-end round trip through FreeCAD's actual
Document.saveCopy - the critical safety property this feature depends on
(saveCopy must NEVER retarget the document's own FileName, or a periodic
autosave could silently redirect a later real Save). This module imports
FreeCAD at the top, so run it under the bundled freecadcmd, not plain
pytest - see sidecar/scripts/run_tests.sh.
"""
import os
import time

import pytest

freecad_or_skip = pytest.importorskip("FreeCAD")
import FreeCAD as App

from gwtcad import recovery, session


@pytest.fixture(autouse=True)
def isolated_recovery_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(recovery, "_RECOVERY_DIR", str(tmp_path / "recovery"))
    yield


@pytest.fixture(autouse=True)
def close_session_doc():
    yield
    try:
        d = session.doc(create=False)
        if d is not None:
            App.closeDocument(d.Name)
    except Exception:
        pass


def test_recovery_path_is_stable_and_collision_free(tmp_path):
    p1 = str(tmp_path / "a" / "Part.FCStd")
    p2 = str(tmp_path / "b" / "Part.FCStd")  # same filename, different folder
    assert recovery._recovery_path(p1) == recovery._recovery_path(p1)  # stable
    assert recovery._recovery_path(p1) != recovery._recovery_path(p2)  # no collision


def test_autosave_current_noop_with_no_open_document():
    result = recovery.autosave_current()
    assert result == {"saved": False, "reason": "no open document"}


def test_autosave_current_noop_when_never_saved():
    session.reset()
    result = recovery.autosave_current()
    assert result["saved"] is False
    assert "never saved" in result["reason"]


def test_autosave_writes_a_copy_without_touching_the_real_file(tmp_path):
    real_path = str(tmp_path / "Part.FCStd")
    d = session.reset()
    d.saveAs(real_path)
    session.set_path(real_path)  # methods.py's document.saveAs does this too - see recovery.py's docstring
    real_mtime_before = os.path.getmtime(real_path)

    time.sleep(1.1)
    result = recovery.autosave_current()

    assert result["saved"] is True
    assert os.path.isfile(result["recoveryPath"])
    assert os.path.getmtime(real_path) == real_mtime_before


def test_autosave_never_retargets_the_document_file_name(tmp_path):
    # the exact safety property this feature depends on: saveCopy (which
    # autosave_current uses) must not be saveAs in disguise.
    real_path = str(tmp_path / "Part.FCStd")
    d = session.reset()
    d.saveAs(real_path)
    session.set_path(real_path)  # methods.py's document.saveAs does this too - see recovery.py's docstring
    recovery.autosave_current()
    assert d.FileName == real_path
    d.save()  # must still write to real_path, not the recovery copy
    assert os.path.getmtime(real_path) > 0


def test_check_recovery_unavailable_when_none_exists(tmp_path):
    real_path = str(tmp_path / "Part.FCStd")
    assert recovery.check_recovery(real_path) == {"available": False}


def test_check_recovery_available_when_newer_than_real_file(tmp_path):
    real_path = str(tmp_path / "Part.FCStd")
    d = session.reset()
    d.saveAs(real_path)
    session.set_path(real_path)  # methods.py's document.saveAs does this too - see recovery.py's docstring
    time.sleep(1.1)
    recovery.autosave_current()

    result = recovery.check_recovery(real_path)
    assert result["available"] is True
    assert result["recoveryMtime"] > result["realMtime"]
    assert result["ageSeconds"] >= 0


def test_check_recovery_unavailable_when_real_file_is_newer(tmp_path):
    # a real Save after the autosave makes the stale recovery copy
    # irrelevant - this is what prevents an endless "recover?" prompt on
    # every future open once the user has actually saved normally.
    real_path = str(tmp_path / "Part.FCStd")
    d = session.reset()
    d.saveAs(real_path)
    session.set_path(real_path)  # methods.py's document.saveAs does this too - see recovery.py's docstring
    recovery.autosave_current()
    time.sleep(1.1)
    d.save()

    result = recovery.check_recovery(real_path)
    assert result["available"] is False


def test_discard_recovery_removes_the_file(tmp_path):
    real_path = str(tmp_path / "Part.FCStd")
    d = session.reset()
    d.saveAs(real_path)
    session.set_path(real_path)  # methods.py's document.saveAs does this too - see recovery.py's docstring
    recovery.autosave_current()
    assert recovery.check_recovery(real_path)["available"] is True

    recovery.discard_recovery(real_path)
    assert recovery.check_recovery(real_path)["available"] is False


def test_discard_recovery_is_safe_when_nothing_exists(tmp_path):
    real_path = str(tmp_path / "NeverAutosaved.FCStd")
    recovery.discard_recovery(real_path)  # must not raise
