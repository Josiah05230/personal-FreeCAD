"""JSON-RPC methods exposed to the Electron shell.

Milestone 0 surface only: enough to build a demo solid headless, stream it to the
viewport, and describe its feature tree. Real modelling operations arrive in
Milestone 1.
"""
import os

import FreeCAD as App
import Part
from FreeCAD import Vector

from .registry import method, RpcError, APP_ERROR
from . import session
from .tessellate import tessellate_shape
from .vocab import op_name, next_label

_DATUM_TYPES = (
    "PartDesign::Plane", "PartDesign::Line", "PartDesign::Point",
    "PartDesign::CoordinateSystem",
)


def _kind(type_id):
    if type_id == "Sketcher::SketchObject":
        return "sketch"
    if type_id in _DATUM_TYPES:
        return "datum"
    if type_id.startswith("PartDesign::"):
        return "solid"
    return "other"


def _origin_plane(body, role):
    for f in body.Origin.OriginFeatures:
        if getattr(f, "Role", None) == role:
            return f
    raise RpcError(APP_ERROR, "origin plane %s not found" % role)


# --------------------------------------------------------------------------- #
# lifecycle
# --------------------------------------------------------------------------- #

@method("ping")
def ping():
    return {
        "pong": True,
        "freecad": ".".join(App.Version()[:3]),
        "build": App.Version()[3],
    }


@method("session.reset")
def session_reset():
    d = session.reset()
    return {"document": d.Name}


# --------------------------------------------------------------------------- #
# demo geometry (Milestone 0 only)
# --------------------------------------------------------------------------- #

@method("demo.pad")
def demo_pad(width=60.0, depth=40.0, height=15.0):
    """Body > rectangular Sketch on XY > Pad. Returns the feature tree."""
    d = session.reset()
    body = d.addObject("PartDesign::Body", "Body")
    sketch = body.newObject("Sketcher::SketchObject", "Sketch")
    sketch.Label = next_label(body, "Sketcher::SketchObject")
    sketch.AttachmentSupport = [(_origin_plane(body, "XY_Plane"), "")]
    sketch.MapMode = "FlatFace"

    w, dp = float(width) / 2.0, float(depth) / 2.0
    sketch.addGeometry(Part.LineSegment(Vector(-w, -dp, 0), Vector(w, -dp, 0)), False)
    sketch.addGeometry(Part.LineSegment(Vector(w, -dp, 0), Vector(w, dp, 0)), False)
    sketch.addGeometry(Part.LineSegment(Vector(w, dp, 0), Vector(-w, dp, 0)), False)
    sketch.addGeometry(Part.LineSegment(Vector(-w, dp, 0), Vector(-w, -dp, 0)), False)
    d.recompute()

    pad = body.newObject("PartDesign::Pad", "Pad")
    pad.Label = next_label(body, "PartDesign::Pad")
    pad.Profile = sketch
    pad.Length = float(height)
    sketch.Visibility = False
    d.recompute()

    if not body.Shape.isValid():
        raise RpcError(APP_ERROR, "demo pad produced an invalid shape")

    return tree_get()


# --------------------------------------------------------------------------- #
# read-side: scene + tree
# --------------------------------------------------------------------------- #

@method("scene.get")
def scene_get():
    """Render buffers for every visible solid body in the document."""
    d = session.doc(create=False)
    meshes = []
    if d is not None:
        for o in d.Objects:
            if o.TypeId != "PartDesign::Body":
                continue
            shape = getattr(o, "Shape", None)
            if shape is None or shape.isNull():
                continue
            buf = tessellate_shape(shape)
            buf["id"] = o.Name
            buf["label"] = o.Label
            meshes.append(buf)
    return {"meshes": meshes}


@method("tree.get")
def tree_get():
    """Feature tree for the timeline + browser."""
    d = session.doc(create=False)
    bodies = []
    if d is not None:
        for o in d.Objects:
            if o.TypeId != "PartDesign::Body":
                continue
            tip = getattr(o, "Tip", None)
            feats = []
            for f in o.Group:
                if f.TypeId == "App::Origin":
                    continue
                feats.append({
                    "id": f.Name,
                    "label": f.Label,
                    "opType": op_name(f.TypeId),
                    "kind": _kind(f.TypeId),
                    "isTip": f is tip,
                    "error": bool(getattr(f, "State", None) and "Error" in f.State),
                })
            bodies.append({
                "id": o.Name,
                "label": o.Label,
                "visible": bool(getattr(o, "Visibility", True)),
                "features": feats,
            })
    return {"bodies": bodies, "path": session.path()}


