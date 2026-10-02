"""Element references survive dimension edits - run under freecadcmd (see
sidecar/scripts/run_tests.sh). pn-cad-files GWT-CAD-NEEDS.md #1.

With a document's UseHasher on, a sketch re-solve renumbers hashed element
names and a fillet's stored edge link goes Invalid. GWT-CAD makes new
documents with hashing off, and migrates an existing document on open.
"""
import pytest

pytest.importorskip("FreeCAD")
import FreeCAD as App
import Part
import Sketcher

from gwtcad import hasher, methods  # noqa: F401  (methods registers the RPCs)
from gwtcad.registry import dispatch

V = App.Vector


def _rect_pad_fillet(doc):
    b = doc.addObject("PartDesign::Body", "Body")
    sk = b.newObject("Sketcher::SketchObject", "Sketch")
    sk.AttachmentSupport = [(b.Origin.OriginFeatures[3], "")]
    sk.MapMode = "FlatFace"
    pts = [V(0, 0, 0), V(40, 0, 0), V(40, 20, 0), V(0, 20, 0)]
    for i in range(4):
        sk.addGeometry(Part.LineSegment(pts[i], pts[(i + 1) % 4]))
    for i in range(4):
        sk.addConstraint(Sketcher.Constraint("Coincident", i, 2, (i + 1) % 4, 1))
    for c in (("Horizontal", 0), ("Horizontal", 2), ("Vertical", 1), ("Vertical", 3)):
        sk.addConstraint(Sketcher.Constraint(*c))
    sk.addConstraint(Sketcher.Constraint("Coincident", 0, 1, -1, 1))
    length = sk.addConstraint(Sketcher.Constraint("DistanceX", 0, 1, 0, 2, 40))
    sk.addConstraint(Sketcher.Constraint("DistanceY", 1, 1, 1, 2, 20))
    pad = b.newObject("PartDesign::Pad", "Pad")
    pad.Profile = sk
    pad.Length = 10
    doc.recompute()
    fil = b.newObject("PartDesign::Fillet", "Fillet")
    fil.Radius = 2
    fil.Base = (pad, ["Edge%d" % (i + 1) for i, e in enumerate(pad.Shape.Edges)
                      if abs(e.BoundBox.ZLength - 10) < 1e-6])
    doc.recompute()
    # a sketch attached to the pad's top face - the face-attachment case
    top = next(i for i, f in enumerate(pad.Shape.Faces)
               if abs(f.CenterOfMass.z - 10) < 1e-6 and f.Surface.__class__.__name__ == "Plane")
    sk2 = b.newObject("Sketcher::SketchObject", "TopSketch")
    sk2.AttachmentSupport = [(pad, "Face%d" % (top + 1))]
    sk2.MapMode = "FlatFace"
    doc.recompute()
    return sk, length, fil, sk2


def _edit_and_check(doc, sk, length, fil, sk2):
    sk.setDatum(length, App.Units.Quantity(45, App.Units.Length))
    doc.recompute()
    assert "Invalid" not in fil.State and fil.isValid(), fil.getStatusString()
    assert sk2.isValid() and "Invalid" not in sk2.State, sk2.getStatusString()
    assert abs(fil.Shape.BoundBox.XLength - 45) < 1e-6


def test_new_documents_have_hashing_off():
    dispatch({"jsonrpc": "2.0", "id": 1, "method": "session.reset", "params": {}})
    assert App.ActiveDocument.UseHasher is False


def test_fillet_survives_a_sketch_edit_in_a_new_document():
    doc = hasher.new_document("HashOff")
    try:
        _edit_and_check(doc, *_rect_pad_fillet(doc))
    finally:
        App.closeDocument(doc.Name)


def test_hashed_document_breaks_without_migration(tmp_path):
    # the bug itself, so this test notices if FreeCAD ever fixes it upstream
    doc = App.newDocument("HashOn")
    try:
        doc.UseHasher = True
        sk, length, fil, _sk2 = _rect_pad_fillet(doc)
        sk.setDatum(length, App.Units.Quantity(45, App.Units.Length))
        doc.recompute()
        assert "Invalid" in fil.State
    finally:
        App.closeDocument(doc.Name)


def test_migrated_document_survives_edits(tmp_path):
    path = str(tmp_path / "hashed.FCStd")
    doc = App.newDocument("Hashed")
    doc.UseHasher = True
    _rect_pad_fillet(doc)
    doc.saveAs(path)
    App.closeDocument(doc.Name)

    doc = App.openDocument(path)
    try:
        vol = doc.getObject("Fillet").Shape.Volume
        assert hasher.migrate(doc) > 0
        assert doc.UseHasher is False
        assert abs(doc.getObject("Fillet").Shape.Volume - vol) < 1e-6  # geometry untouched
        sk = doc.getObject("Sketch")
        length = next(i for i, c in enumerate(sk.Constraints) if c.Type == "DistanceX")
        _edit_and_check(doc, sk, length, doc.getObject("Fillet"), doc.getObject("TopSketch"))
    finally:
        App.closeDocument(doc.Name)
