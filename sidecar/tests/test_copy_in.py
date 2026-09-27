"""pn.copyIn (copy_in.py): where an outside file lands, what gets committed,
and the refusals. FreeCAD itself is stubbed out (_write_part_file just
drops a marker file) - the real .FCStd build is covered end to end by
test/e2e/scenarios/copy_in_gate.js. Throwaway git repos only (conftest)."""
import os
import subprocess

import pytest

from gwtcad import copy_in
from gwtcad.registry import RpcError


@pytest.fixture
def no_freecad(monkeypatch):
    calls = []

    def fake(fcstd, pn, name, description, model=None, existing=False):
        calls.append({"fcstd": fcstd, "pn": pn, "model": model, "existing": existing})
        if not existing:
            with open(fcstd, "w") as f:
                f.write("fake fcstd for %s" % pn)

    monkeypatch.setattr(copy_in, "_write_part_file", fake)
    return calls


def _log(repo):
    return subprocess.run(["git", "-C", str(repo), "log", "--name-only", "--format=%s"],
                          capture_output=True, text=True, check=True).stdout


def test_company_roots_cover_projects_ecad_and_registry(company_config, tmp_path):
    cfg = dict(company_config, ecadRepoPath=str(tmp_path / "ecad"))
    assert copy_in.in_company_repo(os.path.join(company_config["projects"]["CM"]["repoPath"], "a", "b.step"), cfg)
    assert copy_in.in_company_repo(str(tmp_path / "ecad" / "x.kicad_pcb"), cfg)
    assert copy_in.in_company_repo(os.path.join(company_config["registryPath"], "registry.csv"), cfg)
    assert not copy_in.in_company_repo(str(tmp_path / "Downloads" / "x.step"), cfg)
    # a sibling whose name merely starts with the repo's name is outside
    assert not copy_in.in_company_repo(company_config["projects"]["CM"]["repoPath"] + "-old/x.step", cfg)


def test_step_copied_next_to_part_file_and_only_those_files_committed(company_config, cad_repo, tmp_path, no_freecad):
    outside = tmp_path / "Downloads"
    outside.mkdir()
    src = outside / "Bracket.STEP"
    src.write_text("ISO-10303-21;")
    # unrelated dirty work in the repo must NOT be swept into the commit
    (cad_repo / "wip.txt").write_text("someone's uncommitted work")
    fcstd = cad_repo / "CM" / "Z" / "CMZ0010.FCStd"

    r = copy_in.pn_copy_in("CMZ0010", "bracket", "test bracket", str(fcstd), str(src))

    assert r["fcstdPath"] == str(fcstd)
    assert r["copiedPath"] == str(cad_repo / "CM" / "Z" / "CMZ0010.STEP")
    assert open(r["copiedPath"]).read() == "ISO-10303-21;"
    assert src.exists()  # a copy, never a move
    assert no_freecad[0]["model"] == r["copiedPath"]  # geometry comes from the in-repo copy
    assert r["committed"] is True and r["pushed"] is False  # no remote configured
    log = _log(cad_repo)
    assert "CM/Z/CMZ0010.STEP" in log and "CM/Z/CMZ0010.FCStd" in log
    assert "wip.txt" not in log


def test_image_gets_plain_copy_and_empty_tagged_part_file(company_config, cad_repo, tmp_path, no_freecad):
    src = tmp_path / "label.png"
    src.write_bytes(b"\x89PNG fake")
    fcstd = cad_repo / "CM" / "Z" / "CMZ0020" / "CMZ0020.FCStd"  # nested layout works too
    r = copy_in.pn_copy_in("CMZ0020", "label", "warning label", str(fcstd), str(src))
    assert r["copiedPath"] == str(cad_repo / "CM" / "Z" / "CMZ0020" / "CMZ0020.png")
    assert no_freecad[0]["model"] is None


def test_outside_fcstd_becomes_the_part_file(company_config, cad_repo, tmp_path, no_freecad):
    src = tmp_path / "theirs.FCStd"
    src.write_text("their design")
    fcstd = cad_repo / "CM" / "Z" / "CMZ0030.FCStd"
    r = copy_in.pn_copy_in("CMZ0030", "theirs", "their design", str(fcstd), str(src))
    assert r["copiedPath"] == r["fcstdPath"] == str(fcstd)
    assert open(fcstd).read() == "their design"
    assert no_freecad[0]["existing"] is True


def test_refuses_destination_outside_company_repos(company_config, tmp_path, no_freecad):
    src = tmp_path / "a.step"
    src.write_text("x")
    with pytest.raises(RpcError):
        copy_in.pn_copy_in("CMZ0040", "a", "a", str(tmp_path / "elsewhere" / "CMZ0040.FCStd"), str(src))


def test_never_overwrites(company_config, cad_repo, tmp_path, no_freecad):
    src = tmp_path / "a.step"
    src.write_text("x")
    (cad_repo / "CM" / "Z").mkdir(parents=True)
    (cad_repo / "CM" / "Z" / "CMZ0050.step").write_text("already here")
    with pytest.raises(RpcError):
        copy_in.pn_copy_in("CMZ0050", "a", "a", str(cad_repo / "CM" / "Z" / "CMZ0050.FCStd"), str(src))
    assert (cad_repo / "CM" / "Z" / "CMZ0050.step").read_text() == "already here"


def test_missing_source(company_config, cad_repo, tmp_path, no_freecad):
    with pytest.raises(RpcError):
        copy_in.pn_copy_in("CMZ0060", "a", "a", str(cad_repo / "CMZ0060.FCStd"), str(tmp_path / "nope.step"))
