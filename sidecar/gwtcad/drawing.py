"""Headless 2D drawings via TechDraw.

`Drawing.projectToSVG` was removed in FreeCAD 1.1, so we build the projection
ourselves: create a TechDraw DrawViewPart (which runs the hidden-line removal),
then read its visible/hidden edges and emit polylines the renderer draws as SVG.
"""
from .registry import RpcError, APP_ERROR

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


def _norm_dir(direction):
    k = str(direction or "front").strip().lower().replace(" view", "")
    k = _DIR_ALIAS.get(k, k)
    return k if k in _DIRS else "front"


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


def make_view(doc, source_obj, direction="front", scale=1.0):
    direction = _norm_dir(direction)
    d = _DIRS[direction]
    import FreeCAD as App

    page = None
    for o in doc.Objects:
        if o.TypeId == "TechDraw::DrawPage":
            page = o
            break
    if page is None:
        page = doc.addObject("TechDraw::DrawPage", "Drawing")
        tmpl = doc.addObject("TechDraw::DrawSVGTemplate", "Template")
        page.Template = tmpl

    view = doc.addObject("TechDraw::DrawViewPart", "View")
    page.addView(view)
    view.Source = [source_obj]
    view.Direction = App.Vector(*d)
    view.Scale = float(scale)
    view.Label = "%s view" % direction.title()
    if "_gwt_dir" not in view.PropertiesList:
        try:
            view.addProperty("App::PropertyString", "_gwt_dir", "GWT").setEditorMode("_gwt_dir", 2)
        except Exception:
            pass
    try:
        view._gwt_dir = direction
    except Exception:
        pass
    doc.recompute()

    vis = _edges_to_polylines(view.getVisibleEdges()) if hasattr(view, "getVisibleEdges") else []
    hid = _edges_to_polylines(view.getHiddenEdges()) if hasattr(view, "getHiddenEdges") else []
    if not vis and not hid:
        raise RpcError(APP_ERROR, "drawing view produced no geometry")

    xs = [p[0] for poly in vis + hid for p in poly]
    ys = [p[1] for poly in vis + hid for p in poly]
    bbox = [min(xs), min(ys), max(xs), max(ys)] if xs else [0, 0, 0, 0]

    return {
        "id": view.Name,
        "label": view.Label,
        "direction": direction,
        "scale": float(view.Scale),
        "visible": vis,
        "hidden": hid,
        "bbox": bbox,
    }
