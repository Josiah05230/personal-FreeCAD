"""Mesh-tab RPC methods - the Fusion 360 MESH workspace on top of FreeCAD's
`Mesh` / `MeshPart` modules.

Every op works on a FreeCAD `Mesh::Feature` (`o.Mesh` is a `Mesh.MeshObject`).
`id` names the target mesh; when it is None the first `Mesh::Feature` in the doc
is used. Solids come in as `PartDesign::Body` / `Part::Feature`.

FreeCAD 1.1.1 notes (what this build actually exposes):
  - Mesh.MeshObject.decimate(tolerance, reduction)  - reduction in [0, 1]
  - Mesh.MeshObject.smooth("Laplace", iterations)   - int-only positional fails
  - trimByPlane(base, normal) exists but its kept-side is ambiguous, so plane
    cut is done geometrically by facet centroid side (deterministic).
  - getSeparateComponents() -> [MeshObject], harmonize/removeNonManifold*/
    removeDuplicated*/fixIndices/fixDegenerations/fillupHoles all present.
  - Part.Shape().makeShapeFromMesh(topology, tol) + Part.makeSolid works; there
    is no prismatic / organic reconstruction, so those modes degrade to faceted.
"""
import contextlib
import os as _os
import sys as _sys

import FreeCAD as App
import Mesh
import MeshPart
import Part
from FreeCAD import Vector

from .registry import method, RpcError, APP_ERROR
from . import session
from . import build

_MESH_COLOR = [0.62, 0.68, 0.75]

# origin-plane role -> plane normal (base is world origin)
_ROLE_NORMALS = {
    "XY_Plane": (0.0, 0.0, 1.0),
    "XZ_Plane": (0.0, 1.0, 0.0),
    "YZ_Plane": (1.0, 0.0, 0.0),
}


@contextlib.contextmanager
def _quiet():
    """Silence FreeCAD's C-level meshing progress bar - it writes straight to
    fd 1, which is the sidecar's READY / log channel."""
    saved = _os.dup(1)
    devnull = _os.open(_os.devnull, _os.O_WRONLY)
    try:
        _sys.stdout.flush()
        _os.dup2(devnull, 1)
        yield
    finally:
        _os.dup2(saved, 1)
        _os.close(devnull)
        _os.close(saved)


def _tree_with(**extra):
    """Standard tree payload (lazy import dodges the methods <-> meshtools cycle),
    with mesh-op detail attached under `mesh` for the client / smoke test."""
    from . import methods as _m
    out = _m.tree_get()
    if extra:
        out["mesh"] = extra
    return out


def _mesh_obj(id=None):
    d = session.doc(create=False)
    if d is None:
        raise RpcError(APP_ERROR, "no document")
    if id:
        o = d.getObject(id)
        if o is None or o.TypeId != "Mesh::Feature":
            raise RpcError(APP_ERROR, "no mesh body %r" % id)
        return d, o
    for o in d.Objects:
        if o.TypeId == "Mesh::Feature":
            return d, o
    raise RpcError(APP_ERROR, "no mesh body in the document")


def _solid_source(d, bodyId):
    """The solid to tessellate: `bodyId` if given, else the active body, else the
    first object carrying a real shape."""
    if bodyId:
        o = d.getObject(bodyId)
        if o is None:
            raise RpcError(APP_ERROR, "no object %r" % bodyId)
        return o
    cand = session.active_body(d)
    if cand is not None:
        sh = getattr(cand, "Shape", None)
        if sh is not None and not sh.isNull() and sh.Solids:
            return cand
    for o in d.Objects:
        if o.TypeId in ("PartDesign::Body", "Part::Feature", "Part::FeaturePython"):
            sh = getattr(o, "Shape", None)
            if sh is not None and not sh.isNull() and (sh.Solids or sh.Faces):
                return o
    raise RpcError(APP_ERROR, "no solid body to tessellate - create or import one first")


def _add_mesh_feature(d, mesh, label):
    nf = d.addObject("Mesh::Feature", "Mesh")
    nf.Mesh = mesh
    try:
        nf.Label = label
    except Exception:
        pass
    session.set_body_color(nf.Name, _MESH_COLOR)
    return nf


