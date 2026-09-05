"""Fusion 360 style transform / inspection ops.

Move-Copy, Scale, Align act on whole objects (bodies, imported Part::Feature /
Mesh::Feature, App::Link) via their Placement or a baked shape - no parametric
feature history. Interference and Center of Mass are pure queries.
"""
import FreeCAD as App
from FreeCAD import Vector, Rotation, Placement
import Part  # noqa: F401  (kept for parity / future solid work)

from .registry import method, RpcError, APP_ERROR
from . import session


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #

def _doc():
    d = session.doc(create=False)
    if d is None:
        raise RpcError(APP_ERROR, "no document")
    return d


def _need(d, name):
    o = d.getObject(name)
    if o is None:
        raise RpcError(APP_ERROR, "no object %r" % name)
    return o


def _tree():
    from . import methods as _m
    return _m.tree_get()


def _root_copy(res, like):
    """The object from a copyObject() result that stands in for `like` (same
    TypeId), else the first."""
    lst = res if isinstance(res, (list, tuple)) else [res]
    for c in lst:
        if getattr(c, "TypeId", "") == like.TypeId:
            return c
    return lst[0]


def _delta_placement(mode, dx, dy, dz, axisBase, axisDir, angle, fromPoint, toPoint):
    """One Placement delta for a Move-Copy mode. Left-multiplied onto an object's
    Placement it moves the object in world space."""
    if mode == "translate":
        return Placement(Vector(dx, dy, dz), Rotation())
    if mode == "rotate":
        rot = Placement(Vector(0, 0, 0), Rotation(Vector(*axisDir), float(angle)))
        b = Vector(*axisBase)
        nb = Vector(-b.x, -b.y, -b.z)
        # translate(base) * rot * translate(-base) => rotate about `base`
        return Placement(b, Rotation()).multiply(rot).multiply(Placement(nb, Rotation()))
    if mode in ("pointToPoint", "pointToPosition"):
        return Placement(Vector(*toPoint) - Vector(*fromPoint), Rotation())
    raise RpcError(APP_ERROR, "unknown move mode %r" % mode)


def _pow_placement(p, k):
    """p composed with itself k times (k >= 1 -> p, p*p, ...)."""
    out = Placement()
    for _ in range(int(k)):
        out = p.multiply(out)
    return out


def _scale_matrix(sx, sy, sz, c):
    """T(c) * S(sx,sy,sz) * T(-c) - scale about point `c`. Matrix.move/scale both
    left-multiply, so apply -c, then S, then +c."""
    m = App.Matrix()
    m.move(Vector(-c.x, -c.y, -c.z))
    m.scale(float(sx), float(sy), float(sz))
    m.move(Vector(c.x, c.y, c.z))
    return m


_PLANE_ROLES = {
    "XY_Plane": ((0, 0, 0), (0, 0, 1)), "XY": ((0, 0, 0), (0, 0, 1)),
    "XZ_Plane": ((0, 0, 0), (0, 1, 0)), "XZ": ((0, 0, 0), (0, 1, 0)),
    "YZ_Plane": ((0, 0, 0), (1, 0, 0)), "YZ": ((0, 0, 0), (1, 0, 0)),
}


def _ref_point(d, ref):
    """A point from a scale centerRef: {bodyId, sub} face/edge CenterOfMass, a
    bare object name (its shape CenterOfMass), or a [x,y,z] list."""
    if isinstance(ref, (list, tuple)):
        return Vector(*ref)
    if isinstance(ref, dict):
        o = _need(d, ref.get("bodyId") or ref.get("id"))
        sub = ref.get("sub")
        if sub:
            return Vector(o.Shape.getElement(sub).CenterOfMass)
        return Vector(o.Shape.CenterOfMass)
    return Vector(_need(d, ref).Shape.CenterOfMass)


def _face_plane(d, ref):
    """(origin, normal) for an align ref. Accepts an origin-plane role string /
    {role} or {bodyId, sub} naming a planar face."""
    role = ref if isinstance(ref, str) else (
        ref.get("role") if isinstance(ref, dict) and not ref.get("sub") else None)
    if role in _PLANE_ROLES:
        o, n = _PLANE_ROLES[role]
        return Vector(*o), Vector(*n)
    if not isinstance(ref, dict) or not ref.get("sub"):
        raise RpcError(APP_ERROR, "align ref must be an origin plane role or {bodyId, sub}")
    o = _need(d, ref["bodyId"])
    try:
        face = o.Shape.getElement(ref["sub"])
    except Exception:
        raise RpcError(APP_ERROR, "align: cannot resolve %r on %r" % (ref["sub"], ref["bodyId"]))
    if getattr(face, "ShapeType", "") != "Face" or not isinstance(face.Surface, Part.Plane):
        raise RpcError(APP_ERROR, "align needs two planar faces for now")
    try:
        p = Vector(face.Surface.Position)
    except Exception:
        p = Vector(face.CenterOfMass)
    return p, Vector(face.normalAt(0, 0))


