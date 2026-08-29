"""Active document state for the sidecar.

One document at a time for now. Milestone 2 (assemblies) turns this into a small
document set keyed by path.
"""
import FreeCAD as App

_DEFAULT_NAME = "GWTCAD"
_state = {"name": _DEFAULT_NAME, "path": None}

# Origin geometry (planes/axes/point) has no reliable headless Visibility flag,
# so the sidecar tracks which datum object names the user has switched on.
_shown_datums = set()


def datum_shown(name):
    return name in _shown_datums


def set_datum_shown(name, shown):
    if shown:
        _shown_datums.add(name)
    else:
        _shown_datums.discard(name)


# Bodies rolled back to before their first solid feature (nothing to show yet).
_rolled_empty = set()


def set_rolled_empty(body_name, empty):
    if empty:
        _rolled_empty.add(body_name)
    else:
        _rolled_empty.discard(body_name)


def is_rolled_empty(body_name):
    return body_name in _rolled_empty


# Per-object display colour [r,g,b] 0-1 (headless has no ViewObject).
_colors = {}


def set_body_color(name, rgb):
    if rgb is None:
        _colors.pop(name, None)
    else:
        _colors[name] = list(rgb)


def body_color(name):
    return _colors.get(name)


# Inserted 2D canvases (image underlays). Session-scoped for now; the renderer
# holds the pixels, the sidecar holds placement + real-world size.
_canvases = {}
_canvas_seq = [0]


def add_canvas(plane_role, w_mm, h_mm):
    _canvas_seq[0] += 1
    cid = "Canvas%d" % _canvas_seq[0]
    _canvases[cid] = {"id": cid, "plane": plane_role, "w": float(w_mm), "h": float(h_mm),
                      "offset": [0.0, 0.0], "rot": 0.0}
    return _canvases[cid]


def canvases():
    return list(_canvases.values())


def update_canvas(cid, **kw):
    if cid not in _canvases:
        return None
    _canvases[cid].update({k: v for k, v in kw.items() if v is not None})
    return _canvases[cid]


def remove_canvas(cid):
    _canvases.pop(cid, None)


def _find(name):
    for d in App.listDocuments().values():
        if d.Name == name:
            return d
    return None


def doc(create=True):
    d = _find(_state["name"])
    if d is None and create:
        d = App.newDocument(_DEFAULT_NAME)
        _state["name"] = d.Name
        _state["path"] = None
    return d


def reset():
    d = _find(_state["name"])
    if d is not None:
        App.closeDocument(d.Name)
    d = App.newDocument(_DEFAULT_NAME)
    _state["name"] = d.Name
    _state["path"] = None
    _shown_datums.clear()
    return d


def open_path(path):
    d = _find(_state["name"])
    if d is not None:
        App.closeDocument(d.Name)
    d = App.openDocument(path)
    _state["name"] = d.Name
    _state["path"] = path
    return d


def set_path(path):
    _state["path"] = path


def path():
    return _state["path"]


def active_body(d=None):
    d = d or doc()
    bodies = [o for o in d.Objects if o.TypeId == "PartDesign::Body"]
    return bodies[-1] if bodies else None
