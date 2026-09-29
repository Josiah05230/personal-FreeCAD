"""The purchased-part drawing generator and how its drawings reopen - run
under freecadcmd (see sidecar/scripts/run_tests.sh). Uses a real vendor
STEP (KiCad's bundled 3D models) through the real generator; only the
Firebase upload is stubbed."""
import os
import shutil

import pytest

pytest.importorskip("FreeCAD")
import FreeCAD as App

from gwtcad import drawing, methods, session, supplier_models as sm
from gwtcad import partnumbers as pn

VENDOR_STEP = "/usr/share/kicad/3dmodels/Inductor_SMD.3dshapes/L_0603_1608Metric.step"


@pytest.fixture(autouse=True)
def no_upload(monkeypatch):
    monkeypatch.setattr(sm._storage, "upload_file", lambda *a, **k: None)


@pytest.fixture
def generated(company_config, cad_repo):
    if not os.path.isfile(VENDOR_STEP) or not shutil.which("rsvg-convert"):
        pytest.skip("needs KiCad 3D models + rsvg-convert")
    pn.pn_reserve("CM", "B", 1, "screw", "M3x6 socket head", mfg="McMaster-Carr", mfgPn="91292A111")
    folder = os.path.join(str(cad_repo), "CM", "B")
    os.makedirs(folder)
    shutil.copy(VENDOR_STEP, os.path.join(folder, "CMB0010.stp"))
    session.set_part_number({"pn": "USER0010", "name": "users part", "description": "open doc"})
    result = sm.generate_supplier_drawing("CMB0010")
    yield result, os.path.join(folder, "CMB0010.FCStd")
    for d in list(App.listDocuments().values()):
        App.closeDocument(d.Name)


def test_refuses_to_generate_without_a_real_mfg_and_mfg_pn(company_config, cad_repo):
    # regression: a .stp with no mfg/mfg_pn recorded on the registry row
    # used to silently produce a drawing whose NOTES callout said
    # "IS EQUIVALENT TO SUPPLIER ?" and whose title block PART NAME said
    # "PART" - a real, misleading placeholder shipped on a real generated
    # drawing (found live on CMC0020). This must be a hard block instead,
    # never a guessed-at fact.
    pn.pn_reserve("CM", "C", 99, "connector", "6-pin housing, no vendor info yet")
    folder = os.path.join(str(cad_repo), "CM", "C")
    os.makedirs(folder)
    shutil.copy(VENDOR_STEP, os.path.join(folder, "CMC0990.stp"))
    result = sm.generate_supplier_drawing("CMC0990")
    assert result["ok"] is False
    assert not os.path.isfile(os.path.join(folder, "CMC0990.FCStd"))
    assert any("?" not in e and "mfg" in e for e in result["errors"])


def test_part_name_is_the_one_word_registry_name_and_mfg_pn_is_only_in_the_note(generated):
    # regression: PART NAME was "<mfg> <mfg_pn>" ("McMaster-Carr 91292A111",
    # "Deutsch DT04-2P"); the user's rule is one word, mfg PN only in the note
    result, path = generated
    assert result["ok"], result
    methods.document_open(path)
    d = session.doc(create=False)
    cells = []
    for o in d.Objects:
        if o.TypeId == "Spreadsheet::Sheet":
            cells += [o.getContents(c).lstrip("'") for c in o.getUsedCells()]
    assert "SCREW" in cells
    assert not any("91292A111" in c or "McMaster" in c for c in cells)
    notes = [t for o in d.Objects if o.TypeId == "TechDraw::DrawViewAnnotation" for t in o.Text]
    assert any("IS EQUIVALENT TO MCMASTER-CARR 91292A111" in t for t in notes)


def _front_view(d):
    return next(o for o in d.Objects if o.TypeId == "TechDraw::DrawProjGroupItem"
                and drawing._get_tag(o, "_gwt_dir", "") in ("", "front") and str(o.Type) == "Front")


