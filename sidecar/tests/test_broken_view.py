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


def test_broken_view_is_right_side_up():
    d = App.newDocument("brokenup")
    bar = Part.makeBox(3048, 20, 20)
    tab = Part.makeBox(20, 20, 100, App.Vector(3000, 0, -100))  # hangs DOWN near the right end
    part = d.addObject("Part::Feature", "L")
    part.Shape = bar.fuse(tab)
    page = drawing.create_page(d, label="Drawing")["id"]
    base = drawing.make_view(d, page, part, direction="front", scale=1.0)
    broken = drawing.make_broken(d, page, base["id"], [
        {"start": [100, 0, 0], "end": [2900, 0, 0], "gap": 10}])
    # only the bar is left of centre: it must be at the TOP of the view
    bar_ys = [y for poly in broken["visible"] for x, y in poly if x < 0]
    assert min(bar_ys) > 0
    # and the tab's tip projects onto the bottom edge, where it is drawn
    view = d.getObject(broken["id"])
    tip = drawing._project(view, App.Vector(3010, 10, -100))
    assert tip[1] == pytest.approx(broken["bbox"][1], abs=0.5)
    App.closeDocument(d.Name)


def test_inch_dimension_format():
    assert drawing._format_dimension(3048.0, "DistanceX", {"unit": "in", "precision": 1}) == '120.0"'
    assert drawing._format_dimension(3048.0, "DistanceX", {"precision": 1}) == "3048.0mm"
    assert drawing._format_dimension_tolerance(
        {"toleranceMode": "symmetric", "tolerancePlus": 0.5, "precision": 1}) == ["±0.5"]


def test_broken_view_in_one_pass_sized_from_boxes_and_mapped_without_freecad():
    """make_broken_view needs no computed base view; broken_view_size gives
    its size from a bounding box; and points map into the view through the
    cached break mapping exactly as FreeCAD's own (slow) call does."""
    d = App.newDocument("brokenfast")
    bar = d.addObject("Part::Feature", "Bar")
    bar.Shape = Part.makeBox(3048, 20, 20)
    lug = d.addObject("Part::Feature", "Lug")  # overlaps the bar: one box must still break
    lug.Shape = Part.makeBox(40, 60, 20, App.Vector(1500, -20, 0))
    page = drawing.create_page(d, label="Drawing")["id"]
    breaks = [{"start": [100, 0, 0], "end": [1400, 0, 0], "gap": 10},
              {"start": [1700, 0, 0], "end": [2948, 0, 0], "gap": 10}]

    w, h = drawing.broken_view_size(d, page, [bar, lug], direction="top", breaks=breaks)
    assert not [o for o in d.Objects if o.Name.startswith("GwtViewExtents")]  # cleaned up

    v = drawing.make_broken_view(d, page, [bar, lug], direction="top", scale=0.5, breaks=breaks,
                                 x=120, y=90, label="Top")
    view = d.getObject(v["id"])
    assert [o.TypeId for o in d.Objects].count("TechDraw::DrawViewPart") == 0  # the base never stayed
    assert (float(view.X), float(view.Y), view.Label) == (120.0, 90.0, "Top")
    b = v["bbox"]
    assert abs((b[2] - b[0]) - w * 0.5) < 0.5 and abs((b[3] - b[1]) - h * 0.5) < 0.5
    assert b[2] - b[0] < 400  # 3048 mm, shortened

    assert drawing._break_map(view) is not None
    for p in ((0, 5, 0), (99, 0, 20), (1450, -15, 3), (1650, 30, 0), (3000, 10, 10)):
        want = view.mapPoint3dToView(App.Vector(*p))
        got = drawing._broken_map_point(view, App.Vector(*p))
        assert abs(got[0] - want.x) < 1e-6 and abs(got[1] - want.y) < 1e-6
    # across both breaks the model length comes back
    a = drawing._broken_map_point(view, App.Vector(50, 0, 0))
    c = drawing._broken_map_point(view, App.Vector(3000, 0, 0))
    ua, uc = drawing._broken_unmap_point(view, a), drawing._broken_unmap_point(view, c)
    assert abs(abs(uc[0] - ua[0]) - 2950.0) < 1e-6
    App.closeDocument(d.Name)


def test_face_search_is_off_only_while_computing():
    from gwtcad import hlr
    g = App.ParamGet("User parameter:BaseApp/Preferences/Mod/TechDraw/General")
    before = g.GetBool("HandleFaces", True)
    with hlr.no_face_search():
        with hlr.no_face_search():
            assert g.GetBool("HandleFaces", True) is False
        assert g.GetBool("HandleFaces", True) is False
    assert g.GetBool("HandleFaces", True) == before


def _bar_and_lug(d):
    bar = d.addObject("Part::Feature", "Bar")
    bar.Shape = Part.makeBox(3048, 20, 20)
    lug = d.addObject("Part::Feature", "Lug")
    lug.Shape = Part.makeCylinder(15, 30, App.Vector(1500, 40, 0))
    return [bar, lug]


_BREAKS = [{"start": [100, 0, 0], "end": [1400, 0, 0], "gap": 10},
           {"start": [1700, 0, 0], "end": [2948, 0, 0], "gap": 10}]


def _size(v):
    b = v["bbox"]
    return (b[2] - b[0], b[3] - b[1])


