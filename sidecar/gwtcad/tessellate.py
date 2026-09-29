"""Convert an OCCT / FreeCAD `Shape` into GPU-ready render buffers.

Design (see docs/decisions.md D-0004): each face is tessellated independently and
vertices are NOT welded across face boundaries. Normals are averaged only within a
face, so shading is smooth across a face and hard at every real edge - the classic
CAD look. Model edges are emitted separately as polylines for a dark overlay.

All coordinates are FreeCAD-native: millimetres, Z-up. The viewport handles the
up-axis; it does not rewrite coordinates here.
"""
import math

import numpy as np

# tessellation deflection in mm - smaller = finer. Tuned later / made adaptive.
SURFACE_DEFLECTION = 0.10
EDGE_DEFLECTION = 0.05
# angular deflection in radians. Part's per-face tessellate applies a much
# finer fixed angle, so every small circle becomes ~60 segments: a PCB face
# with 300+ drilled holes took ~6s and 40k triangles on its own, and tiny
# fillets/torii came out as 8k triangles each.
ANGULAR_DEFLECTION = 0.35

# "draft" quality: what a heavy shape shows first while mesh_pool builds the
# full mesh in the background (see methods.scene_get). Linear deflection
# scales with the model so a big part stays cheap; edges skip the
# tangent/sharp classification (~1.5s on a 1000-face PCBA) and all read as
# sharp, which matches the default "show tangent edges" look.
DRAFT_LINEAR_FRACTION = 0.002   # of the bounding-box diagonal
DRAFT_ANGULAR_DEFLECTION = 1.0


def _normalize(x, y, z):
    n = math.sqrt(x * x + y * y + z * z)
    if n < 1e-12:
        return 0.0, 0.0, 0.0
    return x / n, y / n, z / n


def _face_outward_normal(face):
    """Best-effort outward surface normal at the middle of the face's UV range."""
    try:
        umin, umax, vmin, vmax = face.ParameterRange
        nrm = face.normalAt((umin + umax) * 0.5, (vmin + vmax) * 0.5)
        nx, ny, nz = nrm.x, nrm.y, nrm.z
        if str(face.Orientation) == "Reversed":
            nx, ny, nz = -nx, -ny, -nz
        return _normalize(nx, ny, nz)
    except Exception:
        return None


def tessellate_face(face, deflection=SURFACE_DEFLECTION):
    """Return (positions, normals, tri_indices) for one face, all face-local.

    positions/normals are flat lists of floats (3 per vertex); tri_indices is a
    flat list of ints indexing into that vertex array. Vectorized with numpy:
    the per-triangle Python loop was the biggest in-process meshing cost on
    a many-part model.
    """
    verts, tris = face.tessellate(deflection)
    if not verts or not tris:
        return [], [], []
    P = np.array([(v.x, v.y, v.z) for v in verts], dtype=float)
    T = np.array(tris, dtype=np.int64)
    ref = _face_outward_normal(face)
    fn = np.cross(P[T[:, 1]] - P[T[:, 0]], P[T[:, 2]] - P[T[:, 0]])
    ln = np.linalg.norm(fn, axis=1)
    ok = ln > 1e-12
    fn[ok] /= ln[ok, None]
    fn[~ok] = 0.0
    if ref is not None:
        # keep winding consistent with the outward normal
        flip = fn @ np.asarray(ref) < 0.0
        fn[flip] *= -1.0
        T[flip] = T[flip][:, ::-1]
    acc = np.zeros_like(P)
    for k in range(3):
        np.add.at(acc, T[:, k], fn)
    la = np.linalg.norm(acc, axis=1)
    nz = la > 1e-12
    acc[nz] /= la[nz, None]
    if ref is not None:
        acc[~nz] = ref
    return P.ravel().tolist(), acc.ravel().tolist(), T.ravel().tolist()


