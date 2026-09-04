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


def _boolean_consumed_bodies(d):
    """Body names that have been folded into a PartDesign::Boolean as a tool -
    they must not show as their own body in the tree or scene."""
    out = set()
    if d is None:
        return out
    for o in d.Objects:
        if o.TypeId == "PartDesign::Boolean":
            for t in getattr(o, "Group", []) or []:
                if getattr(t, "TypeId", "") == "PartDesign::Body":
                    out.add(t.Name)
    return out


def _ensure_body_tip(d, body):
    """After removing / re-pointing a feature, body.Tip can be left dangling or
    on a non-solid - body.Shape then goes null and the viewport blanks. Snap Tip
    to the last remaining solid feature (or None for an empty body)."""
    if body is None or body.TypeId != "PartDesign::Body":
        return
    tip = getattr(body, "Tip", None)
    live = tip is not None and d.getObject(getattr(tip, "Name", "") or "") is not None
    if live:
        try:
            if _kind(tip.TypeId) == "solid":
                return
        except Exception:
            pass
    last_solid = None
    for f in body.Group:
        if f.TypeId == "App::Origin":
            continue
        try:
            if _kind(f.TypeId) == "solid":
                last_solid = f
        except Exception:
            pass
    try:
        body.Tip = last_solid
    except Exception:
        pass
    # a normal delete never means "rolled back to empty" - only history.rollTo
    # sets that. If solids remain, make sure the flag is not stuck on.
    if last_solid is not None:
        session.set_rolled_empty(body.Name, False)


# primitive.box / primitive.cylinder (+ sphere / torus / coil / pipe) are
# implemented in gwtcad.primitives, imported at the bottom of this module.


@method("feature.extrude")
def feature_extrude(sketchId=None, length=10.0, reversed=False, midplane=False, cut=False,
                    upToFaceRef=None, operation=None, offset=0.0, faceRef=None, taper=0.0,
                    length2=0.0, throughAll=False):
    """operation: 'join' (add) | 'cut' (remove) | 'intersect' (keep the overlap)
    | 'newBody' (separate solid).
    `cut=True` is kept as a shorthand for operation='cut'. When upToFaceRef is
    given, `offset` is the extra distance past that face. Instead of a sketch you
    may pass `faceRef` ({bodyId, sub}) to extrude an existing flat model face."""
    if faceRef and not sketchId:
        d = session.doc(create=False)
        if d is None:
            raise RpcError(APP_ERROR, "no document")
        fbody = d.getObject(faceRef["bodyId"])
        if fbody is None:
            raise RpcError(APP_ERROR, "no object %r" % faceRef["bodyId"])
        body = fbody if fbody.TypeId == "PartDesign::Body" else fbody.getParentGeoFeatureGroup()
        if body is None or body.TypeId != "PartDesign::Body":
            raise RpcError(APP_ERROR, "that face is not on a Body")
        if getattr(body, "Tip", None) is None:
            raise RpcError(APP_ERROR,
                           "that body has no solid yet - draw a sketch on the face "
                           "and extrude that instead")
        # only a flat face works as a pad/pocket profile - reject cylinders etc.
        try:
            _fsub = faceRef["sub"]
            _fidx = int(_fsub[4:]) - 1
            _face = body.Tip.Shape.Faces[_fidx]
            if type(_face.Surface).__name__ != "Plane":
                raise RpcError(APP_ERROR,
                               "that face is curved - extruding a face needs a flat "
                               "one (or use a sketch)")
        except RpcError:
            raise
        except Exception:
            pass  # index/attr trouble: let the pad attempt surface the real error
        sk = (body.Tip, [faceRef["sub"]])   # PartDesign accepts a base-solid face as a profile
    else:
        d, sk = _obj(sketchId)
        if sk.TypeId != "Sketcher::SketchObject":
            raise RpcError(APP_ERROR, "%r is not a sketch" % sketchId)
        body = sk.getParentGeoFeatureGroup()
        if body is None or body.TypeId != "PartDesign::Body":
            raise RpcError(APP_ERROR, "sketch is not inside a Body")
        # re-using a sketch that another feature already consumed corrupts both
        # on recompute - so transparently extrude an independent copy instead
        # (Fusion-style: one sketch, many features off it)
        sk = build.reusable_profile(d, body, sk)
    op = (operation or ("cut" if cut else "join")).lower()
    up = _resolve_ref(d, body, upToFaceRef) if upToFaceRef else None
    off = float(offset or 0.0)

    # clear the sketch of redundant constraints first (they can leave the solver
    # unable to form a closed wire, which then makes a NULL pad). Only touch the
    # ones FreeCAD names; a real conflict is left for the user to fix.
    if not isinstance(sk, tuple) and sk.TypeId == "Sketcher::SketchObject":
        _strip_redundant_constraints(sk, d)

    # remember exactly what to undo if this build turns out invalid - just the
    # feature we are about to add, never anything already in the body
    prev_tip = getattr(body, "Tip", None)
    prev_tip_name = prev_tip.Name if prev_tip is not None else None
    try:
        prev_vol = body.Shape.Volume if getattr(body, "Shape", None) is not None else 0.0
    except Exception:
        prev_vol = 0.0
    made = None        # the Pad/Pocket this call creates
    made_body = None   # a fresh Body, for the newbody branch

    if op == "cut":
        made = build.pocket(body, sk, float(length), up_to=up, offset=off, taper=taper,
                            through_all=throughAll)
        target = body
    elif op == "intersect":
        # keep only where the new prism and the existing solid overlap. PartDesign
        # has no native "intersect pad", so pad a scratch body and Common it in.
        if isinstance(sk, tuple) or prev_tip is None or _kind(prev_tip.TypeId) != "solid":
            raise RpcError(APP_ERROR,
                           "Intersect needs a sketch profile and an existing solid "
                           "to intersect with")
        nb = build.new_body(d, next_label(None, "PartDesign::Body"))
        skc = d.copyObject(sk, False)
        nb.addObject(skc)
        pad = build.pad(nb, skc, float(length), reversed_=reversed,
                        midplane=midplane, up_to=up, offset=off, taper=taper,
                        length2=length2, through_all=throughAll)
        made_body = nb
        d.recompute()
        boolean = body.newObject("PartDesign::Boolean", "Boolean")
        boolean.Label = next_label(body, "PartDesign::Boolean")
        boolean.Type = "Common"
        boolean.Group = [nb]
        made = boolean
        target = body
        body.Tip = boolean
        try:
            boolean.touch()
        except Exception:
            pass
        d.recompute(None, True, True)
    elif op == "newbody":
        tip = getattr(body, "Tip", None)
        if isinstance(sk, tuple):
            # a model-face profile cannot be copied into a fresh body - just pad
            made = build.pad(body, sk, float(length), reversed_=reversed,
                             midplane=midplane, up_to=up, offset=off, taper=taper,
                        length2=length2, through_all=throughAll)
            target = body
        elif tip is not None and _kind(tip.TypeId) == "solid":
            # body already has a solid - pad a copy of the sketch in a fresh body
            nb = build.new_body(d, next_label(None, "PartDesign::Body"))
            skc = d.copyObject(sk, False)
            nb.addObject(skc)
            made = build.pad(nb, skc, float(length), reversed_=reversed,
                             midplane=midplane, up_to=up, offset=off, taper=taper,
                        length2=length2, through_all=throughAll)
            made_body = nb
            target = nb
        else:
            made = build.pad(body, sk, float(length), reversed_=reversed,
                             midplane=midplane, up_to=up, offset=off, taper=taper,
                        length2=length2, through_all=throughAll)
            target = body
    else:  # join
        made = build.pad(body, sk, float(length), reversed_=reversed,
                         midplane=midplane, up_to=up, offset=off, taper=taper,
                        length2=length2, through_all=throughAll)
        target = body
        # Extrude "Two Sides": PartDesign::Pad.Type "TwoLengths" produces a null
        # shape in this FreeCAD build, so pad the same profile a second time in
        # the opposite direction instead - two fused additive features standing
        # in for Fusion's single two-sided one.
        if length2 and not isinstance(sk, tuple) and not up and not throughAll:
            try:
                sk2 = build.reusable_profile(d, body, sk)
                made2 = build.pad(body, sk2, float(length2), reversed_=(not reversed), taper=taper)
                d.recompute()
                if body.Shape.isValid():
                    made = made2
            except Exception:
                pass  # keep the single-sided result rather than fail the whole extrude

    if op != "intersect":
        d.recompute()

    fail_msg = ("extrude produced an invalid shape - check the profile is a "
                "clean closed outline and try again")

    # a Pocket cuts opposite the profile normal; a cut sketch on a base plane (or
    # a face whose normal points away from the material) then pockets into empty
    # space and removes nothing. If the volume did not drop, flip Reversed once.
    if op == "cut" and made is not None:
        try:
            cur = target.Shape.Volume if getattr(target, "Shape", None) is not None else prev_vol
            valid_now = target.Shape is not None and not target.Shape.isNull() and target.Shape.isValid()
        except Exception:
            cur, valid_now = prev_vol, False
        if valid_now and cur >= prev_vol - 1e-6 and up is None:
            try:
                made.Reversed = not bool(getattr(made, "Reversed", False))
                d.recompute()
                cur = target.Shape.Volume
            except Exception:
                pass
        if valid_now and cur >= prev_vol - 1e-6 and up is None:
            fail_msg = ("the cut profile does not intersect the solid - draw it on "
                        "a face of the model, or where it overlaps the body")
            try:
                made.Reversed = not bool(getattr(made, "Reversed", False))  # restore
            except Exception:
                pass
            valid_now = False  # force the rollback path below
        ok = valid_now
    else:
        ok = None  # decided below

    # if the pad failed, remove EXACTLY the feature we just made (and the fresh
    # body, if any) and restore the previous tip - never touch features that
    # were already there, or a bad 2nd extrude wipes the whole body
    if ok is None:
        try:
            shp = getattr(target, "Shape", None)
            ok = shp is not None and not shp.isNull() and shp.isValid()
        except Exception:
            ok = False
        if ok and op == "intersect":
            try:
                ok = target.Shape.Volume <= prev_vol + 1e-6 and target.Shape.Volume > 1e-9
            except Exception:
                ok = False
            if not ok:
                fail_msg = ("Intersect produced nothing - the new prism and the "
                            "existing solid do not overlap")
    if not ok:
        try:
            if made is not None and d.getObject(made.Name) is not None:
                d.removeObject(made.Name)
            if made_body is not None and d.getObject(made_body.Name) is not None:
                # take the scratch body's children (copied sketch + pad) with it
                for child in list(getattr(made_body, "Group", [])):
                    try:
                        if d.getObject(child.Name) is not None:
                            d.removeObject(child.Name)
                    except Exception:
                        pass
                d.removeObject(made_body.Name)
            if prev_tip_name and d.getObject(prev_tip_name) is not None:
                try:
                    body.Tip = d.getObject(prev_tip_name)
                except Exception:
                    pass
            d.recompute()
        except Exception:
            pass
        raise RpcError(APP_ERROR, fail_msg)
    return tree_get()


