"""Headless KiCad import - two tiers.

Tier 1 (this file's original slice of ECAD/MCAD interop): parse the
`.kicad_pcb` S-expression directly - no `pcbnew`, no `kicad-cli` - and pull
the Edge.Cuts outline plus one labelled placeholder box per footprint into
the current document, so an assembly can reference real board geometry even
with no KiCad 3D model library installed. Net/joint mapping is deferred.

Tier 2 (kicad_import_step below): shells out to `kicad-cli pcb export step`
(real per-component 3D models where the board's footprints have them,
verified against a populated demo board to genuinely produce one separate
Part::Feature per component, not one fused blob) then Import.insert's the
result - this is the real, richly-detailed import, used as the DEFAULT when
opening a PCB-assembly (type F) part. Tier 1 remains available as an
explicit fallback (kicad.import) for a board with no 3D models, or if
kicad-cli isn't installed on this machine.
"""
import os
import subprocess
import tempfile

from gwtcad.registry import method, RpcError, APP_ERROR
from gwtcad import session

BOARD_NAME = "_KICAD_BOARD"
PARTS_NAME = "_KICAD_PARTS"

KICAD_CLI = os.environ.get("GWTCAD_KICAD_CLI", "kicad-cli")  # assumed on PATH - see docs/first-time-setup.md


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


def _kicad_cli_available():
    try:
        r = subprocess.run([KICAD_CLI, "version"], capture_output=True, text=True, timeout=10)
        return r.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


@method("kicad.importStep")
def kicad_import_step(path=None):
    """Real per-component import: kicad-cli pcb export step (each populated
    footprint's own 3D model becomes its own solid - verified against a real
    board with 3D models attached, NOT the case for every KiCad demo/template
    board, some of which genuinely have no 3D models on their footprints at
    all) into a temp .step, then Import.insert it into the current document.

    This is the DEFAULT way to open a PCB-assembly (type F) part - richer
    than kicad.import's outline+placeholder tier, at the cost of actually
    needing kicad-cli on this machine and the board's footprints having real
    3D models assigned. Falls back to kicad.import automatically (never
    raises for THAT reason) if kicad-cli is missing or the export produces
    nothing usable - a missing 3D model library degrades to a placeholder
    board, it never blocks opening the part entirely."""
    if not path or not os.path.isfile(path):
        raise RpcError(APP_ERROR, "kicad.importStep: file not found: %r" % path)

    if not _kicad_cli_available():
        result = kicad_import(path)
        result["kicad"]["stepImport"] = False
        result["kicad"]["stepImportReason"] = "kicad-cli not found on PATH"
        return result

    tmpdir = tempfile.mkdtemp(prefix="gwtcad-kicad-step-")
    step_path = os.path.join(tmpdir, "board.step")
    try:
        r = subprocess.run(
            [KICAD_CLI, "pcb", "export", "step", path, "--output", step_path, "--force"],
            capture_output=True, text=True, timeout=120,
        )
        # kicad-cli's exit code is NOT a reliable success signal on its own -
        # confirmed it returns 2 (not 0) on a genuinely successful export
        # that only had a warning to report (e.g. a legacy zone-fill
        # strategy note). The output file actually existing is the real
        # signal; a nonzero code with no file is the real failure case.
        if not os.path.isfile(step_path):
            result = kicad_import(path)
            result["kicad"]["stepImport"] = False
            result["kicad"]["stepImportReason"] = (r.stderr or r.stdout or "export failed").strip()
            return result

        import Import

        d = session.doc()
        _remove(d, BOARD_NAME)
        _remove(d, PARTS_NAME)
        # a re-import must not pile up a second copy of the last STEP import.
        # App::Part containers (Import.insert's Top/Bot/Step_Models groups)
        # can't be wrapped in an App::DocumentObjectGroup afterward - their
        # children are already properly scoped inside them, and forcing them
        # into a plain group breaks that scope (confirmed: FreeCAD warns
        # "go out of the allowed scope" and silently refuses the reparent).
        # So instead of a real FreeCAD group, just remember the top-level
        # object names THIS import created, in link order, and remove those
        # PLUS everything reachable from them via OutList (recursively) -
        # NOT just .Group: an App::Part's own Origin (with its axes/planes)
        # is only referenced via OutList, never listed in .Group, so a
        # .Group-only walk silently leaks that origin + its 6 children on
        # every re-import (confirmed directly - Import.insert also never
        # reuses object names across repeated calls, so leaked objects
        # accumulate under new names forever, never colliding/overwriting).
        prior_names = (session.kicad_link() or {}).get("stepImportTopLevelNames") or []
        to_remove = []
        seen = set()

        def _collect(name):
            if name in seen:
                return
            seen.add(name)
            o = d.getObject(name)
            if o is None:
                return
            for child in list(o.OutList):
                _collect(child.Name)
            to_remove.append(name)

        for name in prior_names:
            _collect(name)
        # children before parents (already the order _collect appends in,
        # since it recurses into OutList before appending the object itself)
        for name in to_remove:
            try:
                d.removeObject(name)
            except Exception:
                pass

        before = set(o.Name for o in d.Objects)
        Import.insert(step_path, d.Name)
        new_objs = [o for o in d.Objects if o.Name not in before]
        top_level_new = [o for o in new_objs if not o.InList]

        d.recompute()
        session.set_kicad_link(path, stepImportTopLevelNames=[o.Name for o in top_level_new])

        from gwtcad.methods import tree_get

        return {
            **tree_get(),
            "kicad": {
                "path": path,
                "stepImport": True,
                "componentCount": sum(1 for o in new_objs if o.TypeId == "Part::Feature"),
            },
        }
    finally:
        try:
            os.remove(step_path)
        except OSError:
            pass
        try:
            os.rmdir(tmpdir)
        except OSError:
            pass


