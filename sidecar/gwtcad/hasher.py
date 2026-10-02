"""Element-name hashing off (pn-cad-files GWT-CAD-NEEDS.md #1).

With a document's UseHasher on (FreeCAD 1.1's default), element names are
stored as hashed ids, and a sketch re-solve hands the same underlying names
NEW ids - so every stored reference to an edge / face of a later feature
(fillet and chamfer edges, sketch attachments, Up To Face, external
geometry) stops resolving the moment a dimension changes. With it off the
names are plain text and identical before and after the edit.

New documents are created with it off (new_document). An existing document
is migrated on open: its stored references are re-derived under plain names
(migrate). Flex tests: SGJ0060 5 -> 0 failing changes.
"""
import FreeCAD as App

_LINK_TYPES = {
    "App::PropertyLinkSub", "App::PropertyLinkSubList", "App::PropertyLinkSubHidden",
    "App::PropertyLinkSubListHidden", "App::PropertyXLinkSub", "App::PropertyXLinkSubList",
    "App::PropertyLinkSubChild", "App::PropertyLinkSubListChild",
}


def new_document(name):
    d = App.newDocument(name)
    try:
        d.UseHasher = False
    except Exception:
        pass
    return d


def _index_only(v):
    """A link value with every sub-element name cut to its index name
    ('Edge2'), which is still right while the geometry hasn't changed."""
    def strip(s):
        if not isinstance(s, str):
            return s
        if ";" in s:
            s = s.split(".")[-1]
        # '?Face2': FreeCAD couldn't map the stored name (e.g. the linked part
        # was itself just migrated) and kept the old index - still right
        # while geometry is unchanged
        return s.lstrip("?")
    if isinstance(v, tuple) and len(v) == 2 and not isinstance(v[0], tuple):
        o, subs = v
        return (o, [strip(s) for s in subs]) if isinstance(subs, (list, tuple)) else (o, strip(subs))
    if isinstance(v, list):
        return [_index_only(x) for x in v]
    return v


def _modelling_objects(d):
    # never TechDraw: touching a view would redo its hidden-line removal
    return [o for o in d.Objects if not o.TypeId.startswith("TechDraw::")]


def migrate(d):
    """Turn hashing off on an opened document and re-derive its stored
    element references under plain names, without changing any geometry.
    Returns how many link properties were re-derived (0 = nothing to do)."""
    if not getattr(d, "UseHasher", False):
        return 0
    saved = []
    for o in _modelling_objects(d):
        for p in o.PropertiesList:
            try:
                if o.getTypeIdOfProperty(p) in _LINK_TYPES:
                    saved.append((o, p, _index_only(getattr(o, p))))
            except Exception:
                continue
    d.UseHasher = False
    objs = _modelling_objects(d)
    for o in objs:
        o.touch()
    d.recompute()  # every shape regenerates plain element names
    for o, p, v in saved:
        try:
            setattr(o, p, v)  # re-derived from the index names, now plain
        except Exception:
            pass  # read-only (sketch external geometry) - re-resolved on recompute
    # only the objects holding references need it; recompute carries their
    # dependents along
    for o in {id(o): o for o, _p, _v in saved}.values():
        o.touch()
    d.recompute()
    try:
        d.clearUndos()  # the migration isn't an edit to undo
    except Exception:
        pass
    return len(saved)


def rebuild_transient(d):
    """Recompute objects whose Shape isn't stored in the file (Draft
    ShapeStrings saved Transient to keep label files small) - an untouched
    object isn't recomputed on open, so the first edit upstream of a text
    pad left it with an empty profile (GWT-CAD-NEEDS.md #2). True if any."""
    hit = []
    for o in _modelling_objects(d):
        try:
            if "Shape" in o.PropertiesList and "Transient" in (o.getPropertyStatus("Shape") or []):
                hit.append(o)
        except Exception:
            continue
    for o in hit:
        o.touch()
    if hit:
        d.recompute()
    return bool(hit)