# dihedral angle (deg) below which a shared edge counts as a smooth / tangent
# transition rather than a designed crease.
TANGENT_ANGLE_DEG = 12.0
_CLEARLY_TANGENT = math.cos(math.radians(4.0))
_CLEARLY_SHARP = math.cos(math.radians(TANGENT_ANGLE_DEG + 12.0))


def _normal_fn(face):
    """A fast "surface normal near point p" for one face: analytic for planes
    and cylinders (most mechanical faces; Surface.parameter() was the bulk of
    edge classification), the general projection otherwise. Sign is
    irrelevant here - callers compare |n1 . n2|."""
    try:
        surf = face.Surface
        kind = type(surf).__name__
        if kind == "Plane":
            n = _normalize(surf.Axis.x, surf.Axis.y, surf.Axis.z)
            return lambda p: n
        if kind == "Cylinder":
            ax = _normalize(surf.Axis.x, surf.Axis.y, surf.Axis.z)
            c = surf.Center

            def cyl(p):
                dx, dy, dz = p.x - c.x, p.y - c.y, p.z - c.z
                t = dx * ax[0] + dy * ax[1] + dz * ax[2]
                return _normalize(dx - t * ax[0], dy - t * ax[1], dz - t * ax[2])
            return cyl
    except Exception:
        pass
    return lambda p: _surf_normal_near(face, p)


def _classify_edges(shape, pair_dots=None):
    """{edgeIndex: "sharp"|"tangent"|"free"} - "free" = an edge with fewer than
    two adjacent faces (open wire / lamina boundary)."""
    out = {}
    try:
        edges = shape.Edges
        faces = shape.Faces
    except Exception:
        return out
    # map each edge (by hash) to the faces that use it
    by_edge = {}
    for fi, face in enumerate(faces):
        try:
            for e in face.Edges:
                by_edge.setdefault(e.hashCode(), []).append(fi)
        except Exception:
            continue
    normal_of = {}
    cos_lim = math.cos(math.radians(TANGENT_ANGLE_DEG))
    for ei, edge in enumerate(edges):
        adj = by_edge.get(edge.hashCode(), [])
        if len(adj) < 2:
            out[ei] = "free"
            continue
        if adj[0] == adj[1]:
            out[ei] = "tangent"  # a seam: the face meets itself smoothly
            continue
        if pair_dots:
            # mesh normals at a curved face's boundary are off by up to half
            # the meshing angle, so they only settle the clear cases; the
            # band around the threshold gets the exact surface normals below
            dot = pair_dots.get((min(adj[0], adj[1]), max(adj[0], adj[1])))
            if dot is not None and dot >= _CLEARLY_TANGENT:
                out[ei] = "tangent"
                continue
            if dot is not None and dot <= _CLEARLY_SHARP:
                out[ei] = "sharp"
                continue
        try:
            mid = edge.valueAt((edge.FirstParameter + edge.LastParameter) * 0.5)
            fns = []
            for fi in adj[:2]:
                f = normal_of.get(fi)
                if f is None:
                    f = normal_of[fi] = _normal_fn(faces[fi])
                fns.append(f)
            n1 = fns[0](mid)
            n2 = fns[1](mid)
            if n1 is None or n2 is None:
                out[ei] = "sharp"
                continue
            d = abs(n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2])
            out[ei] = "tangent" if d >= cos_lim else "sharp"
        except Exception:
            out[ei] = "sharp"
    return out


def _surf_normal_near(face, pnt):
    try:
        u, v = face.Surface.parameter(pnt)
        nrm = face.normalAt(u, v)
        return _normalize(nrm.x, nrm.y, nrm.z)
    except Exception:
        return _face_outward_normal(face)


def _premesh(shape, linear=SURFACE_DEFLECTION, angular=ANGULAR_DEFLECTION):
    """Mesh the whole shape once with an angular limit, so the per-face
    tessellate calls below reuse that triangulation instead of remeshing each
    face at Part's fine default angle. Works on a copy: triangulation lives on
    the shared TShape, and the document's own shapes (drawings, exports)
    shouldn't inherit this coarser mesh. The copy keeps face/edge order, so
    faceGroups and edge indices still match the original shape."""
    try:
        import MeshPart
        s = shape.copy()
        MeshPart.meshFromShape(Shape=s, LinearDeflection=linear,
                               AngularDeflection=angular, Relative=False)
        return s
    except Exception:
        return shape


