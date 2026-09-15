"""Headless 2D drawings via TechDraw.

`Drawing.projectToSVG` was removed in FreeCAD 1.1, so we build the projection
ourselves: create a TechDraw view (which runs the hidden-line removal), then
read its visible/hidden edges and emit polylines the renderer draws as SVG.
Dimension `FormattedValue` needs a GUI ViewProvider and is empty headlessly,
so the sidecar returns raw measured values and the frontend formats them
(lead/trail zero, precision, radius/diameter prefix).

Every drawing concept here is a real native TechDraw/Spreadsheet document
object living inside the .FCStd - `document.save`/`document.open` need no
special handling, they round-trip like any other object. `session.py`'s
`_drawings` registry only remembers id->label for the Browser tree; the
page's actual contents are these objects themselves.
"""
import json
import math
import time

import FreeCAD as App

from .registry import RpcError, APP_ERROR
from . import session

_DIRS = {
    "front": (0, -1, 0),
    "back": (0, 1, 0),
    "top": (0, 0, 1),
    "bottom": (0, 0, -1),
    "left": (-1, 0, 0),
    "right": (1, 0, 0),
    "iso": (1, -1, 1),
}
_DIR_ALIAS = {
    "isometric": "iso", "3d": "iso", "isometric view": "iso",
    "rear": "back", "bot": "bottom", "underside": "bottom",
}

_DIM_TYPES = {"distance", "distancex", "distancey", "distancez", "radius",
              "diameter", "angle", "angle3pt", "area"}


def _norm_dir(direction):
    k = str(direction or "front").strip().lower().replace(" view", "")
    k = _DIR_ALIAS.get(k, k)
    return k if k in _DIRS else "front"


def _norm_dim_type(kind):
    k = str(kind or "distance").strip().lower()
    if k not in _DIM_TYPES:
        return "Distance"
    return {"distancex": "DistanceX", "distancey": "DistanceY",
            "distancez": "DistanceZ", "angle3pt": "Angle3Pt"}.get(k, k.title())


def _edges_to_polylines(edges, tol=0.2):
    out = []
    for e in edges:
        try:
            pts = [(p.x, p.y) for p in e.discretize(Deflection=tol)]
        except Exception:
            try:
                a = e.valueAt(e.FirstParameter)
                b = e.valueAt(e.LastParameter)
                pts = [(a.x, a.y), (b.x, b.y)]
            except Exception:
                continue
        if len(pts) >= 2:
            out.append(pts)
    return out


def _view_bbox(vis, hid):
    xs = [p[0] for poly in vis + hid for p in poly]
    ys = [p[1] for poly in vis + hid for p in poly]
    return [min(xs), min(ys), max(xs), max(ys)] if xs else [0, 0, 0, 0]


def _project_offset(view):
    """The constant (dx, dy) that lines view.projectPoint() up with the
    SAME 2D coordinate frame the view's own visible/hidden edge polylines
    already use for the sheet SVG.

    view.projectPoint() alone returns an UNCENTERED projection (confirmed
    live: for a 40x20x20 box, projectPoint gave x in [0,40]/y in [0,20],
    while getVisibleEdges() - what the polylines are built from - gave x in
    [-20,20]/y in [-10,10] for the exact same geometry). Two approaches that
    looked right were confirmed WRONG on a second box size:
      - view.getGeometricCenter(): matched by coincidence on a 40x20x20 box,
        but returns the model's own 3D centroid, not the view's projection
        center - off by (0,10) on a 40x40x20 box.
      - matching shape.Edges[0] to getVisibleEdges()[0]: visible-edge
        culling does not preserve edge order/identity between the two lists,
        so "edge 1" in each is not necessarily the same physical edge - off
        by (0,20) on the same 40x40x20 box.
    The only correspondence that does NOT depend on matching a specific
    edge/vertex between the two representations is the bounding box itself:
    project every model vertex, take that set's min corner, and diff it
    against the min corner of the already-projected polylines (both are
    plain axis-aligned min/max over the same point set, immune to ordering).
    """
    edges = list(view.getVisibleEdges() or []) + list(view.getHiddenEdges() or [])
    if not edges:
        return (0.0, 0.0)
    xs2d, ys2d = [], []
    for e in edges:
        for t in (e.FirstParameter, e.LastParameter):
            pt = e.valueAt(t)
            xs2d.append(pt.x)
            ys2d.append(pt.y)
    if not xs2d:
        return (0.0, 0.0)
    min2d = (min(xs2d), min(ys2d))

    shape = view.Source[0].Shape if view.Source else None
    if shape is None or not shape.Vertexes:
        return (0.0, 0.0)
    xsp, ysp = [], []
    for v in shape.Vertexes:
        p = view.projectPoint(v.Point)
        xsp.append(p.x)
        ysp.append(p.y)
    minp = (min(xsp), min(ysp))

    return (minp[0] - min2d[0], minp[1] - min2d[1])