def _sketch_local_extent(sk):
    """(xmin, xmax, ymin, ymax) of the real (non-construction) sketch geometry in
    the sketch's own 2D frame, or None. Used to tell whether a revolve profile
    straddles its own H/V axis."""
    xs, ys = [], []
    for g in getattr(sk, "Geometry", []):
        try:
            if getattr(g, "Construction", False):
                continue
            if hasattr(g, "StartPoint"):
                for p in (g.StartPoint, g.EndPoint):
                    xs.append(p.x)
                    ys.append(p.y)
            c = getattr(g, "Center", None)
            r = getattr(g, "Radius", None)
            if c is not None and r is not None:
                xs += [c.x - r, c.x + r]
                ys += [c.y - r, c.y + r]
        except Exception:
            pass
    if not xs:
        return None
    return (min(xs), max(xs), min(ys), max(ys))


@method("feature.revolve")
def feature_revolve(sketchId=None, angle=360.0, axis="V", axisRef=None,
                    reversed=False, cut=False, faceRef=None, operation=None):
    """Revolve a sketch, OR (no sketchId) a flat model face - the latter needs
    an explicit axisRef since a face has no H/V axis of its own.
    operation: 'join' (default) | 'cut' (Groove) | 'newbody' | 'intersect'.
    The caller also passes cut=True for 'cut'; 'newbody' / 'intersect' build an
    additive Revolution and then re-express it against the body."""
    vert = str(axis).upper().startswith("V")

    if faceRef and not sketchId:
        d = session.doc(create=False)
        if d is None:
            raise RpcError(APP_ERROR, "no document")
        fbody = d.getObject(faceRef["bodyId"])
        if fbody is None:
            raise RpcError(APP_ERROR, "no object %r" % faceRef["bodyId"])
        body = fbody if fbody.TypeId == "PartDesign::Body" else fbody.getParentGeoFeatureGroup()
        if body is None or body.TypeId != "PartDesign::Body":
            raise RpcError(APP_ERROR, "that face is not on a Body")
        if getattr(body, "Tip", None) is None:
            raise RpcError(APP_ERROR,
                           "that body has no solid yet - draw a sketch on the "
                           "face and revolve that instead")
        try:
            _fidx = int(faceRef["sub"][4:]) - 1
            _face = body.Tip.Shape.Faces[_fidx]
            if type(_face.Surface).__name__ != "Plane":
                raise RpcError(APP_ERROR,
                               "that face is curved - revolving a face needs a "
                               "flat one (or use a sketch)")
        except RpcError:
            raise
        except Exception:
            pass
        if not axisRef:
            raise RpcError(APP_ERROR,
                           "revolving a face needs an axis - also select a "
                           "straight edge or a datum axis to revolve about")
        sk = None
        base_prof = (body.Tip, [faceRef["sub"]])
    else:
        d, sk = _obj(sketchId)
        if sk.TypeId != "Sketcher::SketchObject":
            raise RpcError(APP_ERROR, "%r is not a sketch" % sketchId)
        body = sk.getParentGeoFeatureGroup()
        if body is None or body.TypeId != "PartDesign::Body":
            raise RpcError(APP_ERROR, "sketch is not inside a Body")
        base_prof = None

        # a profile that crosses the revolve axis sweeps into itself - PartDesign
        # sometimes returns that as a "valid" sliver rather than an error, which
        # then reads as the body vanishing. Catch it up front while we still can
        # name the axis (only when the axis IS the sketch's own H/V line).
        if not axisRef:
            ext = _sketch_local_extent(sk)
            if ext is not None:
                xmin, xmax, ymin, ymax = ext
                tol = 1e-6
                straddles = (xmin < -tol and xmax > tol) if vert else (ymin < -tol and ymax > tol)
                if straddles:
                    raise RpcError(APP_ERROR,
                                   "the profile crosses the revolve axis - move the "
                                   "sketch fully to one side of the %s axis, or select "
                                   "a model edge / datum line to revolve about"
                                   % ("vertical" if vert else "horizontal"))

    prof = base_prof if base_prof is not None else build.reusable_profile(d, body, sk)
    prev_tip = getattr(body, "Tip", None)
    prev_tip_name = prev_tip.Name if prev_tip is not None else None

    _rev_op = (operation or "join").lower()
    _reexpress = _rev_op in ("newbody", "intersect")
    _before = None
    if _reexpress:
        try:
            _before = body.Shape.copy()
        except Exception:
            _before = None

    # resolve the axis BEFORE creating the feature - body.newObject() advances
    # body.Tip to the new (half-built) Revolution, so a ref that resolves through
    # body.Tip (e.g. axisRef.bodyId is the Body id, which the GUI sends for edge
    # picks) would otherwise point the Revolution's ReferenceAxis at itself and
    # trip "The graph must be a DAG." -> null shape -> a silent no-op revolve.
    axis_tuple = _resolve_ref(d, body, axisRef) if axisRef else None

    tid = "PartDesign::Groove" if cut else "PartDesign::Revolution"
    rev = body.newObject(tid, "Revolution")
    rev.Label = next_label(body, tid)
    rev.Profile = prof
    if axis_tuple is not None:
        rev.ReferenceAxis = axis_tuple
    else:
        rev.ReferenceAxis = (prof, ["V_Axis" if vert else "H_Axis"])
    rev.Angle = float(angle)
    if reversed:
        rev.Reversed = True
    if hasattr(prof, "Visibility"):
        prof.Visibility = False

    # build; if it comes out invalid, drop exactly this feature (and any profile
    # copy we made), put the tip back, and raise - never disturb existing work
    extra = [prof] if (sk is not None and prof is not sk) else []
    _what = ("revolve produced an invalid shape - check the profile is one closed "
             "outline that stays on one side of the axis, then try again")
    if _reexpress and _before is not None and not _before.isNull():
        # additive Revolution already built; re-express its contribution as a
        # new body (newbody) or an intersection (intersect) - same path the
        # mirror / pattern Operation uses
        d.recompute()
        _finish_transform(d, body, rev, prev_tip_name, _before, _rev_op, _what)
    else:
        build.finalize_or_rollback(d, body, rev, prev_tip_name, extra, _what,
                                   check_made=True)
    return tree_get()


@method("feature.sweep")
def feature_sweep(profileId, pathId=None, pathRef=None, cut=False, operation=None,
                  orientation="Path", transition="Transformed"):
    """operation: 'join' (default) | 'cut' | 'newbody' | 'intersect' (same set as
    extrude). orientation: 'Path' (profile follows the path's curvature, Frenet)
    or 'Parallel' (profile orientation stays fixed). transition: how corners in
    the path are handled - 'Transformed' | 'Right corner' | 'Round corner'."""
    d, prof = _obj(profileId)
    body = prof.getParentGeoFeatureGroup()
    if body is None or body.TypeId != "PartDesign::Body":
        raise RpcError(APP_ERROR, "profile is not inside a Body")
    op = (operation or ("cut" if cut else "join")).lower()
    prev_tip = getattr(body, "Tip", None)
    prev_tip_name = prev_tip.Name if prev_tip is not None else None
    reexpress = op in ("newbody", "intersect")
    before = None
    if reexpress:
        try:
            before = body.Shape.copy()
        except Exception:
            before = None

    tid = "PartDesign::SubtractivePipe" if op == "cut" else "PartDesign::AdditivePipe"
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
    try:
        pipe.Mode = "Frenet" if str(orientation).lower().startswith("path") else "Fixed"
    except Exception:
        pass
    try:
        pipe.Transition = transition
    except Exception:
        pass
    prof.Visibility = False

    what = "sweep produced an invalid shape"
    if reexpress and before is not None and not before.isNull():
        d.recompute()
        _finish_transform(d, body, pipe, prev_tip_name, before, op, what)
    else:
        build.finalize_or_rollback(d, body, pipe, prev_tip_name, [], what, check_made=True)
    return tree_get()


@method("feature.loft")
def feature_loft(sketchIds, cut=False, operation=None, ruled=False, closed=False):
    """operation: 'join' (default) | 'cut' | 'newbody' | 'intersect'. ruled = a
    straight-line blend between sections instead of a smooth one. closed = loop
    the last section back to the first."""
    if not sketchIds or len(sketchIds) < 2:
        raise RpcError(APP_ERROR, "loft needs at least two profiles")
    d, first = _obj(sketchIds[0])
    body = first.getParentGeoFeatureGroup()
    if body is None or body.TypeId != "PartDesign::Body":
        raise RpcError(APP_ERROR, "profile is not inside a Body")
    op = (operation or ("cut" if cut else "join")).lower()
    prev_tip = getattr(body, "Tip", None)
    prev_tip_name = prev_tip.Name if prev_tip is not None else None
    reexpress = op in ("newbody", "intersect")
    before = None
    if reexpress:
        try:
            before = body.Shape.copy()
        except Exception:
            before = None

    tid = "PartDesign::SubtractiveLoft" if op == "cut" else "PartDesign::AdditiveLoft"
    loft = body.newObject(tid, "Loft")
    loft.Label = next_label(body, tid)
    loft.Profile = first
    loft.Sections = [d.getObject(s) for s in sketchIds[1:]]
    try:
        loft.Ruled = bool(ruled)
    except Exception:
        pass
    try:
        loft.Closed = bool(closed)
    except Exception:
        pass
    for s in sketchIds:
        d.getObject(s).Visibility = False

    what = "loft produced an invalid shape"
    if reexpress and before is not None and not before.isNull():
        d.recompute()
        _finish_transform(d, body, loft, prev_tip_name, before, op, what)
    else:
        build.finalize_or_rollback(d, body, loft, prev_tip_name, [], what, check_made=True)
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
def pattern_circular(count=4, angle=360.0, axisRef=None, axisPlane="XY",
                     scope="body", refs=None, operation="join"):
    body = _require_body()
    _solid_tip(body)  # ensure there is a solid
    d = body.Document
    prev_tip_name = getattr(getattr(body, "Tip", None), "Name", None)
    before = body.Shape.copy() if getattr(body, "Shape", None) is not None else None
    axis_tuple = _resolve_ref(d, body, axisRef) if axisRef else None  # resolve before newObject
    originals = _transform_originals(body, scope, refs)
    p = body.newObject("PartDesign::PolarPattern", "PolarPattern")
    p.Label = next_label(body, "PartDesign::PolarPattern")
    p.Originals = originals
    if axis_tuple is not None:
        p.Axis = axis_tuple
    else:
        role = {"XY": "Z_Axis", "XZ": "Y_Axis", "YZ": "X_Axis"}.get(axisPlane.upper(), "Z_Axis")
        for f in body.Origin.OriginFeatures:
            if getattr(f, "Role", None) == role:
                p.Axis = (f, [""])
                break
    p.Angle = float(angle)
    p.Occurrences = int(count)
    _apply_transformed(body, p)
    _finish_transform(d, body, p, prev_tip_name, before, operation,
                      "circular pattern produced an invalid shape - try fewer "
                      "copies or a different axis")
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
def feature_chamfer(edges, size=2.0, mode="Equal", size2=0.0, angle=45.0):
    """mode: 'Equal' (one distance), 'Two distances' (Size + Size2), or
    'Distance and angle' (Size + Angle)."""
    body = _require_body()
    tip = _solid_tip(body)
    f = build.dress_up(body, "PartDesign::Chamfer", tip, edges, "Chamfer")
    f.Size = float(size)
    m = str(mode or "Equal").lower()
    try:
        if m.startswith("two"):
            f.ChamferType = "Two distances"
            f.Size2 = float(size2) if float(size2 or 0) > 0 else float(size)
        elif "angle" in m:
            f.ChamferType = "Distance and angle"
            f.Angle = float(angle)
        else:
            f.ChamferType = "Equal distance"
    except Exception:
        pass  # older builds: single-distance only, Size already set
    body.Document.recompute()
    if not body.Shape.isValid():
        raise RpcError(APP_ERROR, "chamfer produced an invalid shape")
    return tree_get()


