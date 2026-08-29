"""Headless assemblies on FreeCAD 1.1's built-in Assembly workbench.

Level 1 (solid): an `Assembly::AssemblyObject` holding `App::Link`s to bodies in
external `.FCStd` files, each positioned by a Placement, one grounded.

Level 2 (best-effort): real joints via `JointObject.Joint` + the MbD solver. The
reference format the workbench feeds from GUI selection is replicated here; if the
solve does not converge the joint is still recorded.
"""
import os

import FreeCAD as App

from .registry import RpcError, APP_ERROR

JOINT_TYPES = (
    "Fixed", "Revolute", "Cylindrical", "Slider", "Ball",
    "Distance", "Parallel", "Perpendicular", "Angle",
)


def get_or_make_assembly(doc):
    for o in doc.Objects:
        if o.TypeId == "Assembly::AssemblyObject":
            return o
    asm = doc.addObject("Assembly::AssemblyObject", "Assembly")
    doc.recompute()
    return asm


def add_component(doc, path, name=None):
    path = os.path.abspath(os.path.expanduser(path))
    if not os.path.isfile(path):
        raise RpcError(APP_ERROR, "no such file: %s" % path)

    # cross-document App::Link requires the container document to be on disk
    if not doc.FileName:
        import tempfile
        tmp = os.path.join(tempfile.gettempdir(), "gwtcad-assembly-%d.FCStd" % os.getpid())
        doc.saveAs(tmp)

    asm = get_or_make_assembly(doc)

    src = None
    for d in App.listDocuments().values():
        if getattr(d, "FileName", "") == path:
            src = d
            break
    if src is None:
        src = App.openDocument(path, hidden=True)

    bodies = [o for o in src.Objects if o.TypeId == "PartDesign::Body"]
    target = bodies[0] if bodies else (src.Objects[0] if src.Objects else None)
    if target is None:
        raise RpcError(APP_ERROR, "%s has nothing to link" % os.path.basename(path))

    link = doc.addObject("App::Link", name or os.path.splitext(os.path.basename(path))[0])
    link.LinkedObject = target
    try:
        asm.addObject(link)
    except Exception:
        pass
    doc.recompute()
    return link


def set_placement(doc, link_name, base, axis, angle_deg):
    link = doc.getObject(link_name)
    if link is None:
        raise RpcError(APP_ERROR, "no component %r" % link_name)
    from FreeCAD import Vector, Rotation, Placement
    link.Placement = Placement(
        Vector(*base), Rotation(Vector(*axis), float(angle_deg))
    )
    doc.recompute()
    return link


def ground(doc, link_name):
    """Mark a component fixed. Uses a JointObject.GroundedJoint when available."""
    link = doc.getObject(link_name)
    if link is None:
        raise RpcError(APP_ERROR, "no component %r" % link_name)
    # always carry a flag so the tree/UI reflect grounding no matter which
    # engine path succeeds below
    if "Grounded" not in link.PropertiesList:
        link.addProperty("App::PropertyBool", "Grounded", "Assembly")
    link.Grounded = True
    try:
        import JointObject
        asm = get_or_make_assembly(doc)
        obj = doc.addObject("App::FeaturePython", "GroundedJoint")
        JointObject.GroundedJoint(obj, link)
        try:
            asm.addObject(obj)
        except Exception:
            pass
        doc.recompute()
        return {"grounded": link_name, "via": "GroundedJoint"}
    except Exception as e:  # noqa: BLE001
        return {"grounded": link_name, "via": "flag", "note": str(e)}


def add_joint(doc, jtype, comp1, sub1, comp2, sub2, **params):
    if jtype not in JOINT_TYPES:
        raise RpcError(APP_ERROR, "unknown joint type %r" % jtype)
    try:
        import JointObject
        import UtilsAssembly
    except Exception as e:
        raise RpcError(APP_ERROR, "JointObject unavailable: %s" % e)

    asm = get_or_make_assembly(doc)
    c1 = doc.getObject(comp1)
    c2 = doc.getObject(comp2)
    if c1 is None or c2 is None:
        raise RpcError(APP_ERROR, "joint needs two existing components")

    # The built-in Assembly joint proxy is tightly coupled to the GUI selection /
    # edit model. Try the real proxy first; if it will not initialise headless,
    # fall back to a plain record object so the joint still shows in the tree and
    # round-trips in the .FCStd.
    engine = "solver"
    obj = None
    _orig = getattr(UtilsAssembly, "activeAssembly", None)
    UtilsAssembly.activeAssembly = lambda *a, **k: asm
    try:
        type_index = list(JointObject.JointTypes).index(jtype)
        obj = doc.addObject("App::FeaturePython", "Joint")
        JointObject.Joint(obj, type_index)
        obj.JointType = jtype
        if "Reference1" in obj.PropertiesList:
            obj.Reference1 = [(c1, [sub1 or ""])]
            obj.Reference2 = [(c2, [sub2 or ""])]
    except Exception:
        if obj is not None:
            try:
                doc.removeObject(obj.Name)
            except Exception:
                pass
        engine = "record"
        obj = doc.addObject("App::FeaturePython", "Joint")
        for pname, val in (
            ("JointType", jtype),
            ("Component1", "%s:%s" % (comp1, sub1)),
            ("Component2", "%s:%s" % (comp2, sub2)),
        ):
            obj.addProperty("App::PropertyString", pname, "Joint")
            setattr(obj, pname, val)
    finally:
        if _orig is not None:
            UtilsAssembly.activeAssembly = _orig

    for k, v in params.items():
        if k in obj.PropertiesList:
            setattr(obj, k, v)
    try:
        asm.addObject(obj)
    except Exception:
        pass

    solved = engine == "solver"
    try:
        if hasattr(asm, "solve"):
            asm.solve()
        doc.recompute()
    except Exception:
        solved = False
    return {"id": obj.Name, "type": jtype, "solved": solved, "engine": engine}


def tree(doc):
    asm = None
    for o in doc.Objects:
        if o.TypeId == "Assembly::AssemblyObject":
            asm = o
            break
    if asm is None:
        return {"assembly": None, "components": [], "joints": []}
    comps, joints = [], []
    for o in doc.Objects:
        if o.TypeId == "App::Link":
            p = o.Placement
            comps.append({
                "id": o.Name,
                "label": o.Label,
                "grounded": bool(getattr(o, "Grounded", False)),
                "placement": {
                    "base": [p.Base.x, p.Base.y, p.Base.z],
                    "axis": [p.Rotation.Axis.x, p.Rotation.Axis.y, p.Rotation.Axis.z],
                    "angle": p.Rotation.Angle,
                },
            })
        elif o.Name.startswith("Joint") or o.Name.startswith("GroundedJoint"):
            joints.append({
                "id": o.Name,
                "label": o.Label,
                "type": getattr(o, "JointType", "Grounded"),
            })
    return {"assembly": asm.Name, "components": comps, "joints": joints}