def _project(view, model_point, offset=None):
    """Project a 3D model-space point into the SAME 2D coordinate frame the
    view's own visible/hidden edge polylines already use for the sheet SVG.
    Pass a pre-computed `offset` (from _project_offset) when projecting many
    points against the same view to avoid recomputing it each time."""
    if offset is None:
        offset = _project_offset(view)
    p = view.projectPoint(model_point)
    return (p.x - offset[0], p.y - offset[1])


def _tag(obj, prop, value):
    """Stash a GWT-CAD-only string property on a native TechDraw object -
    same pattern as the original _gwt_dir tag: invisible to plain FreeCAD,
    round-trips with the object since it's a real property, no companion
    file needed."""
    if prop not in obj.PropertiesList:
        try:
            obj.addProperty("App::PropertyString", prop, "GWT").setEditorMode(prop, 2)
        except Exception:
            return
    try:
        setattr(obj, prop, str(value))
    except Exception:
        pass


def _get_tag(obj, prop, default=""):
    return getattr(obj, prop, default) or default


# --------------------------------------------------------------------------- #
# pages
# --------------------------------------------------------------------------- #

def list_pages(doc):
    out = []
    for o in doc.Objects:
        if o.TypeId == "TechDraw::DrawPage":
            out.append({"id": o.Name, "label": o.Label})
    return out


def get_page(doc, page_id):
    if page_id:
        p = doc.getObject(page_id)
        if p is not None and p.TypeId == "TechDraw::DrawPage":
            return p
    raise RpcError(APP_ERROR, "no such drawing page: %r" % page_id)


def create_page(doc, label=None):
    page = doc.addObject("TechDraw::DrawPage", "Drawing")
    tmpl = doc.addObject("TechDraw::DrawSVGTemplate", "Template")
    page.Template = tmpl
    if label:
        page.Label = label
    session.add_drawing(label=page.Label, drawing_id=page.Name)
    doc.recompute()
    return {"id": page.Name, "label": page.Label}


def delete_page(doc, page_id):
    page = get_page(doc, page_id)
    views = list(page.Views)
    tmpl = page.Template
    doc.removeObject(page.Name)
    for v in views:
        try:
            doc.removeObject(v.Name)
        except Exception:
            pass
    if tmpl is not None:
        try:
            doc.removeObject(tmpl.Name)
        except Exception:
            pass
    session.remove_drawing(page_id)
    doc.recompute()


def rename_page(doc, page_id, label):
    page = get_page(doc, page_id)
    page.Label = label
    session.rename_drawing(page_id, page.Label)
    return {"id": page.Name, "label": page.Label}


