#!/usr/bin/env python3
"""Build the HES 9400 1/16" mounting spacer as a native GWT-CAD model.

Drives the GWT-CAD sidecar (headless FreeCAD) over its JSON-RPC API - the same
calls the app's ribbon fires - so the result is a real PartDesign::Body with a
full, editable feature timeline (sketches, pad, fillet, pockets), not an
imported dead solid.

    python3 models/hes-9400-spacer/build_spacer.py [--out DIR]

Writes <out>/HES-9400-spacer-1_16in.FCStd (+ .gwtcad.json sidecar, and a STEP
next to it for anyone who just wants the solid).

Geometry comes from the HES 9400/9500/9600/9700 frame-preparation template
(HES doc 3026006.002 rev C) and the 9400 series data sheet - see README.md.
"""
import argparse
import json
import os
import subprocess
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))


# --- the part, in one place -------------------------------------------------
# Every number below is off the HES frame-preparation template. Lengths are
# along the strike (X, +X = top of the strike as installed), widths across it
# (Y, +Y = the edge toward the door), thickness along Z.
PARAMS = [
    # name,                expression,      what it is
    ("plate_length",       "9 in",          "strike body length, 9\" [228.6]"),
    ("plate_width",        "1.75 in",       "strike body width, 1-3/4\" [44.5]"),
    ("plate_thickness",    "0.0625 in",     "the spacer: 1/16\" shim"),
    ("corner_radius",      "0.125 in",      "corner break so it sits flat and clean"),
    ("mount_offset",       "4.125 in",      "mounting screws 4-1/8\" [104.8] each side of the latchbolt centerline"),
    ("mount_hole_dia",     "0.28125 in",    "9/32\" clearance for the 1/4\"-20 x 1\" mounting screws"),
    ("power_hole_dia",     "0.75 in",       "3/4\" [19] clearance for power wiring, on the latchbolt centerline"),
    ("lbm_offset",         "2.625 in",      "LBM/LBSM wiring hole, 2 x 1-5/16\" above the latchbolt centerline"),
    ("lbm_hole_dia",       "0.5 in",        "1/2\" [12.7] clearance for LBM/LBSM wiring"),
    ("lockdown_offset",    "1.3125 in",     "optional lockdown screw, 1-5/16\" [33.3] above the latchbolt centerline"),
    ("lockdown_from_door", "1.0625 in",     "lockdown screw sits 1-1/16\" [27.0] in from the door-side edge"),
    ("lockdown_hole_dia",  "6 mm",          "generous clearance for the #10-32 UNF / 10-24 UNC lockdown screw"),
]


# --- sidecar plumbing -------------------------------------------------------
class Sidecar:
    """Start freecadcmd + sidecar/server.py, talk JSON-RPC 2.0 to it."""

    def __init__(self):
        cfg_path = os.path.join(ROOT, "config.local.json")
        if not os.path.exists(cfg_path):
            cfg_path = os.path.join(ROOT, "config.example.json")
        cfg = json.load(open(cfg_path))
        self.cmd = os.path.expanduser(cfg.get("freecadcmd", "freecadcmd"))
        self.proc = None
        self.url = None
        self._id = 0

    def __enter__(self):
        env = dict(os.environ, GWTCAD_HOST="127.0.0.1", GWTCAD_PORT="0")
        self.proc = subprocess.Popen(
            [self.cmd, os.path.join(ROOT, "sidecar", "server.py")],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env, text=True)
        deadline = time.time() + 120
        while time.time() < deadline:
            line = self.proc.stdout.readline()
            if not line:
                if self.proc.poll() is not None:
                    raise RuntimeError("sidecar exited before it was ready")
                continue
            if line.startswith("GWTCAD_SIDECAR_READY "):
                info = json.loads(line[len("GWTCAD_SIDECAR_READY "):])
                self.url = "http://%s:%d/rpc" % (info["host"], info["port"])
                return self
        raise RuntimeError("sidecar did not report ready")

    def __exit__(self, *_exc):
        if self.proc is not None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.proc.kill()

    def mm(self, name_or_expr):
        """Millimetres, evaluated by the engine's own parameter evaluator - the
        script and the model can never drift apart on what a number means."""
        return self.rpc("expr.eval", text=name_or_expr)["value"]

    def rpc(self, method, **params):
        self._id += 1
        body = json.dumps({"jsonrpc": "2.0", "id": self._id,
                           "method": method, "params": params}).encode()
        req = urllib.request.Request(self.url, data=body,
                                     headers={"Content-Type": "application/json"})
        out = json.loads(urllib.request.urlopen(req, timeout=300).read())
        if "error" in out:
            raise RuntimeError("%s: %s" % (method, out["error"].get("message")))
        return out["result"]


