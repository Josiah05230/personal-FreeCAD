"""Registry row selection: which row is "current" for a sequence, and the
one-row-per-sequence view every listing/lookup RPC is built on. registry.csv
holds one row PER REVISION by design (see partnumbers.py's module
docstring) - these tests exist because getting "current" wrong silently
shows stale data instead of erroring.
"""
from gwtcad import partnumbers as pn


def _row(pn_seq, rev, **overrides):
    row = {
        "pn": "%s%d" % (pn_seq, rev), "pn_seq": pn_seq, "project": pn_seq[:2],
        "type": pn_seq[2:3], "seq": pn_seq[3:], "rev": str(rev),
        "name": "", "description": "", "reason": "", "mfg": "", "mfg_pn": "",
        "purchasing_link": "", "status": "active", "lifecycle": "in_work",
        "rev_date": "", "created": "", "repo_relpath": "",
    }
    row.update(overrides)
    return row


def test_current_row_picks_highest_rev():
    rows = [_row("CMC001", 0), _row("CMC001", 1), _row("CMC001", 2)]
    cur = pn._current_row(rows, "CMC001")
    assert cur["rev"] == "2"


def test_current_row_unaffected_by_row_order():
    rows = [_row("CMC001", 2), _row("CMC001", 0), _row("CMC001", 1)]
    cur = pn._current_row(rows, "CMC001")
    assert cur["rev"] == "2"


def test_current_row_none_for_unknown_sequence():
    rows = [_row("CMC001", 0)]
    assert pn._current_row(rows, "CMC999") is None


def test_current_row_ignores_other_sequences():
    rows = [_row("CMC001", 0), _row("CMC001", 1), _row("CMB001", 5)]
    cur = pn._current_row(rows, "CMC001")
    assert cur["rev"] == "1"


def test_current_rows_returns_one_per_sequence():
    rows = [
        _row("CMC001", 0), _row("CMC001", 1),  # CMC001's current is rev 1
        _row("CMB001", 0),                      # CMB001 only has rev 0
    ]
    current = pn._current_rows(rows)
    by_seq = {r["pn_seq"]: r for r in current}
    assert set(by_seq) == {"CMC001", "CMB001"}
    assert by_seq["CMC001"]["rev"] == "1"
    assert by_seq["CMB001"]["rev"] == "0"


def test_current_rows_skips_rows_with_no_pn_seq():
    row = _row("CMC001", 0)
    row["pn_seq"] = ""
    assert pn._current_rows([row]) == []


def test_row_for_pn_matches_exact_revision_not_current():
    rows = [_row("CMC001", 0), _row("CMC001", 1)]
    # _row_for_pn wants the EXACT pn string (with rev digit), unlike
    # _current_row which always resolves to the latest.
    exact = pn._row_for_pn(rows, "CMC0010")
    assert exact["rev"] == "0"


def test_row_for_pn_none_when_that_exact_revision_never_existed():
    rows = [_row("CMC001", 0), _row("CMC001", 1)]
    assert pn._row_for_pn(rows, "CMC0015") is None


def test_rows_for_seq_returns_all_revisions_in_original_order():
    rows = [_row("CMC001", 2), _row("CMC001", 0), _row("CMC001", 1)]
    seq_rows = pn._rows_for_seq(rows, "CMC001")
    assert [r["rev"] for r in seq_rows] == ["2", "0", "1"]
