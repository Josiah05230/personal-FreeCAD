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
from . import build
from . import drawing as _drawing
from . import assembly as _assembly
from .tessellate import tessellate_shape
from .vocab import op_name, next_label
from . import expr as _expr

_DATUM_TYPES = (
    "PartDesign::Plane", "PartDesign::Line", "PartDesign::Point",
    "PartDesign::CoordinateSystem",
)

# Tessellation cache: body name -> (signature, render buffer). OCCT meshing is
# the slow part of scene.get; skip it when a body's shape is unchanged.
_TESS_CACHE = {}


def _shape_sig(shape):
    try:
        bb = shape.BoundBox
        return "%d|%d|%.5f|%.5f|%.3f,%.3f,%.3f,%.3f,%.3f,%.3f" % (
            len(shape.Faces), len(shape.Edges), shape.Area, shape.Volume,
            bb.XMin, bb.YMin, bb.ZMin, bb.XMax, bb.YMax, bb.ZMax,
        )
    except Exception:
        return None


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
    _TESS_CACHE.clear()
    _ensure_starter_body(d)
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
# real modelling operations
# --------------------------------------------------------------------------- #

def _require_body():
    b = session.active_body()
    if b is None:
        raise RpcError(APP_ERROR, "no active body - create a solid first")
    return b


def _ensure_starter_body(d):
    """Fusion always has one component with an origin (3 planes + 3 axes + point),
    even in an empty design. Guarantee an empty Body exists so the browser's
    Origin section is never blank."""
    if d is None:
        return None
    for o in d.Objects:
        if o.TypeId == "PartDesign::Body":
            return o
    body = d.addObject("PartDesign::Body", "Body")
    d.recompute()  # materialises the Origin child (planes / axes / point)
    return body


def _solid_tip(body):
    tip = getattr(body, "Tip", None)
    if tip is None or _kind(tip.TypeId) != "solid":
        raise RpcError(APP_ERROR, "active body has no solid to modify yet")
    return tip


@method("primitive.box")
def primitive_box(width=40.0, depth=40.0, height=40.0, name=None):
    d = session.doc()
    body = build.new_body(d, name or "Box")
    sk = build.rect_sketch(body, float(width), float(depth), "XY", centered=True)
    d.recompute()
    build.pad(body, sk, float(height))
    d.recompute()
    if not body.Shape.isValid():
        raise RpcError(APP_ERROR, "box shape invalid")
    return tree_get()


@method("primitive.cylinder")
def primitive_cylinder(diameter=40.0, height=40.0, name=None):
    d = session.doc()
    body = build.new_body(d, name or "Cylinder")
    sk = build.circle_sketch(body, float(diameter) / 2.0, "XY")
    d.recompute()
    build.pad(body, sk, float(height))
    d.recompute()
    if not body.Shape.isValid():
        raise RpcError(APP_ERROR, "cylinder shape invalid")
    return tree_get()


@method("feature.extrude")
def feature_extrude(sketchId, length=10.0, reversed=False, midplane=False, cut=False,
                    upToFaceRef=None):
    d, sk = _obj(sketchId)
    if sk.TypeId != "Sketcher::SketchObject":
        raise RpcError(APP_ERROR, "%r is not a sketch" % sketchId)
    body = sk.getParentGeoFeatureGroup()
    if body is None or body.TypeId != "PartDesign::Body":
        raise RpcError(APP_ERROR, "sketch is not inside a Body")
    up = _resolve_ref(d, body, upToFaceRef) if upToFaceRef else None
    if cut:
        build.pocket(body, sk, float(length), up_to=up)
    else:
        build.pad(body, sk, float(length), reversed_=reversed, midplane=midplane, up_to=up)
    d.recompute()
    if not body.Shape.isValid():
        raise RpcError(APP_ERROR, "extrude produced an invalid shape")
    return tree_get()


@method("feature.revolve")
def feature_revolve(sketchId, angle=360.0, axis="V", axisRef=None, reversed=False, cut=False):
    d, sk = _obj(sketchId)
    body = sk.getParentGeoFeatureGroup()
    if body is None or body.TypeId != "PartDesign::Body":
        raise RpcError(APP_ERROR, "sketch is not inside a Body")
    tid = "PartDesign::Groove" if cut else "PartDesign::Revolution"
    rev = body.newObject(tid, "Revolution")
    rev.Label = next_label(body, tid)
    rev.Profile = sk
    if axisRef:
        rev.ReferenceAxis = _resolve_ref(d, body, axisRef)
    else:
        rev.ReferenceAxis = (sk, ["V_Axis" if str(axis).upper().startswith("V") else "H_Axis"])
    rev.Angle = float(angle)
    if reversed:
        rev.Reversed = True
    sk.Visibility = False
    d.recompute()
    if not body.Shape.isValid():
        raise RpcError(APP_ERROR, "revolve produced an invalid shape")
    return tree_get()


@method("feature.sweep")
def feature_sweep(profileId, pathId=None, pathRef=None, cut=False):
    d, prof = _obj(profileId)
    body = prof.getParentGeoFeatureGroup()
    tid = "PartDesign::SubtractivePipe" if cut else "PartDesign::AdditivePipe"
    pipe = body.newObject(tid, "Sweep")
    pipe.Label = next_label(body, tid)
    pipe.Profile = prof
    if pathRef:
        obj, sub = _resolve_ref(d, body, pathRef)
        pipe.Spine = (obj, sub if isinstance(sub, list) else [sub])
    else:
        path = d.getObject(pathId) if pathId else None
        if path is None:
            raise RpcError(APP_ERROR, "sweep needs a path sketch or edge")
        pipe.Spine = (path, [])
        path.Visibility = False
    prof.Visibility = False
    d.recompute()
    if not body.Shape.isValid():
        raise RpcError(APP_ERROR, "sweep produced an invalid shape")
    return tree_get()


@method("feature.loft")
def feature_loft(sketchIds, cut=False):
    if not sketchIds or len(sketchIds) < 2:
        raise RpcError(APP_ERROR, "loft needs at least two profiles")
    d, first = _obj(sketchIds[0])
    body = first.getParentGeoFeatureGroup()
    tid = "PartDesign::SubtractiveLoft" if cut else "PartDesign::AdditiveLoft"
    loft = body.newObject(tid, "Loft")
    loft.Label = next_label(body, tid)
    loft.Profile = first
    loft.Sections = [d.getObject(s) for s in sketchIds[1:]]
    for s in sketchIds:
        d.getObject(s).Visibility = False
    d.recompute()
    if not body.Shape.isValid():
        raise RpcError(APP_ERROR, "loft produced an invalid shape")
    return tree_get()


@method("feature.draft")
def feature_draft(faces, angle=3.0, neutral=None, neutralRef=None):
    body = _require_body()
    tip = _solid_tip(body)
    dr = build.dress_up(body, "PartDesign::Draft", tip, faces, "Draft")
    dr.Angle = float(angle)
    if neutralRef:
        dr.NeutralPlane = _resolve_ref(body.Document, body, neutralRef)
    elif neutral:
        dr.NeutralPlane = (tip, [neutral])
    body.Document.recompute()
    if not body.Shape.isValid():
        raise RpcError(APP_ERROR, "draft produced an invalid shape (need a neutral face?)")
    return tree_get()


@method("feature.combine")
def feature_combine(op="Fuse", baseBodyId=None, toolBodyIds=None, keepTools=False):
    d = session.doc()
    bodies = [o for o in d.Objects if o.TypeId == "PartDesign::Body"]
    if len(bodies) < 2:
        raise RpcError(APP_ERROR, "combine needs two bodies")
    base = d.getObject(baseBodyId) if baseBodyId else session.active_body(d)
    if base is None or base.TypeId != "PartDesign::Body":
        raise RpcError(APP_ERROR, "pick a base body")
    if toolBodyIds:
        tools = [d.getObject(t) for t in toolBodyIds if d.getObject(t) is not base]
    else:
        tools = [b for b in bodies if b is not base]
    tools = [t for t in tools if t is not None]
    if not tools:
        raise RpcError(APP_ERROR, "pick at least one tool body")
    if keepTools:
        for t in tools:
            try:
                d.copyObject(t, True)
            except Exception:
                pass
    boolean = base.newObject("PartDesign::Boolean", "Boolean")
    boolean.Label = next_label(base, "PartDesign::Boolean")
    boolean.Type = op  # Fuse | Cut | Common
    boolean.Group = tools
    d.recompute()
    if not base.Shape.isValid():
        raise RpcError(APP_ERROR, "combine produced an invalid shape")
    return tree_get()


