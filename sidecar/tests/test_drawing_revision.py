"""Drawings across a revision (drawing.refreshForRevision) - run under
freecadcmd (see sidecar/scripts/run_tests.sh). A generated drawing nobody
touched is rebuilt for the new revision; an edited one is kept with its
title block brought up to the new PN."""
import os
import shutil

import pytest

pytest.importorskip("FreeCAD")
import FreeCAD as App

from gwtcad import methods, session, supplier_models as sm
from gwtcad import partnumbers as pn

VENDOR_STEP = "/usr/share/kicad/3dmodels/Inductor_SMD.3dshapes/L_0603_1608Metric.step"


@pytest.fixture(autouse=True)
def no_upload(monkeypatch):
    monkeypatch.setattr(sm._storage, "upload_file", lambda *a, **k: None)


@pytest.fixture
def rev1(company_config, cad_repo):
    """CMB0010 generated from a vendor STEP, then revised to CMB0011 and
    opened the way the app does it (newRevision copies, tag, open)."""
    if not os.path.isfile(VENDOR_STEP) or not shutil.which("rsvg-convert"):
        pytest.skip("needs KiCad 3D models + rsvg-convert")
    pn.pn_reserve("CM", "B", 1, "screw", "M3x6 socket head", mfg="McMaster-Carr", mfgPn="91292A111")
    folder = os.path.join(str(cad_repo), "CM", "B")
    os.makedirs(folder)
    shutil.copy(VENDOR_STEP, os.path.join(folder, "CMB0010.stp"))
    assert sm.generate_supplier_drawing("CMB0010")["ok"]
    res = pn.pn_new_revision("CMB001", reason="fix body placement")
    methods.document_open(res["path"])
    pn.pn_tag_document(res["pn"], res["name"], res["description"])
    yield res
    for d in list(App.listDocuments().values()):
        App.closeDocument(d.Name)


def _page(d):
    return next(o for o in d.Objects if o.TypeId == "TechDraw::DrawPage")


def _title_cells(d):
    out = []
    for o in d.Objects:
        if o.TypeId == "Spreadsheet::Sheet":
            for cell in ("B2", "B3", "B4", "B5", "A2", "A3", "A4"):
                try:
                    out.append(o.getContents(cell).lstrip("'"))
                except Exception:
                    pass
    return out


def _note_texts(d):
    texts = []
    for o in d.Objects:
        if o.TypeId == "TechDraw::DrawViewAnnotation":
            texts.extend(o.Text)
    return texts


def test_generated_drawing_is_stamped_and_the_stamp_survives_reopen(rev1):
    d = session.doc(create=False)
    page = _page(d)
    info = sm._auto_drawing_info(page)
    assert info and info["kind"] == "supplier"
    # opening lazily (KeepUpdated off on disk) must not read as an edit
    sm._drawing._ensure_page_live(d, page)
    assert sm.page_signature(page) == info["sig"]


def test_untouched_drawing_is_regenerated_for_the_new_revision(rev1):
    out = sm.refresh_drawing_for_revision()
    assert [p["action"] for p in out["pages"]] == ["regenerated"]
    d = session.doc(create=False)
    assert len([o for o in d.Objects if o.TypeId == "TechDraw::DrawPage"]) == 1
    assert "CMB0011" in _title_cells(d)
    assert "CMB0010" not in _title_cells(d)
    notes = " ".join(_note_texts(d))
    assert "CMB0011 IS EQUIVALENT TO MCMASTER-CARR 91292A111" in notes
    # nothing from the old page left behind
    assert len([o for o in d.Objects if o.TypeId == "TechDraw::DrawProjGroup"]) == 1
    assert len([o for o in d.Objects if o.TypeId == "Spreadsheet::Sheet"]) == 1
    # and the rebuilt page is itself stamped as untouched
    page = _page(d)
    assert sm._auto_drawing_info(page)["sig"] == sm.page_signature(page)