# --------------------------------------------------------------------------- #
# edit: visibility, history rollback, rename, delete
# --------------------------------------------------------------------------- #

def _obj(name):
    d = session.doc(create=False)
    if d is None:
        raise RpcError(APP_ERROR, "no document")
    o = d.getObject(name)
    if o is None:
        raise RpcError(APP_ERROR, "no object %r" % name)
    return d, o


@method("object.setVisibility")
def object_set_visibility(id, visible):
    d, o = _obj(id)
    o.Visibility = bool(visible)
    d.recompute()
    return {"id": id, "visible": bool(o.Visibility)}


@method("history.rollTo")
def history_roll_to(bodyId, featureId=None):
    """Set the Body tip (Fusion's rollback marker). featureId=None -> newest."""
    d, body = _obj(bodyId)
    if body.TypeId != "PartDesign::Body":
        raise RpcError(APP_ERROR, "%r is not a Body" % bodyId)
    feats = [f for f in body.Group if f.TypeId != "App::Origin"]
    if not feats:
        return {"tip": None}
    target = feats[-1] if featureId is None else d.getObject(featureId)
    if target is None:
        raise RpcError(APP_ERROR, "no feature %r" % featureId)
    body.Tip = target
    # everything after the tip is hidden; tip solid shown
    reached = False
    for f in feats:
        if _kind(f.TypeId) == "solid":
            f.Visibility = f is target or (not reached)
        if f is target:
            reached = True
    d.recompute()
    return {"tip": target.Name}


@method("feature.rename")
def feature_rename(id, label):
    d, o = _obj(id)
    o.Label = str(label)
    d.recompute()
    return {"id": id, "label": o.Label}


@method("feature.delete")
def feature_delete(id):
    d, o = _obj(id)
    d.removeObject(o.Name)
    d.recompute()
    return {"deleted": id}


# --------------------------------------------------------------------------- #
# document: save / open
# --------------------------------------------------------------------------- #

@method("document.saveAs")
def document_save_as(path):
    d = session.doc(create=False)
    if d is None:
        raise RpcError(APP_ERROR, "no document")
    path = os.path.abspath(os.path.expanduser(path))
    d.saveAs(path)
    session.set_path(path)
    return {"path": path}


@method("document.save")
def document_save():
    d = session.doc(create=False)
    if d is None:
        raise RpcError(APP_ERROR, "no document")
    p = session.path()
    if not p:
        raise RpcError(APP_ERROR, "document has no path yet - use saveAs")
    d.save()
    return {"path": p}


@method("document.open")
def document_open(path):
    path = os.path.abspath(os.path.expanduser(path))
    if not os.path.isfile(path):
        raise RpcError(APP_ERROR, "no such file: %s" % path)
    d = session.open_path(path)
    d.recompute()
    return {"path": path, "name": d.Name}


@method("document.info")
def document_info():
    d = session.doc(create=False)
    return {
        "path": session.path(),
        "objects": 0 if d is None else len(d.Objects),
    }


# --------------------------------------------------------------------------- #
# import / export
# --------------------------------------------------------------------------- #

@method("io.importStep")
def io_import_step(path):
    """STEP / IGES / BREP import. Uses the headless-safe `Import` module."""
    import Import
    d = session.doc()
    path = os.path.abspath(os.path.expanduser(path))
    if not os.path.isfile(path):
        raise RpcError(APP_ERROR, "no such file: %s" % path)
    Import.insert(path, d.Name)
    d.recompute()
    return {"path": path}

@method("io.exportStep")
def io_export_step(path):
    d = session.doc(create=False)
    if d is None:
        raise RpcError(APP_ERROR, "no document")
    path = os.path.abspath(os.path.expanduser(path))
    objs = [o for o in d.Objects if o.TypeId == "PartDesign::Body"]
    Part.export(objs, path)
    return {"path": path, "bodies": len(objs)}


@method("io.exportStl")
def io_export_stl(path):
    import Mesh
    d = session.doc(create=False)
    if d is None:
        raise RpcError(APP_ERROR, "no document")
    path = os.path.abspath(os.path.expanduser(path))
    objs = [o for o in d.Objects if o.TypeId == "PartDesign::Body"]
    Mesh.export(objs, path)
    return {"path": path, "bodies": len(objs)}