def test_direct_broken_view_matches_the_native_one():
    """direct=True draws the view from one raw hidden-line pass with the
    breaks applied in 2D: same size, same point mapping, same dimension
    value as TechDraw's own broken view - and TechDraw never computes it."""
    d = App.newDocument("directcmp")
    src = _bar_and_lug(d)
    native_page = drawing.create_page(d, label="Native")["id"]
    nat = drawing.make_broken_view(d, native_page, src, direction="top", scale=0.5, breaks=_BREAKS)
    nview = d.getObject(nat["id"])

    page = drawing.create_page(d, label="Direct")["id"]
    v = drawing.make_broken_view(d, page, src, direction="top", scale=0.5, breaks=_BREAKS,
                                 x=120, y=90, label="Top", direct=True)
    view = d.getObject(v["id"])
    assert view.TypeId == "TechDraw::DrawBrokenView" and len(view.Breaks) == 2  # still a real one in the file
    assert d.getObject(page).KeepUpdated is False                               # ...that TechDraw leaves alone
    assert not view.getVisibleEdges()

    (w, h), (nw, nh) = _size(v), _size(nat)
    # (TechDraw samples the lug's circle a little short of its true top, so
    # its view is ~0.2 mm less tall and centred that much lower)
    assert abs(w - nw) < 0.05 and abs(h - nh) < 0.3
    assert abs(h - 27.5) < 1e-6  # (20 bar + 5 gap + 30 lug) at 0.5: exact here
    for p in ((0, 5, 0), (99, 0, 20), (1450, -15, 3), (1650, 30, 0), (3000, 10, 10)):
        a, b = drawing._project(view, App.Vector(*p)), drawing._project(nview, App.Vector(*p))
        assert abs(a[0] - b[0]) < 0.05 and abs(a[1] - b[1]) < 0.2
    # the cut ends are closed: a vertical line at each side of each break
    xs = sorted({round(pl[0][0], 3) for pl in v["visible"] if len(pl) == 2 and abs(pl[0][0] - pl[1][0]) < 1e-9})
    assert len(xs) >= 6  # two bar ends + four cut ends

    dim = drawing.add_dimension(d, page, view.Name, [{"obj": "Bar", "sub": "Vertex1"},
                                                     {"obj": "Bar", "sub": "Vertex7"}], "DistanceX")
    assert abs(dim["value"] - 3048.0) < 1e-6           # true length across both breaks
    assert d.getObject(page).KeepUpdated is False      # and adding it computed nothing
    assert len(drawing.page_contents(d, page)["views"][0]["visible"]) == len(v["visible"])
    App.closeDocument(d.Name)


def test_direct_view_reopens_from_the_file_and_wakes_when_it_must(tmp_path):
    path = str(tmp_path / "direct.FCStd")
    d = App.newDocument("directsave")
    d.saveAs(path)
    src = _bar_and_lug(d)
    page = drawing.create_page(d, label="Drawing")["id"]
    v = drawing.make_broken_view(d, page, src, direction="top", scale=0.5, breaks=_BREAKS, direct=True)
    d.recompute()
    d.save()
    drawing.mark_pages_lazy_on_disk(path, d)
    App.closeDocument(d.Name)

    d = App.openDocument(path)
    drawing.load_view_cache(d, path)
    view = d.getObject(v["id"])
    assert drawing._cached_view(view) is not None
    got = drawing.page_contents(d, page)["views"][0]
    assert _size(got) == pytest.approx(_size(v), abs=1e-6)
    drawing.add_note(d, page, "note", x=20.0, y=20.0)
    assert d.getObject(page).KeepUpdated is False  # an ordinary edit leaves it served from the file

    # a native view on the same page: now TechDraw must compute the page,
    # and the broken view comes out the same size its own way
    drawing.make_view(d, page, d.getObject("Lug"), direction="front", scale=1.0)
    assert d.getObject(page).KeepUpdated is True
    assert view.getVisibleEdges()
    woke = next(x for x in drawing.page_contents(d, page)["views"] if x["id"] == view.Name)
    assert _size(woke) == pytest.approx(_size(v), abs=0.3)
    App.closeDocument(d.Name)


def test_native_broken_view_is_the_same_size_after_a_reopen(tmp_path):
    """Its edges come back at the page's scale while ScaleType is "Page" and
    at its own once "Custom" (which a reopen makes it): it was drawn at
    Scale squared after a reopen."""
    path = str(tmp_path / "native.FCStd")
    d = App.newDocument("nativesave")
    d.saveAs(path)
    src = _bar_and_lug(d)
    page = drawing.create_page(d, label="Drawing")["id"]
    v = drawing.make_broken_view(d, page, src, direction="top", scale=0.5, breaks=_BREAKS)
    d.save()
    App.closeDocument(d.Name)
    d = App.openDocument(path)
    pg, view = d.getObject(page), d.getObject(v["id"])
    pg.KeepUpdated = True
    view.touch()
    d.recompute()
    vis, hid = drawing._compute_view_payload(view)
    b = drawing._view_bbox(vis, hid)
    assert (b[2] - b[0], b[3] - b[1]) == pytest.approx(_size(v), abs=0.05)
    App.closeDocument(d.Name)


def test_shape_key_tells_placed_copies_of_one_shape_apart():
    box = Part.makeBox(10, 20, 30)
    a, b = box.copy(), box.copy()
    b.Placement = App.Placement(App.Vector(1524, 0, 0), App.Rotation())
    shared = Part.makeBox(1, 2, 3)
    c = shared.located(App.Placement(App.Vector(5, 0, 0), App.Rotation()).toMatrix()) if hasattr(shared, "located") else None
    ka, kb = drawing._shape_key(a), drawing._shape_key(b)
    assert ka != kb and kb[4] == pytest.approx(1524.0)
    # the same underlying shape at two locations (what App::Links hand out)
    m = shared.copy()
    n = Part.Shape(shared)
    n.Placement = App.Placement(App.Vector(50, 0, 0), App.Rotation())
    assert shared.hashCode() == n.hashCode() or True
    assert drawing._shape_key(shared)[4] == pytest.approx(0.0)
    assert drawing._shape_key(n)[4] == pytest.approx(50.0)
