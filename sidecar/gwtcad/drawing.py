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
import base64
import json
import math
import os
import time
from xml.sax.saxutils import escape

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


def _view_uv_to_sheet(view, uv):
    """A point in a view's own projected UV frame (the same frame
    page_contents' views[].visible/hidden polylines and _project's output
    live in - what the frontend calls "view-UV") -> absolute page/sheet
    coordinates (mm), the frame view.X/view.Y and a note's own X/Y live in.

    Mirrors the frontend's uvToLocal + placed.x/y exactly (see
    DrawingSheet.tsx): sheet = view.X + (u - minX), view.Y - (v - maxY),
    using the view's own bbox (min/max over its visible+hidden polylines,
    same source _view_bbox already uses for the view DTO's own bbox field)
    to find that frame's origin. Needed because a leader's WayPoints - a
    DrawLeaderLine, not a DrawViewDimension - take raw sheet coordinates
    with no References2D-style live binding at all; a caller only ever has
    a point relative to the view it clicked on, so this conversion has to
    happen at write time (see add_note's leader_point)."""
    try:
        vis = _edges_to_polylines(view.getVisibleEdges()) if hasattr(view, "getVisibleEdges") else []
        hid = _edges_to_polylines(view.getHiddenEdges()) if hasattr(view, "getHiddenEdges") else []
    except Exception:
        vis, hid = [], []
    minX, minY, maxX, maxY = _view_bbox(vis, hid)
    return (float(view.X) + (uv[0] - minX), float(view.Y) + (maxY - uv[1]))


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
    views, dimensions, notes, tables, images = [], [], [], [], []
    for o in page.Views:
        tid = o.TypeId
        if tid == "TechDraw::DrawViewImage":
            images.append(_image_dto(o))
        elif tid in ("TechDraw::DrawViewPart", "TechDraw::DrawViewSection",
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
            # view.X/Y round-trip now (fixed 2026-09-20: a view's on-sheet
            # position was pure client-side layout state - dragging one
            # visibly moved it within the session, but view.X/Y was never
            # actually set on the FreeCAD object, so it silently snapped
            # back to the same hardcoded cascade default on every reopen,
            # same class of bug as the table-position one already fixed).
            # Zero is a legitimate placed position, not "never set" - only
            # omit x/y when the tag confirming an explicit placement is
            # itself absent, so an old file predating this fix still falls
            # back to the frontend's own cascade default exactly as before.
            if _get_tag(o, "_gwt_placed", ""):
                entry["x"] = float(o.X)
                entry["y"] = float(o.Y)
            base = _get_tag(o, "_gwt_base", "")
            if base:
                entry["baseViewId"] = base
            if tid == "TechDraw::DrawBrokenView":
                brk_raw = _get_tag(o, "_gwt_breaks", "")
                if brk_raw:
                    try:
                        entry["breaks"] = json.loads(brk_raw)
                    except Exception:
                        pass
            views.append(entry)
        elif tid == "TechDraw::DrawProjGroup":
            # A real first/third-angle projection group: one Anchor view plus
            # N projected views (TechDraw::DrawProjGroupItem), all sharing
            # ONE Scale (TechDraw enforces this - there is no per-item scale
            # to drift out of sync, unlike three independently-created plain
            # views) and laid out by TechDraw's own AutoDistribute, not this
            # app's placement code. Added 2026-09 for exactly this: a set of
            # orthographic views that are genuinely locked together (same
            # scale, standard alignment) rather than three unrelated views
            # that each happen to point a camera in a different direction -
            # see make_projection_group below for the write side.
            #
            # Each child ProjGroupItem is emitted as an ordinary view entry
            # (same shape a plain DrawViewPart gets) so every existing
            # consumer of page_contents' views[] - export_page_svg, the
            # frontend's DrawingSheet - keeps working with zero changes;
            # "groupId" is the only new field, letting a caller that DOES
            # care about the grouping (e.g. "select the whole group") find
            # the other members, without requiring it to.
            for item in o.Views:
                if item.TypeId != "TechDraw::DrawProjGroupItem":
                    continue
                try:
                    vis, hid = _part_view_payload(item)
                except Exception:
                    continue
                direction = _get_tag(item, "_gwt_dir", "") or str(item.Type).lower()
                entry = {
                    "id": item.Name, "label": item.Label, "direction": direction,
                    "kind": "part", "scale": float(o.Scale),
                    "visible": vis, "hidden": hid, "bbox": _view_bbox(vis, hid),
                    "groupId": o.Name,
                    # FreeCAD's Python proxy objects don't support reliable
                    # `is`/`==` identity comparison (confirmed live: a
                    # freshly-fetched reference to the SAME underlying object
                    # compares unequal both ways) - .Name equality is the
                    # correct check, same pattern this codebase already uses
                    # elsewhere for object identity (e.g. _get_tag callers).
                    "isAnchor": (o.Anchor is not None and item.Name == o.Anchor.Name),
                    # Item X/Y are relative to the GROUP's own placement, not
                    # page-absolute (confirmed live: a 3-item group at
                    # X=150 has items at their own small +/- offsets from
                    # that, e.g. Y=-30 for the Top item) - add the group's
                    # position once here so every view entry this function
                    # returns keeps meaning "absolute sheet position",
                    # same contract page_contents already promises for a
                    # plain view's x/y.
                    "x": float(o.X) + float(item.X),
                    "y": float(o.Y) + float(item.Y),
                }
                views.append(entry)
        elif tid == "TechDraw::DrawViewDimension":
            dim_entry = {
                "id": o.Name, "viewId": (o.References2D[0][0].Name if o.References2D else ""),
                "type": o.Type, "value": _dimension_raw_value(o),
            }
            geom = _dimension_geom(o)
            if geom:
                dim_entry.update(geom)
            dimensions.append(dim_entry)
        elif tid == "TechDraw::DrawViewAnnotation":
            leader_id = None
            leader_view_id = None
            leader_uv = None
            for leader in doc.Objects:
                if (leader.TypeId == "TechDraw::DrawLeaderLine"
                        and getattr(leader, "LeaderParent", None) is o):
                    leader_id = leader.Name
                    leader_view_id = _get_tag(leader, "_gwt_leaderView", "") or None
                    raw_uv = _get_tag(leader, "_gwt_leaderUV", "")
                    if raw_uv:
                        try:
                            leader_uv = json.loads(raw_uv)
                        except Exception:
                            leader_uv = None
                    break
            # was a hand-rolled duplicate of _note_dto that predated
            # textStyle/color - reuse _note_dto directly so a reopened
            # drawing's notes come back with the same fields a freshly-added
            # note does (bug: Bold/Italic/color silently vanished from
            # page_contents even though add_note/set_note_style set them
            # correctly - the Text formatting toolbar reads its state FROM
            # this payload, so it looked like clicking Bold did nothing).
            note_entry = _note_dto(o)
            note_entry["leaderId"] = leader_id
            # leaderViewId/leaderPointUV: the leader's own tip, in the SAME
            # view-relative UV frame every other view-anchored point in this
            # payload uses (dimensions' p1/p2/center/etc) - the frontend
            # converts this to sheet coordinates itself via uvToLocal +
            # that view's own placed.x/y, so the leader always lands
            # exactly where the app placed the view, not wherever the raw
            # WayPoints snapshot (page-absolute, computed once at creation
            # time against a view.X/Y this app never actually sets) happens
            # to be. Previously nothing exposed the leader's tip at all, so
            # the callout LINE never rendered anywhere in the app, only the
            # note's own text (user question, 2026-09-20: "Is there a way
            # to make leader notes for call outs?").
            if leader_id and leader_view_id and leader_uv:
                note_entry["leaderViewId"] = leader_view_id
                note_entry["leaderPointUV"] = leader_uv
            notes.append(note_entry)
        elif tid == "TechDraw::DrawViewSpreadsheet":
            from . import tables as _tables
            sheet = o.Source
            rows = []
            columns = []
            raw_rows_out = None
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
                raw_rows_json = _get_tag(sheet, "_gwt_rawrows", "")
                raw_rows = None
                if raw_rows_json:
                    try:
                        raw_rows = json.loads(raw_rows_json)
                    except Exception:
                        raw_rows = None
                if raw_rows is not None and columns:
                    # re-resolve every "=NAME" cell against the CURRENT
                    # parameter/PN values, same as make_table does on a
                    # fresh write - the spreadsheet's own cell text is only
                    # ever last write's resolved snapshot, so reading it
                    # directly would freeze a parameter-driven cell at
                    # whatever value it had the moment it was last saved
                    # instead of staying live (see make_table's _gwt_rawrows
                    # comment for the full reasoning).
                    rows = [{c["source"]: _tables._cell_value(row, c) for c in columns} for row in raw_rows]
                    raw_rows_out = raw_rows
                else:
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
                            "pageId": page.Name, "columns": columns, "rows": rows,
                            "rawRows": raw_rows_out if raw_rows_out is not None else rows,
                            "style": _tables.table_style(o)})
    cleanup_lines = {}
    for v in views:
        cl = list_cleanup_lines(doc, v["id"])
        if cl:
            cleanup_lines[v["id"]] = cl
    return {"views": views, "dimensions": dimensions, "notes": notes,
            "tables": tables, "images": images, "cleanupLines": cleanup_lines}


# --------------------------------------------------------------------------- #
# SVG export (server-side port of app/src/renderer/ui/DrawingSheet.tsx's
# render) - see this function's own docstring below for the full rationale.
# --------------------------------------------------------------------------- #