@method("pattern.circular")
def pattern_circular(count=4, angle=360.0, axisRef=None, axisPlane="XY"):
    body = _require_body()
    tip = _solid_tip(body)
    d = body.Document
    p = body.newObject("PartDesign::PolarPattern", "PolarPattern")
    p.Label = next_label(body, "PartDesign::PolarPattern")
    p.Originals = [tip]
    if axisRef:
        p.Axis = _resolve_ref(d, body, axisRef)
    else:
        role = {"XY": "Z_Axis", "XZ": "Y_Axis", "YZ": "X_Axis"}.get(axisPlane.upper(), "Z_Axis")
        for f in body.Origin.OriginFeatures:
            if getattr(f, "Role", None) == role:
                p.Axis = (f, [""])
                break
    p.Angle = float(angle)
    p.Occurrences = int(count)
    _apply_transformed(body, p)
    if not body.Shape.isValid():
        raise RpcError(APP_ERROR, "circular pattern produced an invalid shape")
    return tree_get()


@method("feature.fillet")
def feature_fillet(edges, radius=2.0):
    body = _require_body()
    tip = _solid_tip(body)
    f = build.dress_up(body, "PartDesign::Fillet", tip, edges, "Fillet")
    f.Radius = float(radius)
    body.Document.recompute()
    if not body.Shape.isValid():
        raise RpcError(APP_ERROR, "fillet produced an invalid shape (radius too large?)")
    return tree_get()


@method("feature.chamfer")
def feature_chamfer(edges, size=2.0):
    body = _require_body()
    tip = _solid_tip(body)
    f = build.dress_up(body, "PartDesign::Chamfer", tip, edges, "Chamfer")
    f.Size = float(size)
    body.Document.recompute()
    if not body.Shape.isValid():
        raise RpcError(APP_ERROR, "chamfer produced an invalid shape")
    return tree_get()


@method("feature.shell")
def feature_shell(faces, thickness=2.0):
    body = _require_body()
    tip = _solid_tip(body)
    f = build.dress_up(body, "PartDesign::Thickness", tip, faces, "Shell")
    f.Value = float(thickness)
    body.Document.recompute()
    if not body.Shape.isValid():
        raise RpcError(APP_ERROR, "shell produced an invalid shape")
    return tree_get()


@method("feature.hole")
def feature_hole(face, point, diameter=6.0, depth=10.0, throughAll=False,
                 cutType="None", cutDiameter=0.0, cutDepth=0.0, csAngle=90.0):
    """Hole on a planar face at a world-space point, with optional counterbore
    or countersink."""
    body = _require_body()
    tip = _solid_tip(body)
    d = body.Document
    sk = body.newObject("Sketcher::SketchObject", "Sketch")
    sk.Label = next_label(body, "Sketcher::SketchObject")
    sk.AttachmentSupport = [(tip, [face])]
    sk.MapMode = "FlatFace"
    d.recompute()
    import Part
    from FreeCAD import Vector
    wp = Vector(point[0], point[1], point[2])
    local = sk.Placement.inverse().multVec(wp)
    sk.addGeometry(Part.Circle(Vector(local.x, local.y, 0), Vector(0, 0, 1),
                               float(diameter) / 2.0), False)
    d.recompute()

    made = False
    try:
        h = body.newObject("PartDesign::Hole", "Hole")
        h.Label = next_label(body, "PartDesign::Hole")
        h.Profile = sk
        h.Diameter = float(diameter)
        if throughAll:
            h.DepthType = "ThroughAll"
        else:
            h.DepthType = "Dimension"
            h.Depth = float(depth)
        if cutType in ("Counterbore", "Countersink"):
            h.HoleCutType = cutType
            if float(cutDiameter) > 0:
                h.HoleCutDiameter = float(cutDiameter)
            if cutType == "Counterbore" and float(cutDepth) > 0:
                h.HoleCutDepth = float(cutDepth)
            if cutType == "Countersink":
                h.HoleCutCountersinkAngle = float(csAngle)
        sk.Visibility = False
        d.recompute()
        made = body.Shape.isValid()
    except Exception:
        made = False

    if not made:
        for o in list(body.Group):
            if o.TypeId == "PartDesign::Hole":
                try:
                    d.removeObject(o.Name)
                except Exception:
                    pass
        build.pocket(body, sk, float(depth), through_all=bool(throughAll))
        d.recompute()

    if not body.Shape.isValid():
        raise RpcError(APP_ERROR, "hole produced an invalid shape")
    return tree_get()


@method("feature.rib")
def feature_rib(sketchId, thickness=3.0, reversed=False, midplane=True):
    """Rib / web: an open profile sketch thickened symmetrically toward the solid.

    Prefers PartDesign::Rib; where the FreeCAD build lacks it, falls back to
    offsetting the open wire to a thin closed profile and padding it symmetric so
    the result fuses into the body."""
    d, sk = _obj(sketchId)
    body = sk.getParentGeoFeatureGroup()
    if body is None or body.TypeId != "PartDesign::Body":
        raise RpcError(APP_ERROR, "sketch is not inside a Body")

    try:
        rib = body.newObject("PartDesign::Rib", "Rib")
        rib.Label = next_label(body, "PartDesign::Rib")
        rib.Profile = sk
        for prop in ("Width", "Thickness"):
            if hasattr(rib, prop):
                setattr(rib, prop, float(thickness))
                break
        if midplane and hasattr(rib, "Midplane"):
            rib.Midplane = True
        if reversed and hasattr(rib, "Reversed"):
            rib.Reversed = True
        sk.Visibility = False
        d.recompute()
        if body.Shape.isValid():
            return tree_get()
    except Exception:
        pass

    for o in list(body.Group):
        if o.TypeId == "PartDesign::Rib":
            try:
                d.removeObject(o.Name)
            except Exception:
                pass

    import Part
    try:
        w = sk.Shape.Wires[0]
        span = w.BoundBox.DiagonalLength or 10.0
        off = w.makeOffset2D(float(thickness) / 2.0, openResult=True, intersection=True)
        Part.Face(off)  # validity check
    except Exception:
        raise RpcError(APP_ERROR,
                       "rib needs an open profile that spans between solid walls")
    helper = body.newObject("Sketcher::SketchObject", "Sketch")
    helper.Label = next_label(body, "Sketcher::SketchObject")
    helper.Placement = sk.Placement
    inv = sk.Placement.inverse()
    for e in off.Edges:
        try:
            a = inv.multVec(e.valueAt(e.FirstParameter))
            b = inv.multVec(e.valueAt(e.LastParameter))
            helper.addGeometry(
                Part.LineSegment(App.Vector(a.x, a.y, 0), App.Vector(b.x, b.y, 0)), False)
        except Exception:
            pass
    d.recompute()
    pad = build.pad(body, helper, max(span, float(thickness) * 4), midplane=True)
    try:
        pad.Label = next_label(body, "PartDesign::Pad").replace("Extrude", "Rib")
    except Exception:
        pass
    sk.Visibility = False
    helper.Visibility = False
    d.recompute()
    if not body.Shape.isValid():
        raise RpcError(APP_ERROR, "rib produced an invalid shape")
    return tree_get()


@method("body.copy")
def body_copy(id):
    """Duplicate a whole body (with its feature history) as an independent body."""
    d, o = _obj(id)
    if o.TypeId != "PartDesign::Body":
        raise RpcError(APP_ERROR, "select a body to copy")
    res = d.copyObject(o, True)
    copies = res if isinstance(res, (list, tuple)) else [res]
    new_body = next((c for c in copies if getattr(c, "TypeId", "") == "PartDesign::Body"), None)
    if new_body is not None:
        new_body.Label = o.Label + " copy"
    d.recompute()
    return tree_get()


@method("body.transform")
def body_transform(id, translate=(0, 0, 0), rotate=(0, 0, 0), relative=True):
    """Move / rotate a whole body. rotate = (rx, ry, rz) degrees."""
    d, o = _obj(id)
    from FreeCAD import Placement, Vector, Rotation
    delta = Placement(Vector(*translate),
                      Rotation(float(rotate[2]), float(rotate[1]), float(rotate[0])))
    o.Placement = o.Placement.multiply(delta) if relative else delta
    d.recompute()
    return tree_get()


def _apply_transformed(body, feat):
    """PartDesign Transformed features (LinearPattern / PolarPattern / Mirrored)
    only fold into the body once it is the Tip and has been recomputed with the
    dirty flag set - a plain d.recompute() leaves them inert headless."""
    d = body.Document
    body.Tip = feat
    try:
        feat.touch()
    except Exception:
        pass
    d.recompute(None, True, True)


@method("pattern.linear")
def pattern_linear(direction=(1, 0, 0), count=3, spacing=20.0, directionRef=None):
    body = _require_body()
    tip = _solid_tip(body)
    d = body.Document
    p = body.newObject("PartDesign::LinearPattern", "LinearPattern")
    p.Label = next_label(body, "PartDesign::LinearPattern")
    p.Originals = [tip]
    if directionRef:
        p.Direction = _resolve_ref(d, body, directionRef)
    else:
        role = {(1, 0, 0): "X_Axis", (0, 1, 0): "Y_Axis", (0, 0, 1): "Z_Axis"}.get(
            tuple(direction), "X_Axis")
        for g in body.Origin.OriginFeatures:
            if getattr(g, "Role", "") == role:
                p.Direction = (g, [""])
                break
    p.Length = float(spacing) * max(1, int(count) - 1)
    p.Occurrences = int(count)
    _apply_transformed(body, p)
    if not body.Shape.isValid():
        raise RpcError(APP_ERROR, "rectangular pattern produced an invalid shape")
    return tree_get()