def _mesh_whole_shape(shape, lin, ang):
    """Triangles + normals + face groups for a whole shape from ONE MeshPart
    call (Segments=True gives each triangle's source face), un-welded per face
    and oriented by each face's outward normal - all vectorized. Per-face
    tessellate() + Python normal loops cost ~1ms a face; a vendor part has
    thousands. Returns (positions, normals, indices, faceGroups, meshed copy)
    or None to fall back to the per-face path."""
    import MeshPart
    s = shape.copy()  # triangulation lives on the TShape - keep it off the document's shape
    m = MeshPart.meshFromShape(Shape=s, LinearDeflection=lin, AngularDeflection=ang,
                               Relative=False, Segments=True)
    faces = s.Faces
    nseg = m.countSegments()
    if nseg != len(faces):
        return None
    pts, tris = m.Topology
    if not tris:
        return [], [], [], [], s
    P = np.array([(q.x, q.y, q.z) for q in pts], dtype=float)
    Tr = np.array(tris, dtype=np.int64)
    seg = np.full(len(Tr), -1, dtype=np.int64)
    for k in range(nseg):
        fac = m.getSegment(k)
        if fac:
            seg[list(fac)] = k
    keep = seg >= 0
    Tr, seg = Tr[keep], seg[keep]
    order = np.argsort(seg, kind="stable")
    Tr, seg = Tr[order], seg[order]
    refs = np.zeros((nseg, 3))
    has = np.zeros(nseg, dtype=bool)
    for k, f in enumerate(faces):
        r = _face_outward_normal(f)
        if r is not None:
            refs[k] = r
            has[k] = True
    fn = np.cross(P[Tr[:, 1]] - P[Tr[:, 0]], P[Tr[:, 2]] - P[Tr[:, 0]])
    ln = np.linalg.norm(fn, axis=1)
    ok = ln > 1e-12
    fn[ok] /= ln[ok, None]
    fn[~ok] = 0.0
    flip = has[seg] & (np.einsum("ij,ij->i", fn, refs[seg]) < 0.0)
    fn[flip] *= -1.0
    Tr[flip] = Tr[flip][:, ::-1]
    # un-weld: one vertex per (face, point), so shading stays hard at edges
    nP = len(P)
    uniq, inv = np.unique((seg[:, None] * nP + Tr).ravel(), return_inverse=True)
    newT = inv.reshape(-1, 3)
    newP = P[uniq % nP]
    acc = np.zeros_like(newP)
    for k in range(3):
        np.add.at(acc, newT[:, k], fn)
    la = np.linalg.norm(acc, axis=1)
    nz = la > 1e-12
    acc[nz] /= la[nz, None]
    vseg = uniq // nP
    fill = ~nz & has[vseg]
    acc[fill] = refs[vseg[fill]]
    starts = np.flatnonzero(np.r_[True, seg[1:] != seg[:-1]])
    counts = np.diff(np.r_[starts, len(seg)])
    groups = [{"face": int(seg[a]), "start": int(a) * 3, "count": int(c) * 3} for a, c in zip(starts, counts)]
    return newP.ravel().tolist(), acc.ravel().tolist(), newT.ravel().tolist(), groups, s, _face_pair_dots(uniq % nP, vseg, acc)