def test_generated_drawing_shows_its_overall_size(generated):
    # user, 2026-09-28: "There are also not dimensions in the drawing for
    # me to be able to tell scale" - front width/height + right depth,
    # measured from each view's drawn outline
    _, path = generated
    methods.document_open(path)
    d = session.doc(create=False)
    dims = [o for o in d.Objects if o.TypeId == "TechDraw::DrawViewDimension"]
    assert len(dims) == 3
    bb = App.BoundBox()
    for o in d.Objects:
        if o.TypeId == "Part::Feature":
            bb.add(o.Shape.BoundBox)
    values = sorted(round(drawing._dimension_raw_value(x), 2) for x in dims)
    assert values == sorted(round(v, 2) for v in (bb.XLength, bb.ZLength, bb.YLength))
    # each dimension sits just outside its own view's outline
    for x in dims:
        view = x.References2D[0][0]
        vis, hid = drawing._part_view_payload(view)
        min_x, min_y, max_x, max_y = drawing._view_bbox(vis, hid)
        label = drawing._dimension_geom(x)["labelUV"]
        assert label[1] > max_y or label[0] > max_x, (x.Name, label, (min_x, min_y, max_x, max_y))


def test_a_dimension_on_a_group_view_lands_on_its_outline(generated):
    # regression: a Front/Top/Right item's outline carries the group's
    # Scale but projectPoint() doesn't, so a dimension's points on a scaled
    # group view were drawn at 1/Scale of the geometry, in the view's corner
    _, path = generated
    methods.document_open(path)
    d = session.doc(create=False)
    page = next(o for o in d.Objects if o.TypeId == "TechDraw::DrawPage")
    view = _front_view(d)
    assert float(view.Scale) > 1.5  # a small vendor part is drawn enlarged
    drawing._ensure_page_live(d, page)
    vis, hid = drawing._part_view_payload(view)
    min_x, min_y, max_x, max_y = drawing._view_bbox(vis, hid)
    shape = view.Source[0].Shape
    far = max(range(len(shape.Vertexes)),
              key=lambda i: (shape.Vertexes[i].Point - shape.Vertexes[0].Point).Length)
    dim = drawing.add_dimension(d, page.Name, view.Name,
                                [{"sub": "Vertex1"}, {"sub": "Vertex%d" % (far + 1)}], "Distance")
    tol = 0.05 * max(max_x - min_x, max_y - min_y)
    for p in (dim["p1"], dim["p2"]):
        assert min_x - tol <= p[0] <= max_x + tol and min_y - tol <= p[1] <= max_y + tol, (p, (min_x, min_y, max_x, max_y))
    # and the value is still in model mm, not sheet mm (a projected length
    # can't exceed the 3D one; in sheet mm it would be Scale times bigger)
    assert 0 < dim["value"] <= (shape.Vertexes[far].Point - shape.Vertexes[0].Point).Length + 1e-6


@pytest.mark.parametrize("name,desc,why", [
    ("flat head", "M3x5mm flat head screw", "one-word"),
    ("", "M3x5mm flat head screw", "one-word"),
    ("screw", "Flat head screw (92010A114)", "manufacturer part number"),
])
def test_refuses_a_title_that_breaks_the_drawing_rules(company_config, cad_repo, name, desc, why):
    if not os.path.isfile(VENDOR_STEP):
        pytest.skip("needs KiCad 3D models")
    pn.pn_reserve("CM", "B", 3, name, desc, mfg="McMaster-Carr", mfgPn="92010A114")
    folder = os.path.join(str(cad_repo), "CM", "B")
    os.makedirs(folder)
    shutil.copy(VENDOR_STEP, os.path.join(folder, "CMB0030.stp"))
    result = sm.generate_supplier_drawing("CMB0030")
    assert result["ok"] is False
    assert any(why in e for e in result["errors"]), result
    assert not os.path.isfile(os.path.join(folder, "CMB0030.FCStd"))