def page_contents(doc, page_id):
    """Everything already on a page, for rehydrating the sheet UI on
    reopen (Browser 'Drawings' double-click, or a fresh document.open) -
    the TechDraw/Spreadsheet objects themselves are the only persisted
    state (see module docstring), so this just re-derives the same payload
    shapes make_view/add_dimension/add_note/make_table already return."""
    page = get_page(doc, page_id)
    views, dimensions, notes, tables = [], [], [], []
    for o in page.Views:
        tid = o.TypeId
        if tid in ("TechDraw::DrawViewPart", "TechDraw::DrawViewSection",
                   "TechDraw::DrawViewDetail", "TechDraw::DrawBrokenView"):
            try:
                vis, hid = _part_view_payload(o)
            except Exception:
                continue
            kind = _get_tag(o, "_gwt_kind", "part")
            direction = _get_tag(o, "_gwt_dir", "front")
            entry = {
                "id": o.Name, "label": o.Label, "direction": direction,
                "kind": kind, "scale": float(o.Scale),
                "visible": vis, "hidden": hid, "bbox": _view_bbox(vis, hid),
            }
            base = _get_tag(o, "_gwt_base", "")
            if base:
                entry["baseViewId"] = base
            views.append(entry)
        elif tid == "TechDraw::DrawViewDimension":
            dimensions.append({
                "id": o.Name, "viewId": (o.References2D[0][0].Name if o.References2D else ""),
                "type": o.Type, "value": _dimension_raw_value(o),
            })
        elif tid == "TechDraw::DrawViewAnnotation":
            leader_id = None
            for leader in doc.Objects:
                if (leader.TypeId == "TechDraw::DrawLeaderLine"
                        and getattr(leader, "LeaderParent", None) is o):
                    leader_id = leader.Name
                    break
            notes.append({
                "id": o.Name, "text": "\n".join(o.Text) if o.Text else "",
                "x": float(o.X), "y": float(o.Y), "leaderId": leader_id,
            })
        elif tid == "TechDraw::DrawViewSpreadsheet":
            sheet = o.Source
            rows = []
            columns = []
            if sheet is not None:
                gwt_cols = _get_tag(sheet, "_gwt_columns", "")
                if gwt_cols:
                    try:
                        columns = json.loads(gwt_cols)
                    except Exception:
                        columns = []
                if not columns:
                    # fallback for a table not created through make_table
                    # (or from before _gwt_columns existed): re-derive from
                    # the header row text, lossy if header != data key.
                    col = 0
                    while True:
                        cell = "%s1" % chr(ord("A") + col)
                        try:
                            header = sheet.get(cell)
                        except Exception:
                            break
                        if not header:
                            break
                        columns.append({"key": str(header).lower(), "header": str(header),
                                         "source": str(header).lower()})
                        col += 1
                row = 2
                while columns:
                    try:
                        first = sheet.get("A%d" % row)
                    except Exception:
                        break
                    if not first:
                        break
                    rowvals = {}
                    for i, c in enumerate(columns):
                        cell = "%s%d" % (chr(ord("A") + i), row)
                        try:
                            rowvals[c["source"]] = sheet.get(cell)
                        except Exception:
                            rowvals[c["source"]] = ""
                    rows.append(rowvals)
                    row += 1
            tables.append({"id": o.Name, "sheetId": sheet.Name if sheet else "",
                            "pageId": page.Name, "columns": columns, "rows": rows})
    cleanup_lines = {}
    for v in views:
        cl = list_cleanup_lines(doc, v["id"])
        if cl:
            cleanup_lines[v["id"]] = cl
    return {"views": views, "dimensions": dimensions, "notes": notes,
            "tables": tables, "cleanupLines": cleanup_lines}


# --------------------------------------------------------------------------- #
# views
# --------------------------------------------------------------------------- #

def _part_view_payload(view):
    vis = _edges_to_polylines(view.getVisibleEdges()) if hasattr(view, "getVisibleEdges") else []
    hid = _edges_to_polylines(view.getHiddenEdges()) if hasattr(view, "getHiddenEdges") else []
    if not vis and not hid:
        raise RpcError(APP_ERROR, "drawing view produced no geometry")
    return vis, hid


def make_view(doc, page_id, source_obj, direction="front", scale=1.0):
    page = get_page(doc, page_id)
    direction = _norm_dir(direction)
    d = _DIRS[direction]

    view = doc.addObject("TechDraw::DrawViewPart", "View")
    page.addView(view)
    view.Source = [source_obj]
    view.Direction = App.Vector(*d)
    view.Scale = float(scale)
    view.Label = "%s view" % direction.title()
    _tag(view, "_gwt_dir", direction)
    _tag(view, "_gwt_kind", "part")
    doc.recompute()

    vis, hid = _part_view_payload(view)
    return {
        "id": view.Name, "label": view.Label, "direction": direction,
        "kind": "part", "scale": float(view.Scale),
        "visible": vis, "hidden": hid, "bbox": _view_bbox(vis, hid),
    }