def _solid_of(o):
    """Best solid shape for an object, or None for meshes / empty bodies."""
    if o.TypeId == "Mesh::Feature":
        return None
    s = getattr(o, "Shape", None)
    if (s is None or s.isNull()) and getattr(o, "Tip", None) is not None:
        s = getattr(o.Tip, "Shape", None)
    return s


def _default_solids(d):
    return [o for o in d.Objects
            if o.TypeId in ("PartDesign::Body", "Part::Feature")
            and _solid_of(o) is not None and not _solid_of(o).isNull()]


# --------------------------------------------------------------------------- #
# body.moveCopy
# --------------------------------------------------------------------------- #

@method("body.moveCopy")
def move_copy(ids=None, mode="translate",
              dx=0, dy=0, dz=0,
              axisBase=None, axisDir=None, angle=0,
              fromPoint=None, toPoint=None,
              createCopy=False, copies=1):
    """Move (or copy N times) whole objects by one Placement delta. Modes:
    translate | rotate | pointToPoint | pointToPosition."""
    d = _doc()
    ids = ids or []
    delta = _delta_placement(
        mode, dx, dy, dz,
        axisBase or [0, 0, 0], axisDir or [0, 0, 1], angle,
        fromPoint or [0, 0, 0], toPoint or [0, 0, 0])

    if not createCopy:
        for name in ids:
            o = _need(d, name)
            o.Placement = delta.multiply(o.Placement)  # left-multiply -> world move
        d.recompute()
        return _tree()

    n = max(1, int(copies))
    for name in ids:
        o = _need(d, name)
        for k in range(1, n + 1):
            root = _root_copy(d.copyObject(o, True), o)
            root.Placement = _pow_placement(delta, k).multiply(o.Placement)
            root.Label = o.Label + (" copy %d" % k if n > 1 else " copy")
    d.recompute()
    return _tree()


# --------------------------------------------------------------------------- #
# body.scaleBody
# --------------------------------------------------------------------------- #

@method("body.scaleBody")
def scale_body(id=None, uniform=True, factor=2.0,
               fx=1, fy=1, fz=1, centerRef=None, center=None):
    """Scale a body about a point. PartDesign bodies get a real, native,
    editable PartDesign::FeaturePython Scale feature in the timeline (see
    pdscale.py) - not a baked shape. Meshes and bare Part::Feature objects
    (no PartDesign body to add a timeline feature to) still bake to a derived
    Part::Feature, transformed in place for a mesh."""
    if not id:
        raise RpcError(APP_ERROR, "scaleBody needs an id")
    d = _doc()
    o = _need(d, id)
    center = center or [0, 0, 0]
    sx, sy, sz = ((float(factor),) * 3 if uniform
                  else (float(fx), float(fy), float(fz)))

    c = None
    if centerRef is not None:
        c = _ref_point(d, centerRef)
    elif any(abs(float(v)) > 1e-12 for v in center):
        c = Vector(*center)

    if o.TypeId == "Mesh::Feature":
        if c is None:
            c = Vector(o.Mesh.BoundBox.Center)
        mesh = o.Mesh.copy()
        mesh.transform(_scale_matrix(sx, sy, sz, c))
        o.Mesh = mesh
        d.recompute()
        return _tree()

    if o.TypeId == "PartDesign::Body":
        shp = getattr(o, "Shape", None)
        if shp is None or shp.isNull():
            raise RpcError(APP_ERROR, "cannot scale %r - no solid shape" % id)
        if c is None:
            try:
                c = Vector(shp.CenterOfMass)
            except Exception:
                c = Vector(shp.BoundBox.Center)
        from . import pdscale
        prev_tip = getattr(o, "Tip", None)
        prev_tip_name = prev_tip.Name if prev_tip is not None else None
        feat = pdscale.add_scale_feature(o, uniform, factor, sx, sy, sz, (c.x, c.y, c.z))
        d.recompute()
        if o.Shape is None or o.Shape.isNull() or not o.Shape.isValid():
            try:
                if prev_tip_name and d.getObject(prev_tip_name) is not None:
                    o.Tip = d.getObject(prev_tip_name)
                d.removeObject(feat.Name)
                d.recompute()
            except Exception:
                pass
            raise RpcError(APP_ERROR, "scale produced an invalid shape")
        return _tree()

    shp = _solid_of(o)
    if shp is None or shp.isNull():
        raise RpcError(APP_ERROR, "cannot scale %r - no solid shape" % id)
    if c is None:
        try:
            c = Vector(shp.CenterOfMass)
        except Exception:
            c = Vector(shp.BoundBox.Center)

    newshape = shp.transformGeometry(_scale_matrix(sx, sy, sz, c))
    nf = d.addObject("Part::Feature", "Scaled")  # addObject sanitises spaces
    nf.Label = o.Label + " scaled"
    nf.Shape = newshape
    o.Visibility = False
    try:
        session.set_body_color(nf.Name, session.body_color(o.Name) or [0.62, 0.68, 0.75])
    except Exception:
        pass
    d.recompute()
    return _tree()