@method("kicad.importBom")
def kicad_import_bom(schPath, assemblyPn):
    """Parses a .kicad_sch's real BOM (via kicad-cli sch export bom) and
    saves it as this F (PCB Assembly) part's kit BOM (pn.saveBom) - the
    ECAD-side equivalent of how a mechanical assembly's BOM comes from its
    open document's App::Link tree (see methods.drawing_bom_rows /
    pn.resolveBomFilenames).

    A symbol only contributes a BOM row if it has a real GWT_PN custom
    field set on the INSTANCE (not the library symbol's own template
    definition, which kicad-cli's BOM export correctly ignores - confirmed
    directly: a field set on the shared lib_symbols entry never appears in
    the export, only one set on the placed symbol itself) matching a PN
    that was actually reserved in the registry. Every other symbol (a
    generic resistor with no company PN, say) is silently skipped - same
    "no PN, no BOM entry" policy pn.resolveBomFilenames already enforces
    for mechanical assemblies.

    --group-by GWT_PN aggregates repeated components (3x the same
    connector -> one row, qty 3) rather than one row per reference -
    verified this actually aggregates correctly, not just passes the flag
    through inertly."""
    from . import partnumbers as _pn

    if not schPath or not os.path.isfile(schPath):
        raise RpcError(APP_ERROR, "kicad.importBom: file not found: %r" % schPath)
    if not _kicad_cli_available():
        raise RpcError(APP_ERROR, "kicad-cli not found on PATH - can't read this board's real BOM")

    tmpdir = tempfile.mkdtemp(prefix="gwtcad-kicad-bom-")
    bom_path = os.path.join(tmpdir, "bom.csv")
    try:
        r = subprocess.run(
            [KICAD_CLI, "sch", "export", "bom", schPath, "--output", bom_path,
             "--fields", "Reference,GWT_PN,QUANTITY", "--labels", "Refs,GwtPn,Qty",
             "--group-by", "GWT_PN"],
            capture_output=True, text=True, timeout=60,
        )
        if not os.path.isfile(bom_path):
            raise RpcError(APP_ERROR,
                            "kicad-cli could not export a BOM from %s: %s" %
                            (schPath, (r.stderr or r.stdout or "unknown error").strip()))

        import csv
        with open(bom_path, newline="", encoding="utf-8") as f:
            rows = list(csv.DictReader(f))

        cfg = _pn._load_config()
        _pn._sync_pull(_pn._registry_path(cfg))
        registry_rows = _pn._read_registry(cfg)

        items = []
        skipped = []
        for row in rows:
            gwt_pn = (row.get("GwtPn") or "").strip()
            if not gwt_pn:
                continue  # a generic part with no company PN - not tracked
            reg_row = _pn._row_for_pn(registry_rows, gwt_pn)
            if reg_row is None:
                skipped.append(gwt_pn)  # a GWT_PN field with a typo/unreserved PN
                continue
            items.append({
                "pn": reg_row["pn"],
                "componentName": reg_row.get("description", ""),
                "qty": int(row.get("Qty") or 1),
            })

        result = _pn.pn_save_bom(assemblyPn, items)
        result["skipped"] = skipped
        return result
    finally:
        try:
            os.remove(bom_path)
        except OSError:
            pass
        try:
            os.rmdir(tmpdir)
        except OSError:
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