# --- small helpers over the RPC surface ------------------------------------
def last_feature(tree):
    """id of the feature the call just created (the tip of the first body)."""
    feats = tree["bodies"][0]["features"]
    return feats[-1]["id"]


def vertical_edges(sc, thickness):
    """Edge names of the plate's four corner edges, read back off the live scene
    the same way a viewport click would - no guessing at OCCT edge numbering."""
    mesh = sc["meshes"][0]
    found = []
    for e in mesh.get("edges", []):
        pts = e["points"]
        xs, ys, zs = pts[0::3], pts[1::3], pts[2::3]
        if (max(xs) - min(xs) < 1e-6 and max(ys) - min(ys) < 1e-6
                and abs((max(zs) - min(zs)) - thickness) < 1e-3):
            found.append(("Edge%d" % (e["edge"] + 1),
                          [xs[0], ys[0], (max(zs) + min(zs)) / 2.0]))
    return found


def circles_sketch(s, holes, label):
    """A sketch of fully-dimensioned circles on the XY plane, ready to pocket.
    holes: [(x, y, diameter), ...] in mm."""
    sk = s.rpc("sketch.onPlane", plane="XY")["sketchId"]
    origin = {"geo": -1, "pt": 1}   # sketch origin = the latchbolt centreline
    x_axis, y_axis = {"geo": -1}, {"geo": -2}
    elements, constraints = [], []
    for i, (x, y, dia) in enumerate(holes):
        centre = {"new": i, "pt": 3}
        elements.append({"type": "circle", "c": [x, y], "r": dia / 2.0})
        constraints.append({"type": "Diameter", "refs": [{"new": i}], "value": dia})
        # Lock each centre against the origin so the sketch is solved, not just
        # drawn. A dimensional constraint here only takes a POSITIVE value, so
        # for a negative coordinate the refs go the other way round (the
        # distance is then measured centre -> origin) instead of losing the
        # sign and mirroring the hole to the wrong side of the plate.
        for axis, value, on_axis in (("DistanceX", x, y_axis), ("DistanceY", y, x_axis)):
            if abs(value) < 1e-9:
                constraints.append({"type": "PointOnObject", "refs": [centre, on_axis]})
            elif value > 0:
                constraints.append({"type": axis, "refs": [origin, centre], "value": value})
            else:
                constraints.append({"type": axis, "refs": [centre, origin], "value": -value})
    if not s.rpc("sketch.finish", sketchId=sk, autoConstrain=False,
                 elements=elements, constraints=constraints)["constrained"]:
        raise RuntimeError("%s is not fully constrained" % label)
    s.rpc("feature.rename", id=sk, label=label)
    return sk


# --- drawing sheet ----------------------------------------------------------
SHEET_W, SHEET_H = 420.0, 297.0  # the app's sheet is A3 landscape


def full_circles(targets):
    """Snap targets that are whole circles (a hole rim), deduplicated - the
    top and bottom face of a through hole project onto each other."""
    seen, out = set(), []
    for t in targets:
        if "radius" not in t or "center" not in t:
            continue
        if abs(t["p1"][0] - t["p2"][0]) > 1e-6 or abs(t["p1"][1] - t["p2"][1]) > 1e-6:
            continue  # an arc (a corner break), not a full circle
        key = (round(t["center"][0], 3), round(t["center"][1], 3), round(t["radius"], 3))
        if key in seen:
            continue
        seen.add(key)
        out.append(t)
    return out


