"""A fast hidden-line view renderer for generated drawings.

TechDraw's hidden-line removal (exact or coarse) takes minutes on a heavy
model - an ESP8266 module's iso view took 161s, a large perfboard's never
finished - and no pre-processing of the B-rep fixed that (defeaturing
4000 holes ran past 400s by itself). This draws the same kind of line view
from a coarse tessellation instead: a depth buffer of the model's
triangles decides which stretches of its real CAD edges (and the
silhouettes of its curved faces) are visible, and those become SVG lines.
Seconds, not minutes, for any model; used for the iso reference view of
heavy parts (see supplier_models._apply_grainwave_template).
"""
import math

import numpy as np
import FreeCAD as App

_RES = 1400          # depth-buffer pixels along the longer side
_EDGE_STEP_PX = 1.0  # edge sampling step


def _basis(direction):
    d = App.Vector(*direction).normalize()
    u = App.Vector(0, 0, 1).cross(d)
    u = u.normalize() if u.Length > 1e-9 else App.Vector(1, 0, 0)
    v = d.cross(u).normalize()
    return (np.array([u.x, u.y, u.z]), np.array([v.x, v.y, v.z]), np.array([d.x, d.y, d.z]))


def _mesh(shapes, tol):
    """One coarse mesh of every shape, with the source face of each triangle
    (MeshPart meshes a whole model ~5x faster than Part's per-face
    tessellate, and at pixel accuracy a coarser angle is invisible)."""
    import MeshPart
    pts, tris, face_ids = [], [], []
    base = fid = 0
    for sh in shapes:
        try:
            m = MeshPart.meshFromShape(Shape=sh, LinearDeflection=tol, AngularDeflection=0.8, Segments=True)
        except Exception:
            continue
        p, t = m.Topology
        if not t:
            continue
        pts.extend((q.x, q.y, q.z) for q in p)
        tris.extend((a + base, b + base, c + base) for a, b, c in t)
        ids = [0] * len(t)
        for k in range(m.countSegments()):
            for f in m.getSegment(k):
                ids[f] = fid + k
        face_ids.extend(ids)
        base += len(p)
        fid += m.countSegments() or 1
    return np.array(pts, float).reshape(-1, 3), np.array(tris, int).reshape(-1, 3), np.array(face_ids, int)


def _fill(zb, a, b, c, za, zbv, zc, x0, y0, nx, ny):
    """Depth-test every pixel centre in each triangle's (nx x ny) box at
    once - one numpy pass for a whole batch of triangles."""
    h, w = zb.shape
    ox, oy = np.meshgrid(np.arange(nx), np.arange(ny))
    xs = (x0[:, None, None] + ox[None]) + 0.5
    ys = (y0[:, None, None] + oy[None]) + 0.5
    ax, ay = a[:, 0, None, None], a[:, 1, None, None]
    bx, by = b[:, 0, None, None], b[:, 1, None, None]
    cx, cy = c[:, 0, None, None], c[:, 1, None, None]
    den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
    den = np.where(np.abs(den) < 1e-12, np.nan, den)
    l1 = ((by - cy) * (xs - cx) + (cx - bx) * (ys - cy)) / den
    l2 = ((cy - ay) * (xs - cx) + (ax - cx) * (ys - cy)) / den
    l3 = 1.0 - l1 - l2
    inside = (l1 >= -1e-3) & (l2 >= -1e-3) & (l3 >= -1e-3)
    z = l1 * za[:, None, None] + l2 * zbv[:, None, None] + l3 * zc[:, None, None]
    ix = xs.astype(int)
    iy = ys.astype(int)
    ok = inside & (ix >= 0) & (ix < w) & (iy >= 0) & (iy < h)
    np.minimum.at(zb, (iy[ok], ix[ok]), z[ok])


