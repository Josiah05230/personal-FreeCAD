"""Fusion-360-style solid primitives: Box / Cylinder / Sphere / Torus / Coil / Pipe.

Every RPC returns the project's standard tree payload. `gwtcad.methods` imports
this module, so all cross-module imports are done lazily inside each function to
dodge the load-time cycle.

box / cylinder / sphere / torus land as native PartDesign Additive* / Subtractive*
features so the timeline and the .FCStd round-trip stay meaningful. coil / pipe
are swept solids (no PartDesign primitive exists) wrapped into their own Body via
a FeatureBase, or combined into the active body through a PartDesign::Boolean.
"""
import FreeCAD as App
from FreeCAD import Vector, Rotation, Placement
import Part

from .registry import method, RpcError, APP_ERROR, METHODS
from . import session
from . import build
from .vocab import next_label

# primitive.box / primitive.cylinder also exist as thin stubs in methods.py.
# This module is the real implementation - drop any stub registration so the
# richer version wins no matter the import order.
for _n in ("primitive.box", "primitive.cylinder", "primitive.sphere",
           "primitive.torus", "primitive.coil", "primitive.pipe"):
    METHODS.pop(_n, None)

# primitive -> (Additive TypeId, Subtractive TypeId)
_PD = {
    "box": ("PartDesign::AdditiveBox", "PartDesign::SubtractiveBox"),
    "cylinder": ("PartDesign::AdditiveCylinder", "PartDesign::SubtractiveCylinder"),
    "sphere": ("PartDesign::AdditiveSphere", "PartDesign::SubtractiveSphere"),
    "torus": ("PartDesign::AdditiveTorus", "PartDesign::SubtractiveTorus"),
}
_TITLE = {"box": "Box", "cylinder": "Cylinder", "sphere": "Sphere",
          "torus": "Torus", "coil": "Coil", "pipe": "Pipe"}

_EPS = 1e-9


# --------------------------------------------------------------------------- #
# small helpers
# --------------------------------------------------------------------------- #

def _tree():
    from . import methods as _m
    return _m.tree_get()


def _doc():
    d = session.doc()
    if d is None:
        raise RpcError(APP_ERROR, "no active document")
    return d


def _has_solid(body):
    """True when `body` currently owns a valid, non-empty solid."""
    if body is None:
        return False
    try:
        shp = body.Shape
        return (shp is not None and not shp.isNull() and shp.isValid()
                and shp.Volume > _EPS)
    except Exception:
        return False


def _shape_ok(shp):
    try:
        return shp is not None and not shp.isNull() and shp.Volume > _EPS
    except Exception:
        return False


def _pos(name, v):
    v = float(v)
    if v <= 0.0:
        raise RpcError(APP_ERROR, "%s must be positive" % name)
    return v


# --------------------------------------------------------------------------- #
# PartDesign box / cylinder / sphere / torus
# --------------------------------------------------------------------------- #

def _center_offset(kind, dims):
    """Where the Additive/Subtractive feature sits. Box grows from a corner, so
    shift it so it is centred on the plane origin (Fusion's 'from center'); the
    other three are already origin-centred."""
    if kind == "box":
        return Placement(Vector(-dims["length"] / 2.0, -dims["width"] / 2.0, 0.0),
                         Rotation())
    return Placement(Vector(0, 0, 0), Rotation())


def _apply_dims(feat, kind, dims):
    if kind == "box":
        feat.Length = dims["length"]
        feat.Width = dims["width"]
        feat.Height = dims["height"]
    elif kind == "cylinder":
        feat.Radius = dims["radius"]
        feat.Height = dims["height"]
    elif kind == "sphere":
        feat.Radius = dims["radius"]
    elif kind == "torus":
        feat.Radius1 = dims["mean"]     # mean (centreline) radius
        feat.Radius2 = dims["section"]  # tube radius