def _face_pair_dots(orig, vseg, nrm):
    """{(faceA, faceB): max |nA . nB|} over the mesh points two faces share
    (the welded mesh gives both faces the same point along their common
    edge) - classifies every edge between them as tangent or sharp without
    a per-edge surface projection."""
    if len(orig) < 2:
        return {}
    order = np.argsort(orig, kind="stable")
    o, sg, nn = orig[order], vseg[order], nrm[order]
    same = (o[1:] == o[:-1]) & (sg[1:] != sg[:-1])
    if not same.any():
        return {}
    i = np.flatnonzero(same)
    a, b = sg[i], sg[i + 1]
    d = np.abs(np.einsum("ij,ij->i", nn[i], nn[i + 1]))
    lo, hi = np.minimum(a, b), np.maximum(a, b)
    keys = lo * (int(vseg.max()) + 1) + hi
    uk, inv = np.unique(keys, return_inverse=True)
    best = np.zeros(len(uk))
    np.maximum.at(best, inv, d)
    m = int(vseg.max()) + 1
    return {(int(k // m), int(k % m)): float(v) for k, v in zip(uk, best)}


def tessellate_shape(shape, draft=False):
    """Return a render mesh for a whole shape (`draft`: the quick, coarser
    first look - see DRAFT_*; the buffer then carries "draft": True).

    {
      "positions": [x,y,z, ...],
      "normals":   [x,y,z, ...],
      "indices":   [i,j,k, ...],
      "faceGroups": [{"face": <faceIndex>, "start": <indexOffset>, "count": <n>}],
      "edges": [{"edge": <edgeIndex>, "points": [x,y,z, ...]}],
      "bbox": {"min": [x,y,z], "max": [x,y,z]}
    }

    faceGroups let the picker map a triangle back to a FreeCAD face index.
    """
    positions = []
    normals = []
    indices = []
    face_groups = []
    vert_offset = 0

    lin, ang = SURFACE_DEFLECTION, ANGULAR_DEFLECTION
    if draft:
        try:
            lin = max(lin, shape.BoundBox.DiagonalLength * DRAFT_LINEAR_FRACTION)
        except Exception:
            pass
        ang = DRAFT_ANGULAR_DEFLECTION
    whole = None
    try:
        whole = _mesh_whole_shape(shape, lin, ang)
    except Exception:
        whole = None
    pair_dots = None
    if whole is not None:
        positions, normals, indices, face_groups, shape, pair_dots = whole
    else:
        shape = _premesh(shape, lin, ang)
    for fi, face in enumerate(shape.Faces if whole is None else ()):
        try:
            fp, fn, fidx = tessellate_face(face, lin)
        except Exception:
            continue
        if not fidx:
            continue
        start = len(indices)
        positions.extend(fp)
        normals.extend(fn)
        indices.extend(i + vert_offset for i in fidx)
        vert_offset += len(fp) // 3
        face_groups.append({"face": fi, "start": start, "count": len(fidx)})

    verts = []
    for vi, v in enumerate(getattr(shape, "Vertexes", [])):
        try:
            verts.append({"vertex": vi, "p": [v.X, v.Y, v.Z]})
        except Exception:
            continue

    # classify each edge as sharp / tangent (smooth) / other so the client can
    # style tangent edges independently (hide them, dash them, ...). "tangent"
    # = the two faces sharing the edge meet at a near-zero dihedral angle.
    kinds = {} if draft else _classify_edges(shape, pair_dots)

    edges = []
    for ei, edge in enumerate(shape.Edges):
        pts = []
        try:
            for p in edge.discretize(Deflection=EDGE_DEFLECTION):
                pts.extend((p.x, p.y, p.z))
        except Exception:
            try:
                a = edge.valueAt(edge.FirstParameter)
                b = edge.valueAt(edge.LastParameter)
                pts = [a.x, a.y, a.z, b.x, b.y, b.z]
            except Exception:
                continue
        if len(pts) >= 6:
            edges.append({"edge": ei, "points": pts, "kind": kinds.get(ei, "sharp")})

    bb = shape.BoundBox
    out = {
        "positions": positions,
        "normals": normals,
        "indices": indices,
        "faceGroups": face_groups,
        "edges": edges,
        "vertices": verts,
        "bbox": {
            "min": [bb.XMin, bb.YMin, bb.ZMin],
            "max": [bb.XMax, bb.YMax, bb.ZMax],
        },
    }
    if draft:
        out["draft"] = True
    return out