def test_long_title_block_text_is_shrunk_to_fit_its_cell(company_config, cad_repo):
    # regression: CMB0020's registry description ran past the title block's
    # right border in the exported PDF ("...flat head screw (92010A11")
    if not os.path.isfile(VENDOR_STEP) or not shutil.which("rsvg-convert"):
        pytest.skip("needs KiCad 3D models + rsvg-convert")
    import re
    long_desc = "Passivated 18-8 stainless steel Phillips drive flat head screw"
    pn.pn_reserve("CM", "B", 2, "screw", long_desc, mfg="McMaster-Carr", mfgPn="92010A114")
    folder = os.path.join(str(cad_repo), "CM", "B")
    os.makedirs(folder)
    shutil.copy(VENDOR_STEP, os.path.join(folder, "CMB0020.stp"))
    assert sm.generate_supplier_drawing("CMB0020")["ok"]
    methods.document_open(os.path.join(folder, "CMB0020.FCStd"))  # tags the session so =PN etc. resolve
    d = session.doc(create=False)
    try:
        page = next(o for o in d.Objects if o.TypeId == "TechDraw::DrawPage")
        svg = drawing.export_page_svg(d, page.Name)
    finally:
        App.closeDocument(d.Name)

    def size_of(text):
        m = re.search(r'<text[^>]*font-size="([\d.]+)"[^>]*><tspan[^>]*>%s</tspan>' % re.escape(text), svg)
        assert m, text
        return float(m.group(1))

    # a short value keeps the table's own size, the long one is shrunk to fit
    assert size_of("CMB0020") > size_of(long_desc)
    from gwtcad import sheet_templates
    style = sheet_templates.load_sheet_template("GrainWave Technologies")["spec"]["titleBlockTable"]["style"]
    value_w = style["colWidths"][-1]
    # font sizes are written to 4 decimals, so allow that much rounding
    assert drawing._measure_text(long_desc, size_of(long_desc)) <= value_w - 3 + 0.01


def test_generation_restores_the_users_session_part_number(generated):
    result, _ = generated
    assert result["ok"], result
    assert session.part_number()["pn"] == "USER0010"


def test_generated_file_stores_its_part_number_and_uses_coarse_views(generated):
    _, path = generated
    d = App.openDocument(path)
    assert d.GwtPartNumber == "CMB0010"
    assert d.GwtPartDescription == "M3x6 socket head"
    views = [o for o in d.Objects if hasattr(o, "CoarseView")]
    assert views and all(o.CoarseView for o in views)


def test_reopened_drawing_reports_every_view_at_true_size(generated):
    # regression: the standalone iso reported its TechDraw Scale on top of
    # geometry that is already scaled, so PDFs drew it ~5x too big
    _, path = generated
    methods.document_open(path)
    d = session.doc(create=False)
    page = next(o for o in d.Objects if o.TypeId == "TechDraw::DrawPage")
    views = drawing.page_contents(d, page.Name)["views"]
    assert views and all(v["scale"] == 1.0 for v in views)
    assert not any(v.get("needsFit") for v in views)  # generator layouts are never refit
    w, h = 420.0, 297.0
    for v in views:
        bw, bh = v["bbox"][2] - v["bbox"][0], v["bbox"][3] - v["bbox"][1]
        assert bw < w / 2 and bh < h / 2, (v["label"], bw, bh)


def test_open_recovers_part_number_and_never_inherits_the_previous_one(generated, cad_repo):
    _, path = generated
    r = methods.document_open(path)
    assert r["partNumber"]["pn"] == "CMB0010"

    # a file with nothing stored and no registry match must come up untagged,
    # not carrying CMB0010 over from the previous open
    stray = os.path.join(str(cad_repo), "scratch.FCStd")
    d = App.newDocument("scratch")
    d.saveAs(stray)
    App.closeDocument(d.Name)
    assert methods.document_open(stray)["partNumber"] is None