# --------------------------------------------------------------------------- #
# body.align
# --------------------------------------------------------------------------- #

@method("body.align")
def align(moveId=None, fromRef=None, toRef=None):
    """Rigid-move `moveId` so its `fromRef` planar face mates against `toRef`
    (normals opposed). Refs: origin-plane role or {bodyId, sub}."""
    if not moveId or fromRef is None or toRef is None:
        raise RpcError(APP_ERROR, "align needs moveId, fromRef and toRef")
    d = _doc()
    mo = _need(d, moveId)
    p0, n0 = _face_plane(d, fromRef)
    p1, n1 = _face_plane(d, toRef)
    n1 = Vector(-n1.x, -n1.y, -n1.z)  # flip target normal so the faces mate

    rot = Rotation(n0, n1)  # shortest-arc n0 -> n1
    # translate(p1) * rotate(about origin) * translate(-p0)
    place = (Placement(p1, Rotation())
             .multiply(Placement(Vector(0, 0, 0), rot))
             .multiply(Placement(Vector(-p0.x, -p0.y, -p0.z), Rotation())))
    mo.Placement = place.multiply(mo.Placement)
    d.recompute()
    return _tree()


# --------------------------------------------------------------------------- #
# inspect.interference   (QUERY)
# --------------------------------------------------------------------------- #

@method("inspect.interference")
def interference(ids=None):
    """Pairwise solid overlap volume. Default: every solid body in the doc."""
    d = _doc()
    if ids:
        objs = [_need(d, n) for n in ids]
    else:
        objs = _default_solids(d)
    shapes = [(o.Name, _solid_of(o)) for o in objs]
    shapes = [(n, s) for n, s in shapes if s is not None and not s.isNull()]
    if len(shapes) < 2:
        raise RpcError(APP_ERROR, "interference needs at least 2 solid bodies")

    pairs = []
    total = 0.0
    for i in range(len(shapes)):
        for j in range(i + 1, len(shapes)):
            na, sa = shapes[i]
            nb, sb = shapes[j]
            vol = 0.0
            try:
                common = sa.common(sb)
                if common is not None and not common.isNull():
                    vol = float(common.Volume)
            except Exception:
                vol = 0.0
            total += vol
            pairs.append({"a": na, "b": nb, "volume": vol,
                          "hasInterference": vol > 1e-6})
    return {"pairs": pairs, "totalVolume": total}


# --------------------------------------------------------------------------- #
# inspect.centerOfMass   (QUERY)
# --------------------------------------------------------------------------- #

@method("inspect.centerOfMass")
def center_of_mass(ids=None):
    """Per-body COM / volume / area plus a volume-weighted combined COM.
    Default: every solid body in the doc."""
    d = _doc()
    if ids:
        objs = [_need(d, n) for n in ids]
    else:
        objs = _default_solids(d)

    out = []
    acc = Vector(0, 0, 0)
    tv = 0.0
    for o in objs:
        s = _solid_of(o)
        if s is None or s.isNull():
            continue
        try:
            com = Vector(s.CenterOfMass)
            v = float(s.Volume)
            a = float(s.Area)
        except Exception:
            continue
        out.append({"id": o.Name, "com": [com.x, com.y, com.z],
                    "volume": v, "area": a})
        if v > 1e-12:
            acc = acc + com.multiply(v)
            tv += v
    ccom = [acc.x / tv, acc.y / tv, acc.z / tv] if tv > 1e-12 else [0.0, 0.0, 0.0]
    return {"bodies": out, "combined": {"com": ccom, "volume": tv}}