def _add_pd_feature(body, tid, kind, dims, plane_ref=None):
    feat = body.newObject(tid, kind.capitalize())
    feat.Label = next_label(body, tid)
    if plane_ref:
        try:
            from . import methods as _m
            attach = _m._resolve_ref(body.Document, body, plane_ref)
            feat.AttachmentSupport = [attach]
            feat.MapMode = "FlatFace"
        except Exception:
            pass  # bad/unresolvable ref - fall back to the body origin
    try:
        feat.AttachmentOffset = _center_offset(kind, dims)
    except Exception:
        pass
    _apply_dims(feat, kind, dims)
    return feat


def _pd_primitive(kind, dims, operation, name, plane_ref=None):
    d = _doc()
    op = (operation or "newbody").lower()
    add_tid, sub_tid = _PD[kind]

    if op in ("newbody", "join"):
        target = session.active_body(d)
        if op == "join" and _has_solid(target):
            body = target
        else:
            body = build.new_body(d, name or _TITLE[kind])
            d.recompute()
        _add_pd_feature(body, add_tid, kind, dims, plane_ref=plane_ref)
        d.recompute()
        if not _has_solid(body):
            raise RpcError(APP_ERROR, "%s: the result is not a valid solid" % kind)
        return _tree()

    if op == "cut":
        body = session.active_body(d)
        if not _has_solid(body):
            raise RpcError(APP_ERROR,
                           "cut needs an active body with a solid - none found")
        _add_pd_feature(body, sub_tid, kind, dims, plane_ref=plane_ref)
        d.recompute()
        if not _has_solid(body):
            raise RpcError(APP_ERROR,
                           "%s cut left an empty or invalid solid" % kind)
        return _tree()

    if op == "intersect":
        body = session.active_body(d)
        if not _has_solid(body):
            raise RpcError(APP_ERROR,
                           "intersect needs an active body with a solid - none found")
        scratch = build.new_body(d, next_label(None, "PartDesign::Body"))
        d.recompute()
        _add_pd_feature(scratch, add_tid, kind, dims, plane_ref=plane_ref)
        d.recompute()
        if not _has_solid(scratch):
            _drop(d, scratch)
            raise RpcError(APP_ERROR, "%s: the primitive is not a valid solid" % kind)
        return _boolean_into(d, body, scratch, "Common",
                             "intersect not available for this %s yet" % kind,
                             prev_vol=body.Shape.Volume)

    raise RpcError(APP_ERROR, "unknown operation %r" % operation)


# --------------------------------------------------------------------------- #
# swept coil / pipe -> land as a Body, or combine into the active body
# --------------------------------------------------------------------------- #

def _drop(d, obj):
    try:
        if obj is not None and d.getObject(obj.Name) is not None:
            d.removeObject(obj.Name)
    except Exception:
        pass


def _state_bad(obj):
    st = " ".join(getattr(obj, "State", []) or [])
    return ("Invalid" in st) or ("Error" in st) or ("Touched" in st)


def _boolean_into(d, body, tool_body, btype, fail_msg, prev_vol=None):
    """Add a PartDesign::Boolean (Fuse|Cut|Common) to `body` with `tool_body` as
    its tool, make it the tip, recompute. Roll the whole thing back on failure.
    `tool_body` is hidden from the tree by methods._boolean_consumed_bodies.
    OCCT can leave the Boolean 'Invalid' when the swept tool is coincident with a
    face of the target - that is caught here and reported, not silently dropped."""
    prev_tip = getattr(body, "Tip", None)
    try:
        tool_body.Visibility = False
    except Exception:
        pass
    boolean = body.newObject("PartDesign::Boolean", "Boolean")
    boolean.Label = next_label(body, "PartDesign::Boolean")
    boolean.Type = btype
    boolean.Group = [tool_body]
    body.Tip = boolean
    try:
        boolean.touch()
    except Exception:
        pass
    d.recompute(None, True, True)

    ok = _has_solid(body) and not _state_bad(boolean) and not _state_bad(body)
    if ok and prev_vol is not None and btype in ("Cut", "Common"):
        # a Cut / Common that changed nothing means the tool never reached the
        # body - treat that as a no-op failure (same convention as methods.py).
        try:
            ok = abs(body.Shape.Volume - prev_vol) > 1e-6
        except Exception:
            ok = False
    if not ok:
        try:
            if prev_tip is not None:
                body.Tip = prev_tip
            _drop(d, boolean)
            _drop(d, tool_body)
            d.recompute()
        except Exception:
            pass
        raise RpcError(APP_ERROR, fail_msg)
    return _tree()