def dimension(s, page, view, subs, kind, expect, label=None, tol=0.02):
    """Add a dimension, check it actually measures what it is meant to (a
    drawing that reads a wrong number is worse than no drawing), and drop its
    label where it belongs on the sheet."""
    res = s.rpc("drawing.addDimension", pageId=page, viewId=view,
                refs=[{"sub": x} for x in subs], kind=kind)
    got = res.get("value")
    if got is None or abs(got - expect) > tol:
        s.rpc("drawing.removeDimension", dimId=res["id"])
        raise RuntimeError("%s dimension on %s read %r, expected %.4f"
                           % (kind, subs, got, expect))
    if label is not None:
        s.rpc("drawing.moveDimension", dimId=res["id"], labelUV=list(label))
    return res


def preview_svg(s, page, path):
    """A flat SVG of the sheet, for anyone reading the repo without the app
    open. The app draws its own (richer) sheet from exactly this payload."""
    c = s.rpc("drawing.pageContents", pageId=page)
    views = {v["id"]: v for v in c["views"]}
    fmts = s.rpc("drawing.getDimensionFormats")["overrides"]

    def pt(view, x, y):
        """Sheet mm, y up from the bottom-left corner like the page itself."""
        return view["x"] + x, SHEET_H - (view["y"] + y)

    out = ['<svg xmlns="http://www.w3.org/2000/svg" width="420mm" height="297mm" '
           'viewBox="0 0 %g %g">' % (SHEET_W, SHEET_H),
           '<rect x="0" y="0" width="%g" height="%g" fill="#fff"/>' % (SHEET_W, SHEET_H),
           '<rect x="10" y="10" width="%g" height="%g" fill="none" stroke="#222" '
           'stroke-width="0.7"/>' % (SHEET_W - 20, SHEET_H - 20),
           '<g stroke="#111" stroke-width="0.35" fill="none" '
           'stroke-linecap="round" stroke-linejoin="round">']
    for v in c["views"]:
        for poly in v["visible"]:
            pts = " ".join("%.3f,%.3f" % pt(v, x, y) for x, y in poly)
            out.append('<polyline points="%s"/>' % pts)
    out.append("</g>")

    out.append('<g stroke="#1553a8" stroke-width="0.25" fill="none">')
    labels = []
    for dim in c["dimensions"]:
        v = views.get(dim["viewId"])
        if v is None:
            continue
        fmt = fmts.get(dim["id"], {})
        lx, ly = pt(v, *dim["labelUV"])
        text = "%s%.2f%s" % (fmt.get("textPrefix", ""), dim["value"], fmt.get("textSuffix", ""))
        if dim["type"] in ("Diameter", "Radius"):
            cx, cy = pt(v, *dim["center"])
            out.append('<line x1="%.3f" y1="%.3f" x2="%.3f" y2="%.3f"/>' % (cx, cy, lx, ly))
            text = "%s%s%.2f" % (fmt.get("textPrefix", ""),
                                 "R" if dim["type"] == "Radius" else "\u2300", dim["value"])
        else:
            (x1, y1), (x2, y2) = pt(v, *dim["p1"]), pt(v, *dim["p2"])
            if dim["type"] == "DistanceX":
                out.append('<polyline points="%.3f,%.3f %.3f,%.3f %.3f,%.3f %.3f,%.3f"/>'
                           % (x1, y1, x1, ly, x2, ly, x2, y2))
            elif dim["type"] == "DistanceY":
                out.append('<polyline points="%.3f,%.3f %.3f,%.3f %.3f,%.3f %.3f,%.3f"/>'
                           % (x1, y1, lx, y1, lx, y2, x2, y2))
            else:
                out.append('<line x1="%.3f" y1="%.3f" x2="%.3f" y2="%.3f"/>' % (x1, y1, x2, y2))
        labels.append((lx, ly, text))
    out.append("</g>")

    out.append('<g font-family="DejaVu Sans, Helvetica, sans-serif" fill="#1553a8" '
               'font-size="3.4" text-anchor="middle">')
    for lx, ly, text in labels:
        out.append('<text x="%.3f" y="%.3f">%s</text>' % (lx, ly - 1.0, text))
    out.append("</g>")

    out.append('<g font-family="DejaVu Sans, Helvetica, sans-serif" fill="#111" font-size="3.6">')
    for note in c["notes"]:
        nx, ny = note["x"], SHEET_H - note["y"]
        for i, line in enumerate(note["text"].split("\n")):
            out.append('<text x="%.3f" y="%.3f">%s</text>'
                       % (nx, ny + i * 5.0, line.replace("&", "&amp;").replace("<", "&lt;")))
    out.append("</g></svg>")
    with open(path, "w") as f:
        f.write("\n".join(out))
    return path


