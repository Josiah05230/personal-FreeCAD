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
    folder = os.path.join(str(cad_repo), "CM", "B", "CMB0010")
    os.makedirs(folder)
    shutil.copy(VENDOR_STEP, os.path.join(folder, "CMB0010.stp"))
    session.set_part_number({"pn": "USER0010", "name": "users part", "description": "open doc"})
    result = sm.generate_supplier_drawing("CMB0010")
    yield result, os.path.join(folder, "CMB0010.FCStd")
    for d in list(App.listDocuments().values()):
        App.closeDocument(d.Name)


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
    folder = os.path.join(str(cad_repo), "CM", "C", "CMC0020")
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