def _result_body(d, shape, operation, kind, name):
    """Place a raw swept `shape` per `operation`: its own Body for newbody / an
    unusable active body, or a Boolean into the active body otherwise."""
    from . import methods as _m
    op = (operation or "newbody").lower()
    label = name or _TITLE[kind]

    _combine_fail = ("%s %s failed - OCCT could not %s this swept solid into the "
                     "active body. Build it as a new body and combine instead.")

    if op in ("newbody", "join"):
        target = session.active_body(d)
        if op == "join" and _has_solid(target):
            tool = _m._scratch_body_from_shape(d, shape, "%sTool" % _TITLE[kind])
            return _boolean_into(d, target, tool, "Fuse",
                                 _combine_fail % (kind, op, "fuse"),
                                 prev_vol=target.Shape.Volume)
        nb = _m._scratch_body_from_shape(d, shape, label)
        try:
            nb.Label = label
        except Exception:
            pass
        d.recompute()
        if not _has_solid(nb):
            _drop(d, nb)
            raise RpcError(APP_ERROR, "%s: the result is not a valid solid" % kind)
        return _tree()

    if op in ("cut", "intersect"):
        target = session.active_body(d)
        if not _has_solid(target):
            raise RpcError(APP_ERROR,
                           "%s needs an active body with a solid - none found" % op)
        tool = _m._scratch_body_from_shape(d, shape, "%sTool" % _TITLE[kind])
        btype = "Cut" if op == "cut" else "Common"
        verb = "cut" if op == "cut" else "intersect"
        return _boolean_into(d, target, tool, btype,
                             _combine_fail % (kind, op, verb),
                             prev_vol=target.Shape.Volume)

    raise RpcError(APP_ERROR, "unknown operation %r" % operation)


def _section_frame(wire):
    """Start point and tangent of a path wire, for placing a circular section
    perpendicular to it."""
    edge = wire.Edges[0]
    p0 = wire.Vertexes[0].Point
    try:
        t0 = edge.tangentAt(edge.FirstParameter)
    except Exception:
        t0 = Vector(0, 0, 1)
    if t0.Length < _EPS:
        t0 = Vector(0, 0, 1)
    return p0, t0


# --------------------------------------------------------------------------- #
# RPC methods
# --------------------------------------------------------------------------- #

@method("primitive.box")
def primitive_box(length=40, width=40, height=40, operation="newbody",
                  planeRef=None, name=None):
    """Fusion Box. planeRef (an origin plane, datum plane, or flat face) places
    it there instead of the body origin."""
    dims = {"length": _pos("length", length), "width": _pos("width", width),
            "height": _pos("height", height)}
    return _pd_primitive("box", dims, operation, name, plane_ref=planeRef)


@method("primitive.cylinder")
def primitive_cylinder(diameter=40, height=40, operation="newbody",
                       planeRef=None, name=None):
    """Fusion Cylinder. planeRef places it on a plane/face instead of the origin."""
    dims = {"radius": _pos("diameter", diameter) / 2.0,
            "height": _pos("height", height)}
    return _pd_primitive("cylinder", dims, operation, name, plane_ref=planeRef)


@method("primitive.sphere")
def primitive_sphere(diameter=40, operation="newbody", planeRef=None, name=None):
    """Fusion Sphere. planeRef places its centre-plane instead of the origin."""
    dims = {"radius": _pos("diameter", diameter) / 2.0}
    return _pd_primitive("sphere", dims, operation, name, plane_ref=planeRef)


@method("primitive.torus")
def primitive_torus(meanDiameter=60, sectionDiameter=15, operation="newbody",
                    planeRef=None, name=None):
    """Fusion Torus. meanDiameter is the centreline circle, sectionDiameter the
    tube. planeRef places it on a plane/face instead of the origin."""
    mean = _pos("meanDiameter", meanDiameter) / 2.0
    section = _pos("sectionDiameter", sectionDiameter) / 2.0
    if section >= mean:
        raise RpcError(APP_ERROR,
                       "sectionDiameter must be smaller than meanDiameter")
    return _pd_primitive("torus", {"mean": mean, "section": section},
                         operation, name, plane_ref=planeRef)