def _resolve_ref(d, body, ref):
    """A geometry reference from the UI -> (obj, [subelement]) for
    MirrorPlane / ReferenceAxis / AttachmentSupport.

    ref = {"kind":"origin","role":"YZ_Plane"|"X_Axis"|...}
        | {"kind":"plane","id":"<construction plane/axis name>"}
        | {"kind":"face","bodyId":"...","sub":"Face3"}
        | {"kind":"edge","bodyId":"...","sub":"Edge7"}
    """
    k = ref.get("kind")
    if k == "origin":
        role = ref["role"]
        for g in body.Origin.OriginFeatures:
            if getattr(g, "Role", "") == role:
                return (g, [""])
        raise RpcError(APP_ERROR, "origin feature %r not found" % role)
    if k == "plane":
        o = d.getObject(ref["id"])
        if o is None:
            raise RpcError(APP_ERROR, "no datum %r" % ref.get("id"))
        return (o, [""])
    if k in ("face", "edge", "vertex"):
        src = d.getObject(ref["bodyId"])
        if src is None:
            raise RpcError(APP_ERROR, "no object %r" % ref.get("bodyId"))
        base = src.Tip if src.TypeId == "PartDesign::Body" else src
        return (base, [ref["sub"]])
    if k == "sketch":
        o = d.getObject(ref.get("id") or ref.get("sketchId"))
        if o is None:
            raise RpcError(APP_ERROR, "no sketch %r" % ref.get("id"))
        sub = ref.get("sub")
        if not sub:
            # prefer a construction line, else the first edge
            sub = "Edge1"
            try:
                for i, g in enumerate(o.Geometry):
                    if o.getConstruction(i) and g.TypeId == "Part::GeomLineSegment":
                        sub = "Edge%d" % (i + 1)
                        break
            except Exception:
                pass
        return (o, [sub])
    raise RpcError(APP_ERROR, "bad reference kind %r" % k)


@method("feature.mirror")
def feature_mirror(planeRef=None, plane="YZ"):
    body = _require_body()
    tip = _solid_tip(body)
    d = body.Document
    m = body.newObject("PartDesign::Mirrored", "Mirrored")
    m.Label = next_label(body, "PartDesign::Mirrored")
    m.Originals = [tip]
    if planeRef:
        m.MirrorPlane = _resolve_ref(d, body, planeRef)
    else:
        m.MirrorPlane = (build.origin_plane(body, plane), [""])
    _apply_transformed(body, m)
    if not body.Shape.isValid():
        raise RpcError(APP_ERROR, "mirror produced an invalid shape")
    return tree_get()


@method("datum.plane")
def datum_plane(baseRef=None, basePlane="XY", offset=10.0):
    body = _require_body()
    d = body.Document
    pl = body.newObject("PartDesign::Plane", "DatumPlane")
    pl.Label = next_label(body, "PartDesign::Plane")
    if baseRef:
        pl.AttachmentSupport = [_resolve_ref(d, body, baseRef)]
    else:
        pl.AttachmentSupport = [(build.origin_plane(body, basePlane), [""])]
    pl.MapMode = "FlatFace"
    from FreeCAD import Placement, Vector, Rotation
    pl.AttachmentOffset = Placement(Vector(0, 0, float(offset)), Rotation())
    session.set_datum_shown(pl.Name, True)  # new datums are shown, like Fusion
    pl.Visibility = True
    d.recompute()
    return tree_get()


@method("datum.axis")
def datum_axis(refs=None):
    """Construction axis from selection: one edge (axis of that curve), or two
    points/planes (line through / intersection). refs = [GeomRef, ...]."""
    body = _require_body()
    d = body.Document
    ax = body.newObject("PartDesign::Line", "DatumLine")
    ax.Label = next_label(body, "PartDesign::Line")
    resolved = [_resolve_ref(d, body, r) for r in (refs or []) if r]
    if resolved:
        try:
            ax.AttachmentSupport = resolved
            ax.MapMode = "TwoPointLine" if len(resolved) >= 2 else "AxisOfCurve"
        except Exception:
            ax.MapMode = "Deactivated"
    session.set_datum_shown(ax.Name, True)
    ax.Visibility = True
    d.recompute()
    return tree_get()


@method("datum.point")
def datum_point(ref=None):
    """Construction point on a vertex / edge midpoint / plane-line intersection."""
    body = _require_body()
    d = body.Document
    pt = body.newObject("PartDesign::Point", "DatumPoint")
    pt.Label = next_label(body, "PartDesign::Point")
    if ref:
        try:
            pt.AttachmentSupport = [_resolve_ref(d, body, ref)]
            wanted = "Vertex" if ref.get("kind") == "vertex" else "Center"
            for mode in (wanted, "Vertex", "Translate", "Center", "ObjectXY"):
                try:
                    pt.MapMode = mode
                    break
                except Exception:
                    continue
        except Exception:
            pt.MapMode = "Deactivated"
    session.set_datum_shown(pt.Name, True)
    pt.Visibility = True
    d.recompute()
    return tree_get()


@method("feature.suppress")
def feature_suppress(id, suppressed=True):
    """Toggle a feature's participation without deleting it."""
    d, o = _obj(id)
    ok = False
    for prop in ("Suppressed", "Suppress"):
        if hasattr(o, prop):
            setattr(o, prop, bool(suppressed))
            ok = True
            break
    if not ok:
        o.Visibility = not bool(suppressed)
    d.recompute()
    return tree_get()


def _frame(sk):
    """The sketch plane's world frame: origin + x/y/z unit axes (for the 2D UI)."""
    p = sk.Placement
    ox = p.multVec(App.Vector(1, 0, 0)).sub(p.Base)
    oy = p.multVec(App.Vector(0, 1, 0)).sub(p.Base)
    oz = p.multVec(App.Vector(0, 0, 1)).sub(p.Base)
    return {
        "origin": [p.Base.x, p.Base.y, p.Base.z],
        "x": [ox.x, ox.y, ox.z],
        "y": [oy.x, oy.y, oy.z],
        "z": [oz.x, oz.y, oz.z],
    }


def _plane_uv(fr, p):
    """World point -> sketch-plane (u, v) mm. fr = _frame() result (unit axes)."""
    ox, oy, oz = fr["origin"]
    xx, xy, xz = fr["x"]
    yx, yy, yz = fr["y"]
    dx, dy, dz = p[0] - ox, p[1] - oy, p[2] - oz
    return [dx * xx + dy * xy + dz * xz, dx * yx + dy * yy + dz * yz]


def _face_ref_geom(sk, fr):
    """Edges + vertices of the sketch's support face, projected into plane UV so
    the 2D editor can show them faint and snap a new point / centre / endpoint
    onto real model geometry."""
    try:
        sup = getattr(sk, "AttachmentSupport", None)
        if not sup:
            return None
        obj, subs = sup[0]
        sub = subs[0] if isinstance(subs, (list, tuple)) and subs else subs
        if not sub or not isinstance(sub, str):
            return None
        face = obj.Shape.getElement(sub)
        if face is None or face.ShapeType != "Face":
            return None
        polys, pts, seen = [], [], set()
        for e in face.Edges:
            try:
                uv = [_plane_uv(fr, (p.x, p.y, p.z)) for p in e.discretize(24)]
            except Exception:
                continue
            if len(uv) >= 2:
                polys.append(uv)
        for v in face.Vertexes:
            uv = _plane_uv(fr, (v.X, v.Y, v.Z))
            k = (round(uv[0], 4), round(uv[1], 4))
            if k not in seen:
                seen.add(k)
                pts.append(uv)
        if not polys and not pts:
            return None
        return {"polys": polys, "points": pts}
    except Exception:
        return None


@method("sketch.onPlane")
def sketch_on_plane(plane="XY"):
    """Create an empty sketch on an origin plane, ready for the 2D editor."""
    body = session.active_body()
    d = session.doc()
    if body is None:
        body = build.new_body(d)
    sk = body.newObject("Sketcher::SketchObject", "Sketch")
    sk.Label = next_label(body, "Sketcher::SketchObject")
    sk.AttachmentSupport = [(build.origin_plane(body, plane), "")]
    sk.MapMode = "FlatFace"
    sk.Visibility = True
    d.recompute()
    return {"sketchId": sk.Name, "bodyId": body.Name, "frame": _frame(sk),
            "refGeom": None}


