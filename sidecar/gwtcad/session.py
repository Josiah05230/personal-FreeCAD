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