def _resolve_plane(d, plane_ref, base, normal):
    """(base, unit-normal) from an origin-plane role / datum name, else from the
    raw base + normal the client sent."""
    if plane_ref:
        role = _ROLE_NORMALS.get(plane_ref)
        if role is not None:
            return (0.0, 0.0, 0.0), role
        o = d.getObject(plane_ref) if d is not None else None
        pl = getattr(o, "Placement", None) if o is not None else None
        if pl is not None:
            bv = pl.Base
            nv = pl.Rotation.multVec(Vector(0, 0, 1))
            return (bv.x, bv.y, bv.z), (nv.x, nv.y, nv.z)
        # unknown ref -> fall through to the explicit base / normal
    b = tuple(float(x) for x in (base or [0.0, 0.0, 0.0]))
    n = tuple(float(x) for x in (normal or [0.0, 0.0, 1.0]))
    ln = (n[0] ** 2 + n[1] ** 2 + n[2] ** 2) ** 0.5 or 1.0
    return b, (n[0] / ln, n[1] / ln, n[2] / ln)


def _facet_side_cut(mesh, base, normal, keep_positive):
    """New mesh keeping whole facets whose centroid is on the wanted side of the
    plane. dot(centroid - base, normal) >= 0 is the positive side."""
    bx, by, bz = base
    nx, ny, nz = normal
    tris = []
    for f in mesh.Facets:
        p = f.Points
        cx = (p[0][0] + p[1][0] + p[2][0]) / 3.0
        cy = (p[0][1] + p[1][1] + p[2][1]) / 3.0
        cz = (p[0][2] + p[1][2] + p[2][2]) / 3.0
        side = (cx - bx) * nx + (cy - by) * ny + (cz - bz) * nz
        if (side >= 0.0) == keep_positive:
            tris.append(Vector(*p[0]))
            tris.append(Vector(*p[1]))
            tris.append(Vector(*p[2]))
    with _quiet():
        return Mesh.Mesh(tris)


def _try_fill(m, notes):
    for args in ((), (1000,), (0.0,)):
        try:
            m.fillupHoles(*args)
            notes.append("fillupHoles applied")
            return
        except Exception:
            continue
    notes.append("fill not done - no usable fillupHoles signature")


# --------------------------------------------------------------------------- #
# tessellation / conversion
# --------------------------------------------------------------------------- #

@method("mesh.fromBRep")
def mesh_from_brep(bodyId=None, deflection=0.1, angularDeflection=0.5, name=None):
    """Tessellate a solid body into a new Mesh::Feature. Hides the source body so
    the two do not z-fight."""
    d = session.doc()
    src = _solid_source(d, bodyId)
    shape = getattr(src, "Shape", None)
    if shape is None or shape.isNull():
        raise RpcError(APP_ERROR, "source body has no solid shape")
    with _quiet():
        m = MeshPart.meshFromShape(Shape=shape, LinearDeflection=float(deflection),
                                   AngularDeflection=float(angularDeflection), Relative=False)
    nf = _add_mesh_feature(d, m, name or (src.Label + " Mesh"))
    try:
        src.Visibility = False
    except Exception:
        pass
    d.recompute()
    return _tree_with(id=nf.Name, tris=nf.Mesh.CountFacets, source=src.Name, sourceHidden=True)


_RECOGNIZE_MIN_FACETS = 20     # ignore planar clusters smaller than this - noise,
                                # not a real designed flat (a rounded-corner sliver
                                # tessellates into a handful of near-coplanar tris)
_RECOGNIZE_PLANAR_DEV = 0.05   # radians - getPlanarSegments' coplanarity tolerance


def _submesh(facets, idx):
    """A standalone Mesh.Mesh holding just the given facet indices, so
    MeshPart.wireFromMesh (whole-mesh boundary only) can be run per-region."""
    tris = []
    for i in idx:
        p = facets[i].Points
        tris.append(Vector(*p[0]))
        tris.append(Vector(*p[1]))
        tris.append(Vector(*p[2]))
    with _quiet():
        return Mesh.Mesh(tris)