def make_section(doc, page_id, base_view_id, plane="XY", offset=0.0, flip=False):
    page = get_page(doc, page_id)
    base = doc.getObject(base_view_id)
    if base is None or base.TypeId not in ("TechDraw::DrawViewPart",):
        raise RpcError(APP_ERROR, "section needs a normal part view as its base")

    normals = {"XY": (0, 0, 1), "XZ": (0, 1, 0), "YZ": (1, 0, 0)}
    n = App.Vector(*normals.get(str(plane).upper(), (0, 0, 1)))
    if flip:
        n = n.negative()

    view = doc.addObject("TechDraw::DrawViewSection", "Section")
    page.addView(view)
    view.BaseView = base
    view.Source = base.Source
    view.SectionNormal = n
    origin = base.Source[0].Shape.BoundBox.Center if base.Source else App.Vector(0, 0, 0)
    origin = App.Vector(origin.x, origin.y, origin.z + float(offset))
    view.SectionOrigin = origin
    view.Direction = base.Direction
    view.Scale = base.Scale
    view.Label = "Section %s" % view.Name
    base.Visibility = False
    _tag(view, "_gwt_kind", "section")
    _tag(view, "_gwt_base", base.Name)
    doc.recompute()

    vis, hid = _part_view_payload(view)
    return {
        "id": view.Name, "label": view.Label, "direction": _get_tag(base, "_gwt_dir", "front"),
        "kind": "section", "baseViewId": base.Name, "scale": float(view.Scale),
        "visible": vis, "hidden": hid, "bbox": _view_bbox(vis, hid),
    }


def make_detail(doc, page_id, base_view_id, anchor_xy, radius):
    page = get_page(doc, page_id)
    base = doc.getObject(base_view_id)
    if base is None:
        raise RpcError(APP_ERROR, "detail needs a base view")

    view = doc.addObject("TechDraw::DrawViewDetail", "Detail")
    page.addView(view)
    view.BaseView = base
    view.Source = base.Source
    view.AnchorPoint = App.Vector(float(anchor_xy[0]), float(anchor_xy[1]), 0)
    view.Radius = float(radius)
    view.Direction = base.Direction
    view.Scale = base.Scale * 2.0
    view.Label = "Detail %s" % view.Name
    _tag(view, "_gwt_kind", "detail")
    _tag(view, "_gwt_base", base.Name)
    doc.recompute()
    # DrawViewDetail computes its cut on a background worker in this FreeCAD
    # build; closing/saving the document before it settles segfaults
    # headlessly (confirmed live - "waiting for detail cut to finish" then a
    # SIGSEGV in App.closeDocument/doc.saveAs with no such wait). One more
    # recompute + a short sleep reliably lets it finish first.
    doc.recompute()
    time.sleep(0.3)

    vis, hid = _part_view_payload(view)
    return {
        "id": view.Name, "label": view.Label, "direction": _get_tag(base, "_gwt_dir", "front"),
        "kind": "detail", "baseViewId": base.Name, "scale": float(view.Scale),
        "visible": vis, "hidden": hid, "bbox": _view_bbox(vis, hid),
    }


def make_broken(doc, page_id, base_view_id, breaks):
    """`breaks`: list of {"axis":"x"|"y","pos":float,"gap":float}."""
    page = get_page(doc, page_id)
    base = doc.getObject(base_view_id)
    if base is None:
        raise RpcError(APP_ERROR, "broken view needs a base view")

    view = doc.addObject("TechDraw::DrawBrokenView", "Broken")
    page.addView(view)
    view.Source = base.Source
    view.Direction = base.Direction
    view.Scale = base.Scale
    view.Label = "Broken %s" % view.Name
    brk = []
    for b in (breaks or []):
        brk.append({
            "sketch": None,
            "axis": str(b.get("axis", "x")),
            "position": float(b.get("pos", 0.0)),
            "gap": float(b.get("gap", 10.0)),
        })
    _tag(view, "_gwt_kind", "broken")
    _tag(view, "_gwt_breaks", json.dumps(brk))
    doc.recompute()

    vis, hid = _part_view_payload(view)
    return {
        "id": view.Name, "label": view.Label, "direction": _get_tag(base, "_gwt_dir", "front"),
        "kind": "broken", "breaks": brk, "scale": float(view.Scale),
        "visible": vis, "hidden": hid, "bbox": _view_bbox(vis, hid),
    }