def test_rebuild_never_carries_a_placeholder_supplier_forward(rev1):
    # regression: with no mfg/mfg_pn on the new revision's registry row, the
    # rebuild kept the old note's supplier text (" IS EQUIVALENT TO SUPPLIER
    # ?") and the old stamp's title text ("PART"). Drop the note and say so.
    cfg = pn._load_config()
    rows = pn._read_registry(cfg)
    for r in rows:
        if r["pn"] == "CMB0011":
            r["mfg"], r["mfg_pn"] = "", ""
    pn._write_registry(cfg, rows)

    out = sm.refresh_drawing_for_revision()
    page = out["pages"][0]
    assert page["action"] == "regenerated"
    assert "CMB0011" in page["warning"]
    d = session.doc(create=False)
    text = " ".join(_note_texts(d) + _title_cells(d))
    assert "IS EQUIVALENT TO" not in text
    assert "?" not in text and "SUPPLIER" not in text and "PART" not in _title_cells(d)


def test_edited_drawing_is_kept_but_updated_to_the_new_revision(rev1):
    d = session.doc(create=False)
    page = _page(d)
    sm._drawing._ensure_page_live(d, page)
    iso = next(o for o in d.Objects if o.TypeId == "TechDraw::DrawViewPart"
               and o.InList and not any(p.TypeId == "TechDraw::DrawProjGroup" for p in o.InList))
    iso.X = iso.X.Value + 15.0  # the user dragged a view
    d.recompute()
    before = sorted(o.Name for o in d.Objects)

    out = sm.refresh_drawing_for_revision()
    assert [p["action"] for p in out["pages"]] == ["updated"]
    assert sorted(o.Name for o in d.Objects) == before  # nothing rebuilt
    assert "CMB0011" in _title_cells(d)
    assert "CMB0010" not in _title_cells(d)


def test_promotion_gate_leaves_the_open_part_open(rev1):
    # regression: _has_drawing_page opened the part being promoted - the one
    # on screen - and App.openDocument handed back that same document, so
    # closing it closed the user's part out from under the session
    r = sm.ensure_drawing_or_block("CMB0011")
    assert r["ok"] and r["hadDrawing"]
    assert session.doc(create=False) is not None
    assert session.doc(create=False).FileName == rev1["path"]


def test_a_drawing_already_made_for_this_revision_is_not_rebuilt(rev1):
    sm.refresh_drawing_for_revision()
    d = session.doc(create=False)
    before = sorted(o.Name for o in d.Objects)
    out = sm.refresh_drawing_for_revision()
    assert [p["action"] for p in out["pages"]] == ["updated"]
    assert sorted(o.Name for o in d.Objects) == before


def _view_bbox(d, view):
    from gwtcad import drawing as dr
    vis, hid = dr._part_view_payload(view)
    return dr._view_bbox(vis, hid)


def _iso(d):
    return next(o for o in d.Objects if o.TypeId == "TechDraw::DrawViewPart"
                and not any(p.TypeId == "TechDraw::DrawProjGroup" for p in o.InList))


def test_edited_drawing_views_follow_the_new_revisions_geometry(rev1):
    # the drawing must never show the previous revision's part: an edited
    # (kept) page still redraws every view from the current model
    d = session.doc(create=False)
    page = _page(d)
    sm._drawing._ensure_page_live(d, page)
    iso = _iso(d)
    iso.X = iso.X.Value + 15.0  # edited drawing
    d.recompute()
    before = _view_bbox(d, iso)
    body = next(o for o in d.Objects if o.TypeId == "Part::Feature")
    import Part
    body.Shape = body.Shape.fuse(Part.makeBox(4, 4, 4, body.Shape.BoundBox.Center))
    out = sm.refresh_drawing_for_revision()
    assert [p["action"] for p in out["pages"]] == ["updated"]
    after = _view_bbox(d, _iso(d))
    assert after != before


def test_an_in_work_revision_updates_without_rebuilding(rev1):
    d = session.doc(create=False)
    before = sorted(o.Name for o in d.Objects)
    out = sm.refresh_drawing_for_revision(rebuild=False)
    assert [p["action"] for p in out["pages"]] == ["updated"]
    assert sorted(o.Name for o in d.Objects) == before
    assert "CMB0011" in _title_cells(d)
    # and going active later still rebuilds it (untouched since generation)
    assert [p["action"] for p in sm.refresh_drawing_for_revision()["pages"]] == ["regenerated"]