@method("sketch.onFace")
def sketch_on_face(bodyId, face):
    d, body = _obj(bodyId)
    tip = _solid_tip(body)
    sk = body.newObject("Sketcher::SketchObject", "Sketch")
    sk.Label = next_label(body, "Sketcher::SketchObject")
    sk.AttachmentSupport = [(tip, [face])]
    sk.MapMode = "FlatFace"
    sk.Visibility = True
    d.recompute()
    fr = _frame(sk)
    return {"sketchId": sk.Name, "bodyId": body.Name, "frame": fr,
            "refGeom": _face_ref_geom(sk, fr)}


@method("sketch.on")
def sketch_on(ref):
    """Unified sketch-plane pick from the viewport.

    ref = {"kind": "origin", "role": "XY_Plane"}
        | {"kind": "plane",  "id": "<construction plane name>"}
        | {"kind": "face",   "bodyId": "...", "sub": "Face3"}
    """
    kind = ref.get("kind")
    d = session.doc()
    body = session.active_body(d) or build.new_body(d)
    if kind == "face":
        return sketch_on_face(ref["bodyId"], ref["sub"])
    sk = body.newObject("Sketcher::SketchObject", "Sketch")
    sk.Label = next_label(body, "Sketcher::SketchObject")
    if kind == "origin":
        role = ref.get("role", "XY_Plane")
        target = None
        for g in body.Origin.OriginFeatures:
            if getattr(g, "Role", "") == role:
                target = g
                break
        if target is None:
            raise RpcError(APP_ERROR, "origin plane %r not found" % role)
        sk.AttachmentSupport = [(target, "")]
    elif kind == "plane":
        pl = d.getObject(ref["id"])
        if pl is None:
            raise RpcError(APP_ERROR, "no plane %r" % ref.get("id"))
        sk.AttachmentSupport = [(pl, "")]
    else:
        raise RpcError(APP_ERROR, "bad sketch ref kind %r" % kind)
    sk.MapMode = "FlatFace"
    sk.Visibility = True
    d.recompute()
    return {"sketchId": sk.Name, "bodyId": body.Name, "frame": _frame(sk),
            "refGeom": None}


@method("sketch.reopen")
def sketch_reopen(sketchId):
    """Re-enter an existing sketch for editing. Returns its plane frame and its
    current geometry as editor entities."""
    d, sk = _obj(sketchId)
    if sk.TypeId != "Sketcher::SketchObject":
        raise RpcError(APP_ERROR, "%r is not a sketch" % sketchId)
    sk.Visibility = True
    ents = []
    for g in sk.Geometry:
        t = g.TypeId
        if t == "Part::GeomLineSegment":
            ents.append({"type": "line",
                         "a": [g.StartPoint.x, g.StartPoint.y],
                         "b": [g.EndPoint.x, g.EndPoint.y]})
        elif t == "Part::GeomCircle":
            ents.append({"type": "circle", "c": [g.Center.x, g.Center.y], "r": g.Radius})
        elif t == "Part::GeomArcOfCircle":
            ents.append({"type": "arc", "c": [g.Center.x, g.Center.y], "r": g.Radius,
                         "a0": g.FirstParameter, "a1": g.LastParameter})
    d.recompute()
    body = sk.getParentGeoFeatureGroup()
    fr = _frame(sk)
    return {"sketchId": sketchId, "bodyId": body.Name if body else None,
            "frame": fr, "entities": ents, "refGeom": _face_ref_geom(sk, fr)}


@method("sketch.clear")
def sketch_clear(sketchId):
    d, sk = _obj(sketchId)
    while sk.GeometryCount:
        sk.delGeometry(sk.GeometryCount - 1)
    d.recompute()
    return {"sketchId": sketchId, "count": 0}


def _add_sketch_elements(sk, elements):
    """Add editor entities to a sketch. Returns emap: emap[i] = [geoId, ...] for
    element i (a rect yields 4), so constraints can address them by element."""
    import Part
    from FreeCAD import Vector
    emap = []
    for el in elements or []:
        t = el.get("type")
        cons = bool(el.get("construction", False))
        ids = []
        if t == "line":
            a, b = el["a"], el["b"]
            ids.append(sk.addGeometry(
                Part.LineSegment(Vector(a[0], a[1], 0), Vector(b[0], b[1], 0)), cons))
        elif t == "circle":
            c = el["c"]
            ids.append(sk.addGeometry(
                Part.Circle(Vector(c[0], c[1], 0), Vector(0, 0, 1), float(el["r"])), cons))
        elif t == "arc":
            c = el["c"]
            circ = Part.Circle(Vector(c[0], c[1], 0), Vector(0, 0, 1), float(el["r"]))
            ids.append(sk.addGeometry(
                Part.ArcOfCircle(circ, float(el["a0"]), float(el["a1"])), cons))
        elif t == "rect":
            import Sketcher
            a, b = el["a"], el["b"]
            x0, y0, x1, y1 = a[0], a[1], b[0], b[1]
            corners = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
            for i in range(4):
                p0, p1 = corners[i], corners[(i + 1) % 4]
                ids.append(sk.addGeometry(
                    Part.LineSegment(Vector(p0[0], p0[1], 0), Vector(p1[0], p1[1], 0)), cons))
            # give it the standard rectangle constraint set so it behaves and
            # shows the expected symbols: corner coincidents + H/V on the sides
            g0, g1, g2, g3 = ids
            for cc in (
                ("Coincident", g0, 2, g1, 1),
                ("Coincident", g1, 2, g2, 1),
                ("Coincident", g2, 2, g3, 1),
                ("Coincident", g3, 2, g0, 1),
                ("Horizontal", g0), ("Horizontal", g2),
                ("Vertical", g1), ("Vertical", g3),
            ):
                try:
                    sk.addConstraint(Sketcher.Constraint(*cc))
                except Exception:
                    pass
        else:
            raise RpcError(APP_ERROR, "unknown sketch element %r" % t)
        emap.append(ids)
    return emap


_POINT_CONSTRAINTS = {"Coincident"}
_LINE_PAIR_CONSTRAINTS = {"Parallel", "Perpendicular", "Equal", "Tangent"}


def _apply_sketch_constraints(sk, constraints, emap):
    """constraints: [{type, refs:[{new:i, sub:0, pt:1} | {geo:<id>, pt:1}]}].
    `new` indexes into the elements just added (emap); `geo` is a raw geoId of
    pre-existing geometry."""
    import Sketcher

    def gid(ref):
        if "geo" in ref:
            return int(ref["geo"])
        return emap[int(ref.get("new", 0))][int(ref.get("sub", 0))]

    for c in constraints or []:
        ct = c.get("type")
        refs = c.get("refs", [])
        try:
            if ct in ("Distance", "Radius", "Diameter") and refs:
                v = float(c.get("value", 0) or 0)
                if v > 0:
                    sk.addConstraint(Sketcher.Constraint(ct, gid(refs[0]), v))
            elif ct in ("Horizontal", "Vertical") and refs:
                sk.addConstraint(Sketcher.Constraint(ct, gid(refs[0])))
            elif ct == "PointOnObject" and len(refs) >= 2:
                sk.addConstraint(Sketcher.Constraint(
                    "PointOnObject",
                    gid(refs[0]), int(refs[0].get("pt", 1)),
                    int(refs[1].get("geo", -1))))
            elif ct in _LINE_PAIR_CONSTRAINTS and len(refs) >= 2:
                sk.addConstraint(Sketcher.Constraint(ct, gid(refs[0]), gid(refs[1])))
            elif ct == "Coincident" and len(refs) >= 2:
                sk.addConstraint(Sketcher.Constraint(
                    "Coincident",
                    gid(refs[0]), int(refs[0].get("pt", 1)),
                    gid(refs[1]), int(refs[1].get("pt", 1))))
            elif ct == "Concentric" and len(refs) >= 2:
                sk.addConstraint(Sketcher.Constraint(
                    "Coincident", gid(refs[0]), 3, gid(refs[1]), 3))
        except Exception:
            pass


@method("sketch.finish")
def sketch_finish(sketchId, autoConstrain=True, elements=None, constraints=None):
    """Commit geometry + manual constraints and close the sketch in one call
    (editor sends everything at once so there is a single recompute)."""
    d, sk = _obj(sketchId)
    emap = _add_sketch_elements(sk, elements) if elements else []
    if constraints:
        _apply_sketch_constraints(sk, constraints, emap)
    if autoConstrain:
        _auto_constrain(sk)
    d.recompute()
    sk.Visibility = True
    closed = False
    try:
        wires = sk.Shape.Wires
        closed = any(w.isClosed() for w in wires) if wires else False
    except Exception:
        pass
    # Finishing a sketch resumes the build: never leave it sitting "after" the
    # rollback marker where it would render but read as not-yet-existing.
    body = sk.getParentGeoFeatureGroup()
    if body is not None and session.marker(body.Name):
        session.set_marker(body.Name, None)
        session.set_rolled_empty(body.Name, False)
    return {
        "sketchId": sketchId,
        "count": int(sk.GeometryCount),
        "constrained": bool(sk.FullyConstrained),
        "closed": closed,
    }


