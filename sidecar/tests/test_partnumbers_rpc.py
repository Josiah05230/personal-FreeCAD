"""End-to-end RPC tests against real (throwaway, local-only) git repos -
exercises the actual pull/mutate/commit/push cycle that IS this module's
concurrency control (see its module docstring: "a rejected push is the
ONLY signal a collision happened"). No FreeCAD import needed; no network;
no real company data - registry_repo/cad_repo (conftest.py) are fresh git
repos in tmp_path with no remote configured, and company_config points
partnumbers._CONFIG_PATH at a throwaway company.json.
"""
import os

import pytest

from gwtcad import partnumbers as pn
from gwtcad.registry import RpcError


def test_reserve_assigns_pn_and_nested_relpath(company_config):
    result = pn.pn_reserve("CM", "Z", 10, "connector", "test part")
    assert result["pn"] == "CMZ0100"
    assert result["pnSeq"] == "CMZ010"
    assert result["repoRelpath"] == os.path.join("CM", "Z", "CMZ0100", "CMZ0100.FCStd")


def test_reserve_persists_row_to_registry_csv(company_config):
    pn.pn_reserve("CM", "C", 1, "connector", "2 PIN WP FEMALE")
    cfg = pn._load_config()
    row = pn._row_for_pn(pn._read_registry(cfg), "CMC0010")
    assert row is not None
    assert row["name"] == "connector"
    assert row["description"] == "2 PIN WP FEMALE"
    assert row["rev"] == "0"
    assert row["lifecycle"] == "in_work"


def test_reserve_rejects_a_sequence_already_taken(company_config):
    pn.pn_reserve("CM", "C", 1, "connector", "first")
    with pytest.raises(RpcError):
        pn.pn_reserve("CM", "C", 1, "connector", "second - should collide")


def test_reserve_auto_fills_mcmaster_purchasing_link(company_config):
    result = pn.pn_reserve("CM", "B", 1, "screw", "M3x6", mfg="McMaster-Carr", mfgPn="91292A111")
    assert result.get("pn") == "CMB0010"
    cfg = pn._load_config()
    row = pn._row_for_pn(pn._read_registry(cfg), "CMB0010")
    assert "91292A111" in row["purchasing_link"]
    assert "mcmaster.com" in row["purchasing_link"]


def test_reserve_does_not_override_explicit_purchasing_link(company_config):
    pn.pn_reserve("CM", "B", 1, "screw", "M3x6", mfg="McMaster-Carr", mfgPn="91292A111",
                  purchasingLink="https://example.com/my-own-link")
    cfg = pn._load_config()
    row = pn._row_for_pn(pn._read_registry(cfg), "CMB0010")
    assert row["purchasing_link"] == "https://example.com/my-own-link"


def test_new_revision_copies_file_and_stays_in_same_folder(company_config, cad_repo):
    reserved = pn.pn_reserve("CM", "C", 1, "connector", "v0")
    abspath = os.path.join(str(cad_repo), reserved["repoRelpath"])
    os.makedirs(os.path.dirname(abspath), exist_ok=True)
    with open(abspath, "w") as f:
        f.write("fake fcstd content")

    result = pn.pn_new_revision("CMC001", reason="bumped for testing")
    assert result["pn"] == "CMC0011"
    assert result["rev"] == 1
    assert os.path.dirname(result["repoRelpath"]) == os.path.dirname(reserved["repoRelpath"])
    assert os.path.isfile(result["path"])
    # old rev file must still exist - never overwritten/deleted
    assert os.path.isfile(abspath)


def test_new_revision_requires_a_reason(company_config, cad_repo):
    pn.pn_reserve("CM", "C", 1, "connector", "v0")
    with pytest.raises(RpcError):
        pn.pn_new_revision("CMC001", reason="")
    with pytest.raises(RpcError):
        pn.pn_new_revision("CMC001", reason="   ")


def test_new_revision_fails_loudly_if_current_file_is_missing(company_config):
    # reserve() only registers the identity - it never creates the file
    # itself (the caller does saveAs). Bumping a revision before that
    # saveAs happened must fail clearly, not silently invent a rev.
    pn.pn_reserve("CM", "C", 1, "connector", "v0")
    with pytest.raises(RpcError):
        pn.pn_new_revision("CMC001", reason="should fail - no file exists yet")


def test_resolve_finds_file_via_hint(company_config, cad_repo):
    reserved = pn.pn_reserve("CM", "C", 1, "connector", "test")
    abspath = os.path.join(str(cad_repo), reserved["repoRelpath"])
    os.makedirs(os.path.dirname(abspath), exist_ok=True)
    open(abspath, "w").close()

    result = pn.pn_resolve("CMC001")
    assert result["path"] == abspath


def test_resolve_accepts_full_pn_with_rev_digit(company_config, cad_repo):
    reserved = pn.pn_reserve("CM", "C", 1, "connector", "test")
    abspath = os.path.join(str(cad_repo), reserved["repoRelpath"])
    os.makedirs(os.path.dirname(abspath), exist_ok=True)
    open(abspath, "w").close()

    result = pn.pn_resolve("CMC0010")  # full PN, not bare pn_seq
    assert result["path"] == abspath


def test_resolve_raises_for_unknown_pn(company_config):
    with pytest.raises(RpcError):
        pn.pn_resolve("CMZ999")


