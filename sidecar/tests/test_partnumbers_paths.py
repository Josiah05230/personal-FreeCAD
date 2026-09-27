"""PN formatting and file-path resolution - the exact class of bug that
broke silently when pn-cad-files moved from a flat <PN>/<PN>.FCStd layout
to <project>/<type>/<PN>/<PN>.FCStd (supplier_models.py hardcoded the old
shape and would have started silently re-fetching/misplacing already-
organized files). These tests exist so a future structural change gets
caught here instead of by a manual audit after the fact.
"""
import os

from gwtcad import partnumbers as pn


def test_fmt_pn_pads_seq_to_three_digits():
    assert pn._fmt_pn("CM", "Z", 10, 0) == "CMZ0100"
    assert pn._fmt_pn("CM", "Z", 1, 0) == "CMZ0010"
    assert pn._fmt_pn("CM", "Z", 999, 3) == "CMZ9993"


def test_filename_for_matches_fmt_pn():
    assert pn._filename_for("CM", "C", 10, 0) == "CMC0100.FCStd"


def test_new_part_relpath_groups_by_project_then_type():
    relpath = pn._new_part_relpath("CM", "Z", 10, 0)
    assert relpath == os.path.join("CM", "Z", "CMZ0100.FCStd")


def test_new_part_relpath_has_no_per_part_folder():
    # the user asked for the parts themselves at the type level - no
    # <pn>/ folder holding a single file (and no bare <pn>.FCStd at the
    # repo root either).
    relpath = pn._new_part_relpath("CM", "C", 1, 0)
    parts = relpath.split(os.sep)
    assert parts == ["CM", "C", "CMC0010.FCStd"]


def test_kicad_project_relpath_is_per_sequence_beside_the_fcstd():
    assert pn.kicad_project_relpath(os.path.join("PS", "F", "PSF0012.FCStd")) == \
        os.path.join("PS", "F", "PSF001-kicad")


def test_find_part_file_uses_hint_when_valid(tmp_path):
    part_dir = tmp_path / "CM" / "C" / "CMC0010"
    part_dir.mkdir(parents=True)
    (part_dir / "CMC0010.FCStd").write_text("x")
    abspath, relpath = pn._find_part_file(
        str(tmp_path), "CMC0010.FCStd",
        hint_relpath=os.path.join("CM", "C", "CMC0010", "CMC0010.FCStd"),
    )
    assert abspath == str(part_dir / "CMC0010.FCStd")
    assert relpath == os.path.join("CM", "C", "CMC0010", "CMC0010.FCStd")


def test_find_part_file_self_heals_stale_hint(tmp_path):
    # the file actually lives somewhere the hint doesn't know about (e.g.
    # someone hand-moved it, or a migration like this session's happened) -
    # the recursive fallback must still find it.
    real_dir = tmp_path / "CM" / "C" / "CMC0010"
    real_dir.mkdir(parents=True)
    (real_dir / "CMC0010.FCStd").write_text("x")
    abspath, relpath = pn._find_part_file(
        str(tmp_path), "CMC0010.FCStd",
        hint_relpath="CMC0010.FCStd",  # stale: old flat-layout hint
    )
    assert abspath == str(real_dir / "CMC0010.FCStd")
    assert relpath == os.path.join("CM", "C", "CMC0010", "CMC0010.FCStd")


def test_find_part_file_returns_none_when_genuinely_missing(tmp_path):
    abspath, relpath = pn._find_part_file(str(tmp_path), "NOPE.FCStd")
    assert abspath is None
    assert relpath is None


def test_find_part_file_ignores_git_directory(tmp_path):
    (tmp_path / ".git").mkdir()
    (tmp_path / ".git" / "CMC0010.FCStd").write_text("decoy - must not match")
    abspath, _ = pn._find_part_file(str(tmp_path), "CMC0010.FCStd")
    assert abspath is None
