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
    monkeypatch.setattr(methods, "tessellate_shape", lambda s: (calls.append(1), real(s))[1])
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