def _recognize_flats(mesh, min_facets=_RECOGNIZE_MIN_FACETS):
    """Find planar regions in `mesh` and rebuild each as a real, exact Part.Face
    (flat, with holes if the region has interior boundaries) instead of dozens/
    hundreds of triangle facets. Everything left over (rounds, freeform, noise)
    is returned separately, still faceted, for the caller to tessellate as-is.

    This is feature recognition for flats only - FreeCAD's Mesh module has a
    solid, reliable API for coplanar clustering (getPlanarSegments) but nothing
    equally reliable for round/cylindrical detection in this build, so rounds
    are intentionally left faceted rather than shipping a fragile curve fit.
    Returns (flat_faces, leftover_facet_indices, notes).
    """
    notes = []
    with _quiet():
        segs = mesh.getPlanarSegments(_RECOGNIZE_PLANAR_DEV, min_facets)
    facets = list(mesh.Facets)
    flats = []
    used = set()
    for idx in segs:
        if len(idx) < min_facets:
            continue
        try:
            sm = _submesh(facets, idx)
            wires = MeshPart.wireFromMesh(sm)
            if not wires:
                continue
            if len(wires) == 1:
                f = Part.Face(wires[0])
            else:
                # the largest wire is the outer boundary; the rest are holes
                by_size = sorted(wires, key=lambda w: -w.BoundBox.DiagonalLength)
                f = Part.Face(by_size[0]).cut([Part.Face(w) for w in by_size[1:]])
                f = f.Faces[0] if getattr(f, "Faces", None) else f
            if f is None or f.isNull() or not f.isValid():
                continue
        except Exception:
            continue
        flats.append(f)
        used.update(idx)
    leftover = [i for i in range(len(facets)) if i not in used]
    if flats:
        notes.append("recognized %d flat face(s) from %d planar region(s)" %
                     (len(flats), len(segs)))
    return flats, leftover, notes


@method("mesh.toSolid")
def mesh_to_solid(id=None, mode="faceted", sewTolerance=0.1, name=None):
    """Mesh -> BRep as a new PartDesign body (sketchable/fillet-able like any
    other body - not a bare Part::Feature). `mode`:
      - "faceted":  every facet becomes its own tiny flat face (old behaviour).
      - "flats" / "prismatic": recognize planar regions first and rebuild them
        as real exact faces; only genuinely curved/freeform area stays faceted.
        ("organic" also lands here - true NURBS surface fitting is unavailable
        in this build, so it degrades to the same flats-recognition pass.)
    An invalid result is still returned, with a note, rather than raising.
    """
    d, obj = _mesh_obj(id)
    notes = []
    mode = (mode or "faceted").lower()

    mesh = obj.Mesh
    if mode in ("flats", "prismatic", "organic"):
        if mode == "organic":
            notes.append("organic (NURBS) reconstruction unavailable in this build - "
                         "recognizing flats instead, rest stays faceted")
        flats, leftover, rec_notes = _recognize_flats(mesh)
        notes.extend(rec_notes)
        faces = list(flats)
        if leftover:
            rest = _submesh(list(mesh.Facets), leftover)
            rest_shape = Part.Shape()
            with _quiet():
                rest_shape.makeShapeFromMesh(rest.Topology, float(sewTolerance))
            faces.extend(rest_shape.Faces)
        if not faces:
            notes.append("nothing recognized or tessellated - falling back to plain faceted")
            shape = Part.Shape()
            with _quiet():
                shape.makeShapeFromMesh(mesh.Topology, float(sewTolerance))
        else:
            with _quiet():
                shell = Part.makeShell(faces)
                shell.sewShape()
            shape = shell
    else:
        shape = Part.Shape()
        with _quiet():
            shape.makeShapeFromMesh(mesh.Topology, float(sewTolerance))

    result = shape
    try:
        solid = Part.makeSolid(shape)
        if solid is not None and not solid.isNull():
            result = solid
    except Exception as e:
        notes.append("makeSolid failed (%s) - keeping open shell" % e)

    valid = False
    try:
        valid = bool(result.isValid())
    except Exception:
        pass
    if not valid:
        notes.append("result is not a valid solid - returned as-is (shell)")

    label = name or (obj.Label + " Solid")
    body = build.scratch_body_from_shape(d, result, label)
    body.Label = label
    session.set_body_color(body.Name, session.body_color(obj.Name) or _MESH_COLOR)
    try:
        obj.Visibility = False
    except Exception:
        pass
    d.recompute()
    return _tree_with(id=body.Name, source=obj.Name, mode=mode, valid=valid,
                      solids=len(getattr(result, "Solids", []) or []),
                      faces=len(getattr(result, "Faces", []) or []), notes=notes)