@method("feature.shell")
def feature_shell(faces, thickness=2.0, direction="Inside"):
    """direction: 'Inside' (hollow inward, default), 'Outside' (add a wall
    outward), 'Both' (split the wall about the surface)."""
    body = _require_body()
    tip = _solid_tip(body)
    f = build.dress_up(body, "PartDesign::Thickness", tip, faces, "Shell")
    f.Value = float(thickness)
    dr = str(direction or "Inside").lower()
    try:
        if dr.startswith("out"):
            f.Reversed = True
        elif dr.startswith("both"):
            if hasattr(f, "Mode"):
                f.Mode = "RectoVerso"
    except Exception:
        pass
    body.Document.recompute()
    if not body.Shape.isValid():
        raise RpcError(APP_ERROR, "shell produced an invalid shape")
    return tree_get()


@method("feature.pressPull")
def feature_press_pull(subs, distance=2.0):
    """Fusion's Press Pull (Q): one entry point. An edge sub -> fillet by
    `distance`; a face sub -> offset that face by `distance` (positive adds
    material, negative removes). Delegates to the tested fillet / face-extrude
    paths so the result stays parametric."""
    subs = list(subs or [])
    if not subs:
        raise RpcError(APP_ERROR, "pick an edge (to fillet) or a face (to offset)")
    edges = [s for s in subs if str(s).startswith("Edge")]
    faces = [s for s in subs if str(s).startswith("Face")]
    if edges:
        return feature_fillet(edges, abs(float(distance)) or 1.0)
    if faces:
        return feature_offset_face(faces, float(distance))
    raise RpcError(APP_ERROR, "Press Pull needs edge or face references")


@method("feature.offsetFace")
def feature_offset_face(faces, distance=2.0):
    """Move planar faces along their normal. Implemented as a face pad (add) or
    pocket (remove) so it lands in the timeline like any other feature."""
    body = _require_body()
    faces = list(faces or [])
    if not faces:
        raise RpcError(APP_ERROR, "select the face(s) to offset")
    dist = float(distance)
    op = "join" if dist >= 0 else "cut"
    last = None
    for sub in faces:
        last = feature_extrude(sketchId=None, length=abs(dist), operation=op,
                               faceRef={"bodyId": body.Name, "sub": sub})
    return last if last is not None else tree_get()


@method("feature.splitFace")
def feature_split_face(faces, planeRef=None):
    """Imprint a plane's intersection onto the selected face(s), splitting them
    without changing the volume. Non-parametric: emits a derived Part::Feature
    (PartDesign has no native Split Face in this build)."""
    body = _require_body()
    d = body.Document
    tip = _solid_tip(body)
    if planeRef is None:
        raise RpcError(APP_ERROR, "also pick the splitting plane (a datum / origin plane)")
    import Part
    from FreeCAD import Vector

    obj, sub = _resolve_ref(d, body, planeRef)
    # build a big planar face at the reference plane
    if sub and str(sub[0]).startswith("Face"):
        ref_face = obj.Shape.getElement(sub[0])
        pl_pt = ref_face.CenterOfMass
        pl_n = ref_face.normalAt(0, 0)
    else:
        pl = obj.Placement
        pl_pt = pl.Base
        pl_n = pl.Rotation.multVec(Vector(0, 0, 1))
    bb = tip.Shape.BoundBox
    size = bb.DiagonalLength * 2.0 or 100.0
    plane = Part.makePlane(size, size, Vector(pl_pt).sub(Vector(pl_n).multiply(0)), pl_n)
    plane.translate(Vector(pl_pt).sub(plane.CenterOfMass))
    try:
        pieces = tip.Shape.generalFuse([plane])[0]
        result = pieces
    except Exception as e:
        raise RpcError(APP_ERROR, "split face failed: %s" % e)
    pf = d.addObject("Part::Feature", "SplitFace")
    pf.Shape = result
    body.Visibility = False
    d.recompute()
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


_TRANSFORM_SOLID_TYPES = (
    "PartDesign::Pad", "PartDesign::Pocket",
    "PartDesign::Revolution", "PartDesign::Groove",
    "PartDesign::AdditivePipe", "PartDesign::SubtractivePipe",
    "PartDesign::AdditiveLoft", "PartDesign::SubtractiveLoft",
    "PartDesign::Hole",
)


def _body_solid_features(body):
    """Every additive/subtractive solid feature in the body up to the Tip - the
    Originals a Mirror / Pattern needs to transform the WHOLE solid rather than
    just the last feature (which is what Originals=[tip] gives you)."""
    tip = getattr(body, "Tip", None)
    out = []
    for f in body.Group:
        if f.TypeId in _TRANSFORM_SOLID_TYPES:
            out.append(f)
        if tip is not None and f is tip:
            break
    return out


def _features_for_faces(body, subs):
    """The solid features that produced the named Tip.Shape faces (most-recent
    first, dedup). Falls back to the whole chain when a face can't be traced."""
    chain = _body_solid_features(body)
    tip = getattr(body, "Tip", None)
    tshape = getattr(tip, "Shape", None)
    if tshape is None or tshape.isNull() or not subs:
        return chain
    targets = []
    for sub in subs:
        try:
            fc = tshape.getElement(sub)
            targets.append((fc.CenterOfMass, fc.Area))
        except Exception:
            pass
    hits = []
    for f in reversed(chain):
        fs = getattr(f, "Shape", None)
        if fs is None or fs.isNull():
            continue
        for com, area in targets:
            for ff in fs.Faces:
                if abs(ff.Area - area) < 1e-6 and ff.CenterOfMass.distanceToPoint(com) < 1e-6:
                    if f not in hits:
                        hits.append(f)
                    break
    return hits or chain


def _transform_originals(body, scope, refs):
    """Resolve a Mirror / Pattern scope ('body' | 'features' | 'faces') + refs
    (feature ids or face subnames) to the Originals list. Empty -> whole body."""
    scope = (scope or "body").lower()
    d = body.Document
    if scope == "features" and refs:
        want = set(refs)
        picked = [f for f in _body_solid_features(body) if f.Name in want]
        return picked or _body_solid_features(body)
    if scope == "faces" and refs:
        return _features_for_faces(body, list(refs))
    return _body_solid_features(body)


def _scratch_body_from_shape(d, shp, label="__xform"):
    """A throwaway PartDesign::Body whose tip is a Part::Feature holding `shp`,
    for feeding a raw solid into a PartDesign::Boolean or standing alone as a
    'new body' result. Returns the body; its helper Part::Feature is hidden."""
    pf = d.addObject("Part::Feature", label + "_shape")
    pf.Shape = shp
    pf.Visibility = False
    nb = build.new_body(d, next_label(None, "PartDesign::Body"))
    fb = nb.newObject("PartDesign::FeatureBase", "BaseFeat")
    fb.BaseFeature = pf
    nb.Tip = fb
    d.recompute()
    return nb


def _xform_helper_features(d):
    """Part::Feature objects that only exist to seed a FeatureBase - hidden from
    tree / scene (like _boolean_consumed_bodies for tool bodies)."""
    out = set()
    for o in d.Objects:
        if o.TypeId == "PartDesign::FeatureBase":
            bf = getattr(o, "BaseFeature", None)
            if bf is not None and getattr(bf, "TypeId", "") == "Part::Feature":
                out.add(bf.Name)
    return out


def _apply_result_boolean(d, body, prev_tip_name, tool_shape, op, what, prev_vol=None):
    """After a Mirror / Pattern (or Extrude) has produced `tool_shape` (the net
    solid it contributes), combine it with the body per `op`:
      join      -> caller already fused it; nothing to do here.
      cut       -> PartDesign::Boolean Cut  (scratch body as the tool)
      intersect -> PartDesign::Boolean Common
      newbody   -> tool_shape becomes its own PartDesign::Body; `body` is left
                   at prev_tip.
    Returns the feature that is now `body.Tip` (Boolean), or the new body for
    'newbody'. Raises RpcError(what) on an empty / invalid result."""
    op = (op or "join").lower()
    if op == "newbody":
        if prev_tip_name and d.getObject(prev_tip_name) is not None:
            body.Tip = d.getObject(prev_tip_name)
        nb = _scratch_body_from_shape(d, tool_shape, "MirrorResult")
        d.recompute()
        if nb.Shape is None or nb.Shape.isNull() or not nb.Shape.isValid():
            try:
                d.removeObject(nb.Name)
            except Exception:
                pass
            raise RpcError(APP_ERROR, what)
        return nb
    nb = _scratch_body_from_shape(d, tool_shape, "ToolBody")
    boolean = body.newObject("PartDesign::Boolean", "Boolean")
    boolean.Label = next_label(body, "PartDesign::Boolean")
    boolean.Type = "Cut" if op == "cut" else "Common"
    boolean.Group = [nb]
    body.Tip = boolean
    try:
        boolean.touch()
    except Exception:
        pass
    d.recompute(None, True, True)
    shp = getattr(body, "Shape", None)
    ok = shp is not None and not shp.isNull()
    try:
        ok = ok and shp.isValid() and shp.Volume > 1e-9
        # a Cut / Common that changed nothing means the copies never touched the
        # body - treat that as a no-op error, like extrude Cut does
        if ok and prev_vol is not None and abs(shp.Volume - prev_vol) < 1e-6:
            ok = False
    except Exception:
        ok = False
    if not ok:
        for child in list(getattr(nb, "Group", [])):
            try:
                d.removeObject(child.Name)
            except Exception:
                pass
        for nm in (boolean.Name, nb.Name):
            try:
                if d.getObject(nm) is not None:
                    d.removeObject(nm)
            except Exception:
                pass
        if prev_tip_name and d.getObject(prev_tip_name) is not None:
            body.Tip = d.getObject(prev_tip_name)
        d.recompute()
        raise RpcError(APP_ERROR, what)
    return boolean


_FEATURE_NOUNS = {
    "Mirrored": "mirror", "LinearPattern": "pattern", "PolarPattern": "pattern",
    "Revolution": "revolve", "Groove": "revolve",
    "AdditivePipe": "sweep", "SubtractivePipe": "sweep",
    "AdditiveLoft": "loft", "SubtractiveLoft": "loft",
}