def test_resolve_raises_when_file_genuinely_missing(company_config):
    pn.pn_reserve("CM", "C", 1, "connector", "test")
    with pytest.raises(RpcError):
        pn.pn_resolve("CMC001")  # reserved, but the file was never created


def test_set_lifecycle_updates_current_row_only(company_config, cad_repo):
    reserved = pn.pn_reserve("CM", "C", 1, "connector", "v0")
    abspath = os.path.join(str(cad_repo), reserved["repoRelpath"])
    os.makedirs(os.path.dirname(abspath), exist_ok=True)
    open(abspath, "w").close()
    pn.pn_new_revision("CMC001", reason="bump")

    pn.pn_set_lifecycle("CMC001", "active")

    cfg = pn._load_config()
    rows = pn._read_registry(cfg)
    rev0 = pn._row_for_pn(rows, "CMC0010")
    rev1 = pn._row_for_pn(rows, "CMC0011")
    assert rev1["lifecycle"] == "active"
    assert rev0["lifecycle"] == "in_work"  # past revisions never change retroactively


def test_set_lifecycle_rejects_unknown_value(company_config):
    pn.pn_reserve("CM", "C", 1, "connector", "v0")
    with pytest.raises(RpcError):
        pn.pn_set_lifecycle("CMC001", "not_a_real_state")


def test_set_lifecycle_reports_unchanged_when_already_set(company_config):
    pn.pn_reserve("CM", "C", 1, "connector", "v0")  # starts in_work
    result = pn.pn_set_lifecycle("CMC001", "in_work")
    assert result.get("unchanged") is True


def test_relocate_updates_hint_when_move_is_within_project_repo(company_config, cad_repo):
    reserved = pn.pn_reserve("CM", "C", 1, "connector", "v0")
    old_abs = os.path.join(str(cad_repo), reserved["repoRelpath"])
    os.makedirs(os.path.dirname(old_abs), exist_ok=True)
    open(old_abs, "w").close()

    new_dir = os.path.join(str(cad_repo), "CM", "C", "CMC0010", "archive")
    os.makedirs(new_dir)
    new_abs = os.path.join(new_dir, "CMC0010.FCStd")
    os.rename(old_abs, new_abs)

    pn.pn_relocate("CMC001", new_abs)

    cfg = pn._load_config()
    row = pn._row_for_pn(pn._read_registry(cfg), "CMC0010")
    assert row["repo_relpath"] == os.path.relpath(new_abs, str(cad_repo))


def test_relocate_rejects_path_outside_project_repo(company_config, tmp_path):
    pn.pn_reserve("CM", "C", 1, "connector", "v0")
    outside = tmp_path / "elsewhere" / "CMC0010.FCStd"
    outside.parent.mkdir(parents=True)
    outside.write_text("x")
    with pytest.raises(RpcError):
        pn.pn_relocate("CMC001", str(outside))


def test_relocate_rejects_wrong_filename(company_config, cad_repo):
    pn.pn_reserve("CM", "C", 1, "connector", "v0")
    wrong = os.path.join(str(cad_repo), "CM", "C", "SOMETHING_ELSE.FCStd")
    os.makedirs(os.path.dirname(wrong), exist_ok=True)
    open(wrong, "w").close()
    with pytest.raises(RpcError):
        pn.pn_relocate("CMC001", wrong)


def test_list_all_returns_only_current_rows(company_config, cad_repo):
    reserved = pn.pn_reserve("CM", "C", 1, "connector", "v0")
    abspath = os.path.join(str(cad_repo), reserved["repoRelpath"])
    os.makedirs(os.path.dirname(abspath), exist_ok=True)
    open(abspath, "w").close()
    pn.pn_new_revision("CMC001", reason="bump")
    pn.pn_reserve("CM", "B", 1, "screw", "M3x6")

    result = pn.pn_list_all()
    pns = {r["pn"] for r in result["parts"]}
    assert pns == {"CMC0011", "CMB0010"}  # current rev of each, not every row


def test_list_all_filters_by_project(company_config, cad_repo):
    pn.pn_reserve("CM", "C", 1, "connector", "v0")
    result = pn.pn_list_all(project="ZZ")
    assert result["parts"] == []


def test_history_returns_every_revision_oldest_first(company_config, cad_repo):
    reserved = pn.pn_reserve("CM", "C", 1, "connector", "v0")
    abspath = os.path.join(str(cad_repo), reserved["repoRelpath"])
    os.makedirs(os.path.dirname(abspath), exist_ok=True)
    open(abspath, "w").close()
    pn.pn_new_revision("CMC001", reason="bump 1")
    new_abspath = os.path.join(str(cad_repo), "CM", "C", "CMC0010", "CMC0011.FCStd")
    open(new_abspath, "w").close()
    pn.pn_new_revision("CMC001", reason="bump 2")

    result = pn.pn_history("CMC001")
    revs = [r["rev"] for r in result["revisions"]]
    assert revs == ["0", "1", "2"]


def test_list_available_seq_fills_holes_left_by_obsoleted_parts(company_config):
    pn.pn_reserve("CM", "C", 1, "connector", "a")
    pn.pn_reserve("CM", "C", 3, "connector", "c")
    result = pn.pn_list_available_seq("CM", "C", count=3)
    assert 2 in result["available"]
    assert 1 not in result["available"]
    assert 3 not in result["available"]