def test_open_falls_back_to_the_registry_by_filename(company_config, cad_repo):
    pn.pn_reserve("CM", "C", 2, "connector", "2 PIN WP FEMALE")
    folder = os.path.join(str(cad_repo), "CM", "C")
    os.makedirs(folder)
    path = os.path.join(folder, "CMC0020.FCStd")
    d = App.newDocument("untagged")
    d.saveAs(path)
    App.closeDocument(d.Name)
    r = methods.document_open(path)
    assert r["partNumber"] == {"pn": "CMC0020", "name": "connector", "description": "2 PIN WP FEMALE"}


def test_set_view_scale_persists_and_marks_the_view(generated):
    _, path = generated
    methods.document_open(path)
    d = session.doc(create=False)
    iso = next(o for o in d.Objects if o.TypeId == "TechDraw::DrawViewPart")
    before = drawing.set_view_scale(d, iso.Name, iso.Scale)["bbox"]
    after = drawing.set_view_scale(d, iso.Name, iso.Scale / 2)["bbox"]
    assert abs((after[2] - after[0]) - (before[2] - before[0]) / 2) < 0.5
    assert drawing._get_tag(iso, "_gwt_scaled", "") == "1"


def _keep_updated_on_disk(path):
    import re
    import zipfile
    xml = zipfile.ZipFile(path).read("Document.xml").decode()
    return re.findall(r'name="KeepUpdated"[^>]*>\s*<Bool value="(\w+)"', xml)


def test_saved_drawing_is_lazy_on_disk_and_computed_on_first_use(generated):
    # opening a part used to pay for hidden-line removal on every drawing
    # view (~all of the open time); pages are now stored KeepUpdated=False
    # and computed only when the drawing is actually used
    _, path = generated
    assert _keep_updated_on_disk(path) == ["false"]

    methods.document_open(path)
    d = session.doc(create=False)
    parts = [o for o in d.Objects if o.TypeId in ("TechDraw::DrawProjGroupItem", "TechDraw::DrawViewPart")]
    assert parts and not any(v.getVisibleEdges() for v in parts), "views should not compute on open"

    page = next(o for o in d.Objects if o.TypeId == "TechDraw::DrawPage")
    views = drawing.page_contents(d, page.Name)["views"]
    assert all(v["visible"] for v in views)
    drawing.set_view_scale(d, views[0]["id"], 1.0)  # any real drawing edit computes the page
    assert page.KeepUpdated is True


def test_saving_keeps_the_open_page_live_but_the_file_lazy(generated):
    _, path = generated
    methods.document_open(path)
    d = session.doc(create=False)
    page = next(o for o in d.Objects if o.TypeId == "TechDraw::DrawPage")
    drawing._ensure_page_live(d, page)  # as any drawing edit does
    methods.document_save()
    assert page.KeepUpdated is True  # in memory: still live, no recompute forced
    assert _keep_updated_on_disk(path) == ["false"]  # on disk: lazy


def test_multi_body_vendor_model_keeps_each_body_separate(company_config, cad_repo, tmp_path):
    # regression: CMC0020's vendor STEP has 4 bodies but the generator
    # fused them into one object
    if not shutil.which("rsvg-convert"):
        pytest.skip("needs rsvg-convert")
    import Part
    pn.pn_reserve("CM", "C", 3, "connector", "2 pin housing", mfg="TE", mfgPn="1-123")
    folder = os.path.join(str(cad_repo), "CM", "C")
    os.makedirs(folder)
    stp = os.path.join(folder, "CMC0030.stp")
    Part.makeCompound([Part.makeBox(5, 5, 5), Part.makeBox(2, 2, 8, App.Vector(10, 0, 0))]).exportStep(stp)
    result = sm.generate_supplier_drawing("CMC0030")
    assert result["ok"], result
    d = App.openDocument(os.path.join(folder, "CMC0030.FCStd"))
    try:
        bodies = [o for o in d.Objects if o.TypeId == "Part::Feature"]
        assert [b.Label for b in bodies] == ["1-123 body 1", "1-123 body 2"]
        grp = next(o for o in d.Objects if o.TypeId == "TechDraw::DrawProjGroup")
        assert len(grp.Source) == 2
    finally:
        App.closeDocument(d.Name)


