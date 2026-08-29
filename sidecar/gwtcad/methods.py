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

_DATUM_TYPES = (
    "PartDesign::Plane", "PartDesign::Line", "PartDesign::Point",
    "PartDesign::CoordinateSystem",
)


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
def feature_extrude(sketchId, length=10.0, reversed=False, midplane=False, cut=False):
    d, sk = _obj(sketchId)
    if sk.TypeId != "Sketcher::SketchObject":
        raise RpcError(APP_ERROR, "%r is not a sketch" % sketchId)
    body = sk.getParentGeoFeatureGroup()
    if body is None or body.TypeId != "PartDesign::Body":
        raise RpcError(APP_ERROR, "sketch is not inside a Body")
    if cut:
        build.pocket(body, sk, float(length))
    else:
        build.pad(body, sk, float(length), reversed_=reversed, midplane=midplane)
    d.recompute()
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
def feature_hole(face, point, diameter=6.0, depth=10.0, throughAll=False):
    """Circular pocket on a planar face at a world-space point."""
    body = _require_body()
    tip = _solid_tip(body)
    d = body.Document
    sk = body.newObject("Sketcher::SketchObject", "Sketch")
    sk.Label = next_label(body, "Sketcher::SketchObject")
    sk.AttachmentSupport = [(tip, [face])]
    sk.MapMode = "FlatFace"
    d.recompute()
    import Part
    from FreeCAD import Vector, Placement
    wp = Vector(point[0], point[1], point[2])
    local = sk.Placement.inverse().multVec(wp)
    sk.addGeometry(Part.Circle(Vector(local.x, local.y, 0), Vector(0, 0, 1),
                               float(diameter) / 2.0), False)
    d.recompute()
    build.pocket(body, sk, float(depth), through_all=bool(throughAll))
    d.recompute()
    if not body.Shape.isValid():
        raise RpcError(APP_ERROR, "hole produced an invalid shape")
    return tree_get()


@method("pattern.linear")
def pattern_linear(direction=(1, 0, 0), count=3, spacing=20.0):
    body = _require_body()
    tip = _solid_tip(body)
    d = body.Document
    p = body.newObject("PartDesign::LinearPattern", "LinearPattern")
    p.Label = next_label(body, "PartDesign::LinearPattern")
    p.Originals = [tip]
    p.Length = float(spacing) * max(1, int(count) - 1)
    p.Occurrences = int(count)
    d.recompute()
    return tree_get()


@method("feature.mirror")
def feature_mirror(plane="YZ"):
    body = _require_body()
    tip = _solid_tip(body)
    d = body.Document
    m = body.newObject("PartDesign::Mirrored", "Mirrored")
    m.Label = next_label(body, "PartDesign::Mirrored")
    m.Originals = [tip]
    m.MirrorPlane = (build.origin_plane(body, plane), [""])
    d.recompute()
    return tree_get()


@method("datum.plane")
def datum_plane(basePlane="XY", offset=10.0):
    body = _require_body()
    d = body.Document
    pl = body.newObject("PartDesign::Plane", "DatumPlane")
    pl.Label = next_label(body, "PartDesign::Plane")
    pl.AttachmentSupport = [(build.origin_plane(body, basePlane), [""])]
    pl.MapMode = "FlatFace"
    from FreeCAD import Placement, Vector, Rotation
    pl.AttachmentOffset = Placement(Vector(0, 0, float(offset)), Rotation())
    d.recompute()
    return tree_get()


@method("sketch.onPlane")
def sketch_on_plane(plane="XY"):
    """Create an empty sketch on an origin plane and return its id (for the
    interactive sketch environment to populate)."""
    body = session.active_body()
    d = session.doc()
    if body is None:
        body = build.new_body(d)
    sk = body.newObject("Sketcher::SketchObject", "Sketch")
    sk.Label = next_label(body, "Sketcher::SketchObject")
    sk.AttachmentSupport = [(build.origin_plane(body, plane), "")]
    sk.MapMode = "FlatFace"
    d.recompute()
    return {"sketchId": sk.Name, "bodyId": body.Name, "placement": _placement(sk)}


def _placement(o):
    p = o.Placement
    b, axis = p.Base, p.Rotation.Axis
    return {
        "base": [b.x, b.y, b.z],
        "axis": [axis.x, axis.y, axis.z],
        "angle": p.Rotation.Angle,
    }


@method("sketch.addGeometry")
def sketch_add_geometry(sketchId, elements):
    """elements: [{type:'line', a:[x,y], b:[x,y]} | {type:'circle', c:[x,y], r} |
                  {type:'arc', c:[x,y], r, a0, a1}]  - coords in sketch plane mm."""
    d, sk = _obj(sketchId)
    import Part
    from FreeCAD import Vector
    for el in elements:
        t = el.get("type")
        if t == "line":
            a, b = el["a"], el["b"]
            sk.addGeometry(Part.LineSegment(Vector(a[0], a[1], 0), Vector(b[0], b[1], 0)), False)
        elif t == "circle":
            c = el["c"]
            sk.addGeometry(Part.Circle(Vector(c[0], c[1], 0), Vector(0, 0, 1), float(el["r"])), False)
        elif t == "arc":
            c = el["c"]
            circ = Part.Circle(Vector(c[0], c[1], 0), Vector(0, 0, 1), float(el["r"]))
            sk.addGeometry(Part.ArcOfCircle(circ, float(el["a0"]), float(el["a1"])), False)
        elif t == "rect":
            a, b = el["a"], el["b"]
            x0, y0, x1, y1 = a[0], a[1], b[0], b[1]
            corners = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
            for i in range(4):
                p0 = corners[i]
                p1 = corners[(i + 1) % 4]
                sk.addGeometry(Part.LineSegment(Vector(p0[0], p0[1], 0), Vector(p1[0], p1[1], 0)), False)
        else:
            raise RpcError(APP_ERROR, "unknown sketch element %r" % t)
    d.recompute()
    return {"sketchId": sketchId, "count": int(sk.GeometryCount)}