# --------------------------------------------------------------------------- #
# cleanup / editing
# --------------------------------------------------------------------------- #

@method("mesh.reduce")
def mesh_reduce(id=None, targetFactor=0.5, targetCount=0):
    """Decimate. targetCount>0 aims for that many triangles, else keep
    targetFactor (0..1) of them."""
    d, obj = _mesh_obj(id)
    m = obj.Mesh.copy()
    before = m.CountFacets
    tc = int(targetCount or 0)
    if tc > 0:
        target = max(1, min(before, tc))
    else:
        target = max(1, int(round(before * max(0.0, min(1.0, float(targetFactor))))))
    reduction = 1.0 - float(target) / max(1, before)

    bb = m.BoundBox
    diag = (bb.XLength ** 2 + bb.YLength ** 2 + bb.ZLength ** 2) ** 0.5 or 1.0
    done = None
    last = None
    # int-count form first - most direct when the build honours it
    try:
        mm = m.copy()
        mm.decimate(target)
        if mm.CountFacets < before:
            done = mm
    except Exception as e:
        last = e
    # decimate(tolerance, reduction): tolerance caps the allowed error, so walk
    # it up until the triangle count actually reaches the target
    if done is None or done.CountFacets > target * 1.15:
        for tol in (diag * 0.005, diag * 0.02, diag * 0.05, diag * 0.1, 0.1, 0.5, 1.0):
            try:
                mm = m.copy()
                mm.decimate(float(tol), float(reduction))
                if done is None or mm.CountFacets < done.CountFacets:
                    done = mm
                if done.CountFacets <= target * 1.05:
                    break
            except Exception as e:
                last = e
    if done is None:
        raise RpcError(APP_ERROR, "decimate failed: %s" % last)
    obj.Mesh = done
    d.recompute()
    return _tree_with(id=obj.Name, trisBefore=before, tris=obj.Mesh.CountFacets,
                      target=target, reduction=round(reduction, 4))


@method("mesh.smooth")
def mesh_smooth(id=None, iterations=2):
    """Laplacian smoothing for `iterations` passes."""
    d, obj = _mesh_obj(id)
    m = obj.Mesh.copy()
    n = max(1, int(iterations))
    try:
        m.smooth("Laplace", n)          # 1.1.1: smooth(method, iterations)
    except Exception:
        for _ in range(n):
            m.smooth()                  # no-arg form, one pass at a time
    obj.Mesh = m
    d.recompute()
    return _tree_with(id=obj.Name, tris=obj.Mesh.CountFacets, iterations=n)


@method("mesh.flipNormals")
def mesh_flip_normals(id=None):
    d, obj = _mesh_obj(id)
    m = obj.Mesh.copy()
    m.flipNormals()
    obj.Mesh = m
    d.recompute()
    return _tree_with(id=obj.Name, tris=obj.Mesh.CountFacets)