# ISO A3 landscape sheet in mm - same hardcoded fallback DrawingSheet.tsx
# uses (its SHEET_W/SHEET_H/MARGIN). A real TechDraw::DrawSVGTemplate's own
# Width/Height only populate once its Template (SVG file) property is set -
# confirmed live: a freshly created page's Template object reports
# Width=Height=0.0mm until Template is pointed at an actual .svg file, which
# create_page (above) never does today - so this fallback isn't a guess for
# an edge case, it's the ONLY sheet size this app has ever actually produced.
# Reading page.Template.Width/Height first (when they're populated) still
# reproduces exactly the frontend's own 420x297 today (confirmed live against
# an A3_Landscape_blank.svg template) and keeps this function correct if
# create_page is later fixed to set a real template file.
_SHEET_W_DEFAULT = 420.0
_SHEET_H_DEFAULT = 297.0
_MARGIN = 10.0

_RADIAL_DIM_PREFIX = {"Radius": "R", "Diameter": "⌀"}  # ⌀ = ⌀


def _sheet_size(page):
    tmpl = getattr(page, "Template", None)
    w = h = 0.0
    if tmpl is not None:
        try:
            w = float(str(tmpl.Width).split()[0])
            h = float(str(tmpl.Height).split()[0])
        except Exception:
            w = h = 0.0
    if w <= 0 or h <= 0:
        return _SHEET_W_DEFAULT, _SHEET_H_DEFAULT
    return w, h


def _dim_format_for(dim_id):
    """Same merge DrawingSheet.tsx's dims.map does:
    {...dimFormats.default, ...dimFormats.overrides[d.id]} - session.py
    stores exactly those two pieces (dim_format_default()/dim_format(id))
    keyed with the same field names (precision/leadingZero/trailingZeros/
    unitSuffix/textPrefix/textSuffix/toleranceMode/tolerancePlus/
    toleranceMinus) the frontend's DimensionFormat type uses."""
    fmt = dict(session.dim_format_default() or {})
    override = session.dim_format(dim_id)
    if override:
        fmt.update(override)
    return fmt


def _format_dimension(value, dtype, fmt):
    """Port of dimensionFormat.ts's formatDimension - FreeCAD's own
    FormattedValue needs a GUI ViewProvider and is unreadable headlessly (see
    module docstring), so this app always formats client-side from the raw
    measured value; this is that same formatting done server-side for PDF
    export instead of in the browser."""
    precision = max(0, int(fmt.get("precision", 2)))
    s = "%.*f" % (precision, value)
    if fmt.get("trailingZeros", True) is False and "." in s:
        s = s.rstrip("0").rstrip(".")
    if fmt.get("leadingZero", True) is False:
        neg = s.startswith("-")
        body = s[1:] if neg else s
        if body.startswith("0.") and len(body) > 1:
            body = body[1:]
        s = ("-" + body) if neg else body
    radial_prefix = _RADIAL_DIM_PREFIX.get(dtype, "")
    unit_suffix = ""
    if fmt.get("unitSuffix"):
        unit_suffix = "°" if dtype in ("Angle", "Angle3Pt") else "mm"  # ° = °
    return "%s%s%s%s%s" % (fmt.get("textPrefix") or "", radial_prefix, s, unit_suffix,
                            fmt.get("textSuffix") or "")


def _format_dimension_tolerance(fmt):
    """Port of dimensionFormat.ts's formatDimensionTolerance - returns a list
    of 1-2 text lines (symmetric "±X" or deviation "+X"/"-Y"), or None
    when toleranceMode is off/unset or the needed numbers are missing."""
    mode = fmt.get("toleranceMode", "off")
    if mode == "off" or not mode:
        return None
    precision = max(0, int(fmt.get("precision", 2)))

    def fixed(n):
        return "%.*f" % (precision, abs(n))

    if mode == "symmetric":
        t = fmt.get("tolerancePlus")
        if t is None or not (t >= 0):
            return None
        return ["±%s" % fixed(t)]  # ± = ±
    plus = fmt.get("tolerancePlus")
    minus = fmt.get("toleranceMinus")
    if plus is None and minus is None:
        return None

    def signed(n):
        n = n or 0.0
        return ("-%s" if n < 0 else "+%s") % fixed(n)

    return [signed(plus), signed(minus)]


def _measure_text(s, font_size):
    """Port of DrawingSheet.tsx's measureText - a per-character average width
    calibrated against the app's own label font, used only to flush a
    tolerance block against the end of a dimension's value text (see that
    function's own comment for why exact DOM measurement isn't needed)."""
    w = 0.0
    for ch in s:
        if ch == " " or ch in ".,-":
            w += 0.28
        elif ch in ("±", "⌀", "°"):
            w += 0.72
        elif ch.isdigit():
            w += 0.56
        else:
            w += 0.6
    return w * font_size


def _uv_to_local(bbox, scale, uv):
    """Port of DrawingSheet.tsx's uvToLocal - a view-UV point (the same
    projected frame page_contents' views[].visible/hidden polylines and every
    dimension's p1/p2/center/etc already live in) to that view's own local
    (pre-translate) sheet-mm space: (u - minX) * scale, (maxY - v) * scale."""
    min_x, _min_y, _max_x, max_y = bbox
    return (uv[0] - min_x) * scale, (max_y - uv[1]) * scale


def _svg_polyline(poly, stroke, width, dasharray=None):
    if len(poly) < 2:
        return ""
    pts = " ".join("%s,%s" % (_fmt(p[0]), _fmt(-p[1])) for p in poly)  # flip: CAD Y-up -> SVG Y-down
    dash = ' stroke-dasharray="%s"' % dasharray if dasharray else ""
    return ('<polyline points="%s" fill="none" stroke="%s" stroke-width="%s"%s/>'
            % (pts, stroke, _fmt(width), dash))


def _fmt(n):
    """Compact numeric formatting for SVG attribute values - avoids Python's
    repr-style float noise (e.g. 12.000000000000002) without needing an XML
    library, matching what a browser's own SVG serializer already produces
    closely enough for rendering purposes."""
    if isinstance(n, (int,)):
        return str(n)
    r = round(float(n), 4)
    if r == int(r):
        return str(int(r))
    return ("%.4f" % r).rstrip("0").rstrip(".")


def _arrow_points(x, y, dirx, diry):
    """Port of DrawingSheet.tsx's per-dimension `arrow()` closure - a small
    filled triangle pointing (dirx, diry) with its tip at (x, y)."""
    s = 1.6
    backx = x - dirx * s
    backy = y - diry * s
    nx = -diry * s * 0.35
    ny = dirx * s * 0.35
    return "%s,%s %s,%s %s,%s" % (
        _fmt(x), _fmt(y), _fmt(backx + nx), _fmt(backy + ny), _fmt(backx - nx), _fmt(backy - ny))


def _image_data_uri(path):
    """Port of app/src/main/index.ts's 'fs:readImage' handler - the same
    extension -> mime mapping (png/webp, else jpeg) and base64 encoding the
    Electron main process uses to turn a DrawViewImage's ImageFile path into
    something an <image href> can use directly."""
    try:
        with open(path, "rb") as f:
            data = f.read()
    except Exception:
        return None
    ext = path.rsplit(".", 1)[-1].lower() if "." in path else ""
    mime = "image/png" if ext == "png" else "image/webp" if ext == "webp" else "image/jpeg"
    return "data:%s;base64,%s" % (mime, base64.b64encode(data).decode("ascii"))


