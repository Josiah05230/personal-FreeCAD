"""Active document state for the sidecar.

One document at a time for now. Milestone 2 (assemblies) turns this into a small
document set keyed by path.
"""
import FreeCAD as App

_DOC_NAME = "GWTCAD"


def doc(create=True):
    d = App.getDocument(_DOC_NAME) if _DOC_NAME in [x.Name for x in App.listDocuments().values()] else None
    if d is None and create:
        d = App.newDocument(_DOC_NAME)
    return d


def reset():
    """Close the current document and open a fresh empty one."""
    existing = None
    for d in App.listDocuments().values():
        if d.Name == _DOC_NAME:
            existing = d
            break
    if existing is not None:
        App.closeDocument(existing.Name)
    return App.newDocument(_DOC_NAME)


def active_body(d=None):
    d = d or doc()
    bodies = [o for o in d.Objects if o.TypeId == "PartDesign::Body"]
    return bodies[-1] if bodies else None
