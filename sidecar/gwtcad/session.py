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


# Rollback marker per body: the feature name the timeline marker sits AFTER.
# None / absent => marker is at the end (normal editing). This is the source of
# truth for "what exists at this point in history"; body.Tip is set from it for
# geometry but a pre-first-solid marker leaves Tip alone and flags rolled-empty.
_marker = {}
_rolled_empty = set()


def set_marker(body_name, feature_name, tip_at_rollback=None):
    if feature_name is None:
        _marker.pop(body_name, None)
    else:
        _marker[body_name] = {"feature": feature_name, "tip": tip_at_rollback}


def marker(body_name):
    m = _marker.get(body_name)
    return m["feature"] if m else None


def marker_tip(body_name):
    m = _marker.get(body_name)
    return m["tip"] if m else None


def clear_markers():
    _marker.clear()
    _rolled_empty.clear()


# Named user parameters: {name: expression string}. Referenceable from any
# dimension input. Session-scoped; persisted with the document sidecar json.
_params = {}


def params():
    return dict(_params)


def set_param(name, expr):
    _params[name] = expr


def del_param(name):
    _params.pop(name, None)


def clear_params():
    _params.clear()


# Per-feature dimension expressions: {featureName: {prop: "1in + 2mm"}}.
# The feature's numeric property is kept in sync; this remembers the formula so
# editing shows it again, and lets a parameter change re-drive the model.
_feature_exprs = {}


def feature_exprs(name):
    return dict(_feature_exprs.get(name, {}))


def feature_expr(name, prop):
    return _feature_exprs.get(name, {}).get(prop)


def set_feature_expr(name, prop, expr):
    if not expr:
        _feature_exprs.get(name, {}).pop(prop, None)
        return
    _feature_exprs.setdefault(name, {})[prop] = expr


def all_feature_exprs():
    return {n: dict(m) for n, m in _feature_exprs.items()}


def clear_feature_exprs():
    _feature_exprs.clear()


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


def add_canvas(plane_role, w_mm, h_mm, image=None):
    _canvas_seq[0] += 1
    cid = "Canvas%d" % _canvas_seq[0]
    _canvases[cid] = {"id": cid, "plane": plane_role, "w": float(w_mm), "h": float(h_mm),
                      "offset": [0.0, 0.0], "rot": 0.0, "image": image}
    return _canvases[cid]


def load_state(blob):
    """Restore session-only extras (canvases, colours) from a companion file."""
    _canvases.clear()
    for c in blob.get("canvases", []):
        _canvases[c["id"]] = c
    _colors.clear()
    _colors.update(blob.get("colors", {}))
    _params.clear()
    _params.update(blob.get("params", {}))
    _feature_exprs.clear()
    _feature_exprs.update(blob.get("featureExprs", {}))
    mx = 0
    for cid in _canvases:
        try:
            mx = max(mx, int(cid.replace("Canvas", "")))
        except Exception:
            pass
    _canvas_seq[0] = mx


def dump_state():
    return {"canvases": list(_canvases.values()), "colors": dict(_colors),
            "params": dict(_params), "featureExprs": all_feature_exprs()}


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
    clear_markers()
    clear_params()
    clear_feature_exprs()
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