def _finish_transform(d, body, feat, prev_tip_name, before_shape, operation, what):
    """Common tail for Mirror / LinearPattern / PolarPattern / Revolve / Sweep /
    Loft. `feat` has already been built (and, for Transformed types, fused via
    _apply_transformed). operation: join keeps it; cut / intersect / newbody
    re-express the feature's net contribution against the body."""
    op = (operation or "join").lower()
    # grab everything we need to describe/read `feat` BEFORE it might be
    # removed below - a deleted FreeCAD object raises ReferenceError on any
    # further attribute access, even feat.TypeId
    noun = next((n for tid, n in _FEATURE_NOUNS.items() if tid in feat.TypeId), "feature")
    if op == "join":
        build.finalize_or_rollback(d, body, feat, prev_tip_name, [], what,
                                   check_made=True)
        return
    # the geometry the transform added = after - before
    after = getattr(body, "Shape", None)
    if after is None or after.isNull() or before_shape is None:
        build.finalize_or_rollback(d, body, feat, prev_tip_name, [], what,
                                   check_made=True)
        return
    try:
        tool = after.cut(before_shape)
    except Exception:
        tool = None
    # drop the additive feature, restore the pre-feature tip
    try:
        if prev_tip_name and d.getObject(prev_tip_name) is not None:
            body.Tip = d.getObject(prev_tip_name)
        d.removeObject(feat.Name)
        d.recompute()
    except Exception:
        pass
    if tool is None or tool.isNull() or getattr(tool, "Volume", 0.0) <= 1e-9:
        raise RpcError(APP_ERROR,
                       "that %s adds nothing where it can be %s - it does "
                       "not overlap the body" % (noun, op))
    _apply_result_boolean(d, body, prev_tip_name, tool, op,
                          "that %s produced no change - it does not "
                          "overlap the body" % noun,
                          prev_vol=getattr(before_shape, "Volume", None))
    d.recompute()


@method("pattern.linear")
def pattern_linear(direction=(1, 0, 0), count=3, spacing=20.0, directionRef=None,
                   scope="body", refs=None, operation="join"):
    body = _require_body()
    _solid_tip(body)  # ensure there is a solid
    d = body.Document
    prev_tip_name = getattr(getattr(body, "Tip", None), "Name", None)
    before = body.Shape.copy() if getattr(body, "Shape", None) is not None else None
    dir_tuple = _resolve_ref(d, body, directionRef) if directionRef else None  # before newObject
    originals = _transform_originals(body, scope, refs)
    p = body.newObject("PartDesign::LinearPattern", "LinearPattern")
    p.Label = next_label(body, "PartDesign::LinearPattern")
    p.Originals = originals
    if dir_tuple is not None:
        p.Direction = dir_tuple
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
    _finish_transform(d, body, p, prev_tip_name, before, operation,
                      "rectangular pattern produced an invalid shape - try fewer "
                      "copies or a different spacing / direction")
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
        base = src
        if src.TypeId == "PartDesign::Body":
            base = src.Tip
            # a feature being built right now has advanced body.Tip to itself but
            # has no shape yet - resolving against it would make a self-reference
            # (DAG error). Fall back to the last feature that actually has a solid.
            try:
                bs = getattr(base, "Shape", None)
                if bs is None or bs.isNull():
                    for o in reversed(list(src.Group)):
                        os_ = getattr(o, "Shape", None)
                        if os_ is not None and not os_.isNull() and os_.isValid():
                            base = o
                            break
            except Exception:
                pass
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
def feature_mirror(planeRef=None, plane="YZ", scope="body", refs=None,
                   operation="join"):
    body = _require_body()
    _solid_tip(body)  # ensure there is a solid
    d = body.Document
    prev_tip_name = getattr(getattr(body, "Tip", None), "Name", None)
    before = body.Shape.copy() if getattr(body, "Shape", None) is not None else None
    plane_tuple = _resolve_ref(d, body, planeRef) if planeRef else \
        (build.origin_plane(body, plane), [""])  # resolve before newObject
    originals = _transform_originals(body, scope, refs)
    m = body.newObject("PartDesign::Mirrored", "Mirrored")
    m.Label = next_label(body, "PartDesign::Mirrored")
    m.Originals = originals
    m.MirrorPlane = plane_tuple
    _apply_transformed(body, m)
    _finish_transform(d, body, m, prev_tip_name, before, operation,
                      "mirror produced an invalid shape - the mirror plane may "
                      "cut through the solid")
    return tree_get()


def _ref_point(d, body, ref):
    """A representative world point for a UI reference (vertex / edge / face /
    plane / origin) - used to place a datum 'to' that object."""
    from FreeCAD import Vector
    k = ref.get("kind")
    obj, subs = _resolve_ref(d, body, ref)
    sub = subs[0] if isinstance(subs, (list, tuple)) and subs else subs
    try:
        if sub:
            shp = obj.Shape.getElement(sub)
            if k == "vertex":
                return Vector(shp.Point)
            return Vector(shp.CenterOfMass)
        p = getattr(obj, "Placement", None)
        if p is not None:
            return Vector(p.Base)
    except Exception:
        pass
    return Vector(0, 0, 0)


def _ref_kind_of(link):
    """(obj,[sub]) -> 'face' | 'edge' | 'vertex' | 'plane'."""
    sub = (link[1][0] if isinstance(link, (tuple, list)) and link[1] else "") or ""
    if sub.startswith("Face"):
        return "face"
    if sub.startswith("Edge"):
        return "edge"
    if sub.startswith("Vertex"):
        return "vertex"
    tid = getattr(link[0] if isinstance(link, (tuple, list)) else link, "TypeId", "")
    if "Plane" in tid or "Origin" in tid:
        return "plane"
    return "face"


def _is_planar_face_link(link):
    obj, subs = (link[0], link[1]) if isinstance(link, (tuple, list)) else (link, [])
    sub = subs[0] if subs else ""
    try:
        if sub.startswith("Face"):
            f = obj.Shape.getElement(sub)
            return type(f.Surface).__name__ == "Plane", f
        if "Plane" in getattr(obj, "TypeId", "") or "Origin" in getattr(obj, "TypeId", ""):
            return True, None
    except Exception:
        pass
    return False, None


def _midplane_placement(d, body, linkA, linkB):
    """World Placement of the plane midway between two planar faces / planes."""
    from FreeCAD import Placement, Vector, Rotation

    def origin_normal(link):
        obj, subs = link[0], link[1]
        sub = subs[0] if subs else ""
        if sub.startswith("Face"):
            f = obj.Shape.getElement(sub)
            c = f.CenterOfMass
            n = f.normalAt(*f.Surface.parameter(c))
            return c, n
        p = obj.Placement
        return p.Base, p.Rotation.multVec(Vector(0, 0, 1))

    cA, nA = origin_normal(linkA)
    cB, nB = origin_normal(linkB)
    mid = (cA + cB).multiply(0.5)
    # normal: if the two faces face each other, use their average direction
    nrm = nA if nA.dot(nB) >= 0 else nA - nB
    if nrm.Length < 1e-9:
        nrm = nA
    nrm.normalize()
    return Placement(mid, Rotation(Vector(0, 0, 1), nrm))


_PLANE_MODES = ["FlatFace", "ThreePointsPlane", "OXY", "NormalToEdge", "ParallelPlane"]
_AXIS_MODES = {
    "2v": "TwoPointLine", "2f": "IntersectionLine",
    "1f": "Normal", "1e": "Tangent",
}


def _attach_datum(d, body, obj, kind, refs, offset=0.0, angle=0.0, flip=False):
    """Attach a PartDesign::Plane / Line / Point to `refs` (a list of GeomRef),
    choosing the MapMode from the reference set. `kind` is 'plane'|'axis'|'point'.
    offset/angle/flip are applied via AttachmentOffset (plane / axis)."""
    from FreeCAD import Placement, Vector, Rotation
    links = [_resolve_ref(d, body, r) for r in (refs or []) if r]
    kinds = [_ref_kind_of(l) for l in links]
    n = len(links)
    sign = -1.0 if flip else 1.0

    if kind == "plane":
        planar = [_is_planar_face_link(l)[0] for l in links]
        if n == 2 and all(planar):
            obj.MapMode = "Deactivated"
            obj.Placement = _midplane_placement(d, body, links[0], links[1])
            d.recompute()
        else:
            obj.AttachmentSupport = links
            if n == 3 and all(k == "vertex" for k in kinds):
                mode = "ThreePointsPlane"
            elif n >= 2 and all(k == "edge" for k in kinds):
                mode = "OXY"
            elif n == 1 and kinds[0] == "edge":
                mode = "NormalToEdge"
            elif n >= 2 and "vertex" in kinds:
                mode = "ParallelPlane"
            else:
                mode = "FlatFace"
            for m in [mode] + [x for x in _PLANE_MODES if x != mode] + ["Deactivated"]:
                try:
                    obj.MapMode = m
                    d.recompute()
                    break
                except Exception:
                    continue
        obj.AttachmentOffset = Placement(Vector(0, 0, sign * float(offset)),
                                         Rotation(Vector(1, 0, 0), float(angle)))
        d.recompute()
        return

    if kind == "axis":
        obj.AttachmentSupport = links
        key = ("2v" if n >= 2 and all(k == "vertex" for k in kinds)
               else "2f" if n >= 2 and all(k in ("face", "plane") for k in kinds)
               else "1f" if n == 1 and kinds[0] in ("face", "plane")
               else "1e" if n == 1 and kinds[0] == "edge"
               else None)
        for m in ([_AXIS_MODES[key]] if key else []) + ["Tangent", "TwoPointLine",
                  "Normal", "IntersectionLine", "AxisOfCurvature", "Deactivated"]:
            try:
                obj.MapMode = m
                d.recompute()
                break
            except Exception:
                continue
        if float(offset):
            obj.AttachmentOffset = Placement(Vector(0, 0, sign * float(offset)), Rotation())
        d.recompute()
        return

    # point
    obj.AttachmentSupport = links
    if n == 1 and kinds[0] == "vertex":
        _mode_or_manual(d, obj, ["Vertex"], None)
    elif n == 1 and kinds[0] in ("face", "plane"):
        _mode_or_manual(d, obj, ["CenterOfMass"], None)
    elif n == 1 and kinds[0] == "edge":
        e = links[0][0].Shape.getElement(links[0][1][0])
        try:
            u0, u1 = e.ParameterRange
            pmid = e.valueAt(0.5 * (u0 + u1))
        except Exception:
            pmid = e.CenterOfMass
        _mode_or_manual(d, obj, ["MidPoint", "CenterOfMass"], pmid)
    elif n >= 2 and all(k == "edge" for k in kinds):
        eA = links[0][0].Shape.getElement(links[0][1][0])
        eB = links[1][0].Shape.getElement(links[1][1][0])
        try:
            d0, pts, _ = eA.distToShape(eB)
            pnt = pts[0][0]
        except Exception:
            pnt = eA.CenterOfMass
        _mode_or_manual(d, obj, ["IntersectionPoint"], pnt)
    else:
        _mode_or_manual(d, obj, ["IntersectionPoint", "CenterOfMass"], None)
    d.recompute()


def _mode_or_manual(d, obj, modes, fallback_point):
    """Try each MapMode; if none produced a real placement, drop to Deactivated
    at `fallback_point` (a Vector) when given."""
    from FreeCAD import Placement, Vector, Rotation
    for m in modes:
        try:
            obj.MapMode = m
            d.recompute()
            b = obj.Placement.Base
            if fallback_point is None or (b - fallback_point).Length < 1e-6 or b.Length > 1e-9:
                return
        except Exception:
            continue
    if fallback_point is not None:
        obj.MapMode = "Deactivated"
        obj.Placement = Placement(Vector(fallback_point), Rotation())
        d.recompute()