def _auto_constrain(sk):
    """Cheap auto-constraints: weld near-coincident endpoints, snap near-axis
    lines to horizontal / vertical. Enough to make hand-drawn sketches behave.
    Skips anything already constrained so it does not pile redundant constraints
    on geometry that arrived with its own (e.g. a rectangle)."""
    import Sketcher
    n = sk.GeometryCount
    welded = set()      # (geoId, posId) already in a Coincident
    hv = set()          # geoId already Horizontal or Vertical
    for c in sk.Constraints:
        if c.Type == "Coincident":
            welded.add((c.First, c.FirstPos))
            welded.add((c.Second, c.SecondPos))
        elif c.Type in ("Horizontal", "Vertical") and c.Second in (-2000, 0, None):
            hv.add(c.First)
    pts = []  # (geoId, posId, Vector)
    for gid in range(n):
        g = sk.Geometry[gid]
        if g.TypeId == "Part::GeomLineSegment":
            pts.append((gid, 1, g.StartPoint))
            pts.append((gid, 2, g.EndPoint))
    for i in range(len(pts)):
        for j in range(i + 1, len(pts)):
            g1, p1, v1 = pts[i]
            g2, p2, v2 = pts[j]
            if g1 == g2 or (g1, p1) in welded or (g2, p2) in welded:
                continue
            if v1.distanceToPoint(v2) < 0.05:
                try:
                    sk.addConstraint(Sketcher.Constraint("Coincident", g1, p1, g2, p2))
                    welded.add((g1, p1))
                    welded.add((g2, p2))
                except Exception:
                    pass
    for gid in range(n):
        g = sk.Geometry[gid]
        if g.TypeId != "Part::GeomLineSegment" or gid in hv:
            continue
        dx = abs(g.StartPoint.x - g.EndPoint.x)
        dy = abs(g.StartPoint.y - g.EndPoint.y)
        try:
            if dy < 0.05 and dx > 0.05:
                sk.addConstraint(Sketcher.Constraint("Horizontal", gid))
            elif dx < 0.05 and dy > 0.05:
                sk.addConstraint(Sketcher.Constraint("Vertical", gid))
        except Exception:
            pass


@method("sketch.addGeometry")
def sketch_add_geometry(sketchId, elements):
    """elements: [{type:'line', a:[x,y], b:[x,y]} | {type:'circle', c:[x,y], r} |
                  {type:'arc', c:[x,y], r, a0, a1} | {type:'rect', a, b}]
    coords in sketch plane mm."""
    d, sk = _obj(sketchId)
    _add_sketch_elements(sk, elements)
    d.recompute()
    return {"sketchId": sketchId, "count": int(sk.GeometryCount)}


# --------------------------------------------------------------------------- #
# read-side: scene + tree
# --------------------------------------------------------------------------- #

def _datum_dto(o):
    """A renderable description of a plane / axis / point datum."""
    p = o.Placement
    b = p.Base
    if o.TypeId in ("App::Plane", "PartDesign::Plane"):
        x = p.multVec(App.Vector(1, 0, 0)).sub(b)
        y = p.multVec(App.Vector(0, 1, 0)).sub(b)
        return {
            "id": o.Name, "label": o.Label, "kind": "plane",
            "origin": [b.x, b.y, b.z],
            "x": [x.x, x.y, x.z], "y": [y.x, y.y, y.z],
            "size": 40.0,
        }
    if o.TypeId in ("App::Line", "PartDesign::Line"):
        d = p.multVec(App.Vector(1, 0, 0)).sub(b)
        role = getattr(o, "Role", "") or o.Label
        return {
            "id": o.Name, "label": o.Label, "kind": "axis",
            "origin": [b.x, b.y, b.z], "dir": [d.x, d.y, d.z], "length": 60.0,
            "role": role,
        }
    if o.TypeId in ("App::Point", "PartDesign::Point"):
        return {"id": o.Name, "label": o.Label, "kind": "point", "origin": [b.x, b.y, b.z]}
    return None


def _mesh_feature_buffer(o):
    """Render buffer straight from a Mesh::Feature (imported STL/OBJ/3MF)."""
    try:
        m = o.Mesh
        pts = m.Points
        positions = []
        for p in pts:
            positions.extend((p.x, p.y, p.z))
        indices = []
        for f in m.Facets:
            indices.extend(f.PointIndices)
        # flat-ish normals via computeVertexNormals fallback on the client
        normals = [0.0] * len(positions)
        bb = m.BoundBox
        return {
            "positions": positions, "normals": normals, "indices": indices,
            "faceGroups": [{"face": 0, "start": 0, "count": len(indices)}],
            "edges": [],
            "bbox": {"min": [bb.XMin, bb.YMin, bb.ZMin],
                     "max": [bb.XMax, bb.YMax, bb.ZMax]},
            "needsNormals": True,
        }
    except Exception:
        return None


_ORIGIN_ROLES = ("XY_Plane", "XZ_Plane", "YZ_Plane")


_WORLD_PLANES = [
    {"id": "XY_Plane", "label": "XY plane", "kind": "plane", "ptype": "origin",
     "origin": [0, 0, 0], "x": [1, 0, 0], "y": [0, 1, 0], "size": 40.0, "role": "XY_Plane"},
    {"id": "XZ_Plane", "label": "XZ plane", "kind": "plane", "ptype": "origin",
     "origin": [0, 0, 0], "x": [1, 0, 0], "y": [0, 0, 1], "size": 40.0, "role": "XZ_Plane"},
    {"id": "YZ_Plane", "label": "YZ plane", "kind": "plane", "ptype": "origin",
     "origin": [0, 0, 0], "x": [0, 1, 0], "y": [0, 0, 1], "size": 40.0, "role": "YZ_Plane"},
]


def _pick_planes(d):
    """Every plane a sketch can attach to - the 3 world origin planes (always)
    plus any construction planes - for the in-viewport sketch-plane picker."""
    out = [dict(p) for p in _WORLD_PLANES]
    for o in d.Objects:
        if o.TypeId in ("App::Plane", "PartDesign::Plane"):
            fr = _datum_dto(o)
            if fr:
                fr["ptype"] = "construction"
                out.append(fr)
    return out


def _suppressed_names(d):
    """Names of features AFTER the rollback marker in any Body - not part of the
    model at this point in history, so they must not render or be toggled on.
    Driven by the session marker, not body.Tip."""
    out = set()
    for b in d.Objects:
        if b.TypeId != "PartDesign::Body":
            continue
        mk = session.marker(b.Name)
        if not mk:
            continue
        feats = [f for f in b.Group if f.TypeId != "App::Origin"]
        past = False
        for f in feats:
            if past:
                out.add(f.Name)
            if f.Name == mk:
                past = True
    return out


@method("scene.get")
def scene_get():
    """Render buffers for visible bodies, sketches, and datum geometry."""
    d = session.doc()
    _ensure_starter_body(d)
    meshes, sketches, datums = [], [], []

    # scene.get returns EVERYTHING with a `visible` hint; the shell owns
    # show/hide as pure view state and never round-trips the engine for it.
    suppressed = _suppressed_names(d)
    for o in d.Objects:
        if o.Name in suppressed:
            continue
        tid = o.TypeId
        if tid in ("PartDesign::Body", "App::Link", "Part::Feature", "Mesh::Feature",
                   "Part::FeaturePython"):
            if tid == "PartDesign::Body" and session.is_rolled_empty(o.Name):
                continue
            if tid == "Mesh::Feature":
                buf = _mesh_feature_buffer(o)
                if buf is None:
                    continue
            else:
                shape = getattr(o, "Shape", None)
                if shape is None or shape.isNull():
                    continue
                sig = _shape_sig(shape)
                cached = _TESS_CACHE.get(o.Name)
                if sig is not None and cached is not None and cached[0] == sig:
                    buf = dict(cached[1])  # reuse the heavy positions/normals lists
                else:
                    buf = tessellate_shape(shape)
                    if sig is not None:
                        _TESS_CACHE[o.Name] = (sig, buf)
                buf["sig"] = sig
            buf["id"] = o.Name
            buf["label"] = o.Label
            buf["visible"] = bool(getattr(o, "Visibility", True))
            if tid == "App::Link":
                buf["component"] = True
            col = session.body_color(o.Name)
            if col:
                buf["color"] = col
            meshes.append(buf)
        elif tid == "Sketcher::SketchObject":
            polys = []
            try:
                for e in o.Shape.Edges:
                    pts = []
                    for p in e.discretize(24):
                        pts.extend((p.x, p.y, p.z))
                    if len(pts) >= 6:
                        polys.append(pts)
            except Exception:
                pass
            sketches.append({"id": o.Name, "label": o.Label, "polys": polys,
                             "visible": bool(getattr(o, "Visibility", False))})
        elif tid in ("App::Plane", "App::Line", "App::Point",
                     "PartDesign::Plane", "PartDesign::Line", "PartDesign::Point"):
            dto = _datum_dto(o)
            if dto:
                dto["visible"] = session.datum_shown(o.Name)
                datums.append(dto)

    # inserted 2D canvases, resolved to a world frame on their plane
    canv = []
    _ORIGIN_FRAMES = {
        "XY": {"origin": [0, 0, 0], "x": [1, 0, 0], "y": [0, 1, 0]},
        "XZ": {"origin": [0, 0, 0], "x": [1, 0, 0], "y": [0, 0, 1]},
        "YZ": {"origin": [0, 0, 0], "x": [0, 1, 0], "y": [0, 0, 1]},
    }
    for c in session.canvases():
        fr = _ORIGIN_FRAMES.get(c["plane"], _ORIGIN_FRAMES["XY"])
        canv.append({**c, "frame": fr})

    return {
        "meshes": meshes,
        "sketches": sketches,
        "datums": datums,
        "pickPlanes": _pick_planes(d),
        "canvases": canv,
    }


