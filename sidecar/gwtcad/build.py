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


def profile_is_consumed(d, sk):
    """True when this Sketcher object is already the Profile / Sections / Spine
    of some other feature. Handing the SAME sketch to a second feature makes
    PartDesign corrupt both on the next recompute."""
    for o in d.Objects:
        for prop in ("Profile", "Sections", "Spine"):
            v = getattr(o, prop, None)
            if v is None:
                continue
            items = v if isinstance(v, (list, tuple)) else [v]
            for it in items:
                obj = it[0] if isinstance(it, (tuple, list)) and it else it
                if obj is sk:
                    return True
    return False


def reusable_profile(d, body, sk):
    """A profile object safe to give to a NEW feature. If `sk` is a sketch that
    is already consumed elsewhere, duplicate it (F360-style shared profile) so
    the original feature keeps an intact copy and the new one gets its own.
    A (face, [sub]) tuple is returned unchanged."""
    if not hasattr(sk, "TypeId") or sk.TypeId != "Sketcher::SketchObject":
        return sk
    if not profile_is_consumed(d, sk):
        return sk
    dup = d.copyObject(sk, False)
    try:
        dup.Label = sk.Label + " (copy)"
    except Exception:
        pass
    try:
        body.addObject(dup)
    except Exception:
        pass
    dup.Visibility = False
    return dup


def finalize_or_rollback(d, target, made, prev_tip_name, extra, what):
    """Recompute and check `target` has a valid solid. If not, remove exactly
    what this call created - `made` plus everything in `extra` - restore the
    body's previous tip and raise RpcError(what). Features that were already in
    the body are never touched, so a bad new feature can't wipe existing work."""
    d.recompute()
    try:
        shp = getattr(target, "Shape", None)
        ok = shp is not None and not shp.isNull() and shp.isValid()
    except Exception:
        ok = False
    if ok:
        return
    body = None
    for obj in list(extra) + [made]:
        if obj is None:
            continue
        try:
            grp = obj.getParentGeoFeatureGroup()
            if grp is not None and grp.TypeId == "PartDesign::Body":
                body = grp
        except Exception:
            pass
        try:
            if d.getObject(obj.Name) is not None:
                d.removeObject(obj.Name)
        except Exception:
            pass
    try:
        if body is not None and prev_tip_name and d.getObject(prev_tip_name) is not None:
            body.Tip = d.getObject(prev_tip_name)
    except Exception:
        pass
    try:
        d.recompute()
    except Exception:
        pass
    raise RpcError(APP_ERROR, what)


def _set_profile(feature, profile):
    """profile is either a Sketcher object or a (feature, [subnames]) tuple
    naming a flat face of the base solid."""
    # a (None, [...]) tuple slips through when a face profile is resolved against
    # a body with no solid yet - FreeCAD then leaves a half-built Pad that aborts
    # OCCT on the next recompute. Refuse it here.
    if isinstance(profile, (tuple, list)):
        if not profile or profile[0] is None:
            feature.Document.removeObject(feature.Name)
            raise ValueError("no profile to extrude - the base body has no solid")
    feature.Profile = profile
    if hasattr(profile, "Visibility"):
        profile.Visibility = False


def pad(body, sketch, length, reversed_=False, midplane=False, name="Pad",
        up_to=None, offset=0.0):
    p = body.newObject("PartDesign::Pad", name)
    p.Label = next_label(body, "PartDesign::Pad")
    _set_profile(p, sketch)
    p.Length = float(length)
    if up_to is not None:
        try:
            p.Type = "UpToFace"
            p.UpToFace = up_to  # (obj, [sub])
            if offset and hasattr(p, "Offset"):
                p.Offset = float(offset)  # extra distance past the face
        except Exception:
            p.Type = "Length"
    if reversed_:
        p.Reversed = True
    # FreeCAD 1.1 replaced the boolean Midplane with the SideType enum.
    if midplane:
        if hasattr(p, "SideType"):
            p.SideType = "Symmetric"
        else:  # older FreeCAD
            p.Midplane = True
    return p


def pocket(body, sketch, length, through_all=False, name="Pocket", up_to=None,
           offset=0.0):
    p = body.newObject("PartDesign::Pocket", name)
    p.Label = next_label(body, "PartDesign::Pocket")
    _set_profile(p, sketch)
    if up_to is not None:
        try:
            p.Type = "UpToFace"
            p.UpToFace = up_to
            if offset and hasattr(p, "Offset"):
                p.Offset = float(offset)
        except Exception:
            p.Length = float(length)
    elif through_all:
        p.Type = "ThroughAll"
    else:
        p.Length = float(length)
    return p


def dress_up(body, type_id, base_feature, sub_names, name):
    """Fillet / Chamfer / Draft / Thickness - all take a (feature, [subs]) base."""
    f = body.newObject(type_id, name)
    f.Label = next_label(body, type_id)
    f.Base = (base_feature, list(sub_names))
    return f
