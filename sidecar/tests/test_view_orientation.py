"""Views are drawn right side up: what is above in the model is above on
the sheet, and a third-angle group puts the top view above the front.

Needs FreeCAD (run_tests.sh tier 2)."""
import pytest

App = pytest.importorskip("FreeCAD")
import Part  # noqa: E402

from gwtcad import drawing  # noqa: E402


def _l_part(d):
    """A bar on top with a tab hanging DOWN (-Z) at its right, front end."""
    bar = Part.makeBox(300, 60, 20)
    tab = Part.makeBox(20, 20, 100, App.Vector(260, 0, -100))
    o = d.addObject("Part::Feature", "L")
    o.Shape = bar.fuse(tab)
    return o


def test_plain_front_view_is_right_side_up():
    d = App.newDocument("orient")
    o = _l_part(d)
    page = drawing.create_page(d, label="Drawing")["id"]
    v = drawing.make_view(d, page, o, direction="front", scale=1.0)
    left_ys = [y for poly in v["visible"] for x, y in poly if x < 0]  # only the bar is left of centre
    assert min(left_ys) > 0, "the bar must be the TOP of the front view"
    # a model point projects onto the geometry drawn for it
    tip = drawing._project(d.getObject(v["id"]), App.Vector(270, 10, -100))
    assert tip[1] == pytest.approx(v["bbox"][1], abs=0.5)
    App.closeDocument(d.Name)


def test_third_angle_group_puts_top_above_front():
    d = App.newDocument("orientgroup")
    o = _l_part(d)
    page = drawing.create_page(d, label="Drawing")["id"]
    g = drawing.make_projection_group(d, page, o, ["front", "top", "right"], anchor="front",
                                      scale=0.5, spacing=(40, 40))
    drawing.set_projection_group_position(d, g["groupId"], 150, 150)
    views = {v["direction"]: v for v in drawing.page_contents(d, page)["views"] if v.get("groupId")}
    front, top, right = views["front"], views["top"], views["right"]
    assert top["y"] < front["y"], "top view above the front (sheet Y runs down)"
    assert right["x"] > front["x"]
    # front: bar on top
    assert min(y for poly in front["visible"] for x, y in poly if x < 0) > 0
    # right view (seen from +X): the tab is at the front of the part, which
    # a third-angle right view shows on its LEFT, hanging down
    tab_xs = [x for poly in right["visible"] for x, y in poly if y < -15]
    assert tab_xs and max(tab_xs) < 0
    App.closeDocument(d.Name)