# --------------------------------------------------------------------------- #
# inserted 2D canvases (image underlays)
# --------------------------------------------------------------------------- #

@method("canvas.insert")
def canvas_insert(plane="XY", widthMm=100.0, heightMm=100.0, image=None):
    c = session.add_canvas(plane, widthMm, heightMm, image)
    return c


@method("canvas.calibrate")
def canvas_calibrate(id, realMm, measuredMm):
    """User draws a line over a known feature: it currently reads `measuredMm`
    in canvas units but should be `realMm`. Rescale the canvas by the ratio."""
    c = session.update_canvas(id)
    if c is None:
        raise RpcError(APP_ERROR, "no canvas %r" % id)
    if float(measuredMm) <= 0:
        raise RpcError(APP_ERROR, "measured length must be > 0")
    ratio = float(realMm) / float(measuredMm)
    return session.update_canvas(id, w=c["w"] * ratio, h=c["h"] * ratio)


@method("canvas.update")
def canvas_update(id, w=None, h=None, offset=None, rot=None):
    c = session.update_canvas(id, w=w, h=h, offset=offset, rot=rot)
    if c is None:
        raise RpcError(APP_ERROR, "no canvas %r" % id)
    return c


@method("canvas.delete")
def canvas_delete(id):
    session.remove_canvas(id)
    return {"deleted": id}


# --------------------------------------------------------------------------- #
# named parameters + unit-aware expression evaluation for dimension inputs
# --------------------------------------------------------------------------- #

import re as _re


def _params_payload():
    out = []
    for name, e in session.params().items():
        try:
            v = _expr.evaluate(e, "length", session.params())
        except Exception:
            v = None
        out.append({"name": name, "expr": e, "value": v})
    return {"params": out}


@method("params.list")
def params_list():
    return _params_payload()


@method("params.set")
def params_set(name, expr):
    if not _re.match(r"^[A-Za-z_]\w*$", str(name or "")):
        raise RpcError(APP_ERROR, "parameter name must be a plain identifier")
    try:
        _expr.evaluate(str(expr), "length", {**session.params(), str(name): "0"})
    except Exception as ex:
        raise RpcError(APP_ERROR, "bad expression: %s" % ex)
    session.set_param(str(name), str(expr))
    _reapply_feature_exprs()
    out = _params_payload()
    out["rebuilt"] = True
    return out


@method("params.delete")
def params_delete(name):
    session.del_param(str(name))
    _reapply_feature_exprs()
    out = _params_payload()
    out["rebuilt"] = True
    return out


@method("expr.eval")
def expr_eval(text, kind="length"):
    """Evaluate a dimension expression. kind='length' -> mm, 'angle' -> deg."""
    try:
        value = _expr.evaluate(str(text), kind, session.params())
    except Exception as ex:
        raise RpcError(APP_ERROR, str(ex))
    return {"value": value, "expr": str(text), "kind": kind}


# main driven dimension per feature type: the one the UI edits by expression
_PRIMARY_DIM = {
    "PartDesign::Pad": "Length",
    "PartDesign::Pocket": "Length",
    "PartDesign::Revolution": "Angle",
    "PartDesign::Groove": "Angle",
    "PartDesign::Hole": "Depth",
    "PartDesign::Fillet": "Radius",
    "PartDesign::Chamfer": "Size",
    "PartDesign::Thickness": "Value",
    "PartDesign::LinearPattern": "Length",
    "PartDesign::PolarPattern": "Angle",
}
_ANGLE_PROPS = {"Angle"}


def _prop_value(o, prop):
    q = getattr(o, prop, None)
    if q is None:
        return None
    return float(q.Value) if hasattr(q, "Value") else float(q)


def _reapply_feature_exprs():
    """Re-evaluate every stored feature expression against the current params and
    push the value back onto the feature; recompute once."""
    d = session.doc(create=False)
    if d is None:
        return
    touched = False
    for fname, props in session.all_feature_exprs().items():
        o = d.getObject(fname)
        if o is None:
            continue
        for prop, e in props.items():
            if not hasattr(o, prop):
                continue
            kind = "angle" if prop in _ANGLE_PROPS else "length"
            try:
                setattr(o, prop, _expr.evaluate(str(e), kind, session.params()))
                touched = True
            except Exception:
                pass
    if touched:
        d.recompute()


@method("feature.primaryDim")
def feature_primary_dim(id):
    """The feature's main editable dimension: prop, current value, stored expr."""
    d, o = _obj(id)
    prop = _PRIMARY_DIM.get(o.TypeId)
    if prop is None or not hasattr(o, prop):
        return {"id": id, "prop": None}
    return {
        "id": id,
        "prop": prop,
        "value": _prop_value(o, prop),
        "expr": session.feature_expr(id, prop),
        "kind": "angle" if prop in _ANGLE_PROPS else "length",
    }


@method("feature.exprs")
def feature_exprs_get(id):
    return {"id": id, "exprs": session.feature_exprs(id)}


@method("feature.setExpr")
def feature_set_expr(id, prop, expr):
    """Set a feature property from an expression and remember the expression."""
    d, o = _obj(id)
    if not hasattr(o, prop):
        raise RpcError(APP_ERROR, "%s has no property %r" % (o.Label, prop))
    kind = "angle" if prop in _ANGLE_PROPS else "length"
    text = str(expr).strip()
    try:
        val = _expr.evaluate(text, kind, session.params())
    except Exception as ex:
        raise RpcError(APP_ERROR, str(ex))
    setattr(o, prop, val)
    # store only if it is a real expression (not just a plain number)
    try:
        float(text)
        session.set_feature_expr(id, prop, None)
    except ValueError:
        session.set_feature_expr(id, prop, text)
    d.recompute()
    return tree_get()


@method("tree.get")
def tree_get():
    """Feature tree for the timeline + browser."""
    d = session.doc()
    _ensure_starter_body(d)
    bodies = []
    if d is not None:
        # a create/edit advances body.Tip past where it was at rollback; when that
        # happens the marker follows the tip forward (build resumes from here)
        for o in d.Objects:
            if o.TypeId != "PartDesign::Body":
                continue
            mk = session.marker(o.Name)
            tip = getattr(o, "Tip", None)
            if mk and tip is not None and tip.Name != session.marker_tip(o.Name):
                names = [f.Name for f in o.Group if f.TypeId != "App::Origin"]
                if tip.Name in names:
                    session.set_marker(o.Name, None if tip.Name == names[-1] else tip.Name,
                                       tip_at_rollback=tip.Name)
                    session.set_rolled_empty(o.Name, False)

        suppressed = _suppressed_names(d)
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
                    "afterTip": f.Name in suppressed,
                    "suppressed": bool(getattr(f, "Suppressed", getattr(f, "Suppress", False))),
                    "visible": bool(getattr(f, "Visibility", False)) and f.Name not in suppressed,
                    "error": bool(getattr(f, "State", None) and "Error" in f.State),
                })
            origin = []
            try:
                for g in o.Origin.OriginFeatures:
                    k = ("plane" if "Plane" in g.TypeId
                         else "axis" if "Line" in g.TypeId
                         else "point")
                    origin.append({
                        "id": g.Name,
                        "label": g.Label,
                        "role": getattr(g, "Role", ""),
                        "kind": k,
                        "visible": session.datum_shown(g.Name),
                    })
            except Exception:
                pass
            bodies.append({
                "id": o.Name,
                "label": o.Label,
                "visible": bool(getattr(o, "Visibility", True)),
                "features": feats,
                "origin": origin,
                "marker": session.marker(o.Name),
            })
    return {
        "bodies": bodies,
        "path": session.path(),
        "canUndo": d is not None and int(getattr(d, "UndoCount", 0)) > 0,
        "canRedo": d is not None and int(getattr(d, "RedoCount", 0)) > 0,
    }


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


_DATUM_TIDS = ("App::Plane", "App::Line", "App::Point",
               "PartDesign::Plane", "PartDesign::Line", "PartDesign::Point")