@method("datum.plane")
def datum_plane(baseRef=None, basePlane="XY", offset=10.0, targetRef=None,
                refs=None, angle=0.0, flip=False):
    body = _require_body()
    d = body.Document
    pl = body.newObject("PartDesign::Plane", "DatumPlane")
    pl.Label = next_label(body, "PartDesign::Plane")
    ref_list = list(refs or [])
    if not ref_list and baseRef:
        ref_list = [baseRef]
    if targetRef:
        ref_list.append(targetRef)
    if not ref_list:
        role = basePlane if basePlane.endswith("_Plane") else basePlane.upper() + "_Plane"
        ref_list = [{"kind": "origin", "role": role}]
    _attach_datum(d, body, pl, "plane", ref_list, offset, angle, flip)
    session.set_datum_shown(pl.Name, True)  # new datums are shown, like Fusion
    pl.Visibility = True
    d.recompute()
    return tree_get()


@method("datum.planePreview")
def datum_plane_preview(baseRef=None, basePlane="XY", offset=10.0, targetRef=None,
                        refs=None, angle=0.0, flip=False):
    """Where an Offset Plane would land, as a world frame for a viewport ghost.
    Builds a throwaway PartDesign::Plane, reads its placement, removes it."""
    body = _require_body()
    d = body.Document
    from FreeCAD import Placement, Vector, Rotation
    pl = body.newObject("PartDesign::Plane", "__preview_plane")
    try:
        ref_list = list(refs or [])
        if not ref_list and baseRef:
            ref_list = [baseRef]
        if targetRef:
            ref_list.append(targetRef)
        if not ref_list:
            role = basePlane if basePlane.endswith("_Plane") else basePlane.upper() + "_Plane"
            ref_list = [{"kind": "origin", "role": role}]
        _attach_datum(d, body, pl, "plane", ref_list, offset, angle, flip)
        d.recompute()
        dist = float(offset)
        p = pl.Placement
        ox = p.multVec(Vector(1, 0, 0)).sub(p.Base)
        oy = p.multVec(Vector(0, 1, 0)).sub(p.Base)
        oz = p.multVec(Vector(0, 0, 1)).sub(p.Base)
        try:
            size = max(20.0, body.Shape.BoundBox.DiagonalLength * 0.35)
        except Exception:
            size = 40.0
        return {
            "origin": [p.Base.x, p.Base.y, p.Base.z],
            "x": [ox.x, ox.y, ox.z],
            "y": [oy.x, oy.y, oy.z],
            "z": [oz.x, oz.y, oz.z],
            "size": size,
            "distance": dist,
        }
    finally:
        try:
            d.removeObject(pl.Name)
            d.recompute()
        except Exception:
            pass


@method("datum.axis")
def datum_axis(refs=None, ref=None, offset=0.0, flip=False):
    """Construction axis from a reference set: 1 straight edge (along it),
    1 planar face (its normal), 2 vertices (line through), 2 planar faces
    (their intersection). refs = [GeomRef, ...]."""
    body = _require_body()
    d = body.Document
    ax = body.newObject("PartDesign::Line", "DatumLine")
    ax.Label = next_label(body, "PartDesign::Line")
    ref_list = list(refs or [])
    if not ref_list and ref:
        ref_list = [ref]
    if ref_list:
        _attach_datum(d, body, ax, "axis", ref_list, offset=offset, flip=flip)
    session.set_datum_shown(ax.Name, True)
    ax.Visibility = True
    d.recompute()
    return tree_get()


@method("datum.point")
def datum_point(ref=None, refs=None):
    """Construction point: 1 vertex, 1 edge (midpoint), 1 planar face (centroid),
    2 edges (nearest / intersection point). refs = [GeomRef, ...]."""
    body = _require_body()
    d = body.Document
    pt = body.newObject("PartDesign::Point", "DatumPoint")
    pt.Label = next_label(body, "PartDesign::Point")
    ref_list = list(refs or [])
    if not ref_list and ref:
        ref_list = [ref]
    if ref_list:
        _attach_datum(d, body, pt, "point", ref_list)
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


@method("feature.previewUpdate")
def feature_preview_update(featureId=None, props=None):
    """Fast path for live editing: mutate an EXISTING feature's parameters in
    place and recompute once - no undo, no recreate, no full-scene rebuild.
    Returns just the affected body's fresh mesh buffer so the shell can swap a
    single geometry. `props` maps FreeCAD property names to values, e.g.
    {"Length": 12.5, "Reversed": true} for a pad, {"Radius": 3} for a fillet.

    Registered in registry._NO_TXN so these tweaks add no undo steps - one undo
    of the original create still removes the whole preview feature.
    """
    d = session.doc(create=False)
    if d is None:
        raise RpcError(APP_ERROR, "no document")
    obj = d.getObject(featureId) if featureId else None
    if obj is None:
        raise RpcError(APP_ERROR, "no object %r" % featureId)

    for k, val in (props or {}).items():
        if not hasattr(obj, k):
            continue
        try:
            cur = getattr(obj, k)
            if isinstance(cur, bool):
                nv = bool(val)
            elif isinstance(cur, int) and not isinstance(cur, bool):
                nv = int(round(float(val)))
            elif isinstance(cur, float):
                nv = float(val)
            else:
                nv = val
            if nv != cur:          # skip no-op writes (some are deprecation-noisy)
                setattr(obj, k, nv)
        except Exception:
            pass

    d.recompute()

    body = None
    try:
        body = obj.getParentGeoFeatureGroup()
    except Exception:
        body = None

    # scene.get keys a solid's mesh by the *Body* name (not the tip feature), so
    # the shell can only swap it in place if we answer with the same id + the
    # body's resulting shape. Returning the tip feature's name instead makes the
    # shell append a second mesh - you then see both the old and new extrude.
    owner = body if (body is not None and body.TypeId == "PartDesign::Body") else obj
    shape = getattr(owner, "Shape", None)
    if shape is None or shape.isNull():
        tip = getattr(body, "Tip", None) if body is not None else None
        shape = getattr(tip, "Shape", None)
    ok = shape is not None and not shape.isNull()
    try:
        ok = ok and shape.isValid()
    except Exception:
        ok = False
    if not ok:
        raise RpcError(APP_ERROR,
                       "that value produced an invalid shape - try another")

    return {"mesh": _owner_mesh(owner, shape)}


@method("feature.previewSetBase")
def feature_preview_set_base(id=None, subs=None):
    """Live-preview path for a dress-up (fillet / chamfer / shell / draft / hole)
    whose EDGE or FACE set changed: re-point its Base to `subs` and recompute
    once, in place. No drain, no rebuild - so adding a second fillet edge just
    restyles the existing preview instead of it blinking away. In registry._NO_TXN."""
    d = session.doc(create=False)
    if d is None:
        raise RpcError(APP_ERROR, "no document")
    o = d.getObject(id) if id else None
    if o is None:
        raise RpcError(APP_ERROR, "no object %r" % id)
    base = getattr(o, "Base", None)
    if not base or not isinstance(base, tuple):
        raise RpcError(APP_ERROR, "%r has no editable Base" % id)
    o.Base = (base[0], [s for s in (subs or []) if s])
    d.recompute()
    body = None
    try:
        body = o.getParentGeoFeatureGroup()
    except Exception:
        body = None
    owner = body if (body is not None and body.TypeId == "PartDesign::Body") else o
    shape = getattr(owner, "Shape", None)
    ok = shape is not None and not shape.isNull()
    try:
        ok = ok and shape.isValid()
    except Exception:
        ok = False
    # the feature can error (bad edge link, size too big) while body.Shape still
    # holds the last good solid - surface that as a preview notice too
    try:
        st = getattr(o, "State", None) or []
        os_ = getattr(o, "Shape", None)
        if ("Error" in st) or ("Invalid" in st) or (os_ is None or os_.isNull()):
            ok = False
    except Exception:
        pass
    if not ok:
        raise RpcError(APP_ERROR,
                       "that edge / face selection produced an invalid shape - "
                       "try a smaller size or a different pick")
    return {"mesh": _owner_mesh(owner, shape)}


def _owner_mesh(owner, shape):
    """Tessellate `shape` (cached by signature) into a render buffer keyed by the
    owner's name - shared by feature.previewUpdate and feature.editPreview."""
    sig = _shape_sig(shape)
    cached = _TESS_CACHE.get(owner.Name)
    if sig is not None and cached is not None and cached[0] == sig:
        buf = dict(cached[1])
    else:
        buf = tessellate_shape(shape)
        if sig is not None:
            _TESS_CACHE[owner.Name] = (sig, buf)
    buf["sig"] = sig
    buf["id"] = owner.Name
    buf["label"] = owner.Label
    buf["visible"] = True
    col = session.body_color(owner.Name)
    if col:
        buf["color"] = col
    return buf


# --------------------------------------------------------------------------- #
# edit an existing feature: read its params/refs, write them back, live preview
# --------------------------------------------------------------------------- #

# FreeCAD TypeId -> the OpKind string the client dialog uses
_TYPE_KIND = {
    "PartDesign::Pad": "extrude",
    "PartDesign::Pocket": "extrude",
    "PartDesign::Revolution": "revolve",
    "PartDesign::Groove": "revolve",
    "PartDesign::Fillet": "fillet",
    "PartDesign::Chamfer": "chamfer",
    "PartDesign::Thickness": "shell",
    "PartDesign::Draft": "draft",
    "PartDesign::Hole": "hole",
    "PartDesign::Mirrored": "mirror",
    "PartDesign::LinearPattern": "patternLinear",
    "PartDesign::PolarPattern": "patternCircular",
}


def _profile_ref(o):
    """{kind:'sketch',id} or {kind:'face',bodyId,sub} for a feature's Profile.
    A hidden reuse-copy is reported as its SOURCE sketch so the UI re-picks the
    visible one."""
    prof = getattr(o, "Profile", None)
    if prof is None:
        return None
    if isinstance(prof, (tuple, list)):
        feat = prof[0] if prof else None
        subs = list(prof[1]) if len(prof) > 1 else []
        if feat is None:
            return None
        if getattr(feat, "TypeId", "") == "Sketcher::SketchObject":
            src = getattr(feat, build.REF_TAG, "")
            return {"kind": "sketch", "id": src or feat.Name}
        b = feat.getParentGeoFeatureGroup() or feat
        return {"kind": "face", "bodyId": b.Name, "sub": subs[0] if subs else ""}
    if getattr(prof, "TypeId", "") == "Sketcher::SketchObject":
        src = getattr(prof, build.REF_TAG, "")
        return {"kind": "sketch", "id": src or prof.Name}
    return None


def _axis_ref(o):
    ax = getattr(o, "ReferenceAxis", None)
    if not ax:
        return None
    feat, subs = (ax[0], list(ax[1])) if isinstance(ax, (tuple, list)) else (ax, [])
    if feat is None:
        return None
    role = getattr(feat, "Role", "")
    if role:
        return {"kind": "origin", "role": role}
    if getattr(feat, "TypeId", "") == "Sketcher::SketchObject":
        return {"kind": "sketch", "id": feat.Name, "sub": subs[0] if subs else None}
    b = feat.getParentGeoFeatureGroup() or feat
    return {"kind": "edge", "bodyId": getattr(b, "Name", ""), "sub": subs[0] if subs else ""}