def convert_view(doc, page_id, view_id, to_kind, **kw):
    """Right-click "view state" switch: replace a view with a different
    TechDraw kind at the same placement, re-parenting any dimensions that
    referenced it (best-effort - orphaned dims are flagged, not dropped)."""
    view = doc.getObject(view_id)
    if view is None:
        raise RpcError(APP_ERROR, "no such view: %r" % view_id)
    page = get_page(doc, page_id)
    x, y, scale = view.X, view.Y, view.Scale
    source = view.Source
    direction = _get_tag(view, "_gwt_dir", "front")

    orphaned = []
    for o in doc.Objects:
        if o.TypeId == "TechDraw::DrawViewDimension":
            refs = list(getattr(o, "References2D", []) or [])
            if any(r[0] is view for r in refs if r):
                orphaned.append(o.Name)

    doc.removeObject(view.Name)
    doc.recompute()

    if to_kind == "part":
        new = doc.addObject("TechDraw::DrawViewPart", "View")
        page.addView(new)
        new.Source = source
        new.Direction = App.Vector(*_DIRS[_norm_dir(direction)])
        new.Scale = scale
        new.Label = "%s view" % direction.title()
        _tag(new, "_gwt_dir", direction)
        _tag(new, "_gwt_kind", "part")
        new.X, new.Y = x, y
        doc.recompute()
        vis, hid = _part_view_payload(new)
        payload = {"id": new.Name, "label": new.Label, "direction": direction,
                   "kind": "part", "scale": float(new.Scale),
                   "visible": vis, "hidden": hid, "bbox": _view_bbox(vis, hid)}
    elif to_kind == "section":
        payload = make_section(doc, page_id, source[0].Name if source else None,
                                plane=kw.get("plane", "XY"), offset=kw.get("offset", 0.0),
                                flip=kw.get("flip", False))
    else:
        raise RpcError(APP_ERROR, "unsupported view conversion: %r" % to_kind)

    if orphaned:
        payload["orphanedDimensions"] = orphaned
    return payload


# --------------------------------------------------------------------------- #
# dimensions
# --------------------------------------------------------------------------- #

def add_dimension(doc, page_id, view_id, refs, kind="Distance"):
    """`refs`: list of {"sub": "Edge3"} or {"sub":"Vertex1"} names on the view."""
    page = get_page(doc, page_id)
    view = doc.getObject(view_id)
    if view is None:
        raise RpcError(APP_ERROR, "no such view: %r" % view_id)
    if not refs:
        raise RpcError(APP_ERROR, "dimension needs at least one reference")

    dim = doc.addObject("TechDraw::DrawViewDimension", "Dimension")
    page.addView(dim)
    dim.Type = _norm_dim_type(kind)
    dim.References2D = [(view, str(r["sub"])) for r in refs]
    doc.recompute()

    value = _dimension_raw_value(dim)
    return {"id": dim.Name, "viewId": view.Name, "type": dim.Type, "value": value}