def sheet(s, body_id, L, W, T, holes):
    """A dimensioned A3 sheet: the face with every hole called out, plus an
    edge view carrying the 1/16" thickness."""
    page = s.rpc("drawing.pageCreate", label="Spacer")["id"]

    face = s.rpc("drawing.addView", pageId=page, bodyId=body_id,
                 direction="top", scale=1.0)["id"]
    s.rpc("drawing.setViewPosition", viewId=face, x=SHEET_W / 2, y=200.0)
    targets = s.rpc("drawing.snapTargets", viewId=face)["targets"]
    circles = full_circles(targets)

    # which way model +X ends up pointing on the sheet, read off the one hole
    # whose diameter is unique (the lockdown one) instead of assumed
    lock_x, lock_y, lock_d = holes[4]
    lock = next((c for c in circles if abs(c["radius"] * 2 - lock_d) < 1e-3), None)
    if lock is None:
        raise RuntimeError("lockdown hole is not on the sheet")
    flip = 1.0 if (lock["center"][0] > 0) == (lock_x > 0) else -1.0

    def circle_at(x, dia):
        """The hole at this model position - picked off the sheet the way a
        click would, not by guessing at OCCT edge numbering."""
        for c in circles:
            if abs(c["radius"] * 2 - dia) < 1e-3 and abs(c["center"][0] - flip * x) < 1e-3:
                return c["sub"]
        raise RuntimeError("no dia %.3f hole at x=%.3f on the sheet" % (dia, x))

    # Hole diameters, each label parked in its own lane so the sheet reads
    # cleanly the moment it is opened instead of as a pile of overlapping
    # numbers on the centreline. The two mounting holes are one "2X" callout,
    # the way a shop drawing would write it, rather than the same note twice.
    mount_x, _my, mount_d = holes[0]
    _zero, _zy, power_d = holes[2]
    lbm_x, _ly, lbm_d = holes[3]
    mount = dimension(s, page, face, [circle_at(mount_x, mount_d)], "Diameter",
                      mount_d, label=(flip * mount_x, 34.0))
    s.rpc("drawing.setDimensionFormat", dimId=mount["id"], fmt={"textPrefix": "2X "})
    dimension(s, page, face, [circle_at(0.0, power_d)], "Diameter", power_d,
              label=(0.0, 34.0))
    dimension(s, page, face, [circle_at(lbm_x, lbm_d)], "Diameter", lbm_d,
              label=(flip * lbm_x, 46.0))
    dimension(s, page, face, [circle_at(lock_x, lock_d)], "Diameter", lock_d,
              label=(flip * lock_x, -34.0))

    # hole positions, dimensioned off the latchbolt centreline like the
    # HES frame-preparation template does, stacked below the part
    power = circle_at(0.0, power_d)
    for (x, _y, dia), band in ((holes[3], -46.0), (holes[4], -54.0),
                               (holes[0], -62.0), (holes[1], -62.0)):
        dimension(s, page, face, [power, circle_at(x, dia)], "DistanceX", abs(x),
                  label=(flip * x / 2.0, band))
    dimension(s, page, face, [power, circle_at(lock_x, lock_d)], "DistanceY",
              abs(lock_y), label=(flip * 48.0, -2.4))

    # overall plate: the two end edges and the two long edges
    lines = [t for t in targets if "radius" not in t and t["kind"] == "edge"]
    vert = [t for t in lines if abs(t["p1"][0] - t["p2"][0]) < 1e-6]
    horiz = [t for t in lines if abs(t["p1"][1] - t["p2"][1]) < 1e-6]
    ends = (min(vert, key=lambda t: t["p1"][0]), max(vert, key=lambda t: t["p1"][0]))
    sides = (min(horiz, key=lambda t: t["p1"][1]), max(horiz, key=lambda t: t["p1"][1]))
    dimension(s, page, face, [ends[0]["sub"], ends[1]["sub"]], "DistanceX", L,
              label=(0.0, 60.0))
    dimension(s, page, face, [sides[0]["sub"], sides[1]["sub"]], "DistanceY", W,
              label=(-134.0, 0.0))

    # and the edge view, for the one dimension that makes this a 1/16" spacer
    edge = s.rpc("drawing.addView", pageId=page, bodyId=body_id,
                 direction="front", scale=1.0)["id"]
    s.rpc("drawing.setViewPosition", viewId=edge, x=SHEET_W / 2, y=100.0)
    verts = [t for t in s.rpc("drawing.snapTargets", viewId=edge)["targets"]
             if t["kind"] == "vertex"]
    pair = None
    for i, a in enumerate(verts):
        for b in verts[i + 1:]:
            if abs(a["p"][0] - b["p"][0]) < 1e-6 and abs(abs(a["p"][1] - b["p"][1]) - T) < 1e-4:
                pair = (a["sub"], b["sub"])
                break
        if pair:
            break
    if pair is None:
        raise RuntimeError("no through-thickness vertex pair on the edge view")
    dimension(s, page, edge, list(pair), "DistanceY", T, label=(-134.0, 0.0))

    s.rpc("drawing.addNote", pageId=page, x=32.0, y=62.0, textSize=4.0, text=(
        "HES 9400 SERIES SURFACE MOUNTED ELECTRIC STRIKE - 1/16 IN MOUNTING SPACER\n"
        "MATERIAL: 1/16 IN (1.59) STAINLESS SHEET OR SHIM STOCK, 304\n"
        "  16 GA (1.51) IS AN ACCEPTABLE SUBSTITUTE - IT MOVES THE STRIKE 0.08 LESS\n"
        "HOLE PATTERN PER HES FRAME PREPARATION TEMPLATE, DOC 3026006.002 REV C\n"
        "BREAK ALL SHARP EDGES. DIMENSIONS IN MILLIMETRES."))
    return page


