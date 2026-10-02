"""scene.get's mesh cache - run under freecadcmd (see sidecar/scripts/run_tests.sh)."""
import pytest

pytest.importorskip("FreeCAD")
import FreeCAD as App
import Part

from gwtcad import methods, session


def _save_part(path, shape):
    d = App.newDocument("cachetest")
    o = d.addObject("Part::Feature", "Thing")
    o.Shape = shape
    d.recompute()
    d.saveAs(str(path))
    App.closeDocument(d.Name)


@pytest.fixture
def meshing(monkeypatch):
    calls = []
    real = methods.tessellate_shape
    monkeypatch.setattr(methods, "tessellate_shape", lambda s, **kw: (calls.append(1), real(s, **kw))[1])
    # the in-memory cache under test - not meshes saved on disk by earlier runs
    monkeypatch.setattr(methods._mesh_disk, "load", lambda sig: None)
    monkeypatch.setattr(methods._mesh_disk, "save", lambda sig, buf: None)
    yield calls
    for d in list(App.listDocuments().values()):
        App.closeDocument(d.Name)


def test_refresh_and_switching_back_reuse_meshes_but_edits_remesh(tmp_path, meshing):
    # regressions: meshing a shape changes its BoundBox, so the cache key
    # never matched and every refresh re-meshed; and every open threw the
    # cache away, so switching back to a tab re-meshed the whole part
    a, b = tmp_path / "a.FCStd", tmp_path / "b.FCStd"
    _save_part(a, Part.makeCylinder(5, 20).fuse(Part.makeSphere(6, App.Vector(0, 0, 20))))
    _save_part(b, Part.makeBox(3, 3, 3))

    methods.document_open(str(a))
    methods.scene_get()
    assert len(meshing) == 1
    methods.scene_get()
    assert len(meshing) == 1, "an unchanged refresh re-meshed"

    methods.document_open(str(b))
    methods.scene_get()
    methods.document_open(str(a))
    meshing.clear()
    methods.scene_get()
    assert meshing == [], "switching back to a file re-meshed it"

    thing = session.doc(create=False).getObject("Thing")
    thing.Placement.Base = App.Vector(10, 0, 0)
    thing.Placement = thing.Placement
    session.doc(create=False).recompute()
    methods.scene_get()
    assert meshing == [1], "a moved shape must re-mesh, not reuse the old mesh"


def test_meshes_saved_on_disk_serve_a_fresh_session(tmp_path, monkeypatch):
    # a model is only meshed the first time it's ever opened (mesh_disk)
    monkeypatch.setenv("GWTCAD_CONFIG_DIR", str(tmp_path / "cfg"))
    calls = []
    real = methods.tessellate_shape
    monkeypatch.setattr(methods, "tessellate_shape", lambda s, **kw: (calls.append(1), real(s, **kw))[1])
    a = tmp_path / "a.FCStd"
    _save_part(a, Part.makeCylinder(5, 20))
    methods.document_open(str(a))
    methods.scene_get()
    assert calls == [1]
    methods._TESS_CACHE.clear()
    methods._TESS_BY_PATH.clear()  # as after an app restart
    methods.document_open(str(a))
    meshes = methods.scene_get()["meshes"]
    assert calls == [1], "re-meshed instead of loading the saved mesh"
    assert meshes and meshes[0]["indices"]
    for d in list(App.listDocuments().values()):
        App.closeDocument(d.Name)


def test_dimensioned_drawing_reopens_from_saved_geometry(tmp_path):
    from gwtcad import drawing
    path = tmp_path / "dim.FCStd"
    d = App.newDocument("dimtest")
    box = d.addObject("Part::Feature", "Box")
    box.Shape = Part.makeBox(40, 20, 10)
    page = drawing.create_page(d, label="Drawing")["id"]
    view = drawing.make_view(d, page, box, direction="front", scale=2.0)
    drawing.add_dimension(d, page, view["id"], [{"sub": "Vertex1"}, {"sub": "Vertex2"}])
    d.recompute()
    d.saveAs(str(path))
    drawing.mark_pages_lazy_on_disk(str(path), d)
    expected = drawing.page_contents(d, page)
    App.closeDocument(d.Name)

    methods.document_open(str(path))
    d = session.doc(create=False)
    got = drawing.page_contents(d, page)
    assert d.getObject(page).KeepUpdated is False
    [ed], [gd] = expected["dimensions"], got["dimensions"]
    assert gd["value"] == pytest.approx(ed["value"])
    for k in ("p1", "p2"):
        if k in ed:
            assert gd[k] == pytest.approx(ed[k])
    assert got["views"][0]["bbox"] == pytest.approx(expected["views"][0]["bbox"])
    for o in list(App.listDocuments().values()):
        App.closeDocument(o.Name)