def _dimension_raw_value(dim):
    # DrawViewDimension has no headless-readable FormattedValue; recompute the
    # measurement ourselves from References2D against the base view's 3D
    # source shape, projecting through view.projectPoint (the same
    # model-space -> view-plane transform TechDraw's own dimension engine
    # uses) so results land in the same 2D coordinate space as the visible/
    # hidden edge polylines already sent to the frontend.
    try:
        refs = list(dim.References2D or [])
        if not refs:
            return None
        view = refs[0][0]
        shape = view.Source[0].Shape if view.Source else None
        if shape is None:
            return None
        # References2D groups every sub for the same view object into ONE
        # ref tuple, e.g. (view, ('Vertex1', 'Vertex2')) rather than two
        # separate (view, sub) entries - confirmed live: setting two
        # (view, str) pairs with the same view collapses to one entry whose
        # 2nd element is the tuple of both sub-names. Flatten across every
        # ref so a 2-point dimension on the same view keeps both points.
        subs = []
        for r in refs:
            s = r[1]
            subs.extend(s if isinstance(s, (tuple, list)) else [s])
        if dim.Type in ("Radius", "Diameter"):
            edge = _sub_model_edge(shape, subs[0])
            if edge is None:
                return None
            r = edge.Curve.Radius if hasattr(edge.Curve, "Radius") else None
            if r is None:
                return None
            return r * 2 if dim.Type == "Diameter" else r
        if dim.Type == "Angle" and len(subs) >= 2:
            e1 = _sub_model_edge(shape, subs[0])
            e2 = _sub_model_edge(shape, subs[1])
            if e1 is None or e2 is None:
                return None
            d1 = e1.Curve.Direction if hasattr(e1.Curve, "Direction") else None
            d2 = e2.Curve.Direction if hasattr(e2.Curve, "Direction") else None
            if d1 is None or d2 is None:
                return None
            cosang = max(-1.0, min(1.0, d1.dot(d2) / (d1.Length * d2.Length)))
            return math.degrees(math.acos(abs(cosang)))
        # Distance family: 2D distance in the view's own projected plane.
        # A single-edge reference measures between that edge's own two
        # endpoints; a two-point/two-edge reference measures between the
        # first point of each.
        offset = _project_offset(view)
        pts = []
        if len(subs) == 1 and subs[0].startswith("Edge"):
            edge = _sub_model_edge(shape, subs[0])
            if edge is not None:
                pts = [_project(view, edge.valueAt(edge.FirstParameter), offset),
                       _project(view, edge.valueAt(edge.LastParameter), offset)]
        else:
            for s in subs[:2]:
                p = _sub_point_2d(view, shape, s, offset)
                if p is not None:
                    pts.append(p)
        if len(pts) == 2:
            dx = pts[1][0] - pts[0][0]
            dy = pts[1][1] - pts[0][1]
            if dim.Type == "DistanceX":
                return abs(dx)
            if dim.Type == "DistanceY":
                return abs(dy)
            return math.hypot(dx, dy)
    except Exception:
        return None
    return None


def _sub_model_edge(shape, sub):
    """Resolve a sub-element name against the view's raw 3D model shape
    (topology/measurement, e.g. curve radius/length) - NOT the same
    coordinate space as the projected 2D polylines, only used where the
    measurement itself (radius, length, angle) is projection-independent."""
    try:
        return getattr(shape, sub)
    except Exception:
        return None


def _sub_point_2d(view, shape, sub, offset=None):
    """Resolve a vertex/edge-endpoint sub-element to the view's projected 2D
    plane via _project(), the same coordinate space getVisibleEdges()/
    getHiddenEdges() already use for the sheet SVG polylines."""
    try:
        if sub.startswith("Vertex"):
            v = getattr(shape, sub)
            return _project(view, v.Point, offset)
        if sub.startswith("Edge"):
            e = getattr(shape, sub)
            return _project(view, e.valueAt(e.FirstParameter), offset)
    except Exception:
        return None
    return None


def set_dimension_type(doc, dim_id, kind):
    dim = doc.getObject(dim_id)
    if dim is None or dim.TypeId != "TechDraw::DrawViewDimension":
        raise RpcError(APP_ERROR, "no such dimension: %r" % dim_id)
    dim.Type = _norm_dim_type(kind)
    doc.recompute()
    return {"id": dim.Name, "type": dim.Type, "value": _dimension_raw_value(dim)}


def set_dimension_format(dim_id, fmt):
    session.set_dim_format(dim_id, fmt)
    return session.dim_format(dim_id)


def set_default_dimension_format(fmt):
    session.set_dim_format_default(fmt)
    return session.dim_format_default()


# --------------------------------------------------------------------------- #
# cleanup (construction) lines - native cosmetic geometry on a DrawViewPart,
# a real snap target for dimensions/notes, hidden from PDF/DXF export unless
# explicitly shown (matches F360's construction-geometry behaviour).
# --------------------------------------------------------------------------- #