def build(out_dir):
    os.makedirs(out_dir, exist_ok=True)
    fcstd = os.path.join(out_dir, "HES-9400-spacer-1_16in.FCStd")
    step = os.path.join(out_dir, "HES-9400-spacer-1_16in.step")

    with Sidecar() as s:
        s.rpc("ping")
        s.rpc("session.reset")

        # 1. parameters - the model is driven from these, and they show up in
        #    the app's parameters panel for anyone who wants a 1/8" instead
        for name, expression, _comment in PARAMS:
            s.rpc("params.set", name=name, expr=expression)

        L, W, T = s.mm("plate_length"), s.mm("plate_width"), s.mm("plate_thickness")
        R = s.mm("corner_radius")
        mount_x, mount_d = s.mm("mount_offset"), s.mm("mount_hole_dia")
        power_d = s.mm("power_hole_dia")
        lbm_x, lbm_d = s.mm("lbm_offset"), s.mm("lbm_hole_dia")
        lock_x, lock_d = s.mm("lockdown_offset"), s.mm("lockdown_hole_dia")
        lock_y = W / 2.0 - s.mm("lockdown_from_door")

        # 2. plate outline: a rectangle centred on the latchbolt centreline
        sk = s.rpc("sketch.onPlane", plane="XY")["sketchId"]
        res = s.rpc(
            "sketch.finish", sketchId=sk, autoConstrain=False,
            elements=[{"type": "rect", "a": [-L / 2.0, -W / 2.0], "b": [L / 2.0, W / 2.0]}],
            constraints=[
                # centre the rectangle on the origin (= latchbolt centreline)
                {"type": "Symmetric", "refs": [{"new": 0, "sub": 0, "pt": 1},
                                               {"new": 0, "sub": 2, "pt": 1},
                                               {"geo": -1, "pt": 1}]},
                {"type": "DistanceX", "refs": [{"new": 0, "sub": 0, "pt": 1},
                                               {"new": 0, "sub": 0, "pt": 2}], "value": L},
                {"type": "DistanceY", "refs": [{"new": 0, "sub": 1, "pt": 1},
                                               {"new": 0, "sub": 1, "pt": 2}], "value": W},
            ])
        if not res.get("closed"):
            raise RuntimeError("outline sketch did not close")
        s.rpc("feature.rename", id=sk, label="Plate Outline")

        # 3. pad it to the spacer thickness, driven by the parameter
        tree = s.rpc("feature.extrude", sketchId=sk, length=T)
        pad = last_feature(tree)
        s.rpc("feature.setExpr", id=pad, prop="Length", expr="plate_thickness")
        s.rpc("feature.rename", id=pad, label="Plate")

        # 4. break the four corners
        corners = vertical_edges(s.rpc("scene.get"), T)
        if len(corners) != 4:
            raise RuntimeError("expected 4 corner edges, found %d" % len(corners))
        tree = s.rpc("feature.fillet", edges=[n for n, _p in corners],
                     points=[p for _n, p in corners], radius=R)
        fillet = last_feature(tree)
        s.rpc("feature.setExpr", id=fillet, prop="Radius", expr="corner_radius")
        s.rpc("feature.rename", id=fillet, label="Corner Breaks")

        # 5. the two 1/4"-20 mounting screws pass through
        holes_sk = circles_sketch(s, [(mount_x, 0.0, mount_d), (-mount_x, 0.0, mount_d)],
                                  "Mounting Hole Profile")
        tree = s.rpc("feature.extrude", sketchId=holes_sk, operation="cut", throughAll=True)
        s.rpc("feature.rename", id=last_feature(tree), label="Mounting Holes")

        # 6. wiring clearance: power on the latchbolt centreline, LBM/LBSM above it
        wiring_sk = circles_sketch(s, [(0.0, 0.0, power_d), (lbm_x, 0.0, lbm_d)],
                                   "Wiring Clearance Profile")
        tree = s.rpc("feature.extrude", sketchId=wiring_sk, operation="cut", throughAll=True)
        s.rpc("feature.rename", id=last_feature(tree), label="Wiring Clearance")

        # 7. the optional lockdown screw - suppress this feature if you are not
        #    using it, the rest of the part does not depend on it
        lock_sk = circles_sketch(s, [(lock_x, lock_y, lock_d)],
                                 "Lockdown Clearance Profile")
        tree = s.rpc("feature.extrude", sketchId=lock_sk, operation="cut", throughAll=True)
        s.rpc("feature.rename", id=last_feature(tree), label="Lockdown Clearance (optional)")

        # 8. stainless, like the strike it hides behind
        body = s.rpc("tree.get")["bodies"][0]
        s.rpc("feature.rename", id=body["id"], label="HES 9400 Spacer 1-16in")
        presets = [m for fam in s.rpc("material.presets")["families"]
                   for m in fam["materials"]]
        stainless = next((m for m in presets if "stainless" in m["name"].lower()), None)
        if stainless is not None:
            s.rpc("material.assign", targetId=body["id"], uuid=stainless["uuid"])

        # 9. a dimensioned sheet, so this can also just be handed to a shop
        holes = [(mount_x, 0.0, mount_d), (-mount_x, 0.0, mount_d),
                 (0.0, 0.0, power_d), (lbm_x, 0.0, lbm_d), (lock_x, lock_y, lock_d)]
        page = sheet(s, body["id"], L, W, T, holes)
        preview = preview_svg(s, page, os.path.join(out_dir, "drawing-preview.svg"))

        s.rpc("document.saveAs", path=fcstd)
        s.rpc("io.exportStep", path=step)
        return fcstd, step, preview, s.rpc("tree.get")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=HERE, help="output directory (default: this one)")
    args = ap.parse_args()
    fcstd, step, preview, tree = build(args.out)
    print("timeline:")
    for f in tree["bodies"][0]["features"]:
        print("  %-12s %s" % (f["opType"], f["label"]))
    print("wrote %s" % fcstd)
    print("wrote %s" % step)
    print("wrote %s" % preview)


if __name__ == "__main__":
    main()
