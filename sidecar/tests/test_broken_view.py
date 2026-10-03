"""A real (native) broken view: the view is shortened, a dimension across
the break is drawn inside the shortened view and still reads the true
model length, and a length can be shown in inches.

Needs FreeCAD: run with freecadcmd's Python (see test_scene_cache.py).
"""
import pytest

App = pytest.importorskip("FreeCAD")
import Part  # noqa: E402

from gwtcad import drawing, session  # noqa: E402


def test_native_break_shortens_view_and_keeps_true_dimension():
    d = App.newDocument("brokentest")
    bar = d.addObject("Part::Feature", "Bar")
    bar.Shape = Part.makeBox(3048, 20, 20)  # 10 ft
    page = drawing.create_page(d, label="Drawing")["id"]
    base = drawing.make_view(d, page, bar, direction="front", scale=1.0)
    full = base["bbox"]
    assert full[2] - full[0] > 3000

    broken = drawing.make_broken(d, page, base["id"], [
        {"start": [100, 0, 0], "end": [2948, 0, 0], "gap": 10}])
    bb = broken["bbox"]
    assert bb[2] - bb[0] == pytest.approx(210, abs=1)  # 100 + gap 10 + 100
    brk = broken["breaks"][0]
    assert brk["axis"] == "x" and brk["gap"] == pytest.approx(10, abs=0.5)

    view = d.getObject(broken["id"])
    # both ends of the bar land on the shortened view's outline
    left = drawing._project(view, App.Vector(0, 0, 0))
    right = drawing._project(view, App.Vector(3048, 0, 0))
    assert left[0] == pytest.approx(bb[0], abs=0.5)
    assert right[0] == pytest.approx(bb[2], abs=0.5)

    # an overall-length dimension on it still measures the model
    dim = drawing.add_dimension(d, page, broken["id"], [{"sub": "Edge1"}], "Distance")
    drawing._tag(d.getObject(dim["id"]), drawing.DIM_EXTENT_TAG, "x+")
    d.recompute()
    contents = drawing.page_contents(d, page)
    got = next(x for x in contents["dimensions"] if x["id"] == dim["id"])
    assert got["value"] == pytest.approx(3048, abs=0.5)
    App.closeDocument(d.Name)


def test_native_break_respects_view_scale():
    d = App.newDocument("brokenscale")
    bar = d.addObject("Part::Feature", "Bar")
    bar.Shape = Part.makeBox(3048, 20, 20)
    page = drawing.create_page(d, label="Drawing")["id"]
    base = drawing.make_view(d, page, bar, direction="front", scale=0.5)
    broken = drawing.make_broken(d, page, base["id"], [
        {"start": [100, 0, 0], "end": [2948, 0, 0], "gap": 10}])
    bb = broken["bbox"]
    assert bb[2] - bb[0] == pytest.approx(105, abs=1)  # (100 + 10 + 100) at 1:2
    view = d.getObject(broken["id"])
    assert drawing._project(view, App.Vector(3048, 0, 0))[0] == pytest.approx(bb[2], abs=0.5)
    dim = drawing.add_dimension(d, page, broken["id"], [{"sub": "Edge1"}], "Distance")
    drawing._tag(d.getObject(dim["id"]), drawing.DIM_EXTENT_TAG, "x+")
    d.recompute()
    got = next(x for x in drawing.page_contents(d, page)["dimensions"] if x["id"] == dim["id"])
    assert got["value"] == pytest.approx(3048, abs=0.5)
    App.closeDocument(d.Name)


def test_dimension_between_two_objects_across_a_break():
    d = App.newDocument("twoobj")
    a = d.addObject("Part::Feature", "A")
    a.Shape = Part.makeBox(40, 20, 20)
    b = d.addObject("Part::Feature", "B")
    b.Shape = Part.makeBox(40, 20, 20, App.Vector(3008, 0, 0))
    wire = d.addObject("Part::Feature", "Wire")
    wire.Shape = Part.makeBox(2968, 2, 2, App.Vector(40, 9, 9))
    page = drawing.create_page(d, label="Drawing")["id"]
    base = drawing.make_view(d, page, [wire, a, b], direction="front", scale=1.0)
    broken = drawing.make_broken(d, page, base["id"], [
        {"start": [200, 0, 0], "end": [2848, 0, 0], "gap": 10}])
    # A's far left corner to B's far right corner: the whole 3048
    av = next("Vertex%d" % (i + 1) for i, v in enumerate(a.Shape.Vertexes) if v.Point.x == 0)
    bv = next("Vertex%d" % (i + 1) for i, v in enumerate(b.Shape.Vertexes) if v.Point.x == 3048)
    dim = drawing.add_dimension(d, page, broken["id"],
                                [{"obj": "A", "sub": av}, {"obj": "B", "sub": bv}], "DistanceX")
    assert dim["value"] == pytest.approx(3048, abs=0.5)
    bb = broken["bbox"]
    assert dim["p1"][0] == pytest.approx(bb[0], abs=0.5)
    assert dim["p2"][0] == pytest.approx(bb[2], abs=0.5)
    App.closeDocument(d.Name)


def test_inch_dimension_format():
    assert drawing._format_dimension(3048.0, "DistanceX", {"unit": "in", "precision": 1}) == '120.0"'
    assert drawing._format_dimension(3048.0, "DistanceX", {"precision": 1}) == "3048.0mm"
    assert drawing._format_dimension_tolerance(
        {"toleranceMode": "symmetric", "tolerancePlus": 0.5, "precision": 1}) == ["±0.5"]