@method("object.setVisibility")
def object_set_visibility(id, visible):
    d, o = _obj(id)
    visible = bool(visible)
    if o.TypeId in _DATUM_TIDS:
        session.set_datum_shown(o.Name, visible)
    o.Visibility = visible
    d.recompute()
    return {"id": id, "visible": visible}


@method("visibility.setGroup")
def visibility_set_group(group, visible):
    """group: 'bodies' | 'sketches' | 'origin' (origin geometry only) |
    'construction' (user datum planes/axes/points)."""
    d = session.doc(create=False)
    if d is None:
        return {"group": group, "visible": bool(visible)}
    visible = bool(visible)
    for o in d.Objects:
        tid = o.TypeId
        if group == "bodies" and tid == "PartDesign::Body":
            o.Visibility = visible
        elif group == "sketches" and tid == "Sketcher::SketchObject":
            o.Visibility = visible
        elif group == "origin" and tid in ("App::Plane", "App::Line", "App::Point"):
            session.set_datum_shown(o.Name, visible)
            o.Visibility = visible
        elif group == "construction" and tid in (
            "PartDesign::Plane", "PartDesign::Line", "PartDesign::Point"
        ):
            session.set_datum_shown(o.Name, visible)
            o.Visibility = visible
    d.recompute()
    return {"group": group, "visible": visible}


@method("history.undo")
def history_undo():
    d = session.doc(create=False)
    can = d is not None and int(getattr(d, "UndoCount", 0)) > 0
    if can:
        d.undo()
        d.recompute()
        _TESS_CACHE.clear()
    out = tree_get()
    out["undone"] = bool(can)
    out["canUndo"] = d is not None and int(getattr(d, "UndoCount", 0)) > 0
    out["canRedo"] = d is not None and int(getattr(d, "RedoCount", 0)) > 0
    return out


@method("history.redo")
def history_redo():
    d = session.doc(create=False)
    can = d is not None and int(getattr(d, "RedoCount", 0)) > 0
    if can:
        d.redo()
        d.recompute()
        _TESS_CACHE.clear()
    out = tree_get()
    out["redone"] = bool(can)
    out["canUndo"] = d is not None and int(getattr(d, "UndoCount", 0)) > 0
    out["canRedo"] = d is not None and int(getattr(d, "RedoCount", 0)) > 0
    return out


@method("history.rollTo")
def history_roll_to(bodyId, featureId=None):
    """Move the rollback marker to just after `featureId` (None => newest).

    The Body Tip snaps to the last SOLID feature at or before the marker so the
    displayed shape matches that moment; a sketch/datum sitting exactly at the
    marker is shown as an overlay.
    """
    d, body = _obj(bodyId)
    if body.TypeId != "PartDesign::Body":
        raise RpcError(APP_ERROR, "%r is not a Body" % bodyId)
    feats = [f for f in body.Group if f.TypeId != "App::Origin"]
    if not feats:
        return {"tip": None, "marker": None}

    marker_idx = len(feats) - 1 if featureId is None else next(
        (i for i, f in enumerate(feats) if f.Name == featureId), len(feats) - 1)
    marker = feats[marker_idx]

    at_end = marker_idx == len(feats) - 1

    last_solid = None
    for f in feats[: marker_idx + 1]:
        if _kind(f.TypeId) == "solid":
            last_solid = f

    if last_solid is not None:
        body.Tip = last_solid
        session.set_rolled_empty(body.Name, False)
    else:
        session.set_rolled_empty(body.Name, not at_end)

    session.set_marker(
        body.Name,
        None if at_end else marker.Name,
        tip_at_rollback=body.Tip.Name if body.Tip else None,
    )

    for f in feats:
        if _kind(f.TypeId) in ("sketch", "datum"):
            vis = f is marker and not at_end
            f.Visibility = vis
            if _kind(f.TypeId) == "datum":
                session.set_datum_shown(f.Name, vis)
    d.recompute()
    return {
        "tip": last_solid.Name if last_solid else None,
        "marker": None if at_end else marker.Name,
        "hasSolid": last_solid is not None,
    }


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

def _sidecar_json(fcstd_path):
    return fcstd_path + ".gwtcad.json"


def _write_sidecar(path):
    import json
    try:
        with open(_sidecar_json(path), "w") as f:
            json.dump(session.dump_state(), f)
    except Exception:
        pass


@method("document.saveAs")
def document_save_as(path):
    d = session.doc(create=False)
    if d is None:
        raise RpcError(APP_ERROR, "no document")
    path = os.path.abspath(os.path.expanduser(path))
    d.saveAs(path)
    session.set_path(path)
    _write_sidecar(path)
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
    _write_sidecar(p)
    return {"path": p}


@method("document.open")
def document_open(path):
    import json
    path = os.path.abspath(os.path.expanduser(path))
    if not os.path.isfile(path):
        raise RpcError(APP_ERROR, "no such file: %s" % path)
    _TESS_CACHE.clear()
    d = session.open_path(path)
    try:
        sj = _sidecar_json(path)
        if os.path.isfile(sj):
            with open(sj) as f:
                session.load_state(json.load(f))
    except Exception:
        pass
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

# --------------------------------------------------------------------------- #
# drawings (TechDraw, headless)
# --------------------------------------------------------------------------- #

@method("measure.compute")
def measure_compute(refs):
    """refs: [{bodyId, sub}]  where sub is 'Face3' / 'Edge7' / 'Vertex2'.

    1 edge -> length; 1 face -> area + perimeter; 2 subs -> min distance
    (+ angle for two planar faces or two straight edges).
    """
    d = session.doc(create=False)
    if d is None:
        raise RpcError(APP_ERROR, "no document")
    def _resolve(shp, name):
        letters = "".join(c for c in name if c.isalpha())
        num = int("".join(c for c in name if c.isdigit()))
        coll = {"Face": shp.Faces, "Edge": shp.Edges, "Vertex": shp.Vertexes}.get(letters)
        if coll is None or num < 1 or num > len(coll):
            raise RpcError(APP_ERROR, "cannot resolve %r" % name)
        return coll[num - 1]

    subs = []
    for r in refs:
        o = d.getObject(r["bodyId"])
        if o is None:
            raise RpcError(APP_ERROR, "no object %r" % r["bodyId"])
        subs.append((r["sub"], _resolve(o.Shape, r["sub"])))

    out = {"refs": [r["sub"] for r in refs]}
    if len(subs) == 1:
        name, s = subs[0]
        if name.startswith("Edge"):
            out["kind"] = "length"
            out["length"] = round(s.Length, 4)
        elif name.startswith("Face"):
            out["kind"] = "area"
            out["area"] = round(s.Area, 4)
            out["perimeter"] = round(sum(e.Length for e in s.Edges), 4)
        elif name.startswith("Vertex"):
            p = s.Point
            out["kind"] = "point"
            out["point"] = [round(p.x, 4), round(p.y, 4), round(p.z, 4)]
        return out

    (n1, s1), (n2, s2) = subs[0], subs[1]
    try:
        dist, pts, _ = s1.distToShape(s2)
        out["kind"] = "distance"
        out["distance"] = round(dist, 4)
        if pts:
            a, b = pts[0]
            out["from"] = [round(a.x, 4), round(a.y, 4), round(a.z, 4)]
            out["to"] = [round(b.x, 4), round(b.y, 4), round(b.z, 4)]
    except Exception as e:
        raise RpcError(APP_ERROR, "distance failed: %s" % e)

    import math

    def _dir(sub, nm):
        if nm.startswith("Edge") and sub.Curve.TypeId == "Part::GeomLine":
            v = sub.Curve.Direction
            return App.Vector(v.x, v.y, v.z)
        if nm.startswith("Face"):
            try:
                return sub.normalAt(0.5, 0.5)
            except Exception:
                return None
        return None

    d1, d2 = _dir(s1, n1), _dir(s2, n2)
    if d1 and d2 and d1.Length > 0 and d2.Length > 0:
        cosang = max(-1.0, min(1.0, d1.dot(d2) / (d1.Length * d2.Length)))
        out["angle"] = round(math.degrees(math.acos(abs(cosang))), 3)
    return out


@method("drawing.addView")
def drawing_add_view(bodyId=None, direction="front", scale=1.0):
    d = session.doc()
    src = None
    if bodyId:
        src = d.getObject(bodyId)
    if src is None:
        src = session.active_body(d)
    if src is None:
        raise RpcError(APP_ERROR, "no body to project")
    view = _drawing.make_view(d, src, direction, float(scale))
    return view


@method("drawing.list")
def drawing_list():
    d = session.doc(create=False)
    views = []
    if d is not None:
        for o in d.Objects:
            if o.TypeId == "TechDraw::DrawViewPart":
                views.append({"id": o.Name, "label": o.Label,
                              "direction": getattr(o, "_gwt_dir", "front")})
    return {"views": views}


# --------------------------------------------------------------------------- #
# assemblies (built-in Assembly workbench, headless)
# --------------------------------------------------------------------------- #