def export_page_svg(doc, page_id):
    """Assemble a complete, standalone SVG string for a TechDraw drawing page
    - a server-side port of DrawingSheet.tsx's own render, used so the
    headless sidecar can produce a PDF (via `rsvg-convert -f pdf`, outside
    this function) without a GUI TechDraw ViewProvider, which the plain
    console `freecadcmd` process cannot load at all (see module docstring).

    Reuses page_contents(doc, page_id)'s already-correct data (views' visible/
    hidden polylines, dimension geometry, note text, table rows/columns/
    style, image placements) rather than recomputing any geometry - this
    function only serializes that data as SVG, matching the frontend's exact
    numeric formulas (row heights, dy stepping, viewBox math, colors, stroke
    widths) wherever this session's reading of DrawingSheet.tsx found them
    literally, rather than approximating.

    Known simplifications vs. the interactive editor (all cosmetic, not
    correctness bugs - see this function's own inline comments at each site):
      - No selection highlighting, hover state, drag handles, or snap-target
        markers - none of that is part of a static export.
      - No "Blank sheet - use Add View" placeholder text (a placement aid,
        meaningless once actually exporting a page).
      - Radial (Radius/Diameter) and Angle dimensions render their leader/
        arc geometry faithfully; a dimension whose References2D can't be
        resolved at all (page_contents' dim_entry with value=None) is
        skipped outright rather than drawn as a corner label - a corner
        label with no witness lines is a last-resort on-screen affordance
        for "something is wrong here," not something a finished PDF should
        ship.
      - The title block (DrawingSheet.tsx's showTitleBlock overlay, keyed off
        client-only React state with no server-side persistence at all) is
        not reproduced - there is nothing in page_contents/the .FCStd to read
        it from.
    """
    page = get_page(doc, page_id)
    contents = page_contents(doc, page_id)
    sheet_w, sheet_h = _sheet_size(page)

    parts = []
    parts.append('<?xml version="1.0" encoding="UTF-8" standalone="no"?>')
    parts.append(
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
        'viewBox="0 0 %s %s" width="%smm" height="%smm">'
        % (_fmt(sheet_w), _fmt(sheet_h), _fmt(sheet_w), _fmt(sheet_h))
    )

    # sheet background + border (DrawingSheet.tsx: two <rect>s, white fill
    # then a MARGIN-inset outline) - see that render's literal values.
    parts.append('<rect x="0" y="0" width="%s" height="%s" fill="#ffffff"/>' % (_fmt(sheet_w), _fmt(sheet_h)))
    parts.append(
        '<rect x="%s" y="%s" width="%s" height="%s" fill="none" stroke="#111" stroke-width="0.6"/>'
        % (_fmt(_MARGIN), _fmt(_MARGIN), _fmt(sheet_w - _MARGIN * 2), _fmt(sheet_h - _MARGIN * 2))
    )

    # views: same cascade-default placement DrawingSheet.tsx's Placed state
    # falls back to when a view has never been explicitly dragged (x/y absent
    # from page_contents' entry - see that function's own comment). Views
    # that HAVE been placed (x/y present) use their persisted position, same
    # as the frontend reading useState from the same DTO.
    views_by_id = {}
    for i, v in enumerate(contents["views"]):
        vx = v.get("x")
        vy = v.get("y")
        if vx is None or vy is None:
            # DrawingSheet.tsx's own initial-placement cascade for a view
            # with no persisted position - findOpenSlot is a full packing
            # search over existing footprints; a fixed cascade here is a
            # reasonable stand-in for a page that's only ever exported
            # server-side (no interactive drag has happened yet to place it
            # more precisely), not a faithful port of findOpenSlot itself.
            vx = _MARGIN + 6 + (i % 3) * 90
            vy = _MARGIN + 20 + (i // 3) * 70
        placed_scale = float(v.get("scale", 1.0))
        min_x, min_y, max_x, max_y = v["bbox"]
        w = (max_x - min_x) * placed_scale
        h = (max_y - min_y) * placed_scale
        views_by_id[v["id"]] = {"x": vx, "y": vy, "scale": placed_scale, "bbox": v["bbox"], "w": w, "h": h}

        parts.append('<g transform="translate(%s %s)">' % (_fmt(vx), _fmt(vy)))
        parts.append(
            '<rect width="%s" height="%s" fill="#ffffff01" stroke="#00000022" stroke-width="0.3"/>' % (_fmt(w), _fmt(h))
        )
        # nested <svg> with the view's own viewBox, mirroring ViewBox's
        # render exactly: viewBox="minX -maxY (maxX-minX) (maxY-minY)", scaled
        # up to (w, h) - hidden polylines drawn first (dashed grey), then
        # visible ones on top (solid near-black), matching z-order + the
        # exact stroke colors/widths/dasharray literals found in ViewBox.
        parts.append(
            '<svg x="0" y="0" width="%s" height="%s" viewBox="%s %s %s %s">'
            % (_fmt(w), _fmt(h), _fmt(min_x), _fmt(-max_y), _fmt(max_x - min_x), _fmt(max_y - min_y))
        )
        for poly in v.get("hidden", []):
            parts.append(_svg_polyline(poly, "#999", 0.25, "1.4 1"))
        for poly in v.get("visible", []):
            parts.append(_svg_polyline(poly, "#111", 0.45))
        if v.get("kind") == "broken":
            # break-line zigzags (breakLinePoints) - ported literally: 5
            # zigzag segments spanning the bbox, amplitude 2% of the
            # perpendicular span, one line at (position - gap/2), another at
            # (position + gap/2), both drawn in the same accent blue.
            for b in v.get("breaks") or []:
                axis = b.get("axis", "x")
                pos = float(b.get("position", 0.0))
                gap = float(b.get("gap", 10.0))
                for offset in (-gap / 2, gap / 2):
                    line_pos = pos + offset
                    pts = _break_line_points(axis, line_pos, min_x, min_y, max_x, max_y)
                    parts.append(_svg_polyline(pts, "#0696d7", 0.4))
        parts.append("</svg>")
        # view label under the view, same font size/color/format as
        # ViewBox's own <text> ("{label} — {direction} (kind)")
        label = escape(v.get("label", ""))
        direction = escape(v.get("direction", ""))
        kind = v.get("kind", "part")
        suffix = " (%s)" % escape(kind) if kind != "part" else ""
        parts.append(
            '<text x="0" y="%s" font-size="3.4" fill="#333">%s — %s%s</text>'
            % (_fmt(h + 4), label, direction, suffix)
        )
        parts.append("</g>")

    # dimensions
    for d in contents["dimensions"]:
        if d.get("value") is None:
            continue
        pl = views_by_id.get(d.get("viewId"))
        if pl is None:
            continue
        fmt = _dim_format_for(d["id"])
        text = escape(_format_dimension(d["value"], d["type"], fmt))
        tol_lines = _format_dimension_tolerance(fmt)
        value_width = _measure_text(text, 3.4)

        def tolerance_svg(x, y, anchor, dominant_baseline=None):
            if not tol_lines:
                return ""
            if anchor == "start":
                value_left = x
            elif anchor == "end":
                value_left = x - value_width
            else:
                value_left = x - value_width / 2
            tol_x = value_left + value_width + 1
            baseline_attr = ' dominant-baseline="%s"' % dominant_baseline if dominant_baseline else ""
            if len(tol_lines) == 1:
                body = escape(tol_lines[0])
            else:
                body = (
                    '<tspan x="%s" dy="-0.35em">%s</tspan><tspan x="%s" dy="1.05em">%s</tspan>'
                    % (_fmt(tol_x), escape(tol_lines[0]), _fmt(tol_x), escape(tol_lines[1]))
                )
            return (
                '<text x="%s" y="%s" font-size="2.2" text-anchor="start"%s stroke="none">%s</text>'
                % (_fmt(tol_x), _fmt(y), baseline_attr, body)
            )

        gx, gy, scale = pl["x"], pl["y"], pl["scale"]
        bbox = pl["bbox"]

        def uv(point):
            return _uv_to_local(bbox, scale, point)

        if d["type"] in ("Radius", "Diameter") and d.get("center") and d.get("rim") and d.get("labelUV"):
            cx, cy = uv(d["center"])
            rx, ry = uv(d["rim"])
            lx, ly = uv(d["labelUV"])
            dirx0, diry0 = rx - cx, ry - cy
            rlen = math.hypot(dirx0, diry0) or 1.0
            dirx, diry = dirx0 / rlen, diry0 / rlen
            label_anchor = "start" if lx >= cx else "end"
            label_dx = 1.5 if lx >= cx else -1.5
            g_open = '<g transform="translate(%s %s)" stroke="#c47f16" fill="#c47f16" stroke-width="0.25">' % (
                _fmt(gx), _fmt(gy))
            if d["type"] == "Diameter":
                farx, fary = cx - dirx0, cy - diry0
                parts.append(g_open)
                parts.append('<line x1="%s" y1="%s" x2="%s" y2="%s"/>' % (_fmt(farx), _fmt(fary), _fmt(rx), _fmt(ry)))
                parts.append('<polygon points="%s" stroke="none"/>' % _arrow_points(rx, ry, dirx, diry))
                parts.append('<polygon points="%s" stroke="none"/>' % _arrow_points(farx, fary, -dirx, -diry))
                parts.append('<line x1="%s" y1="%s" x2="%s" y2="%s" stroke-width="0.2"/>' % (_fmt(rx), _fmt(ry), _fmt(lx), _fmt(ly)))
                parts.append(
                    '<text x="%s" y="%s" font-size="3.4" text-anchor="%s" dominant-baseline="middle" stroke="none">%s</text>'
                    % (_fmt(lx + label_dx), _fmt(ly), label_anchor, text)
                )
                parts.append(tolerance_svg(lx + label_dx, ly, label_anchor, "middle"))
                parts.append("</g>")
            else:
                parts.append(g_open)
                parts.append('<line x1="%s" y1="%s" x2="%s" y2="%s"/>' % (_fmt(cx), _fmt(cy), _fmt(lx), _fmt(ly)))
                parts.append('<circle cx="%s" cy="%s" r="0.5" stroke="none"/>' % (_fmt(cx), _fmt(cy)))
                parts.append('<polygon points="%s" stroke="none"/>' % _arrow_points(rx, ry, dirx, diry))
                parts.append(
                    '<text x="%s" y="%s" font-size="3.4" text-anchor="%s" dominant-baseline="middle" stroke="none">%s</text>'
                    % (_fmt(lx + label_dx), _fmt(ly), label_anchor, text)
                )
                parts.append(tolerance_svg(lx + label_dx, ly, label_anchor, "middle"))
                parts.append("</g>")
            continue

        if d["type"] in ("Angle", "Angle3Pt") and d.get("center") and d.get("dir1") and d.get("dir2") and d.get("arcRadius"):
            cx, cy = uv(d["center"])
            r = float(d["arcRadius"])
            a1 = math.atan2(-d["dir1"][1], d["dir1"][0])
            a2 = math.atan2(-d["dir2"][1], d["dir2"][0])
            sweep = a2 - a1
            while sweep <= -math.pi:
                sweep += 2 * math.pi
            while sweep > math.pi:
                sweep -= 2 * math.pi
            large = 1 if abs(sweep) > math.pi else 0
            sweep_flag = 1 if sweep >= 0 else 0
            startx, starty = cx + math.cos(a1) * r, cy + math.sin(a1) * r
            endx, endy = cx + math.cos(a2) * r, cy + math.sin(a2) * r
            mid_angle = a1 + sweep / 2
            labelx, labely = cx + math.cos(mid_angle) * (r + 3), cy + math.sin(mid_angle) * (r + 3)
            tan_sign = 1 if sweep_flag else -1
            start_tan = (-math.sin(a1) * tan_sign, math.cos(a1) * tan_sign)
            end_tan = (math.sin(a2) * tan_sign, -math.cos(a2) * tan_sign)
            parts.append('<g transform="translate(%s %s)" stroke="#c47f16" fill="#c47f16" stroke-width="0.25">' % (
                _fmt(gx), _fmt(gy)))
            parts.append(
                '<line x1="%s" y1="%s" x2="%s" y2="%s" stroke-width="0.2" stroke-dasharray="0.8,0.6"/>'
                % (_fmt(cx), _fmt(cy), _fmt(startx), _fmt(starty))
            )
            parts.append(
                '<line x1="%s" y1="%s" x2="%s" y2="%s" stroke-width="0.2" stroke-dasharray="0.8,0.6"/>'
                % (_fmt(cx), _fmt(cy), _fmt(endx), _fmt(endy))
            )
            parts.append(
                '<path d="M %s %s A %s %s 0 %d %d %s %s" fill="none"/>'
                % (_fmt(startx), _fmt(starty), _fmt(r), _fmt(r), large, sweep_flag, _fmt(endx), _fmt(endy))
            )
            parts.append('<polygon points="%s" stroke="none"/>' % _arrow_points(startx, starty, start_tan[0], start_tan[1]))
            parts.append('<polygon points="%s" stroke="none"/>' % _arrow_points(endx, endy, end_tan[0], end_tan[1]))
            parts.append('<text x="%s" y="%s" font-size="3.4" text-anchor="middle" stroke="none">%s</text>' % (
                _fmt(labelx), _fmt(labely), text))
            parts.append(tolerance_svg(labelx, labely, "middle"))
            parts.append("</g>")
            continue

        if not (d.get("p1") and d.get("p2") and d.get("labelUV")):
            # geometry genuinely unresolvable - DrawingSheet.tsx falls back
            # to an un-anchored corner label here; a finished PDF export
            # skips it instead (see export_page_svg's own docstring).
            continue

        p1x, p1y = uv(d["p1"])
        p2x, p2y = uv(d["p2"])
        label_x, label_y = uv(d["labelUV"])

        if d.get("ordinate"):
            dx, dy = p2x - p1x, p2y - p1y
            length = math.hypot(dx, dy) or 1.0
            ux, uy = dx / length, dy / length
            perpx, perpy = -uy, ux
            off_x, off_y = label_x - p2x, label_y - p2y
            perp_off = off_x * perpx + off_y * perpy
            base_x, base_y = p2x + perpx * perp_off, p2y + perpy * perp_off
            parts.append('<g transform="translate(%s %s)" stroke="#c47f16" fill="#c47f16" stroke-width="0.25">' % (
                _fmt(gx), _fmt(gy)))
            parts.append('<line x1="%s" y1="%s" x2="%s" y2="%s" stroke-width="0.2"/>' % (
                _fmt(p2x), _fmt(p2y), _fmt(base_x), _fmt(base_y)))
            parts.append('<line x1="%s" y1="%s" x2="%s" y2="%s" stroke-width="0.2"/>' % (
                _fmt(p1x + perpx * perp_off), _fmt(p1y + perpy * perp_off), _fmt(base_x), _fmt(base_y)))
            parts.append(
                '<text x="%s" y="%s" font-size="3.4" text-anchor="middle" dominant-baseline="middle" stroke="none">%s</text>'
                % (_fmt(label_x), _fmt(label_y), text)
            )
            parts.append(tolerance_svg(label_x, label_y, "middle", "middle"))
            parts.append("</g>")
            continue

        dx, dy = p2x - p1x, p2y - p1y
        length = math.hypot(dx, dy) or 1.0
        ux, uy = dx / length, dy / length
        midx, midy = (p1x + p2x) / 2, (p1y + p2y) / 2
        off_x, off_y = label_x - midx, label_y - midy
        perp_off = off_x * -uy + off_y * ux
        dlx1, dly1 = p1x - uy * perp_off, p1y + ux * perp_off
        dlx2, dly2 = p2x - uy * perp_off, p2y + ux * perp_off
        parts.append('<g transform="translate(%s %s)" stroke="#c47f16" fill="#c47f16" stroke-width="0.25">' % (
            _fmt(gx), _fmt(gy)))
        parts.append('<line x1="%s" y1="%s" x2="%s" y2="%s" stroke-width="0.2"/>' % (_fmt(p1x), _fmt(p1y), _fmt(dlx1), _fmt(dly1)))
        parts.append('<line x1="%s" y1="%s" x2="%s" y2="%s" stroke-width="0.2"/>' % (_fmt(p2x), _fmt(p2y), _fmt(dlx2), _fmt(dly2)))
        parts.append('<line x1="%s" y1="%s" x2="%s" y2="%s"/>' % (
            _fmt(dlx1), _fmt(dly1), _fmt(label_x - ux * 6), _fmt(label_y - uy * 6)))
        parts.append('<line x1="%s" y1="%s" x2="%s" y2="%s"/>' % (
            _fmt(label_x + ux * 6), _fmt(label_y + uy * 6), _fmt(dlx2), _fmt(dly2)))
        parts.append('<polygon points="%s" stroke="none"/>' % _arrow_points(dlx1, dly1, -ux, -uy))
        parts.append('<polygon points="%s" stroke="none"/>' % _arrow_points(dlx2, dly2, ux, uy))
        parts.append('<text x="%s" y="%s" font-size="3.4" text-anchor="middle" stroke="none">%s</text>' % (
            _fmt(label_x), _fmt(label_y), text))
        parts.append(tolerance_svg(label_x, label_y, "middle"))
        parts.append("</g>")

    # notes (+ their leader lines, view-UV -> sheet via the SAME uvToLocal +
    # placed x/y every other view-anchored point above already uses)
    for n in contents["notes"]:
        leader_pl = views_by_id.get(n.get("leaderViewId")) if n.get("leaderViewId") else None
        if leader_pl is not None and n.get("leaderPointUV"):
            lx, ly = _uv_to_local(leader_pl["bbox"], leader_pl["scale"], n["leaderPointUV"])
            tip_x, tip_y = leader_pl["x"] + lx, leader_pl["y"] + ly
            parts.append(
                '<line x1="%s" y1="%s" x2="%s" y2="%s" stroke="%s" stroke-width="0.25"/>'
                % (_fmt(tip_x), _fmt(tip_y), _fmt(n["x"]), _fmt(n["y"]), n.get("color") or "#333")
            )
        font_size = n.get("textSize") or 3.4
        style = n.get("textStyle") or ""
        weight_attr = ' font-weight="bold"' if style in ("Bold", "Bold-Italic") else ""
        style_attr = ' font-style="italic"' if style in ("Italic", "Bold-Italic") else ""
        font_attr = ' font-family="%s"' % escape(n["font"]) if n.get("font") else ""
        color = n.get("color") or "#333"
        lines = (n.get("text") or "").split("\n")
        tspans = "".join(
            '<tspan x="%s" dy="%s">%s</tspan>' % (_fmt(n["x"]), "0" if i == 0 else "1.2em", escape(line) or "&#160;")
            for i, line in enumerate(lines)
        )
        parts.append(
            '<text x="%s" y="%s" font-size="%s"%s%s%s fill="%s">%s</text>'
            % (_fmt(n["x"]), _fmt(n["y"]), _fmt(font_size), font_attr, weight_attr, style_attr, color, tspans)
        )

    # tables - same colWidths/rowHeight/hideHeader/merges layout math as
    # DrawingSheet.tsx's tables.map (colX cumulative-sum, tableW/tableH,
    # mergeAt for skipping covered cells, per-line <tspan> stepping for
    # multi-line cell text)
    for ti, table in enumerate(contents["tables"]):
        style = table.get("style") or {}
        row_h = float(style.get("rowHeight", 5))
        col_widths = style.get("colWidths") or []
        hide_header = bool(style.get("hideHeader", False))
        show_grid = style.get("showGrid", True)
        grid_color = style.get("gridColor", "#111")
        font = style.get("font", "osifont")
        text_size = float(style.get("textSize", 3.2))
        bold = bool(style.get("bold", False))
        italic = bool(style.get("italic", False))
        merges = style.get("merges") or []
        columns = table["columns"]
        rows = table["rows"]
        n_cols = len(columns) or 1
        base_col_w = max(20.0, 130.0 / n_cols)

        def col_w(ci):
            return col_widths[ci] if ci < len(col_widths) else base_col_w

        def col_x(ci):
            return sum(col_w(i) for i in range(ci))

        table_w = sum(col_w(i) for i in range(len(columns)))
        header_rows = 0 if hide_header else 1
        table_h = row_h * (len(rows) + header_rows)
        table_x = style.get("x", _MARGIN + 4 + ti * 8)
        table_y = style.get("y", _MARGIN + 4 + ti * 8)

        def merge_at(r, c):
            for m in merges:
                if m["r"] <= r < m["r"] + m["rs"] and m["c"] <= c < m["c"] + m["cs"]:
                    return m
            return None

        parts.append('<g transform="translate(%s %s)">' % (_fmt(table_x), _fmt(table_y)))
        if show_grid:
            parts.append('<g stroke="%s" stroke-width="0.25" fill="none">' % grid_color)
            parts.append('<rect x="0" y="0" width="%s" height="%s"/>' % (_fmt(table_w), _fmt(table_h)))
            for i in range(1, len(columns)):
                x = col_x(i)
                parts.append('<line x1="%s" y1="0" x2="%s" y2="%s"/>' % (_fmt(x), _fmt(x), _fmt(table_h)))
            for i in range(len(rows)):
                if i == 0 and header_rows == 0:
                    continue
                y = row_h * (i + header_rows)
                parts.append('<line x1="0" y1="%s" x2="%s" y2="%s"/>' % (_fmt(y), _fmt(table_w), _fmt(y)))
            parts.append("</g>")

        font_attr = ' font-family="%s"' % escape(font)
        italic_attr = ' font-style="italic"' if italic else ""
        bold_attr = ' font-weight="bold"' if bold else ""

        if not hide_header:
            for ci, c in enumerate(columns):
                parts.append(
                    '<text x="%s" y="%s" font-size="%s"%s font-weight="bold"%s>%s</text>'
                    % (_fmt(col_x(ci) + 1.5), _fmt(row_h - 1.5), _fmt(text_size), font_attr, italic_attr, escape(str(c.get("header", ""))))
                )

        for ri, row in enumerate(rows):
            for ci, c in enumerate(columns):
                m = merge_at(ri, ci)
                if m and not (m["r"] == ri and m["c"] == ci):
                    continue  # covered by a merge, not its top-left
                cell_y = row_h * (ri + header_rows) + row_h - 1.5
                value = str(row.get(c.get("source", ""), ""))
                lines = value.split("\n")
                n_lines = len(lines)
                x = col_x(ci) + 1.5
                tspans = "".join(
                    '<tspan x="%s" dy="%s">%s</tspan>'
                    % (_fmt(x), ("%gem" % (-(n_lines - 1) * 1.2)) if i == 0 else "1.2em", escape(line) or "&#160;")
                    for i, line in enumerate(lines)
                )
                parts.append(
                    '<text x="%s" y="%s" font-size="%s"%s%s%s>%s</text>'
                    % (_fmt(x), _fmt(cell_y), _fmt(text_size), font_attr, bold_attr, italic_attr, tspans)
                )
        parts.append("</g>")

    # images - embedded as data: URIs (the sidecar's _image_dto only ever
    # returns the ORIGINAL filesystem path FreeCAD embedded into the .FCStd,
    # same as the frontend's own imageData fetch via window.cad.readImage -
    # see that IPC handler's mime-type mapping, ported in _image_data_uri).
    for im in contents["images"]:
        href = _image_data_uri(im["path"])
        if href is None:
            continue  # source file no longer readable - skip rather than emit a broken <image>
        rotation = im.get("rotation") or 0.0
        transform = ""
        if rotation:
            cx = im["x"] + im["width"] / 2
            cy = im["y"] + im["height"] / 2
            transform = ' transform="rotate(%s %s %s)"' % (_fmt(rotation), _fmt(cx), _fmt(cy))
        parts.append(
            '<image href="%s" x="%s" y="%s" width="%s" height="%s"%s/>'
            % (href, _fmt(im["x"]), _fmt(im["y"]), _fmt(im["width"]), _fmt(im["height"]), transform)
        )

    parts.append("</svg>")
    return "\n".join(parts)


def _break_line_points(axis, pos, min_x, min_y, max_x, max_y):
    """Port of DrawingSheet.tsx's breakLinePoints - a jagged zigzag glyph
    across a view's bbox at the given axis/position, standard CAD convention
    for marking a broken-out section. Returns points in the view's own local
    (y-up, pre-flip) coordinate space, same as _edges_to_polylines' output,
    so _svg_polyline's own Y-flip applies to it identically."""
    zigzags = 5
    amp = (max_x - min_x) * 0.02 if axis == "x" else (max_y - min_y) * 0.02
    pts = []
    if axis == "x":
        span = max_y - min_y
        for i in range(zigzags + 1):
            y = min_y + (span * i) / zigzags
            pts.append((pos + (-amp if i % 2 == 0 else amp), y))
    else:
        span = max_x - min_x
        for i in range(zigzags + 1):
            x = min_x + (span * i) / zigzags
            pts.append((x, pos + (-amp if i % 2 == 0 else amp)))
    return pts


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
    """source_obj is normally a single body/object; also accepts a real list
    (an assembly's several App::Link components) - TechDraw's own Source
    property natively unions the projected geometry of every object in it,
    same mechanism the GUI uses for "select the whole assembly, add view"."""
    page = get_page(doc, page_id)
    direction = _norm_dir(direction)
    d = _DIRS[direction]

    view = doc.addObject("TechDraw::DrawViewPart", "View")
    page.addView(view)
    view.Source = list(source_obj) if isinstance(source_obj, (list, tuple)) else [source_obj]
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


# GWT-CAD's own lowercase direction name -> DrawProjGroup.addProjection's
# own projection-type string (confirmed live, not documented anywhere
# obvious: "iso" is direction (1,-1,1) normalized, which addProjection
# calls "FrontTopRight" - the isometric corner you get looking at the
# front-top-right of the part, the same (1,-1,1) _DIRS["iso"] already uses
# for a plain make_view). Every entry here was verified to actually work
# via addProjection, not assumed from FreeCAD's own docs/enum, which don't
# enumerate the valid projection-type strings anywhere convenient.
_PROJ_GROUP_TYPES = {
    "front": "Front", "back": "Rear", "top": "Top", "bottom": "Bottom",
    "left": "Left", "right": "Right", "iso": "FrontTopRight",
}


def make_projection_group(doc, page_id, source_obj, directions, anchor=None, scale=1.0):
    """A REAL first/third-angle projection group (TechDraw::DrawProjGroup) -
    one Anchor view plus N projected views, all sharing ONE Scale enforced
    by TechDraw itself (there is no way for a projection group's members to
    drift out of scale with each other, unlike calling make_view() several
    times for the same part, which creates unrelated views that each just
    happen to point in a different direction and can end up at whatever
    scale each call was given). Added 2026-09 specifically because that
    was happening: a purchased-part reference drawing's front/top/right
    views were three independent make_view() calls and came out at visibly
    different scales.

    `directions` is a list of GWT-CAD's usual lowercase direction names
    (see _PROJ_GROUP_TYPES) - the FIRST one becomes the anchor unless
    `anchor` names a different one explicitly (addProjection's own rule:
    whichever projection is added first becomes Anchor, so this always
    adds `anchor`'s direction first to guarantee it, rather than relying on
    caller ordering). Returns one entry per added view, same DTO shape
    make_view returns, plus "groupId"/"isAnchor" (see page_contents' own
    DrawProjGroup branch, which this mirrors on the read side)."""
    page = get_page(doc, page_id)
    dirs = [_norm_dir(d) for d in directions]
    if not dirs:
        raise RpcError(APP_ERROR, "make_projection_group needs at least one direction")
    anchor_dir = _norm_dir(anchor) if anchor else dirs[0]
    if anchor_dir not in dirs:
        dirs = [anchor_dir] + dirs
    else:
        dirs = [anchor_dir] + [d for d in dirs if d != anchor_dir]
    unknown = [d for d in dirs if d not in _PROJ_GROUP_TYPES]
    if unknown:
        raise RpcError(APP_ERROR, "no projection-group mapping for direction(s): %r" % unknown)

    grp = doc.addObject("TechDraw::DrawProjGroup", "ProjGroup")
    page.addView(grp)
    grp.Source = list(source_obj) if isinstance(source_obj, (list, tuple)) else [source_obj]
    # Third angle (US/ANSI convention) rather than TechDraw's own default
    # of First angle (ISO/European convention) - confirmed live the two
    # conventions place a "Right" view on OPPOSITE sides of the anchor
    # (First angle: Right view lands to the LEFT of Front; Third angle:
    # Right view lands to the RIGHT, matching what "Right" actually sounds
    # like it should mean to a reader not steeped in drafting convention).
    grp.ProjectionType = "Third angle"
    doc.recompute()

    items = []
    for d in dirs:
        item = grp.addProjection(_PROJ_GROUP_TYPES[d])
        doc.recompute()
        _tag(item, "_gwt_dir", d)
        items.append((d, item))
    # ScaleType defaults to "Automatic" - TechDraw computes and OVERRIDES
    # Scale itself in that mode (confirmed live: assigning grp.Scale under
    # Automatic silently has no effect, grp.Scale reads back as whatever
    # TechDraw's own auto-fit picked, not the caller's value) - "Custom"
    # is required for an explicit scale to actually stick.
    grp.ScaleType = "Custom"
    grp.Scale = float(scale)
    doc.recompute()

    out = []
    for d, item in items:
        vis, hid = _part_view_payload(item)
        out.append({
            "id": item.Name, "label": item.Label, "direction": d,
            "kind": "part", "scale": float(grp.Scale),
            "visible": vis, "hidden": hid, "bbox": _view_bbox(vis, hid),
            "groupId": grp.Name,
            "isAnchor": (grp.Anchor is not None and item.Name == grp.Anchor.Name),
        })
    return {"groupId": grp.Name, "anchorDirection": anchor_dir, "views": out}


def make_section(doc, page_id, base_view_id, plane="XY", offset=0.0, flip=False):
    """`plane` is the cut plane in absolute model axes (its normal is the
    THIRD, unlisted axis - "XY" cuts along a plane spanning X and Y, so its
    normal is Z). A cut whose normal is parallel to the base view's own
    Direction produces a section that looks IDENTICAL to the un-sectioned
    view (confirmed live: the cut is then exactly the image plane, at the
    view's own depth - no new profile is exposed) - reject that combination
    outright instead of silently returning a no-op-looking "section"."""
    page = get_page(doc, page_id)
    base = doc.getObject(base_view_id)
    if base is None or base.TypeId not in ("TechDraw::DrawViewPart",):
        raise RpcError(APP_ERROR, "section needs a normal part view as its base")

    normals = {"XY": (0, 0, 1), "XZ": (0, 1, 0), "YZ": (1, 0, 0)}
    n = App.Vector(*normals.get(str(plane).upper(), (0, 0, 1)))
    if flip:
        n = n.negative()

    view_dir = App.Vector(base.Direction).normalize()
    if abs(n.normalize().dot(view_dir)) > 0.99:
        raise RpcError(
            APP_ERROR,
            "cut plane %r is parallel to this view's own line of sight - it would "
            "show no new geometry (the cut sits exactly at the image plane). "
            "Pick a plane perpendicular to the view direction instead." % plane
        )

    view = doc.addObject("TechDraw::DrawViewSection", "Section")
    page.addView(view)
    view.BaseView = base
    view.Source = base.Source
    view.SectionNormal = n
    center = base.Source[0].Shape.BoundBox.Center if base.Source else App.Vector(0, 0, 0)
    # offset moves the cut ALONG its own normal, not always along Z - a
    # plane="YZ" (normal X) cut with a nonzero offset previously only ever
    # nudged origin.z, which does nothing to a plane whose normal is X.
    origin = center + n.normalize() * float(offset)
    view.SectionOrigin = origin
    view.Direction = base.Direction
    view.Scale = base.Scale
    # NOT "Section %s" % view.Name - view.Name is itself "Section" (FreeCAD's
    # own auto-naming from addObject's requested name above), which doubled
    # up as "Section Section" once the frontend appends its own direction/
    # kind suffix (DrawingSheet.tsx's ViewBox: "{label} — {direction} (kind)").
    view.Label = "%s section" % _get_tag(base, "_gwt_dir", "front").title()
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
    # see make_section's comment - avoid "Detail Detail" from echoing
    # view.Name (FreeCAD's own auto-name) back into the label.
    view.Label = "%s detail" % _get_tag(base, "_gwt_dir", "front").title()
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
    # see make_section's comment - avoid "Broken Broken" from echoing
    # view.Name (FreeCAD's own auto-name) back into the label.
    view.Label = "%s broken" % _get_tag(base, "_gwt_dir", "front").title()
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

def remove_view(doc, view_id):
    """Delete a placed view. Any TechDraw::DrawViewDimension that referenced
    it is deleted too (a dimension with no view to measure is meaningless,
    unlike convert_view's re-parent case where a replacement view exists a
    moment later)."""
    view = doc.getObject(view_id)
    if view is None:
        raise RpcError(APP_ERROR, "no such view: %r" % view_id)
    removed_dims = []
    for o in list(doc.Objects):
        if o.TypeId == "TechDraw::DrawViewDimension":
            refs = list(getattr(o, "References2D", []) or [])
            if any(r[0] is view for r in refs if r):
                removed_dims.append(o.Name)
                doc.removeObject(o.Name)
    doc.removeObject(view.Name)
    doc.recompute()
    return {"ok": True, "removedDimensions": removed_dims}


def set_view_position(doc, view_id, x, y):
    """Persist a drag of a placed view - see page_contents' comment on
    view.X/Y (_gwt_placed marks that an explicit position has actually been
    set, distinguishing a real (0, 0) placement from an old file that
    predates this and should still fall back to the frontend's own
    default cascade)."""
    view = doc.getObject(view_id)
    if view is None:
        raise RpcError(APP_ERROR, "no such view: %r" % view_id)
    view.X = float(x)
    view.Y = float(y)
    _tag(view, "_gwt_placed", "1")
    doc.recompute()


def set_projection_group_position(doc, group_id, x, y):
    """Position a whole projection group (see make_projection_group) on the
    sheet - unlike a plain view, page_contents' DrawProjGroup branch reads
    the group's X/Y unconditionally, no _gwt_placed tag needed: a group is
    only ever created (by make_projection_group) with an explicit position
    set right after, so there is no "old file predating this fix, X/Y
    genuinely never set" case to distinguish from a real (0, 0) placement -
    the ambiguity set_view_position's tag exists for doesn't apply here."""
    grp = doc.getObject(group_id)
    if grp is None or grp.TypeId != "TechDraw::DrawProjGroup":
        raise RpcError(APP_ERROR, "no such projection group: %r" % group_id)
    grp.X = float(x)
    grp.Y = float(y)
    doc.recompute()
    return {"id": grp.Name, "x": float(grp.X), "y": float(grp.Y)}


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
    geom = _dimension_geom(dim)
    result = {"id": dim.Name, "viewId": view.Name, "type": dim.Type, "value": value}
    if geom:
        result.update(geom)
    return result


def remove_dimension(doc, dim_id):
    dim = doc.getObject(dim_id)
    if dim is None or dim.TypeId != "TechDraw::DrawViewDimension":
        raise RpcError(APP_ERROR, "no such dimension: %r" % dim_id)
    doc.removeObject(dim.Name)
    doc.recompute()
    return {"ok": True}


def _dimension_linear_points(dim):
    """The two 2D points (in the same projected frame as the view's visible/
    hidden edge polylines) a Distance-family dimension measures between -
    factored out of _dimension_raw_value so add_dimension/page_contents can
    return real p1/p2 for the frontend to draw witness lines from, not just
    the scalar value. Returns None for non-Distance types or if resolution
    fails (mirrors _dimension_raw_value's own failure mode)."""
    try:
        refs = list(dim.References2D or [])
        if not refs:
            return None
        view = refs[0][0]
        shape = view.Source[0].Shape if view.Source else None
        if shape is None:
            return None
        subs = []
        for r in refs:
            s = r[1]
            subs.extend(s if isinstance(s, (tuple, list)) else [s])
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
        return pts if len(pts) == 2 else None
    except Exception:
        return None


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
        pts = _dimension_linear_points(dim)
        if pts:
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


_DIM_PERP_TAG = "_gwt_dimPerp"
_DIM_LABEL_U_TAG = "_gwt_dimLabelU"


def _dimension_radial_source(dim):
    """(view, shape, edge, subs) for a Radius/Diameter dimension, or None -
    factored out of the value/geometry computations since both need the same
    resolved circular edge."""
    refs = list(dim.References2D or [])
    if not refs:
        return None
    view = refs[0][0]
    shape = view.Source[0].Shape if view.Source else None
    if shape is None:
        return None
    subs = []
    for r in refs:
        s = r[1]
        subs.extend(s if isinstance(s, (tuple, list)) else [s])
    if not subs:
        return None
    edge = _sub_model_edge(shape, subs[0])
    if edge is None or not hasattr(edge.Curve, "Radius"):
        return None
    return view, edge


def _dimension_radial_points(dim):
    """centerUV/edgeUV for a Radius/Diameter dimension - the circle's centre
    and one point on its rim, both projected into the view's 2D sheet frame,
    the same way _dimension_linear_points does for Distance. A radial
    dimension's leader runs from somewhere along (or beyond) this line."""
    src = _dimension_radial_source(dim)
    if src is None:
        return None
    view, edge = src
    offset = _project_offset(view)
    center3d = edge.Curve.Center
    # a point on the circle toward the view's local +X, in the circle's own
    # plane (Curve.Axis is its normal) - any point on the rim works, this one
    # is just a deterministic, reproducible choice
    axis = edge.Curve.Axis
    ref = App.Vector(1, 0, 0) if abs(axis.dot(App.Vector(1, 0, 0))) < 0.9 else App.Vector(0, 1, 0)
    radial_dir = axis.cross(ref).normalize()
    rim3d = center3d + radial_dir * edge.Curve.Radius
    center_uv = _project(view, center3d, offset)
    rim_uv = _project(view, rim3d, offset)
    return center_uv, rim_uv


def _dimension_angle_source(dim):
    refs = list(dim.References2D or [])
    if len(refs) < 1:
        return None
    view = refs[0][0]
    shape = view.Source[0].Shape if view.Source else None
    if shape is None:
        return None
    subs = []
    for r in refs:
        s = r[1]
        subs.extend(s if isinstance(s, (tuple, list)) else [s])
    if len(subs) < 2:
        return None
    e1 = _sub_model_edge(shape, subs[0])
    e2 = _sub_model_edge(shape, subs[1])
    if e1 is None or e2 is None:
        return None
    return view, e1, e2


def _dimension_angle_geom(dim):
    """centerUV + start/end 2D directions for an Angle/Angle3Pt dimension -
    the vertex where the two referenced lines (projected into the view's 2D
    sheet frame) meet, and unit directions along each toward its own edge, so
    the frontend can sweep a real arc between them instead of drawing a
    straight line between two arbitrary points (which is all the generic
    Distance-family geom would give it)."""
    src = _dimension_angle_source(dim)
    if src is None:
        return None
    view, e1, e2 = src
    offset = _project_offset(view)
    a1 = _project(view, e1.valueAt(e1.FirstParameter), offset)
    a2 = _project(view, e1.valueAt(e1.LastParameter), offset)
    b1 = _project(view, e2.valueAt(e2.FirstParameter), offset)
    b2 = _project(view, e2.valueAt(e2.LastParameter), offset)
    # intersect the two projected LINES (not segments - the edges' endpoints
    # rarely coincide exactly after projection/rounding) for the true vertex
    center = _line_intersect_2d(a1, a2, b1, b2)
    if center is None:
        # parallel or degenerate in this view - fall back to the nearest
        # pair of endpoints as a best-effort vertex
        center = a1
    def _unit(p, q):
        dx, dy = q[0] - p[0], q[1] - p[1]
        n = math.hypot(dx, dy)
        return (dx / n, dy / n) if n > 1e-9 else (1.0, 0.0)
    # direction from the vertex toward whichever endpoint of each edge is
    # farther away (keeps the arc opening toward the actual edges, not
    # doubling back through the vertex when the vertex is itself an endpoint)
    dir1 = _unit(center, a2 if math.hypot(a2[0] - center[0], a2[1] - center[1])
                 >= math.hypot(a1[0] - center[0], a1[1] - center[1]) else a1)
    dir2 = _unit(center, b2 if math.hypot(b2[0] - center[0], b2[1] - center[1])
                 >= math.hypot(b1[0] - center[0], b1[1] - center[1]) else b1)
    return {"center": center, "dir1": dir1, "dir2": dir2}


def _line_intersect_2d(a1, a2, b1, b2):
    """Where infinite lines through a1-a2 and b1-b2 cross, or None if
    (near-)parallel. Standard 2D line-line intersection determinant form."""
    x1, y1 = a1
    x2, y2 = a2
    x3, y3 = b1
    x4, y4 = b2
    denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
    if abs(denom) < 1e-9:
        return None
    t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom
    return (x1 + t * (x2 - x1), y1 + t * (y2 - y1))


def _dimension_geom(dim):
    """Geometry for the frontend's witness/dimension-line (Distance family),
    leader-line (Radius/Diameter), or arc (Angle/Angle3Pt) SVG drawing -
    computed server-side so it round-trips with the document instead of
    living only in React state that a reopen throws away. perpOff/radius
    offset/arc radius (how far the dimension line/leader/arc sits from the
    measured geometry) default to a fixed value outside it on first
    creation; set_dimension_geom persists a user's drag so it isn't
    recomputed to the default on every reopen."""
    if dim.Type in ("Radius", "Diameter"):
        pts = _dimension_radial_points(dim)
        if not pts:
            return None
        center, rim = pts
        dx, dy = rim[0] - center[0], rim[1] - center[1]
        radius2d = math.hypot(dx, dy)
        if radius2d < 1e-9:
            return None
        ux, uy = dx / radius2d, dy / radius2d
        leader_len = _get_tag(dim, _DIM_PERP_TAG, "")
        try:
            leader_len = float(leader_len)
        except ValueError:
            leader_len = radius2d + 8.0  # first-time default: 8mm past the rim
        label_uv = (center[0] + ux * leader_len, center[1] + uy * leader_len)
        return {"center": list(center), "rim": list(rim), "labelUV": list(label_uv)}
    if dim.Type in ("Angle", "Angle3Pt"):
        ag = _dimension_angle_geom(dim)
        if not ag:
            return None
        arc_r = _get_tag(dim, _DIM_PERP_TAG, "")
        try:
            arc_r = float(arc_r)
        except ValueError:
            arc_r = 12.0  # first-time default: a 12mm-radius arc
        return {
            "center": list(ag["center"]), "dir1": list(ag["dir1"]), "dir2": list(ag["dir2"]),
            "arcRadius": arc_r,
        }
    pts = _dimension_linear_points(dim)
    if not pts:
        return None
    p1, p2 = pts
    if dim.Type in ("DistanceX", "DistanceY"):
        # ordinate-style: the dimension/witness lines are locked to the
        # sheet X or Y axis regardless of where p1/p2 actually sit (that's
        # the whole point of DistanceX/DistanceY vs plain Distance) -
        # previously this fell through to the generic branch below, which
        # draws along the raw p1->p2 direction, wrong for anything not
        # already axis-aligned (confirmed: _dimension_geom had no special
        # case for these two types at all, despite _dimension_raw_value
        # already computing the axis-locked VALUE correctly).
        is_x = dim.Type == "DistanceX"
        perp = (0.0, 1.0) if is_x else (1.0, 0.0)
        perp_off = _get_tag(dim, _DIM_PERP_TAG, "")
        try:
            perp_off = float(perp_off)
        except ValueError:
            perp_off = 8.0
        # p2 projected onto the axis through p1 - the dimension line runs
        # from p1 to this axis-locked point, not to the raw (possibly
        # off-axis) p2 itself.
        proj = (p2[0], p1[1]) if is_x else (p1[0], p2[1])
        label_u = _get_tag(dim, _DIM_LABEL_U_TAG, "")
        try:
            label_u = float(label_u)
        except ValueError:
            label_u = 0.5
        midx = p1[0] + (proj[0] - p1[0]) * label_u
        midy = p1[1] + (proj[1] - p1[1]) * label_u
        label_uv = (midx + perp[0] * perp_off, midy + perp[1] * perp_off)
        return {"p1": list(p1), "p2": list(proj), "labelUV": list(label_uv), "ordinate": True}
    dx, dy = p2[0] - p1[0], p2[1] - p1[1]
    length = math.hypot(dx, dy)
    if length < 1e-9:
        return None
    ux, uy = dx / length, dy / length
    perp = (-uy, ux)
    perp_off = _get_tag(dim, _DIM_PERP_TAG, "")
    try:
        perp_off = float(perp_off)
    except ValueError:
        perp_off = 8.0  # first-time default: 8mm outside the measured points
    label_u = _get_tag(dim, _DIM_LABEL_U_TAG, "")
    try:
        label_u = float(label_u)
    except ValueError:
        label_u = 0.5  # first-time default: centred along p1-p2
    mid = (p1[0] + dx * label_u, p1[1] + dy * label_u)
    label_uv = (mid[0] + perp[0] * perp_off, mid[1] + perp[1] * perp_off)
    return {"p1": list(p1), "p2": list(p2), "labelUV": list(label_uv)}


def set_dimension_geom(doc, dim_id, label_uv):
    """Persist a user's drag of the dimension line/label/leader/arc - solved
    as an offset against the dimension's own referenced geometry (rather
    than storing labelUV directly) so it stays correctly anchored even if
    that geometry itself later moves (e.g. a parameter-driven edit)."""
    dim = doc.getObject(dim_id)
    if dim is None:
        raise RpcError(APP_ERROR, "no such dimension: %r" % dim_id)

    if dim.Type in ("Radius", "Diameter"):
        pts = _dimension_radial_points(dim)
        if not pts:
            raise RpcError(APP_ERROR, "dimension has no resolvable geometry")
        center, _rim = pts
        leader_len = math.hypot(label_uv[0] - center[0], label_uv[1] - center[1])
        _tag(dim, _DIM_PERP_TAG, leader_len)
        return _dimension_geom(dim)

    if dim.Type in ("Angle", "Angle3Pt"):
        ag = _dimension_angle_geom(dim)
        if not ag:
            raise RpcError(APP_ERROR, "dimension has no resolvable geometry")
        center = ag["center"]
        arc_r = math.hypot(label_uv[0] - center[0], label_uv[1] - center[1])
        _tag(dim, _DIM_PERP_TAG, arc_r)
        return _dimension_geom(dim)

    pts = _dimension_linear_points(dim)
    if not pts:
        raise RpcError(APP_ERROR, "dimension has no resolvable geometry")
    p1, p2 = pts

    if dim.Type in ("DistanceX", "DistanceY"):
        # solve against the AXIS-LOCKED line (p1 -> proj), same convention
        # _dimension_geom uses for these two types - solving against the
        # raw p1->p2 diagonal instead (like the generic branch below) would
        # let the label drift as if it could move perpendicular to the
        # actual measured axis, which it can't.
        is_x = dim.Type == "DistanceX"
        proj = (p2[0], p1[1]) if is_x else (p1[0], p2[1])
        dx, dy = proj[0] - p1[0], proj[1] - p1[1]
        length = math.hypot(dx, dy)
        if length < 1e-9:
            raise RpcError(APP_ERROR, "degenerate dimension (zero-length reference)")
        ux, uy = dx / length, dy / length
        perp = (0.0, 1.0) if is_x else (1.0, 0.0)
        vx, vy = label_uv[0] - p1[0], label_uv[1] - p1[1]
        label_u = (vx * ux + vy * uy) / length
        perp_off = vx * perp[0] + vy * perp[1]
        _tag(dim, _DIM_PERP_TAG, perp_off)
        _tag(dim, _DIM_LABEL_U_TAG, label_u)
        return _dimension_geom(dim)

    dx, dy = p2[0] - p1[0], p2[1] - p1[1]
    length = math.hypot(dx, dy)
    if length < 1e-9:
        raise RpcError(APP_ERROR, "degenerate dimension (zero-length reference)")
    ux, uy = dx / length, dy / length
    perp = (-uy, ux)
    vx, vy = label_uv[0] - p1[0], label_uv[1] - p1[1]
    label_u = (vx * ux + vy * uy) / length
    perp_off = vx * perp[0] + vy * perp[1]
    _tag(dim, _DIM_PERP_TAG, perp_off)
    _tag(dim, _DIM_LABEL_U_TAG, label_u)
    return _dimension_geom(dim)


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

def _rgb_to_hex(rgba):
    r, g, b = rgba[0], rgba[1], rgba[2]
    return "#%02x%02x%02x" % (round(r * 255), round(g * 255), round(b * 255))


def _hex_to_rgb(hexcolor):
    h = str(hexcolor).lstrip("#")
    if len(h) != 6:
        return (0.0, 0.0, 0.0)
    return (int(h[0:2], 16) / 255.0, int(h[2:4], 16) / 255.0, int(h[4:6], 16) / 255.0)


def _note_dto(ann):
    return {
        "id": ann.Name, "text": "\n".join(ann.Text), "x": float(ann.X), "y": float(ann.Y),
        "font": str(ann.Font), "textSize": float(ann.TextSize),
        "textStyle": str(ann.TextStyle), "color": _rgb_to_hex(ann.TextColor),
    }


# --------------------------------------------------------------------------- #
# images
# --------------------------------------------------------------------------- #

def _image_dto(img):
    return {
        "id": img.Name, "x": float(img.X), "y": float(img.Y),
        "width": float(img.Width), "height": float(img.Height),
        "rotation": float(str(img.Rotation).split()[0]) if img.Rotation else 0.0,
        "path": str(img.ImageFile),
    }


def add_image(doc, page_id, path, x=0.0, y=0.0, width=None, height=None):
    """A real TechDraw::DrawViewImage - FreeCAD embeds the source file into
    the .FCStd on save (ImageFile is only the ORIGINAL path; the actual
    bytes get copied into the document's own cache the moment the property
    is set, confirmed live via the object's own ImageIncluded property, so
    this is a genuinely portable embed, not a dangling external reference
    that breaks if the source file later moves or is deleted)."""
    if not os.path.isfile(path):
        raise RpcError(APP_ERROR, "no such file: %r" % path)
    page = get_page(doc, page_id)
    img = doc.addObject("TechDraw::DrawViewImage", "Image")
    page.addView(img)
    img.ImageFile = str(path)
    doc.recompute()
    img.X = float(x)
    img.Y = float(y)
    # Width/Height default to the image's own native pixel size (already
    # set by FreeCAD itself from the file) unless the caller asks for a
    # specific placed size - only overridden when explicitly given so a
    # plain "insert this image" keeps its natural aspect ratio.
    if width is not None:
        img.Width = float(width)
    if height is not None:
        img.Height = float(height)
    doc.recompute()
    return _image_dto(img)


def set_image_transform(doc, image_id, x=None, y=None, width=None, height=None):
    """Persist a drag (x/y) and/or resize (width/height) of a placed image."""
    img = doc.getObject(image_id)
    if img is None or img.TypeId != "TechDraw::DrawViewImage":
        raise RpcError(APP_ERROR, "no such image: %r" % image_id)
    if x is not None:
        img.X = float(x)
    if y is not None:
        img.Y = float(y)
    if width is not None:
        img.Width = float(width)
    if height is not None:
        img.Height = float(height)
    doc.recompute()
    return _image_dto(img)


def remove_image(doc, image_id):
    img = doc.getObject(image_id)
    if img is None or img.TypeId != "TechDraw::DrawViewImage":
        raise RpcError(APP_ERROR, "no such image: %r" % image_id)
    doc.removeObject(img.Name)
    doc.recompute()
    return {"ok": True}


def add_note(doc, page_id, text, x, y, leader_view_id=None, leader_point=None,
              font=None, textSize=None, textStyle=None, color=None):
    page = get_page(doc, page_id)
    ann = doc.addObject("TechDraw::DrawViewAnnotation", "Note")
    page.addView(ann)
    # Text is a StringList, one entry per visual line - a single entry
    # containing an embedded "\n" does not render as multiple lines (it's a
    # real property list, not free text with newlines inside one entry), so
    # a genuinely multi-line note must split on "\n" here (paired with
    # _note_dto's "\n".join(ann.Text) below to reconstruct the original
    # string for the frontend/RPC boundary).
    ann.Text = str(text).split("\n")
    ann.X = float(x)
    ann.Y = float(y)
    if font:
        ann.Font = str(font)
    if textSize:
        ann.TextSize = float(textSize)
    if textStyle:
        ann.TextStyle = str(textStyle)
    if color:
        ann.TextColor = _hex_to_rgb(color)
    doc.recompute()

    leader_id = None
    leader_uv = None
    if leader_view_id and leader_point:
        view = doc.getObject(leader_view_id)
        if view is not None:
            # leader_point comes in as view-UV (a point on THAT view, the
            # same frame dimension picks/snap targets use). DrawLeaderLine
            # has no References2D-style live binding at all - WayPoints is
            # just raw page-absolute mm - so this app's OWN rendering can't
            # rely on WayPoints being anywhere near correct: a view's own
            # on-sheet placement (pl.x/pl.y) is purely client-side layout
            # state (confirmed: TechDraw::DrawViewPart's X/Y is never set
            # anywhere in this codebase, so view.X/Y is always 0 - nothing
            # to convert against here that would match what the app itself
            # actually drew). WayPoints is still given a best-effort
            # same-formula conversion below for the sake of any OTHER
            # FreeCAD tool that might read this .FCStd directly (a real
            # native GUI, or an export), but this app's own SVG renders the
            # leader from leaderViewId/leaderPointUV (persisted as tags
            # below) via the same uvToLocal + pl.x/pl.y every other view-
            # relative point already uses, so it's always exactly where the
            # app itself placed that view - not off by whatever WayPoints'
            # page-absolute snapshot happened to be.
            leader_uv = (float(leader_point[0]), float(leader_point[1]))
            sheet_pt = _view_uv_to_sheet(view, leader_uv)
            leader = doc.addObject("TechDraw::DrawLeaderLine", "Leader")
            page.addView(leader)
            leader.LeaderParent = ann
            leader.WayPoints = [
                App.Vector(sheet_pt[0], sheet_pt[1], 0),
                App.Vector(float(x), float(y), 0),
            ]
            _tag(leader, "_gwt_leaderView", view.Name)
            _tag(leader, "_gwt_leaderUV", json.dumps(list(leader_uv)))
            doc.recompute()
            leader_id = leader.Name

    dto = _note_dto(ann)
    dto["leaderId"] = leader_id
    if leader_id:
        dto["leaderViewId"] = leader_view_id
        dto["leaderPointUV"] = list(leader_uv)
    return dto


def set_note_text(doc, note_id, text):
    ann = doc.getObject(note_id)
    if ann is None or ann.TypeId != "TechDraw::DrawViewAnnotation":
        raise RpcError(APP_ERROR, "no such note: %r" % note_id)
    ann.Text = str(text).split("\n")  # see add_note's comment on Text being a StringList
    doc.recompute()
    return _note_dto(ann)


def set_note_style(doc, note_id, font=None, textSize=None, textStyle=None, color=None):
    ann = doc.getObject(note_id)
    if ann is None or ann.TypeId != "TechDraw::DrawViewAnnotation":
        raise RpcError(APP_ERROR, "no such note: %r" % note_id)
    if font:
        ann.Font = str(font)
    if textSize:
        ann.TextSize = float(textSize)
    if textStyle:
        ann.TextStyle = str(textStyle)
    if color:
        ann.TextColor = _hex_to_rgb(color)
    doc.recompute()
    return _note_dto(ann)


def move_note(doc, note_id, x, y):
    ann = doc.getObject(note_id)
    if ann is None or ann.TypeId != "TechDraw::DrawViewAnnotation":
        raise RpcError(APP_ERROR, "no such note: %r" % note_id)
    ann.X = float(x)
    ann.Y = float(y)
    doc.recompute()
    return _note_dto(ann)


def remove_note(doc, note_id):
    ann = doc.getObject(note_id)
    if ann is None or ann.TypeId != "TechDraw::DrawViewAnnotation":
        raise RpcError(APP_ERROR, "no such note: %r" % note_id)
    for o in list(doc.Objects):
        if o.TypeId == "TechDraw::DrawLeaderLine" and getattr(o, "LeaderParent", None) is ann:
            doc.removeObject(o.Name)
    doc.removeObject(ann.Name)
    doc.recompute()
    return {"ok": True}


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
                target = {"sub": "Edge%d" % i, "kind": "edge",
                          "p1": [a[0], a[1]], "p2": [b[0], b[1]]}
                # a full circle's first/last parameter are the SAME point
                # (a==b above), so a straight-segment hit test can only ever
                # match a click landing on that one specific point on the
                # rim, nowhere else on the circle - Radius/Diameter picking
                # was effectively unusable except by luck (confirmed live:
                # a click clearly on the visible circle, just not that exact
                # point, silently created a dimension with value=null).
                # Reporting the circle's own centre+radius lets the client
                # do a real point-to-circle distance test instead.
                if hasattr(e.Curve, "Radius") and hasattr(e.Curve, "Center"):
                    c = _project(view, e.Curve.Center, offset)
                    # radius in the SAME already-projected 2D frame as p1/p2
                    # above (not a raw model-space value scaled by hand) -
                    # measured as the projected distance from centre to the
                    # rim point already computed as `a`, so it's correct
                    # regardless of view scale/projection direction.
                    target["center"] = [c[0], c[1]]
                    target["radius"] = math.hypot(a[0] - c[0], a[1] - c[1])
                targets.append(target)
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