@method("primitive.coil")
def primitive_coil(diameter=30, pitch=8, height=40, sectionDiameter=4,
                   turns=None, operation="newbody", planeRef=None, name=None):
    """Fusion Coil: a helix swept with a circular section. If `turns` is given,
    height = pitch * turns. planeRef accepted but ignored - the coil axis is +Z
    from the origin."""
    d = _doc()
    radius = _pos("diameter", diameter) / 2.0
    pitch = _pos("pitch", pitch)
    secr = _pos("sectionDiameter", sectionDiameter) / 2.0
    if turns is not None:
        height = pitch * float(turns)
    height = _pos("height", height)
    if secr >= radius:
        raise RpcError(APP_ERROR,
                       "sectionDiameter must be smaller than the coil diameter")

    helix = Part.makeHelix(pitch, height, radius)
    p0, t0 = _section_frame(helix)
    prof = Part.Wire(Part.Circle(p0, t0, secr).toShape())
    try:
        solid = helix.makePipeShell([prof], True, True)  # solid, Frenet
    except Exception as e:
        raise RpcError(APP_ERROR, "coil sweep failed: %s" % e)
    if not _shape_ok(solid):
        raise RpcError(APP_ERROR, "coil produced an invalid shape")
    return _result_body(d, solid, operation, "coil", name)


@method("primitive.pipe")
def primitive_pipe(pathRefs=None, sectionDiameter=10, wallThickness=0,
                   operation="newbody", name=None):
    """Fusion Pipe: sweep a circular section along selected path edges.
    pathRefs is a list of {bodyId, sub} - `sub` names an edge (e.g. 'Edge2') on
    that object's Shape; omit `sub` to take the object's first edge.
    wallThickness > 0 makes a hollow pipe wall."""
    d = _doc()
    refs = pathRefs or []
    if not refs:
        raise RpcError(APP_ERROR, "pipe needs at least one path edge in pathRefs")
    secr = _pos("sectionDiameter", sectionDiameter) / 2.0
    wall = float(wallThickness or 0.0)
    if wall < 0.0:
        raise RpcError(APP_ERROR, "wallThickness cannot be negative")

    edges = []
    for ref in refs:
        bid = ref.get("bodyId") or ref.get("new") or ref.get("id")
        sub = ref.get("sub")
        obj = d.getObject(bid) if bid else None
        if obj is None:
            raise RpcError(APP_ERROR, "pipe path: no object %r" % bid)
        shp = getattr(obj, "Shape", None)
        if shp is None or shp.isNull():
            raise RpcError(APP_ERROR, "pipe path: %r has no shape" % bid)
        try:
            edges.append(shp.getElement(sub) if sub else shp.Edges[0])
        except Exception:
            raise RpcError(APP_ERROR,
                           "pipe path: %r has no edge %r" % (bid, sub))
    try:
        wire = Part.Wire(Part.__sortEdges__(edges))
    except Exception as e:
        raise RpcError(APP_ERROR,
                       "pipe path edges do not join into one wire: %s" % e)

    p0, t0 = _section_frame(wire)
    outer_w = Part.Wire(Part.Circle(p0, t0, secr).toShape())
    try:
        if wall > 0.0:
            inner_r = secr - wall
            if inner_r <= 1e-6:
                raise RpcError(APP_ERROR,
                               "wallThickness is too large for this sectionDiameter")
            inner_w = Part.Wire(Part.Circle(p0, t0, inner_r).toShape())
            annulus = Part.Face(outer_w).cut(Part.Face(inner_w))
            solid = wire.makePipe(annulus)
            try:
                solid = solid.removeSplitter()
            except Exception:
                pass
        else:
            solid = wire.makePipeShell([outer_w], True, True)
    except RpcError:
        raise
    except Exception as e:
        raise RpcError(APP_ERROR, "pipe sweep failed: %s" % e)
    if not _shape_ok(solid):
        raise RpcError(APP_ERROR, "pipe produced an invalid shape")
    return _result_body(d, solid, operation, "pipe", name)