@method("mesh.repair")
def mesh_repair(id=None, fixNormals=True, fillHoles=True,
                removeNonManifold=True, removeDuplicates=True):
    """Best-effort cleanup - each call guarded, unavailable ones just noted."""
    d, obj = _mesh_obj(id)
    m = obj.Mesh.copy()
    applied = []
    notes = []

    def _do(name, *args):
        fn = getattr(m, name, None)
        if fn is None:
            notes.append(name + " n/a")
            return
        for a in (args, (), (0.0,)):
            try:
                fn(*a)
                applied.append(name)
                return
            except Exception:
                continue
        notes.append(name + " failed")

    if removeDuplicates:
        _do("removeDuplicatedPoints")
        _do("removeDuplicatedFacets")
    _do("fixIndices")
    _do("fixDegenerations")
    if fixNormals:
        _do("harmonizeNormals")
    if removeNonManifold:
        _do("removeNonManifolds")
        _do("removeNonManifoldPoints")
    if fillHoles:
        _try_fill(m, notes)

    obj.Mesh = m
    d.recompute()
    return _tree_with(id=obj.Name, tris=obj.Mesh.CountFacets, applied=applied, notes=notes)


@method("mesh.deleteFaces")
def mesh_delete_faces(id=None, faceIndices=None):
    d, obj = _mesh_obj(id)
    idx = [int(i) for i in (faceIndices or [])]
    if not idx:
        return _tree_with(id=obj.Name, tris=obj.Mesh.CountFacets, note="no faceIndices - no-op")
    m = obj.Mesh.copy()
    before = m.CountFacets
    m.removeFacets(idx)
    obj.Mesh = m
    d.recompute()
    return _tree_with(id=obj.Name, trisBefore=before, tris=obj.Mesh.CountFacets, removed=len(idx))


# --------------------------------------------------------------------------- #
# split / separate / cut
# --------------------------------------------------------------------------- #

@method("mesh.separate")
def mesh_separate(id=None):
    """Split disconnected shells into one Mesh::Feature each; original hidden."""
    d, obj = _mesh_obj(id)
    with _quiet():
        comps = list(obj.Mesh.getSeparateComponents())
    if len(comps) <= 1:
        return _tree_with(id=obj.Name, components=len(comps),
                          note="single connected component - nothing to separate")
    made = []
    for i, c in enumerate(comps):
        nf = _add_mesh_feature(d, c, "%s part %d" % (obj.Label, i + 1))
        made.append(nf.Name)
    try:
        obj.Visibility = False
    except Exception:
        pass
    d.recompute()
    return _tree_with(id=obj.Name, components=len(comps), made=made)


@method("mesh.planeCut")
def mesh_plane_cut(id=None, planeRef=None, base=None, normal=None, keep="both", fill=False):
    """Cut a mesh by a plane. keep = positive | negative | both. Facets are kept
    whole by centroid side; `fill` is best-effort via fillupHoles."""
    d, obj = _mesh_obj(id)
    b, n = _resolve_plane(d, planeRef, base, normal)
    src = obj.Mesh
    keep = (keep or "both").lower()
    notes = []

    def _side(keep_positive):
        m = _facet_side_cut(src, b, n, keep_positive)
        if fill:
            _try_fill(m, notes)
        return m

    if keep == "both":
        pos = _side(True)
        neg = _side(False)
        f1 = _add_mesh_feature(d, pos, obj.Label + " +")
        f2 = _add_mesh_feature(d, neg, obj.Label + " -")
        try:
            obj.Visibility = False
        except Exception:
            pass
        made = [f1.Name, f2.Name]
    elif keep == "negative":
        obj.Mesh = _side(False)
        made = [obj.Name]
    else:  # positive (default)
        keep = "positive"
        obj.Mesh = _side(True)
        made = [obj.Name]

    d.recompute()
    tris = [d.getObject(x).Mesh.CountFacets for x in made]
    return _tree_with(id=obj.Name, made=made, keep=keep, tris=tris,
                      base=list(b), normal=list(n), notes=notes)


# --------------------------------------------------------------------------- #
# debug
# --------------------------------------------------------------------------- #

@method("mesh.list")
def mesh_list():
    d = session.doc(create=False)
    out = []
    if d is not None:
        for o in d.Objects:
            if o.TypeId == "Mesh::Feature":
                out.append({"id": o.Name, "label": o.Label, "tris": o.Mesh.CountFacets})
    return {"meshes": out}