def _depth_buffer(p2, depth, tris, w, h):
    """Nearest depth per pixel (smaller = closer to the viewer). Triangles
    are filled in batches grouped by their pixel-box size, so a model with
    tens of thousands of tiny triangles (a perfboard's holes) is a handful
    of numpy passes instead of a Python loop per triangle."""
    zb = np.full((h, w), np.inf)
    a, b, c = p2[tris[:, 0]], p2[tris[:, 1]], p2[tris[:, 2]]
    za, zbv, zc = depth[tris[:, 0]], depth[tris[:, 1]], depth[tris[:, 2]]
    x0 = np.floor(np.minimum(np.minimum(a[:, 0], b[:, 0]), c[:, 0])).astype(int)
    x1 = np.ceil(np.maximum(np.maximum(a[:, 0], b[:, 0]), c[:, 0])).astype(int)
    y0 = np.floor(np.minimum(np.minimum(a[:, 1], b[:, 1]), c[:, 1])).astype(int)
    y1 = np.ceil(np.maximum(np.maximum(a[:, 1], b[:, 1]), c[:, 1])).astype(int)
    nx = x1 - x0 + 1
    ny = y1 - y0 + 1
    size = np.maximum(nx, ny)
    for cap in (2, 4, 8, 16, 32, 64):
        sel = np.nonzero((size <= cap) & (size > cap // 2 if cap > 2 else size <= cap))[0]
        for chunk in range(0, len(sel), max(1, 200000 // (cap * cap))):
            i = sel[chunk:chunk + max(1, 200000 // (cap * cap))]
            _fill(zb, a[i], b[i], c[i], za[i], zbv[i], zc[i], x0[i], y0[i], cap, cap)
    for i in np.nonzero(size > 64)[0]:
        _fill(zb, a[i:i + 1], b[i:i + 1], c[i:i + 1], za[i:i + 1], zbv[i:i + 1], zc[i:i + 1],
              x0[i:i + 1], y0[i:i + 1], int(nx[i]), int(ny[i]))
    return zb


def _silhouettes(pts, tris, face_ids, dvec):
    """Mesh edges inside one face whose two triangles face opposite ways
    relative to the view - the outline of a curved face (a cylinder's
    sides), which has no B-rep edge of its own."""
    n = np.cross(pts[tris[:, 1]] - pts[tris[:, 0]], pts[tris[:, 2]] - pts[tris[:, 0]])
    facing = (n @ dvec) < 0
    t = np.repeat(np.arange(len(tris)), 3)
    e = np.stack([tris[:, [0, 1, 2]].ravel(), tris[:, [1, 2, 0]].ravel()], axis=1)
    e.sort(axis=1)
    order = np.lexsort((e[:, 1], e[:, 0]))
    e, t = e[order], t[order]
    same = np.all(e[1:] == e[:-1], axis=1)
    i = np.nonzero(same)[0]
    t1, t2 = t[i], t[i + 1]
    keep = (face_ids[t1] == face_ids[t2]) & (facing[t1] != facing[t2])
    k = e[i[keep]]
    return [np.array([pts[a], pts[b]]) for a, b in k]


_SIMPLIFY_MM = 0.02  # a visible run keeps only points that move it more than this


def _simplify(p, tol):
    """Ramer-Douglas-Peucker: a straight edge sampled every pixel collapses
    to its two ends (the page's SVG, and so its PDF, stays small enough to
    render - a heavy perfboard's views were multi-MB)."""
    if len(p) <= 2:
        return p
    keep = np.zeros(len(p), bool)
    keep[0] = keep[-1] = True
    stack = [(0, len(p) - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        seg = p[j] - p[i]
        n = np.hypot(seg[0], seg[1])
        rel = p[i + 1:j] - p[i]
        d = np.abs(seg[0] * rel[:, 1] - seg[1] * rel[:, 0]) / n if n > 1e-12 else np.hypot(rel[:, 0], rel[:, 1])
        k = int(np.argmax(d))
        if d[k] > tol:
            m = i + 1 + k
            keep[m] = True
            stack.append((i, m))
            stack.append((m, j))
    return p[keep]


def model_mesh(shapes):
    """The coarse mesh render_view_svg works from - build it once and pass
    it to every view of the same model."""
    comp_bb = shapes[0].BoundBox
    for sh in shapes[1:]:
        comp_bb.add(sh.BoundBox)
    diag = max(comp_bb.DiagonalLength, 1e-6)
    pts, tris, face_ids = _mesh(shapes, diag / 400.0)
    return pts, tris, face_ids, diag


def render_view_svg(shapes, direction, max_w=None, max_h=None, scale=None, mesh=None):
    """SVG text of a hidden-line view of `shapes` from `direction`, at
    `scale` (sheet mm per model mm) or sized to fit max_w x max_h. `mesh`
    is a model_mesh() to reuse across views. Returns (svg, width_mm,
    height_mm)."""
    pts, tris, face_ids, diag = mesh or model_mesh(shapes)
    u, v, d = _basis(direction)
    if not len(tris):
        raise ValueError("nothing to draw")
    uv = np.stack([pts @ u, pts @ v], axis=1)
    lo, hi = uv.min(axis=0), uv.max(axis=0)
    span = np.maximum(hi - lo, 1e-9)
    px = _RES / span.max()
    w, h = int(math.ceil(span[0] * px)) + 2, int(math.ceil(span[1] * px)) + 2
    # screen y grows downward; projected v grows upward
    p2 = np.stack([(uv[:, 0] - lo[0]) * px + 1, (hi[1] - uv[:, 1]) * px + 1], axis=1)
    depth = -(pts @ d)  # the view looks along -d: larger dot(d) is nearer
    zb = _depth_buffer(p2, depth, tris, w, h)
    eps = diag * 2e-3

    polylines = []
    for s in shapes:
        for e in s.Edges:
            try:
                q = e.discretize(Distance=max(span.max() / _RES * _EDGE_STEP_PX, 1e-4))
            except Exception:
                continue
            polylines.append(np.array([(p.x, p.y, p.z) for p in q]))
    for seg in _silhouettes(pts, tris, face_ids, d):
        n = max(2, int(np.linalg.norm((seg[1] - seg[0]) @ np.stack([u, v], 1)) * px / _EDGE_STEP_PX) + 1)
        polylines.append(np.linspace(seg[0], seg[1], n))

    if scale is None:
        scale = min(max_w / span[0], max_h / span[1])
    paths = []
    for pl in polylines:
        if len(pl) < 2:
            continue
        puv = np.stack([pl @ u, pl @ v], axis=1)
        sx = (puv[:, 0] - lo[0]) * px + 1
        sy = (hi[1] - puv[:, 1]) * px + 1
        dz = -(pl @ d)
        ix = np.clip(sx.astype(int), 0, w - 1)
        iy = np.clip(sy.astype(int), 0, h - 1)
        # visible where nothing nearer covers the sample (check the pixel and
        # its neighbours so an edge on its own face's border isn't hidden)
        near = zb[iy, ix]
        for oy, ox in ((0, 1), (1, 0), (0, -1), (-1, 0)):
            near = np.maximum(near, zb[np.clip(iy + oy, 0, h - 1), np.clip(ix + ox, 0, w - 1)])
        vis = dz <= near + eps
        sheet = np.stack([(puv[:, 0] - lo[0]) * scale, (hi[1] - puv[:, 1]) * scale], axis=1)
        # split into visible runs, each simplified to the points that shape it
        idx = np.flatnonzero(np.diff(np.concatenate([[0], vis.astype(np.int8), [0]])))
        for a, b in zip(idx[0::2], idx[1::2]):
            if b - a > 1:
                run = _simplify(sheet[a:b], _SIMPLIFY_MM)
                paths.append(["%.2f,%.2f" % (x, y) for x, y in run])

    wmm, hmm = span[0] * scale, span[1] * scale
    body = "\n".join('<polyline points="%s"/>' % " ".join(r) for r in paths)
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" width="%.2fmm" height="%.2fmm" viewBox="0 0 %.2f %.2f">\n'
           '<g fill="none" stroke="#000" stroke-width="0.25" stroke-linecap="round" stroke-linejoin="round">\n'
           '%s\n</g>\n</svg>\n') % (wmm, hmm, wmm, hmm, body)
    return svg, wmm, hmm
