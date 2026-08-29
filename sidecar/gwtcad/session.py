"""Active document state for the sidecar.

One document at a time for now. Milestone 2 (assemblies) turns this into a small
document set keyed by path.
"""
import FreeCAD as App

_DEFAULT_NAME = "GWTCAD"
_state = {"name": _DEFAULT_NAME, "path": None}


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
