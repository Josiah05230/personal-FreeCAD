"""Headless KiCad `.kicad_pcb` import - no `pcbnew`, just the S-expression.

First slice of ECAD/MCAD interop: pull a board's Edge.Cuts outline and its
footprint placements into the current document as a green board solid plus one
labelled placeholder per component, so an assembly can reference real board
geometry. Re-import replaces them in place (the "pull" half of a push/pull with
KiCad running on another machine). Component STEP models and net/joint mapping
are deferred.
"""
import os

from gwtcad.registry import method, RpcError, APP_ERROR
from gwtcad import session

BOARD_NAME = "_KICAD_BOARD"
PARTS_NAME = "_KICAD_PARTS"


# --------------------------------------------------------------------------- #
# S-expression parsing
# --------------------------------------------------------------------------- #

def _tokenize(s):
    out = []
    i, n = 0, len(s)
    while i < n:
        c = s[i]
        if c in "()":
            out.append(c)
            i += 1
        elif c == '"':
            j = i + 1
            buf = []
            while j < n and s[j] != '"':
                if s[j] == "\\" and j + 1 < n:
                    buf.append(s[j + 1])
                    j += 2
                else:
                    buf.append(s[j])
                    j += 1
            out.append('"' + "".join(buf))  # leading quote flags "this is a string"
            i = j + 1
        elif c.isspace():
            i += 1
        else:
            j = i
            while j < n and not s[j].isspace() and s[j] not in '()"':
                j += 1
            out.append(s[i:j])
            i = j
    return out


def _parse(text):
    toks = _tokenize(text)
    pos = [0]

    def rd():
        t = toks[pos[0]]
        pos[0] += 1
        if t == "(":
            lst = []
            while toks[pos[0]] != ")":
                lst.append(rd())
            pos[0] += 1
            return lst
        return t

    return rd()


def _s(x):
    """atom value with the string flag stripped"""
    if isinstance(x, str) and x.startswith('"'):
        return x[1:]
    return x


def _isnum(x):
    try:
        float(x)
        return True
    except (TypeError, ValueError):
        return False


def _get(node, name):
    for c in node:
        if isinstance(c, list) and c and c[0] == name:
            return c
    return None


def _find_all(node, name):
    if isinstance(node, list):
        if node and node[0] == name:
            yield node
        for c in node:
            yield from _find_all(c, name)


def _xy(node):
    """first two numeric args of a node, e.g. (start 1 -2) -> (1.0, -2.0)"""
    nums = [float(x) for x in node[1:] if _isnum(x)]
    return (nums[0], nums[1]) if len(nums) >= 2 else (0.0, 0.0)


# --------------------------------------------------------------------------- #
# geometry
# --------------------------------------------------------------------------- #

def _board_shape(root, thickness):
    """Edge.Cuts -> a solid board. KiCad millimetres, Y points down, so we
    negate Y to land in a right-handed sketch frame."""
    import Part
    from FreeCAD import Vector

    edges = []
    pts_for_bbox = []

    def on_edge(node):
        lyr = _get(node, "layer")
        return lyr is not None and _s(lyr[1]) == "Edge.Cuts"

    for ln in _find_all(root, "gr_line"):
        if not on_edge(ln):
            continue
        a = _xy(_get(ln, "start"))
        b = _xy(_get(ln, "end"))
        pts_for_bbox += [a, b]
        try:
            edges.append(Part.LineSegment(Vector(a[0], -a[1], 0), Vector(b[0], -b[1], 0)).toShape())
        except Exception:
            pass
    for ar in _find_all(root, "gr_arc"):
        if not on_edge(ar):
            continue
        a = _xy(_get(ar, "start"))
        m = _xy(_get(ar, "mid"))
        e = _xy(_get(ar, "end"))
        pts_for_bbox += [a, m, e]
        try:
            edges.append(
                Part.Arc(
                    Vector(a[0], -a[1], 0), Vector(m[0], -m[1], 0), Vector(e[0], -e[1], 0)
                ).toShape()
            )
        except Exception:
            pass
    for rc in _find_all(root, "gr_rect"):
        if not on_edge(rc):
            continue
        a = _xy(_get(rc, "start"))
        b = _xy(_get(rc, "end"))
        pts_for_bbox += [a, b]
        cs = [(a[0], a[1]), (b[0], a[1]), (b[0], b[1]), (a[0], b[1])]
        for i in range(4):
            p, q = cs[i], cs[(i + 1) % 4]
            edges.append(Part.LineSegment(Vector(p[0], -p[1], 0), Vector(q[0], -q[1], 0)).toShape())
    for ci in _find_all(root, "gr_circle"):
        if not on_edge(ci):
            continue
        c = _xy(_get(ci, "center"))
        e = _xy(_get(ci, "end"))
        r = ((e[0] - c[0]) ** 2 + (e[1] - c[1]) ** 2) ** 0.5
        pts_for_bbox += [(c[0] - r, c[1] - r), (c[0] + r, c[1] + r)]
        try:
            edges.append(Part.Circle(Vector(c[0], -c[1], 0), Vector(0, 0, 1), r).toShape())
        except Exception:
            pass
    for pl in _find_all(root, "gr_poly"):
        if not on_edge(pl):
            continue
        pts_node = _get(pl, "pts")
        if not pts_node:
            continue
        poly = [_xy(p) for p in pts_node if isinstance(p, list) and p and p[0] == "xy"]
        pts_for_bbox += poly
        for i in range(len(poly)):
            p, q = poly[i], poly[(i + 1) % len(poly)]
            edges.append(Part.LineSegment(Vector(p[0], -p[1], 0), Vector(q[0], -q[1], 0)).toShape())

    face = None
    if edges:
        try:
            wires = Part.sortEdges(edges)
            faces = []
            for w in wires:
                wire = Part.Wire(w)
                if wire.isClosed():
                    faces.append(Part.Face(wire))
            if faces:
                faces.sort(key=lambda f: f.Area, reverse=True)
                face = faces[0]
                for hole in faces[1:]:
                    try:
                        face = face.cut(hole)
                    except Exception:
                        pass
        except Exception:
            face = None

    if face is None and pts_for_bbox:
        xs = [p[0] for p in pts_for_bbox]
        ys = [-p[1] for p in pts_for_bbox]
        x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
        face = Part.makePlane(x1 - x0, y1 - y0, Vector(x0, y0, 0))

    if face is None:
        raise RpcError(APP_ERROR, "no Edge.Cuts geometry found in the board")

    return face.extrude(Vector(0, 0, float(thickness)))