def _link_ref(link):
    """A (obj,[sub]) attachment link (MirrorPlane / Axis / Direction) -> GeomRef."""
    if not link:
        return None
    feat, subs = (link[0], list(link[1])) if isinstance(link, (tuple, list)) else (link, [])
    if feat is None:
        return None
    role = getattr(feat, "Role", "")
    if role:
        return {"kind": "origin", "role": role}
    tid = getattr(feat, "TypeId", "")
    if tid in ("PartDesign::Plane", "PartDesign::Line", "PartDesign::Point"):
        return {"kind": "plane", "id": feat.Name}
    b = feat.getParentGeoFeatureGroup() or feat
    sub = subs[0] if subs and subs[0] else ""
    kind = "edge" if (sub or "").startswith("Edge") else "face" if (sub or "").startswith("Face") else "plane"
    if kind == "plane":
        return {"kind": "plane", "id": getattr(b, "Name", feat.Name)}
    return {"kind": kind, "bodyId": getattr(b, "Name", ""), "sub": sub}


def _transform_scope_of(body, o):
    """A committed Mirror/Pattern -> ('Body', []) or ('Features', [ids])."""
    orig = [getattr(x, "Name", "") for x in (getattr(o, "Originals", []) or [])]
    whole = [f.Name for f in _body_solid_features(body)]
    if set(orig) == set(whole):
        return "Body", []
    return "Features", orig


def _set_feature_values(o, values):
    """Write dialog OpValues back onto a PartDesign feature (best effort)."""
    T = o.TypeId
    v = values or {}

    def num(prop, key):
        if key in v and v[key] is not None:
            try:
                setattr(o, prop, float(v[key]))
            except Exception:
                pass

    def flag(prop, key):
        if key in v:
            try:
                setattr(o, prop, bool(v[key]))
            except Exception:
                pass

    if T in ("PartDesign::Pad", "PartDesign::Pocket"):
        num("Length", "length")
        flag("Reversed", "reversed")
        if "midplane" in v:
            try:
                if hasattr(o, "SideType"):
                    o.SideType = "Symmetric" if v["midplane"] else "Dimension"
                else:
                    o.Midplane = bool(v["midplane"])
            except Exception:
                pass
    elif T in ("PartDesign::Revolution", "PartDesign::Groove"):
        num("Angle", "angle")
        flag("Reversed", "reversed")
    elif T == "PartDesign::Fillet":
        num("Radius", "radius")
    elif T == "PartDesign::Chamfer":
        num("Size", "size")
    elif T == "PartDesign::Thickness":
        num("Value", "thickness")
    elif T == "PartDesign::Draft":
        num("Angle", "angle")
    elif T == "PartDesign::Hole":
        num("Diameter", "diameter")
        num("Depth", "depth")
    elif T == "PartDesign::LinearPattern":
        if "count" in v:
            try:
                o.Occurrences = int(v["count"])
            except Exception:
                pass
        if "spacing" in v and "count" in v:
            try:
                o.Length = float(v["spacing"]) * max(1, int(v["count"]) - 1)
            except Exception:
                pass
    elif T == "PartDesign::PolarPattern":
        if "count" in v:
            try:
                o.Occurrences = int(v["count"])
            except Exception:
                pass
        num("Angle", "angle")
    # PartDesign::Mirrored has only its plane (a ref, handled in _set_feature_refs)


def _set_feature_refs(d, o, body, refs):
    """Re-point a feature's Profile / Base / ReferenceAxis from UI refs."""
    r = refs or {}
    T = o.TypeId
    if T in ("PartDesign::Pad", "PartDesign::Pocket",
             "PartDesign::Revolution", "PartDesign::Groove"):
        pr = r.get("profile")
        if pr:
            if pr.get("kind") == "sketch":
                sk = d.getObject(pr.get("id") or "")
                if sk is not None:
                    o.Profile = build.reusable_profile(d, body, sk)
            elif pr.get("kind") == "face":
                src = d.getObject(pr.get("bodyId") or "")
                base = src.Tip if (src is not None and src.TypeId == "PartDesign::Body") else src
                if base is not None and pr.get("sub"):
                    o.Profile = (base, [pr["sub"]])
        ax = r.get("axis")
        if ax and hasattr(o, "ReferenceAxis"):
            try:
                o.ReferenceAxis = _resolve_ref(d, body, ax)
            except Exception:
                pass
    elif T in ("PartDesign::Fillet", "PartDesign::Chamfer",
               "PartDesign::Thickness", "PartDesign::Draft"):
        subs = r.get("edges") or r.get("faces")
        if subs and getattr(o, "Base", None):
            o.Base = (o.Base[0], list(subs))
    elif T in ("PartDesign::Mirrored", "PartDesign::LinearPattern",
               "PartDesign::PolarPattern"):
        pa = r.get("planeOrAxis") or r.get("axis")
        if pa:
            try:
                link = _resolve_ref(d, body, pa)
                if T == "PartDesign::Mirrored":
                    o.MirrorPlane = link
                elif T == "PartDesign::LinearPattern":
                    o.Direction = link
                else:
                    o.Axis = link
            except Exception:
                pass
        feats = r.get("features")
        if feats:
            picked = [d.getObject(x) for x in feats if d.getObject(x) is not None]
            if picked:
                o.Originals = picked
        elif r.get("scope") == "Body":
            o.Originals = _body_solid_features(body)


@method("feature.get")
def feature_get(id):
    """Everything the operation dialog needs to reopen a committed feature."""
    d, o = _obj(id)
    kind = _TYPE_KIND.get(o.TypeId)
    if kind is None:
        return {"id": id, "label": o.Label, "kind": None}
    T = o.TypeId
    values, refs = {}, {}
    if T in ("PartDesign::Pad", "PartDesign::Pocket"):
        values["length"] = _prop_value(o, "Length")
        values["reversed"] = bool(getattr(o, "Reversed", False))
        st = getattr(o, "SideType", None)
        values["midplane"] = (str(st) == "Symmetric") if st is not None \
            else bool(getattr(o, "Midplane", False))
        values["mode"] = "To object" if str(getattr(o, "Type", "Length")) == "UpToFace" else "Blind"
        values["operation"] = "Cut" if T == "PartDesign::Pocket" else "Join"
        refs["profile"] = _profile_ref(o)
    elif T in ("PartDesign::Revolution", "PartDesign::Groove"):
        values["angle"] = _prop_value(o, "Angle")
        values["cut"] = (T == "PartDesign::Groove")
        values["reversed"] = bool(getattr(o, "Reversed", False))
        refs["profile"] = _profile_ref(o)
        refs["axis"] = _axis_ref(o)
    elif T == "PartDesign::Fillet":
        values["radius"] = _prop_value(o, "Radius")
        refs["edges"] = list(o.Base[1]) if getattr(o, "Base", None) else []
    elif T == "PartDesign::Chamfer":
        values["size"] = _prop_value(o, "Size")
        refs["edges"] = list(o.Base[1]) if getattr(o, "Base", None) else []
    elif T == "PartDesign::Thickness":
        values["thickness"] = _prop_value(o, "Value")
        refs["faces"] = list(o.Base[1]) if getattr(o, "Base", None) else []
    elif T == "PartDesign::Draft":
        values["angle"] = _prop_value(o, "Angle")
        refs["faces"] = list(o.Base[1]) if getattr(o, "Base", None) else []
    elif T == "PartDesign::Hole":
        values["diameter"] = _prop_value(o, "Diameter")
        values["depth"] = _prop_value(o, "Depth")
    elif T in ("PartDesign::Mirrored", "PartDesign::LinearPattern",
               "PartDesign::PolarPattern"):
        body = o.getParentGeoFeatureGroup()
        scope, feat_ids = _transform_scope_of(body, o) if body is not None else ("Body", [])
        values["scope"] = scope
        values["operation"] = "Join"  # cut/intersect/newbody land as a Boolean / new body, not this feature
        if T == "PartDesign::Mirrored":
            refs["planeOrAxis"] = _link_ref(getattr(o, "MirrorPlane", None))
        elif T == "PartDesign::LinearPattern":
            values["count"] = int(getattr(o, "Occurrences", 2) or 2)
            occ = max(1, values["count"] - 1)
            values["spacing"] = round(float(getattr(o, "Length", 0) or 0) / occ, 4)
            refs["planeOrAxis"] = _link_ref(getattr(o, "Direction", None))
        else:
            values["count"] = int(getattr(o, "Occurrences", 2) or 2)
            values["angle"] = _prop_value(o, "Angle")
            refs["planeOrAxis"] = _link_ref(getattr(o, "Axis", None))
        if feat_ids:
            refs["features"] = feat_ids
    return {"id": id, "label": o.Label, "kind": kind,
            "values": values, "refs": refs, "exprs": session.feature_exprs(id)}


@method("feature.update")
def feature_update(id, values=None, refs=None, exprs=None):
    """Commit an edit: write params + refs onto the existing feature, full
    recompute, surgical rollback on failure, then return the tree."""
    d, o = _obj(id)
    if _TYPE_KIND.get(o.TypeId) is None:
        raise RpcError(APP_ERROR, "%s cannot be edited this way" % o.Label)
    body = o.getParentGeoFeatureGroup()
    prev_tip_name = body.Tip.Name if (body is not None and getattr(body, "Tip", None)) else None
    _set_feature_values(o, values or {})
    _set_feature_refs(d, o, body, refs or {})
    for prop, e in (exprs or {}).items():
        if not (e and hasattr(o, prop)):
            continue
        try:
            k = "angle" if prop in _ANGLE_PROPS else "length"
            setattr(o, prop, _expr.evaluate(str(e), k, session.params()))
            session.set_feature_expr(id, prop, str(e))
        except Exception:
            pass
    # Transformed features (Mirror / Pattern) only fold in with the dirty
    # recompute dance
    if o.TypeId in ("PartDesign::Mirrored", "PartDesign::LinearPattern",
                    "PartDesign::PolarPattern") and body is not None:
        _apply_transformed(body, o)
    build.finalize_or_rollback(
        d, body, o, prev_tip_name, [],
        "that change produced an invalid shape - revert it and try again")
    build.gc_profile_copies(d)
    d.recompute()
    return tree_get()


@method("feature.editPreview")
def feature_edit_preview(id=None, values=None, refs=None):
    """Live preview while editing: write params/refs, recompute ONLY this
    feature (not the downstream chain), return its body's fresh mesh. In
    registry._NO_TXN - adds no undo step."""
    d, o = _obj(id)
    body = o.getParentGeoFeatureGroup()
    _set_feature_values(o, values or {})
    _set_feature_refs(d, o, body, refs or {})
    try:
        d.recompute([o, body] if body is not None else [o])
    except Exception:
        d.recompute()
    owner = body if (body is not None and body.TypeId == "PartDesign::Body") else o
    shape = getattr(owner, "Shape", None)
    if shape is None or shape.isNull():
        tip = getattr(body, "Tip", None) if body is not None else None
        shape = getattr(tip, "Shape", None)
    ok = shape is not None and not shape.isNull()
    try:
        ok = ok and shape.isValid()
    except Exception:
        ok = False
    if not ok:
        raise RpcError(APP_ERROR, "that value produced an invalid shape - try another")
    return {"mesh": _owner_mesh(owner, shape)}


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


