"""Geometry construction helpers shared by the RPC feature methods.

Everything stays in the PartDesign feature tree (Body > Sketch > Pad/Pocket/
Fillet/...), never a raw Part boolean, so the timeline and the .FCStd round-trip
stay meaningful.
"""
import Part
from FreeCAD import Vector

from .registry import RpcError, APP_ERROR
from .vocab import next_label

_ORIGIN_ROLE = {
    "XY": "XY_Plane",
    "XZ": "XZ_Plane",
    "YZ": "YZ_Plane",
}


def origin_plane(body, plane="XY"):
    role = _ORIGIN_ROLE.get(plane.upper())
    if role is None:
        raise RpcError(APP_ERROR, "unknown plane %r" % plane)
    for f in body.Origin.OriginFeatures:
        if getattr(f, "Role", None) == role:
            return f
    raise RpcError(APP_ERROR, "origin plane %s missing" % role)


def new_body(doc, label=None):
    body = doc.addObject("PartDesign::Body", "Body")
    if label:
        body.Label = label
    return body


def rect_sketch(body, w, h, plane="XY", centered=True):
    sk = body.newObject("Sketcher::SketchObject", "Sketch")
    sk.Label = next_label(body, "Sketcher::SketchObject")
    sk.AttachmentSupport = [(origin_plane(body, plane), "")]
    sk.MapMode = "FlatFace"
    x0, y0 = (-w / 2.0, -h / 2.0) if centered else (0.0, 0.0)
    x1, y1 = x0 + w, y0 + h
    pts = [
        (Vector(x0, y0, 0), Vector(x1, y0, 0)),
        (Vector(x1, y0, 0), Vector(x1, y1, 0)),
        (Vector(x1, y1, 0), Vector(x0, y1, 0)),
        (Vector(x0, y1, 0), Vector(x0, y0, 0)),
    ]
    for a, b in pts:
        sk.addGeometry(Part.LineSegment(a, b), False)
    return sk


def circle_sketch(body, radius, plane="XY"):
    sk = body.newObject("Sketcher::SketchObject", "Sketch")
    sk.Label = next_label(body, "Sketcher::SketchObject")
    sk.AttachmentSupport = [(origin_plane(body, plane), "")]
    sk.MapMode = "FlatFace"
    sk.addGeometry(Part.Circle(Vector(0, 0, 0), Vector(0, 0, 1), radius), False)
    return sk


def pad(body, sketch, length, reversed_=False, midplane=False, name="Pad"):
    p = body.newObject("PartDesign::Pad", name)
    p.Label = next_label(body, "PartDesign::Pad")
    p.Profile = sketch
    p.Length = float(length)
    if reversed_:
        p.Reversed = True
    # FreeCAD 1.1 replaced the boolean Midplane with the SideType enum.
    if midplane:
        if hasattr(p, "SideType"):
            p.SideType = "Symmetric"
        else:  # older FreeCAD
            p.Midplane = True
    sketch.Visibility = False
    return p


def pocket(body, sketch, length, through_all=False, name="Pocket"):
    p = body.newObject("PartDesign::Pocket", name)
    p.Label = next_label(body, "PartDesign::Pocket")
    p.Profile = sketch
    if through_all:
        p.Type = "ThroughAll"
    else:
        p.Length = float(length)
    sketch.Visibility = False
    return p


def dress_up(body, type_id, base_feature, sub_names, name):
    """Fillet / Chamfer / Draft / Thickness - all take a (feature, [subs]) base."""
    f = body.newObject(type_id, name)
    f.Label = next_label(body, type_id)
    f.Base = (base_feature, list(sub_names))
    return f