# --------------------------------------------------------------------------- #
# read-side: scene + tree
# --------------------------------------------------------------------------- #

@method("scene.get")
def scene_get():
    """Render buffers for every visible solid body + visible sketches."""
    d = session.doc(create=False)
    meshes = []
    sketches = []
    if d is not None:
        for o in d.Objects:
            if o.TypeId == "PartDesign::Body":
                if not getattr(o, "Visibility", True):
                    continue
                shape = getattr(o, "Shape", None)
                if shape is None or shape.isNull():
                    continue
                buf = tessellate_shape(shape)
                buf["id"] = o.Name
                buf["label"] = o.Label
                meshes.append(buf)
            elif o.TypeId == "App::Link":
                shape = getattr(o, "Shape", None)
                if shape is None or shape.isNull():
                    continue
                buf = tessellate_shape(shape)
                buf["id"] = o.Name
                buf["label"] = o.Label
                buf["component"] = True
                meshes.append(buf)
            elif o.TypeId == "Sketcher::SketchObject" and getattr(o, "Visibility", False):
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
                sketches.append({"id": o.Name, "label": o.Label, "polys": polys})
    return {"meshes": meshes, "sketches": sketches}


@method("tree.get")
def tree_get():
    """Feature tree for the timeline + browser."""
    d = session.doc(create=False)
    bodies = []
    if d is not None:
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
                    "error": bool(getattr(f, "State", None) and "Error" in f.State),
                })
            bodies.append({
                "id": o.Name,
                "label": o.Label,
                "visible": bool(getattr(o, "Visibility", True)),
                "features": feats,
            })
    return {"bodies": bodies, "path": session.path()}


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


@method("object.setVisibility")
def object_set_visibility(id, visible):
    d, o = _obj(id)
    o.Visibility = bool(visible)
    d.recompute()
    return {"id": id, "visible": bool(o.Visibility)}


@method("history.rollTo")
def history_roll_to(bodyId, featureId=None):
    """Set the Body tip (Fusion's rollback marker). featureId=None -> newest."""
    d, body = _obj(bodyId)
    if body.TypeId != "PartDesign::Body":
        raise RpcError(APP_ERROR, "%r is not a Body" % bodyId)
    feats = [f for f in body.Group if f.TypeId != "App::Origin"]
    if not feats:
        return {"tip": None}
    target = feats[-1] if featureId is None else d.getObject(featureId)
    if target is None:
        raise RpcError(APP_ERROR, "no feature %r" % featureId)
    body.Tip = target
    # everything after the tip is hidden; tip solid shown
    reached = False
    for f in feats:
        if _kind(f.TypeId) == "solid":
            f.Visibility = f is target or (not reached)
        if f is target:
            reached = True
    d.recompute()
    return {"tip": target.Name}


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

@method("document.saveAs")
def document_save_as(path):
    d = session.doc(create=False)
    if d is None:
        raise RpcError(APP_ERROR, "no document")
    path = os.path.abspath(os.path.expanduser(path))
    d.saveAs(path)
    session.set_path(path)
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
    return {"path": p}


@method("document.open")
def document_open(path):
    path = os.path.abspath(os.path.expanduser(path))
    if not os.path.isfile(path):
        raise RpcError(APP_ERROR, "no such file: %s" % path)
    d = session.open_path(path)
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


@method("io.importStep")
def io_import_step(path):
    """STEP / IGES / BREP import. Uses the headless-safe `Import` module."""
    import Import
    d = session.doc()
    path = os.path.abspath(os.path.expanduser(path))
    if not os.path.isfile(path):
        raise RpcError(APP_ERROR, "no such file: %s" % path)
    Import.insert(path, d.Name)
    d.recompute()
    return {"path": path}

@method("io.exportStep")
def io_export_step(path):
    d = session.doc(create=False)
    if d is None:
        raise RpcError(APP_ERROR, "no document")
    path = os.path.abspath(os.path.expanduser(path))
    objs = [o for o in d.Objects if o.TypeId == "PartDesign::Body"]
    Part.export(objs, path)
    return {"path": path, "bodies": len(objs)}


@method("io.exportStl")
def io_export_stl(path):
    import Mesh
    d = session.doc(create=False)
    if d is None:
        raise RpcError(APP_ERROR, "no document")
    path = os.path.abspath(os.path.expanduser(path))
    objs = [o for o in d.Objects if o.TypeId == "PartDesign::Body"]
    Mesh.export(objs, path)
    return {"path": path, "bodies": len(objs)}
