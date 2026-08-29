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
    sketch.AttachmentSupport = [(_origin_plane(body, "XY_Plane"), "")]
    sketch.MapMode = "FlatFace"

    w, dp = float(width) / 2.0, float(depth) / 2.0
    sketch.addGeometry(Part.LineSegment(Vector(-w, -dp, 0), Vector(w, -dp, 0)), False)
    sketch.addGeometry(Part.LineSegment(Vector(w, -dp, 0), Vector(w, dp, 0)), False)
    sketch.addGeometry(Part.LineSegment(Vector(w, dp, 0), Vector(-w, dp, 0)), False)
    sketch.addGeometry(Part.LineSegment(Vector(-w, dp, 0), Vector(-w, -dp, 0)), False)
    d.recompute()

    pad = body.newObject("PartDesign::Pad", "Pad")
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
                    "type": f.TypeId,
                    "kind": _kind(f.TypeId),
                    "isTip": f is tip,
                    "error": bool(getattr(f, "State", None) and "Error" in f.State),
                })
            bodies.append({"id": o.Name, "label": o.Label, "features": feats})
    return {"bodies": bodies}


# --------------------------------------------------------------------------- #
# export
# --------------------------------------------------------------------------- #

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
