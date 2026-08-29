"""Convert an OCCT / FreeCAD `Shape` into GPU-ready render buffers.

Design (see docs/decisions.md D-0004): each face is tessellated independently and
vertices are NOT welded across face boundaries. Normals are averaged only within a
face, so shading is smooth across a face and hard at every real edge - the classic
CAD look. Model edges are emitted separately as polylines for a dark overlay.

All coordinates are FreeCAD-native: millimetres, Z-up. The viewport handles the
up-axis; it does not rewrite coordinates here.
"""
import math

# tessellation deflection in mm - smaller = finer. Tuned later / made adaptive.
SURFACE_DEFLECTION = 0.10
EDGE_DEFLECTION = 0.05


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


def tessellate_face(face):
    """Return (positions, normals, tri_indices) for one face, all face-local.

    positions/normals are flat lists of floats (3 per vertex); tri_indices is a
    flat list of ints indexing into that vertex array.
    """
    verts, tris = face.tessellate(SURFACE_DEFLECTION)
    n = len(verts)
    positions = [0.0] * (n * 3)
    for i, v in enumerate(verts):
        positions[i * 3] = v.x
        positions[i * 3 + 1] = v.y
        positions[i * 3 + 2] = v.z

    ref = _face_outward_normal(face)
    accum = [0.0] * (n * 3)
    indices = []

    for (a, b, c) in tris:
        ax, ay, az = verts[a].x, verts[a].y, verts[a].z
        bx, by, bz = verts[b].x, verts[b].y, verts[b].z
        cx, cy, cz = verts[c].x, verts[c].y, verts[c].z
        ux, uy, uz = bx - ax, by - ay, bz - az
        vx, vy, vz = cx - ax, cy - ay, cz - az
        fx = uy * vz - uz * vy
        fy = uz * vx - ux * vz
        fz = ux * vy - uy * vx
        fx, fy, fz = _normalize(fx, fy, fz)

        flip = ref is not None and (fx * ref[0] + fy * ref[1] + fz * ref[2]) < 0.0
        if flip:
            fx, fy, fz = -fx, -fy, -fz
            a, c = c, a  # keep winding consistent with the outward normal

        indices.extend((a, b, c))
        for idx in (a, b, c):
            accum[idx * 3] += fx
            accum[idx * 3 + 1] += fy
            accum[idx * 3 + 2] += fz

    normals = [0.0] * (n * 3)
    for i in range(n):
        nx, ny, nz = _normalize(accum[i * 3], accum[i * 3 + 1], accum[i * 3 + 2])
        if nx == 0.0 and ny == 0.0 and nz == 0.0 and ref is not None:
            nx, ny, nz = ref
        normals[i * 3] = nx
        normals[i * 3 + 1] = ny
        normals[i * 3 + 2] = nz

    return positions, normals, indices


def tessellate_shape(shape):
    """Return a render mesh for a whole shape.

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

    for fi, face in enumerate(shape.Faces):
        try:
            fp, fn, fidx = tessellate_face(face)
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
            edges.append({"edge": ei, "points": pts})

    bb = shape.BoundBox
    return {
        "positions": positions,
        "normals": normals,
        "indices": indices,
        "faceGroups": face_groups,
        "edges": edges,
        "bbox": {
            "min": [bb.XMin, bb.YMin, bb.ZMin],
            "max": [bb.XMax, bb.YMax, bb.ZMax],
        },
    }