def _payload(d, page):
    import json  # tuples vs lists: compare what the app actually receives
    return json.loads(json.dumps({v["id"]: (v["visible"], v["hidden"], v["bbox"], v.get("x"))
                                  for v in drawing.page_contents(d, page.Name)["views"]}))


def test_drawing_opens_from_saved_geometry_without_recomputing(generated):
    # the Drawing tab used to recompute hidden lines on first view (3-10s
    # for a dense vendor model); geometry saved with the file is used instead
    _, path = generated
    live = App.openDocument(path)
    page = next(o for o in live.Objects if o.TypeId == "TechDraw::DrawPage")
    drawing._view_cache["doc"] = None  # force a real computation for reference
    drawing._ensure_page_live(live, page)
    expected = _payload(live, page)
    App.closeDocument(live.Name)

    methods.document_open(path)
    d = session.doc(create=False)
    page = next(o for o in d.Objects if o.TypeId == "TechDraw::DrawPage")
    got = _payload(d, page)
    assert got.keys() == expected.keys()
    for vid, (vis, hid, bbox, x) in got.items():
        evis, ehid, ebbox, ex = expected[vid]
        # hidden-line removal isn't bit-for-bit repeatable (last digit)
        assert (len(vis), len(hid)) == (len(evis), len(ehid)), vid
        assert all(abs(a - b) < 1e-6 for a, b in zip(bbox, ebbox)), (vid, bbox, ebbox)
        assert x == ex or abs(x - ex) < 1e-6
    assert page.KeepUpdated is False, "reading the drawing should not have computed it"
    parts = [o for o in d.Objects if o.TypeId in ("TechDraw::DrawProjGroupItem", "TechDraw::DrawViewPart")]
    assert not any(v.getVisibleEdges() for v in parts)
    svg = drawing.export_page_svg(d, page.Name)
    assert "<polyline" in svg and page.KeepUpdated is False


def test_changed_model_is_recomputed_not_served_stale(generated):
    _, path = generated
    methods.document_open(path)
    d = session.doc(create=False)
    page = next(o for o in d.Objects if o.TypeId == "TechDraw::DrawPage")
    before = _payload(d, page)
    body = next(o for o in d.Objects if o.TypeId == "Part::Feature")
    shape = body.Shape.copy()
    shape.scale(2.0)
    body.Shape = shape
    d.recompute()
    after = _payload(d, page)
    assert page.KeepUpdated is True, "a changed source must compute the page"
    assert after != before


def test_saving_again_keeps_the_geometry_for_the_next_open(generated):
    _, path = generated
    methods.document_open(path)
    methods.document_save()  # page never computed this session: carried forward
    methods.document_open(path)
    d = session.doc(create=False)
    page = next(o for o in d.Objects if o.TypeId == "TechDraw::DrawPage")
    assert all(v["visible"] for v in drawing.page_contents(d, page.Name)["views"])
    assert page.KeepUpdated is False





def test_generated_iso_is_the_same_size_in_session_and_after_reopen(generated):
    # regression: the iso's ScaleType stayed "Page", which ignores Scale in
    # the generating session (so the layout and PDF used a 1x iso) and flips
    # to "Custom" on reopen (8x everywhere else)
    _, path = generated
    import json, zipfile
    saved = json.loads(zipfile.ZipFile(path).read("GwtDrawingCache.json"))["views"]
    d = App.openDocument(path)
    page = next(o for o in d.Objects if o.TypeId == "TechDraw::DrawPage")
    drawing._view_cache["doc"] = None
    drawing._ensure_page_live(d, page)
    for v in drawing._part_views(d):
        fresh = drawing._view_bbox(*drawing._compute_view_payload(v))
        cached = drawing._view_bbox(saved[v.Name]["visible"], saved[v.Name]["hidden"])
        assert all(abs(a - b) < 1e-6 for a, b in zip(fresh, cached)), (v.Name, fresh, cached)