_REOPEN_CONSTRAINTS = {
    "Horizontal", "Vertical", "Parallel", "Perpendicular", "Equal", "Tangent",
    "Coincident", "PointOnObject", "Symmetric", "Distance", "DistanceX",
    "DistanceY", "Radius", "Diameter",
}


def _reopen_constraints(sk, geo_to_ent):
    """The sketch's constraints in the 2D editor's recorded format, addressing
    geometry by the editor entity index (`geo`). geoIds the editor does not know
    (datum axes: -1/-2, or filtered geometry) pass straight through as `geo`."""
    def ref(gid, pos):
        r = {"geo": geo_to_ent.get(gid, gid)}  # datum ids (<0) pass straight through
        if pos:
            r["pt"] = int(pos)
        return r

    def real(g):  # -1/-2 are the datum axes; anything past that is "unset"
        return g is not None and g >= -2

    out = []
    for c in sk.Constraints:
        t = c.Type
        if t not in _REOPEN_CONSTRAINTS:
            continue
        et = ("Distance" if t in ("Distance", "DistanceX", "DistanceY")
              else "Radius" if t in ("Radius", "Diameter") else t)
        refs = [ref(c.First, c.FirstPos)]
        # Radius is always single-ref; a plain line-length Distance has no
        # Second, but a point-to-point / point-to-line Distance does - keep it
        if et != "Radius" and real(getattr(c, "Second", None)):
            refs.append(ref(c.Second, c.SecondPos))
        if t == "Symmetric" and real(getattr(c, "Third", None)):
            refs.append(ref(c.Third, c.ThirdPos))
        item = {"type": et, "refs": refs}
        if et in ("Distance", "Radius"):
            item["value"] = float(c.Value)
        out.append(item)
    return out


@method("sketch.reopen")
def sketch_reopen(sketchId):
    """Re-enter an existing sketch for editing. Returns its plane frame, its
    geometry as editor entities, and its constraints (so dimensions / relations
    survive the round trip)."""
    d, sk = _obj(sketchId)
    if sk.TypeId != "Sketcher::SketchObject":
        raise RpcError(APP_ERROR, "%r is not a sketch" % sketchId)
    sk.Visibility = True
    ents = []
    geo_to_ent = {}
    for gid, g in enumerate(sk.Geometry):
        t = g.TypeId
        if t == "Part::GeomLineSegment":
            ent = {"type": "line",
                   "a": [g.StartPoint.x, g.StartPoint.y],
                   "b": [g.EndPoint.x, g.EndPoint.y]}
        elif t == "Part::GeomCircle":
            ent = {"type": "circle", "c": [g.Center.x, g.Center.y], "r": g.Radius}
        elif t == "Part::GeomArcOfCircle":
            ent = {"type": "arc", "c": [g.Center.x, g.Center.y], "r": g.Radius,
                   "a0": g.FirstParameter, "a1": g.LastParameter}
        elif t == "Part::GeomBSplineCurve":
            try:
                pts = [[p.x, p.y] for p in g.discretize(Number=max(4, g.NbPoles * 3))]
            except Exception:
                pts = [[p.x, p.y] for p in g.getPoles()]
            ent = {"type": "spline", "pts": pts}
        else:
            continue
        if getattr(g, "Construction", False):
            ent["construction"] = True
        geo_to_ent[gid] = len(ents)
        ents.append(ent)
    d.recompute()
    body = sk.getParentGeoFeatureGroup()
    fr = _frame(sk)
    return {"sketchId": sketchId, "bodyId": body.Name if body else None,
            "frame": fr, "entities": ents,
            "constraints": _reopen_constraints(sk, geo_to_ent),
            "refGeom": _face_ref_geom(sk, fr)}


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
        elif t == "spline":
            pts = [Vector(q[0], q[1], 0) for q in el.get("pts", [])]
            if len(pts) >= 2:
                bs = Part.BSplineCurve()
                try:
                    bs.interpolate(pts)
                except Exception:
                    bs.buildFromPoles(pts)
                ids.append(sk.addGeometry(bs, cons))
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

    # per client constraint: the sketch ConstraintIndex it became, or None if it
    # was rejected / errored. Callers that care (sketch.solve) use this to tell
    # an over-constraint apart from a mapping glitch.
    applied = []
    for c in constraints or []:
        ct = c.get("type")
        refs = c.get("refs", [])
        before = int(sk.ConstraintCount)
        try:
            if ct in ("Distance", "Radius", "Diameter") and refs:
                v = float(c.get("value", 0) or 0)
                if v > 0 and len(refs) >= 2:
                    # point-to-point, or point-to-line (2nd ref has no pt)
                    p2 = refs[1].get("pt")
                    if p2 is not None:
                        sk.addConstraint(Sketcher.Constraint(
                            "Distance",
                            gid(refs[0]), int(refs[0].get("pt", 1)),
                            gid(refs[1]), int(p2), v))
                    else:
                        sk.addConstraint(Sketcher.Constraint(
                            "Distance",
                            gid(refs[0]), int(refs[0].get("pt", 1)),
                            gid(refs[1]), v))
                elif v > 0:
                    if refs[0].get("pt") is not None and ct == "Distance":
                        # a lone point ref with no partner - skip (no meaning)
                        pass
                    else:
                        sk.addConstraint(Sketcher.Constraint(ct, gid(refs[0]), v))
            elif ct in ("Horizontal", "Vertical") and refs:
                if len(refs) >= 2 and refs[0].get("pt") is not None:
                    # between two points: same Y (Horizontal) / same X (Vertical)
                    try:
                        sk.addConstraint(Sketcher.Constraint(
                            ct,
                            gid(refs[0]), int(refs[0].get("pt", 1)),
                            gid(refs[1]), int(refs[1].get("pt", 1))))
                    except Exception:
                        sk.addConstraint(Sketcher.Constraint(
                            "DistanceY" if ct == "Horizontal" else "DistanceX",
                            gid(refs[0]), int(refs[0].get("pt", 1)),
                            gid(refs[1]), int(refs[1].get("pt", 1)), 0.0))
                else:
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
            elif ct in ("Symmetric", "Midpoint") and len(refs) >= 3:
                # third point lands at the symmetry centre of the first two -
                # i.e. the midpoint of a line when refs 0/1 are its endpoints
                sk.addConstraint(Sketcher.Constraint(
                    "Symmetric",
                    gid(refs[0]), int(refs[0].get("pt", 1)),
                    gid(refs[1]), int(refs[1].get("pt", 2)),
                    gid(refs[2]), int(refs[2].get("pt", 1))))
        except Exception:
            pass
        now = int(sk.ConstraintCount)
        # 1-based sketch constraint index (matches ConflictingConstraints etc.),
        # or None if this client constraint was rejected outright
        applied.append(now if now > before else None)
    return applied


_REOPEN_GEO_TIDS = ("Part::GeomLineSegment", "Part::GeomCircle",
                    "Part::GeomArcOfCircle", "Part::GeomBSplineCurve")


def _remove_matching_constraints(sk, removed):
    """Delete constraints from a reopened sketch that the editor dropped. The
    editor addresses geometry by entity index; rebuild the same index->geoId map
    sketch.reopen used. Matches on type + primary geoId (+ point); value ignored
    so an edited-then-deleted dimension still matches."""
    ent_to_geo = {}
    ei = 0
    for gid, g in enumerate(sk.Geometry):
        if g.TypeId in _REOPEN_GEO_TIDS:
            ent_to_geo[ei] = gid
            ei += 1
    for want in removed or []:
        wt = want.get("type")
        wrefs = want.get("refs", [])
        if not wrefs:
            continue
        r0 = wrefs[0]
        raw = int(r0["geo"]) if "geo" in r0 else None
        if raw is None:
            continue
        wg = ent_to_geo.get(raw, raw)  # editor index -> geoId (datum ids pass through)
        wp = int(r0.get("pt", 0))
        for ci in range(int(sk.ConstraintCount) - 1, -1, -1):
            con = sk.Constraints[ci]
            if con.Type != wt:
                continue
            if int(getattr(con, "First", -2000)) != wg:
                continue
            if wp and int(getattr(con, "FirstPos", 0)) != wp:
                continue
            try:
                sk.delConstraint(ci)
            except Exception:
                pass
            break


def _strip_redundant_constraints(sk, d, max_passes=8):
    """Delete the constraints FreeCAD flags as redundant / partially redundant,
    re-solving between passes because removing one can expose another. Leaves
    conflicting constraints alone (a real user contradiction). Returns how many
    were dropped."""
    dropped = 0
    for _ in range(max_passes):
        try:
            red = sorted(
                {int(i) for i in getattr(sk, "RedundantConstraints", ())} |
                {int(i) for i in getattr(sk, "PartiallyRedundantConstraints", ())},
                reverse=True,
            )
        except Exception:
            break
        if not red:
            break
        removed_any = False
        for ci in red:
            if 1 <= ci <= int(sk.ConstraintCount):
                try:
                    sk.delConstraint(ci - 1)
                    dropped += 1
                    removed_any = True
                except Exception:
                    pass
        try:
            d.recompute()
        except Exception:
            pass
        if not removed_any:
            break
    return dropped


@method("sketch.finish")
def sketch_finish(sketchId, autoConstrain=True, elements=None, constraints=None,
                  removedConstraints=None):
    """Commit geometry + manual constraints and close the sketch in one call
    (editor sends everything at once so there is a single recompute)."""
    d, sk = _obj(sketchId)
    if removedConstraints:
        _remove_matching_constraints(sk, removedConstraints)
    emap = _add_sketch_elements(sk, elements) if elements else []
    if constraints:
        _apply_sketch_constraints(sk, constraints, emap)
    if autoConstrain:
        _auto_constrain(sk)
    d.recompute()

    # _auto_constrain (and dimensioning opposite sides of a rect) can leave
    # redundant constraints that stop the solver forming a closed wire and make
    # a NULL pad - strip them and re-solve until clean
    dropped = _strip_redundant_constraints(sk, d)

    sk.Visibility = True
    # a re-finished (edited) sketch: push the change into any hidden copies that
    # other features were built from, so "edit the sketch" updates them all
    build.sync_ref_copies(d, sk)
    d.recompute()
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
        "droppedRedundant": dropped,
    }


def _auto_constrain(sk):
    """Cheap auto-constraints: weld near-coincident endpoints, snap near-axis
    lines to horizontal / vertical. Enough to make hand-drawn sketches behave.
    Skips anything already constrained so it does not pile redundant constraints
    on geometry that arrived with its own (e.g. a rectangle)."""
    import Sketcher
    n = sk.GeometryCount
    welded = set()      # (geoId, posId) already in a Coincident
    hv = set()          # geoId already Horizontal or Vertical (line-level)
    for c in sk.Constraints:
        if c.Type == "Coincident":
            welded.add((c.First, c.FirstPos))
            welded.add((c.Second, c.SecondPos))
        elif c.Type in ("Horizontal", "Vertical"):
            # a line-level H/V has an unset Second; either way the line is done
            if int(getattr(c, "FirstPos", 0)) == 0:
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