@method("assembly.create")
def assembly_create():
    d = session.doc()
    asm = _assembly.get_or_make_assembly(d)
    return {"assembly": asm.Name}


@method("assembly.addComponent")
def assembly_add_component(path, name=None):
    d = session.doc()
    link = _assembly.add_component(d, path, name)
    return _assembly.tree(d)


@method("assembly.setPlacement")
def assembly_set_placement(componentId, base=(0, 0, 0), axis=(0, 0, 1), angle=0.0):
    d = session.doc()
    _assembly.set_placement(d, componentId, base, axis, float(angle))
    return _assembly.tree(d)


@method("assembly.ground")
def assembly_ground(componentId):
    d = session.doc()
    r = _assembly.ground(d, componentId)
    r.update(_assembly.tree(d))
    return r


@method("assembly.addJoint")
def assembly_add_joint(jointType, comp1, sub1="", comp2="", sub2="", params=None):
    d = session.doc()
    r = _assembly.add_joint(d, jointType, comp1, sub1, comp2, sub2, **(params or {}))
    r.update(_assembly.tree(d))
    return r


@method("assembly.tree")
def assembly_tree():
    d = session.doc(create=False)
    if d is None:
        return {"assembly": None, "components": [], "joints": []}
    return _assembly.tree(d)


_BREP_EXT = {".step", ".stp", ".iges", ".igs", ".brep", ".brp"}
_MESH_EXT = {".stl", ".obj", ".3mf", ".ply", ".off"}
_PALETTE = [
    [0.62, 0.68, 0.75], [0.80, 0.55, 0.45], [0.55, 0.72, 0.55],
    [0.75, 0.70, 0.45], [0.60, 0.55, 0.75], [0.45, 0.70, 0.72],
]


@method("body.split")
def body_split(bodyId, planeRef):
    """Cut a solid with a plane (surface split). Produces one Part::Feature per
    resulting piece; the source body is hidden."""
    d, src = _obj(bodyId)
    shape = getattr(src, "Shape", None)
    if shape is None or shape.isNull():
        raise RpcError(APP_ERROR, "%r has no solid" % bodyId)

    # build a large plane from the reference's placement / face
    resolve_body = src if src.TypeId == "PartDesign::Body" else session.active_body(d)
    ref_obj, subs = _resolve_ref(d, resolve_body, planeRef)
    if subs and subs[0] and hasattr(ref_obj, "Shape"):
        face = ref_obj.Shape.getElement(subs[0])
        origin = face.CenterOfMass
        normal = face.normalAt(0.5, 0.5)
    else:
        p = ref_obj.Placement
        origin = p.Base
        normal = p.Rotation.multVec(App.Vector(0, 0, 1))

    bb = shape.BoundBox
    big = max(bb.XLength, bb.YLength, bb.ZLength) * 3 + 50
    plane = Part.Plane(App.Vector(origin), App.Vector(normal)).toShape(-big, big, -big, big)

    import BOPTools.SplitAPI as SplitAPI
    result = SplitAPI.slice(shape, [plane], "Split", 1e-6)
    solids = result.Solids
    if len(solids) < 2:
        raise RpcError(APP_ERROR, "the plane did not divide the body")
    src.Visibility = False
    made = []
    for i, s in enumerate(solids):
        nf = d.addObject("Part::Feature", "%s_part%d" % (src.Label, i + 1))
        nf.Shape = s
        session.set_body_color(nf.Name, _PALETTE[i % len(_PALETTE)])
        made.append(nf.Name)
    d.recompute()
    return tree_get()


@method("sheet.baseFlange")
def sheet_base_flange(sketchId, thickness=1.5):
    """Base flange from a sketch profile using the SheetMetal addon if present,
    otherwise a plain pad of that thickness (still a valid sheet blank)."""
    d, sk = _obj(sketchId)
    body = sk.getParentGeoFeatureGroup()
    if body is None:
        raise RpcError(APP_ERROR, "sketch is not in a body")
    try:
        import SheetMetalCmd  # noqa: F401
        # the addon's base bend feature
        f = body.newObject("Part::FeaturePython", "BaseFlange")
        import SheetMetalBaseCmd
        SheetMetalBaseCmd.SMBaseBend(f, sk)
        f.thickness = float(thickness)
        sk.Visibility = False
        d.recompute()
        if body.Shape.isValid():
            return tree_get()
    except Exception:
        pass
    # fallback: pad
    build.pad(body, sk, float(thickness))
    d.recompute()
    return tree_get()


@method("io.importStep")  # kept for back-compat
def io_import_step(path):
    return io_import_model(path)


@method("io.importModel")
def io_import_model(path):
    """Import STEP/IGES/BREP (as solids) or STL/OBJ/3MF/PLY/OFF (as meshes).

    Multi-body files land as separate objects. Each imported object gets a
    distinct palette colour (file colours are not reliably readable headless).
    """
    d = session.doc()
    path = os.path.abspath(os.path.expanduser(path))
    if not os.path.isfile(path):
        raise RpcError(APP_ERROR, "no such file: %s" % path)
    ext = os.path.splitext(path)[1].lower()
    before = set(o.Name for o in d.Objects)

    if ext in _BREP_EXT:
        import Import
        Import.insert(path, d.Name)
    elif ext in _MESH_EXT:
        import Mesh
        Mesh.insert(path, d.Name)
    else:
        raise RpcError(APP_ERROR, "unsupported import format %r" % ext)

    d.recompute()
    stem = os.path.splitext(os.path.basename(path))[0]
    new = [o for o in d.Objects if o.Name not in before]
    for i, o in enumerate(new):
        session.set_body_color(o.Name, _PALETTE[i % len(_PALETTE)])
        try:
            o.Label = stem if len(new) == 1 else "%s %d" % (stem, i + 1)
        except Exception:
            pass
    return {"path": path, "imported": [o.Name for o in new], "count": len(new)}


def _export_targets(d):
    return [o for o in d.Objects
            if o.TypeId in ("PartDesign::Body", "Part::Feature", "Mesh::Feature",
                            "App::Link", "Part::FeaturePython")]


@method("io.export")
def io_export(path):
    """Export by extension: STEP/IGES/BREP (B-rep) or STL/OBJ/3MF/PLY (mesh)."""
    d = session.doc(create=False)
    if d is None:
        raise RpcError(APP_ERROR, "no document")
    path = os.path.abspath(os.path.expanduser(path))
    ext = os.path.splitext(path)[1].lower()
    objs = _export_targets(d)
    if not objs:
        raise RpcError(APP_ERROR, "nothing to export")
    if ext in _BREP_EXT:
        Part.export(objs, path)
    elif ext in _MESH_EXT:
        import Mesh
        Mesh.export(objs, path)
    else:
        raise RpcError(APP_ERROR, "unsupported export format %r" % ext)
    return {"path": path, "objects": len(objs)}


@method("io.exportStep")
def io_export_step(path):
    return io_export(path if path.lower().endswith((".step", ".stp")) else path + ".step")


@method("io.exportStl")
def io_export_stl(path):
    return io_export(path if path.lower().endswith(".stl") else path + ".stl")


# --------------------------------------------------------------------------- #
# scale / unit conversion
# --------------------------------------------------------------------------- #

_UNIT_MM = {"mm": 1.0, "cm": 10.0, "m": 1000.0, "in": 25.4, "ft": 304.8, "thou": 0.0254}


@method("body.scale")
def body_scale(id, factor):
    """Non-parametric uniform scale about the object's origin. Works on imports
    (Part::Feature / Mesh::Feature) and PartDesign bodies (baked to a
    Part::Feature so the scale sticks)."""
    d, o = _obj(id)
    f = float(factor)
    if f <= 0:
        raise RpcError(APP_ERROR, "scale factor must be > 0")
    from FreeCAD import Matrix
    m = Matrix()
    m.scale(f, f, f)

    if o.TypeId == "Mesh::Feature":
        mesh = o.Mesh.copy()
        mesh.transform(m)
        o.Mesh = mesh
    elif hasattr(o, "Shape") and o.Shape and not o.Shape.isNull():
        scaled = o.Shape.transformGeometry(m)
        if o.TypeId == "Part::Feature":
            o.Shape = scaled
        else:
            nf = d.addObject("Part::Feature", o.Label + "_scaled")
            nf.Shape = scaled
            o.Visibility = False
            session.set_body_color(nf.Name, session.body_color(o.Name) or [0.62, 0.68, 0.75])
            o = nf
    else:
        raise RpcError(APP_ERROR, "cannot scale %r" % id)
    d.recompute()
    return {"id": o.Name, "factor": f}


@method("body.convertUnits")
def body_convert_units(id, fromUnit, toUnit):
    src = _UNIT_MM.get(fromUnit)
    dst = _UNIT_MM.get(toUnit)
    if src is None or dst is None:
        raise RpcError(APP_ERROR, "unknown unit (use %s)" % ", ".join(_UNIT_MM))
    return body_scale(id, src / dst)