def _placeholders(root, thickness):
    """One small labelled box per footprint at its placement."""
    import Part
    from FreeCAD import Vector, Placement, Rotation

    boxes = []
    placements = {}
    for fp in _find_all(root, "footprint"):
        at = _get(fp, "at")
        if not at:
            continue
        x, y = _xy(at)
        rot = float(at[3]) if len(at) > 3 and _isnum(at[3]) else 0.0
        lyr = _get(fp, "layer")
        back = lyr is not None and _s(lyr[1]).startswith("B.")
        ref = ""
        for pr in _find_all(fp, "property"):
            if len(pr) >= 3 and _s(pr[1]) == "Reference":
                ref = _s(pr[2])
                break

        b = Part.makeBox(2.4, 2.4, 1.4, Vector(-1.2, -1.2, 0))
        pl = Placement()
        pl.Rotation = Rotation(Vector(0, 0, 1), rot if back else -rot)
        pl.Base = Vector(x, -y, -1.4 if back else float(thickness))
        b.Placement = pl
        boxes.append(b)
        placements[ref or ("FP%d" % len(boxes))] = [x, -y, rot, "B" if back else "F"]

    comp = Part.makeCompound(boxes) if boxes else None
    return comp, placements


# --------------------------------------------------------------------------- #
# RPC
# --------------------------------------------------------------------------- #

def _remove(d, name):
    o = d.getObject(name)
    if o is not None:
        try:
            d.removeObject(name)
        except Exception:
            pass


@method("kicad.import")
def kicad_import(path=None, thickness=None):
    """Import (or re-import) a .kicad_pcb board outline + footprint placeholders."""
    if not path or not os.path.isfile(path):
        raise RpcError(APP_ERROR, "kicad.import: file not found: %r" % path)
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        root = _parse(fh.read())
    if not isinstance(root, list) or not root or root[0] != "kicad_pcb":
        raise RpcError(APP_ERROR, "not a .kicad_pcb file")

    if thickness is None:
        gen = _get(root, "general")
        tnode = _get(gen, "thickness") if gen else None
        thickness = float(tnode[1]) if tnode and _isnum(tnode[1]) else 1.6

    board = _board_shape(root, thickness)
    comp, placements = _placeholders(root, thickness)

    d = session.doc()
    _remove(d, BOARD_NAME)
    _remove(d, PARTS_NAME)

    bo = d.addObject("Part::Feature", BOARD_NAME)
    bo.Label = "PCB - %s" % os.path.splitext(os.path.basename(path))[0]
    bo.Shape = board
    session.set_body_color(bo.Name, [0.10, 0.42, 0.20])

    if comp is not None:
        po = d.addObject("Part::Feature", PARTS_NAME)
        po.Label = "PCB Components (%d)" % len(placements)
        po.Shape = comp
        session.set_body_color(po.Name, [0.16, 0.16, 0.18])

    d.recompute()
    session.set_kicad_link(path, placements)

    from gwtcad.methods import tree_get

    bb = board.BoundBox
    return {
        **tree_get(),
        "kicad": {
            "path": path,
            "thickness": thickness,
            "components": len(placements),
            "size": [round(bb.XLength, 3), round(bb.YLength, 3), round(bb.ZLength, 3)],
        },
    }


@method("kicad.reimport")
def kicad_reimport(path=None):
    """Re-pull the board from disk after it changed in KiCad."""
    link = session.kicad_link()
    p = path or (link or {}).get("path")
    if not p:
        raise RpcError(APP_ERROR, "no KiCad board linked yet")
    return kicad_import(p)


@method("kicad.status")
def kicad_status():
    return session.kicad_link() or {}