@method("sketch.solve")
def sketch_solve(elements=None, constraints=None, sketchId=None):
    """Run the editor's current geometry + constraints through the real solver
    in a throwaway document. Returns the solved coordinates plus which elements
    still have free degrees of freedom (so the editor can grey out the rest).
    Never touches the live document."""
    prev = App.ActiveDocument.Name if App.ActiveDocument else None
    sd = App.newDocument("gwtcad_solve_scratch")
    try:
        sk = sd.addObject("Sketcher::SketchObject", "S")
        emap = _add_sketch_elements(sk, elements or [])
        pre = int(sk.ConstraintCount)          # constraints the rect set etc. added
        clist = constraints or []
        applied = _apply_sketch_constraints(sk, clist, emap) if clist else []
        sd.recompute()
        try:
            free_pairs = sk.getGeometryWithDependentParameters()
            free_geo = set(int(p[0]) for p in free_pairs)
        except Exception:
            free_geo = None

        # map a sketch ConstraintIndex back to the client's 0-based index using
        # the per-constraint applied list (robust to extras the rect adds, and to
        # constraints FreeCAD rejected outright)
        _sk_to_client = {si: ci for ci, si in enumerate(applied) if si is not None}

        def _client_idx(names):
            out = []
            for si in names or []:
                ci = _sk_to_client.get(int(si))
                if ci is not None:
                    out.append(ci)
            return out

        conflicting = _client_idx(getattr(sk, "ConflictingConstraints", ()))
        redundant = _client_idx(getattr(sk, "RedundantConstraints", ()))
        partial = _client_idx(getattr(sk, "PartiallyRedundantConstraints", ()))
        malformed = _client_idx(getattr(sk, "MalformedConstraints", ()))

        # a client constraint that did NOT make it in (and is not just a
        # duplicate we would have added anyway) is itself an over-constraint
        # signal - surface it so the editor's veto / precheck can act
        rejected = [ci for ci, si in enumerate(applied) if si is None]
        for ci in rejected:
            if ci not in redundant and ci not in conflicting:
                redundant.append(ci)
        geom = []
        free_elems = []
        for i, ids in enumerate(emap):
            gid0 = ids[0] if ids else None
            g = sk.Geometry[gid0] if gid0 is not None and gid0 < sk.GeometryCount else None
            t = g.TypeId if g is not None else None
            if t == "Part::GeomLineSegment":
                geom.append({"type": "line",
                             "a": [g.StartPoint.x, g.StartPoint.y],
                             "b": [g.EndPoint.x, g.EndPoint.y]})
            elif t == "Part::GeomCircle":
                geom.append({"type": "circle",
                             "c": [g.Center.x, g.Center.y], "r": g.Radius})
            elif t == "Part::GeomArcOfCircle":
                geom.append({"type": "arc",
                             "c": [g.Center.x, g.Center.y], "r": g.Radius,
                             "a0": g.FirstParameter, "a1": g.LastParameter})
            else:
                geom.append(None)
            if free_geo is None or any(x in free_geo for x in ids):
                free_elems.append(i)
        return {
            "geometry": geom,
            "free": free_elems,
            "fullyConstrained": bool(sk.FullyConstrained),
            "conflicting": conflicting,
            "redundant": redundant,
            "partiallyRedundant": partial,
            "malformed": malformed,
        }
    finally:
        try:
            App.closeDocument(sd.Name)
        except Exception:
            pass
        if prev and App.getDocument(prev) is not None:
            App.setActiveDocument(prev)


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
            # "" for a user construction plane; "XY_Plane" etc. for an origin plane
            "role": getattr(o, "Role", "") or "",
            "ptype": "origin" if getattr(o, "Role", "") else "construction",
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
    consumed_bodies = _boolean_consumed_bodies(d)
    helper_shapes = _xform_helper_features(d)
    for o in d.Objects:
        if o.Name in suppressed:
            continue
        if o.Name in helper_shapes:
            continue  # Part::Feature that only seeds a FeatureBase - drawn by the body
        tid = o.TypeId
        if tid in ("PartDesign::Body", "App::Link", "Part::Feature", "Mesh::Feature",
                   "Part::FeaturePython"):
            if tid == "PartDesign::Body" and session.is_rolled_empty(o.Name):
                continue
            if tid == "PartDesign::Body" and o.Name in consumed_bodies:
                continue  # tool body folded into a Boolean (e.g. extrude Intersect)
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
            if build.is_ref_copy(o):
                continue  # hidden internal copy of a reused sketch
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
        consumed_bodies = _boolean_consumed_bodies(d)
        for o in d.Objects:
            if o.TypeId != "PartDesign::Body":
                continue
            if o.Name in consumed_bodies:
                continue  # tool body folded into a Boolean (e.g. extrude Intersect)
            tip = getattr(o, "Tip", None)
            feats = []
            for f in o.Group:
                if f.TypeId == "App::Origin":
                    continue
                if build.is_ref_copy(f):
                    continue  # hidden internal copy of a reused sketch
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


def _reshow_loose_sketches(d):
    """A sketch not consumed by any feature (pad / pocket / revolve / loft /
    sweep) should be visible again once that feature is undone."""
    consumed = set()
    for o in d.Objects:
        for prop in ("Profile", "Sections", "Spine"):
            v = getattr(o, prop, None)
            if v is None:
                continue
            items = v if isinstance(v, (list, tuple)) else [v]
            for it in items:
                nm = getattr(it, "TypeId", "")
                if nm == "Sketcher::SketchObject":
                    consumed.add(it.Name)
    for o in d.Objects:
        if (o.TypeId == "Sketcher::SketchObject" and o.Name not in consumed
                and not build.is_ref_copy(o)):
            try:
                o.Visibility = True
            except Exception:
                pass
    build.gc_profile_copies(d)


@method("history.undo")
def history_undo():
    d = session.doc(create=False)
    can = d is not None and int(getattr(d, "UndoCount", 0)) > 0
    if can:
        d.undo()
        d.recompute()
        _reshow_loose_sketches(d)
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
        _reshow_loose_sketches(d)
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
        if build.is_ref_copy(f):
            f.Visibility = False
            continue
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
    # a label change touches no geometry - skip the recompute so the UI is snappy
    _d, o = _obj(id)
    o.Label = str(label)
    return {"id": id, "label": o.Label}


@method("feature.delete")
def feature_delete(id):
    d, o = _obj(id)
    body = o.getParentGeoFeatureGroup()
    d.removeObject(o.Name)
    d.recompute()
    build.gc_profile_copies(d)  # sweep hidden sketch copies this freed
    _ensure_body_tip(d, body)   # deleting the tip must not leave Tip dangling
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


def _sub_shape(d, ref):
    """The exact sub-shape a UI reference points at (edge / face / wire), or the
    whole Shape if the ref has no sub-element."""
    body = session.active_body(d)
    obj, subs = _resolve_ref(d, body, ref)
    sub = subs[0] if isinstance(subs, (list, tuple)) and subs else subs
    if sub and isinstance(sub, str) and hasattr(obj, "Shape"):
        try:
            return obj.Shape.getElement(sub)
        except Exception:
            pass
    return getattr(obj, "Shape", None)


def _new_surface(d, shape, label, color):
    nf = d.addObject("Part::Feature", label.replace(" ", ""))
    nf.Label = label
    nf.Shape = shape
    session.set_body_color(nf.Name, color)
    d.recompute()
    return nf


_SURF_COLOR = [0.53, 0.60, 0.70]


@method("surface.ruled")
def surface_ruled(refs=None):
    """A ruled surface stretched between two selected edges / wires."""
    d = session.doc()
    curves = []
    for r in (refs or [])[:2]:
        sh = _sub_shape(d, r)
        if sh is None:
            continue
        if sh.ShapeType == "Edge":
            curves.append(sh)
        elif sh.ShapeType == "Wire":
            curves.append(sh)
        elif sh.ShapeType == "Face" and sh.Wires:
            curves.append(sh.OuterWire)
    if len(curves) < 2:
        raise RpcError(APP_ERROR, "select two edges or wires")
    surf = Part.makeRuledSurface(curves[0], curves[1])
    _new_surface(d, surf, "Ruled Surface", _SURF_COLOR)
    return tree_get()


@method("surface.fill")
def surface_fill(refs=None):
    """Boundary patch - a face filling the closed loop of the selected edges."""
    d = session.doc()
    edges = []
    for r in (refs or []):
        sh = _sub_shape(d, r)
        if sh is None:
            continue
        if sh.ShapeType == "Edge":
            edges.append(sh)
        elif sh.ShapeType == "Wire":
            edges.extend(sh.Edges)
    if len(edges) < 2:
        raise RpcError(APP_ERROR, "select 2 or more boundary edges")
    face = None
    try:
        chains = Part.sortEdges(edges)
        wire = Part.Wire(chains[0])
        try:
            face = Part.makeFilledFace(wire.Edges)
        except Exception:
            face = None
        if face is None or face.isNull():
            face = Part.Face(wire)
    except Exception as e:
        raise RpcError(APP_ERROR, "could not fill that boundary: %s" % e)
    _new_surface(d, face, "Boundary Fill", _SURF_COLOR)
    return tree_get()


@method("surface.stitch")
def surface_stitch(refs=None):
    """Sew selected faces into one shell (becomes a solid if it fully closes)."""
    d = session.doc()
    faces = []
    for r in (refs or []):
        sh = _sub_shape(d, r)
        if sh is None:
            continue
        if sh.ShapeType == "Face":
            faces.append(sh)
        elif sh.ShapeType == "Shell":
            faces.extend(sh.Faces)
    if len(faces) < 2:
        raise RpcError(APP_ERROR, "select two or more faces")
    shell = Part.makeShell(faces)
    try:
        shell.sewShape()
    except Exception:
        pass
    out = shell
    try:
        if shell.isClosed():
            out = Part.makeSolid(shell)
    except Exception:
        pass
    _new_surface(d, out, "Stitched", _SURF_COLOR)
    return tree_get()


@method("surface.offset")
def surface_offset(refs=None, distance=1.0):
    """Offset the selected face / shell by a distance to make a new surface."""
    d = session.doc()
    src = None
    for r in (refs or []):
        sh = _sub_shape(d, r)
        if sh is not None and sh.ShapeType in ("Face", "Shell"):
            src = sh
            break
    if src is None:
        raise RpcError(APP_ERROR, "select a face or shell")
    dist = float(distance)
    off = None
    try:
        off = src.makeOffsetShape(dist, 1e-6)
    except Exception:
        off = None
    if off is None or off.isNull():
        # planar fallback: copy the face and slide it along its normal
        try:
            f = src.Faces[0] if src.ShapeType == "Shell" else src
            n = f.normalAt(*f.Surface.parameter(f.CenterOfMass))
            off = src.copy()
            off.translate(App.Vector(n).multiply(dist))
        except Exception as e:
            raise RpcError(APP_ERROR, "offset failed: %s" % e)
    _new_surface(d, off, "Offset Surface", _SURF_COLOR)
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


# KiCad .kicad_pcb import (registers kicad.* RPC methods on import)
from gwtcad import kicad as _kicad_methods  # noqa: E402,F401

# Fusion-parity feature modules. Each registers its own @method RPCs on import.
# Guarded so a problem in one module cannot take the whole sidecar down.
for _mod in ("primitives", "xform", "meshtools"):
    try:
        __import__("gwtcad." + _mod)
    except Exception as _e:  # pragma: no cover - surfaced in the sidecar log
        import sys as _sys
        print("[gwtcad] optional module %r failed to load: %s" % (_mod, _e),
              file=_sys.stderr)