def add_cleanup_line(doc, view_id, p1, p2):
    view = doc.getObject(view_id)
    if view is None or not hasattr(view, "makeCosmeticLine"):
        raise RpcError(APP_ERROR, "cleanup lines are only supported on plain part views")
    a = App.Vector(float(p1[0]), float(p1[1]), 0)
    b = App.Vector(float(p2[0]), float(p2[1]), 0)
    tag = view.makeCosmeticLine(a, b)
    doc.recompute()
    return {"id": str(tag), "viewId": view.Name, "p1": list(p1), "p2": list(p2)}


def list_cleanup_lines(doc, view_id):
    view = doc.getObject(view_id)
    if view is None or not hasattr(view, "CosmeticEdges"):
        return []
    out = []
    for ce in view.CosmeticEdges or []:
        try:
            a, b = ce.Start, ce.End
            out.append({"id": str(ce.Tag), "p1": [a.x, a.y], "p2": [b.x, b.y]})
        except Exception:
            continue
    return out


def remove_cleanup_line(doc, view_id, line_id):
    view = doc.getObject(view_id)
    if view is None or not hasattr(view, "removeCosmeticEdge"):
        return
    try:
        view.removeCosmeticEdge(line_id)
        doc.recompute()
    except Exception:
        pass


# --------------------------------------------------------------------------- #
# notes / leaders
# --------------------------------------------------------------------------- #

def add_note(doc, page_id, text, x, y, leader_view_id=None, leader_point=None):
    page = get_page(doc, page_id)
    ann = doc.addObject("TechDraw::DrawViewAnnotation", "Note")
    page.addView(ann)
    ann.Text = [str(text)]
    ann.X = float(x)
    ann.Y = float(y)
    doc.recompute()

    leader_id = None
    if leader_view_id and leader_point:
        view = doc.getObject(leader_view_id)
        if view is not None:
            leader = doc.addObject("TechDraw::DrawLeaderLine", "Leader")
            page.addView(leader)
            leader.LeaderParent = ann
            leader.WayPoints = [
                App.Vector(float(leader_point[0]), float(leader_point[1]), 0),
                App.Vector(float(x), float(y), 0),
            ]
            doc.recompute()
            leader_id = leader.Name

    return {"id": ann.Name, "text": str(text), "x": float(ann.X), "y": float(ann.Y),
            "leaderId": leader_id}


def set_note_text(doc, note_id, text):
    ann = doc.getObject(note_id)
    if ann is None or ann.TypeId != "TechDraw::DrawViewAnnotation":
        raise RpcError(APP_ERROR, "no such note: %r" % note_id)
    ann.Text = [str(text)]
    doc.recompute()
    return {"id": ann.Name, "text": str(text)}


# --------------------------------------------------------------------------- #
# snap targets
# --------------------------------------------------------------------------- #

def list_snap_targets(doc, view_id):
    view = doc.getObject(view_id)
    if view is None:
        raise RpcError(APP_ERROR, "no such view: %r" % view_id)
    targets = []
    try:
        shape = view.Source[0].Shape if view.Source else None
    except Exception:
        shape = None
    if shape is not None:
        offset = _project_offset(view)
        for i, e in enumerate(shape.Edges, 1):
            try:
                a = _project(view, e.valueAt(e.FirstParameter), offset)
                b = _project(view, e.valueAt(e.LastParameter), offset)
                targets.append({"sub": "Edge%d" % i, "kind": "edge",
                                 "p1": [a[0], a[1]], "p2": [b[0], b[1]]})
            except Exception:
                continue
        for i, v in enumerate(shape.Vertexes, 1):
            try:
                p = _project(view, v.Point, offset)
                targets.append({"sub": "Vertex%d" % i, "kind": "vertex",
                                 "p": [p[0], p[1]]})
            except Exception:
                continue
    for cl in list_cleanup_lines(doc, view_id):
        targets.append({"sub": "Cosmetic%s" % cl["id"], "kind": "cleanup",
                         "p1": cl["p1"], "p2": cl["p2"]})
    return targets
