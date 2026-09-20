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


def _get_or_make_joint_group(doc, asm):
    """Joints must live in a real Assembly::JointGroup, not as loose top-level
    objects - JointObject.Joint's internal setJointConnectors() walks up to
    find the owning Assembly via the object's parent group, and without a
    JointGroup that lookup returns None and crashes
    ('NoneType' object has no attribute 'Type', confirmed live 2026-09-20:
    reproducing the exact prior code path - doc.addObject a bare
    App::FeaturePython, never placed in a group - hit this every time)."""
    for o in doc.Objects:
        if o.TypeId == "Assembly::JointGroup":
            return o
    jg = asm.newObject("Assembly::JointGroup", "Joints")
    doc.recompute()
    return jg


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

    # FreeCAD auto-opens a component's document as a dependency the moment the
    # CONTAINER document (doc) is opened, to resolve whatever App::Link target
    # was saved last time - but that auto-open is a partial restore keyed to
    # the stale saved link, not a full read of the file. Found live: an
    # enclosure file with two bodies (an empty starter "Body" plus the real
    # "Body001" with actual geometry) auto-loaded via the container's own
    # links showed ONLY "Body" - the real body was simply missing from
    # src.Objects, even though opening that same file directly (no container
    # involved) shows both. Re-opening the already-open doc in place isn't
    # safe either: any EXISTING App::Link elsewhere in this process still
    # holds direct references into the old in-memory objects, and closing
    # that document invalidates them (their Shape silently goes null even
    # though LinkedObject still reports a name) - confirmed by reproducing it
    # standalone, 2026-09-19. So: read the target from a private, freshly
    # opened handle on the same path (never touching whatever FreeCAD already
    # auto-loaded), then point the new link at the SAME live document by
    # object name - by the time this returns, App.listDocuments() only has
    # one document for that path (FreeCAD collapses re-opens of an
    # already-open path onto the existing Document object rather than
    # creating a second one), so the name-based lookup lands on a fully
    # populated document without disturbing any link that already depends on
    # it.
    src = App.openDocument(path, hidden=True)

    def _has_solid(body):
        tip = getattr(body, "Tip", None)
        return tip is not None and tip.TypeId != "App::Origin"

    bodies = [o for o in src.Objects if o.TypeId == "PartDesign::Body"]
    solid_bodies = [b for b in bodies if _has_solid(b)]
    loose_shapes = [o for o in src.Objects
                    if o.TypeId in ("Part::Feature", "Mesh::Feature", "App::Link")]
    target = (solid_bodies[0] if solid_bodies else
              loose_shapes[0] if loose_shapes else
              bodies[0] if bodies else
              src.Objects[0] if src.Objects else None)
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


def remove_component(doc, link_name):
    """Remove a linked component (and any joints/grounds referencing it) from
    the assembly. Used when re-pointing a component at a different resolved
    file (e.g. switching a git pin) - simplest correct way to change what an
    existing App::Link points at is to drop it and add a fresh one."""
    link = doc.getObject(link_name)
    if link is None:
        return {"removed": False}
    for o in list(doc.Objects):
        if o.Name.startswith("Joint") or o.Name.startswith("GroundedJoint"):
            refs = []
            for pname in ("Reference1", "Reference2"):
                v = getattr(o, pname, None)
                if v:
                    refs.extend(r[0] for r in v if isinstance(r, tuple))
            if link_name in refs or getattr(o, "Component1", "") == link_name or getattr(
                o, "Component2", ""
            ).startswith(link_name):
                try:
                    doc.removeObject(o.Name)
                except Exception:
                    pass
    doc.removeObject(link_name)
    doc.recompute()
    return {"removed": True}


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
    """Mark a component fixed. Uses a JointObject.GroundedJoint when available.

    Must live in the assembly's JointGroup (see _get_or_make_joint_group) -
    the same headless-init requirement as add_joint below."""
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
        jg = _get_or_make_joint_group(doc, asm)
        obj = jg.newObject("App::FeaturePython", "GroundedJoint")
        JointObject.GroundedJoint(obj, link)
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

    # The real proxy's setJointConnectors() (called below, NOT a plain
    # Reference1/Reference2 assignment) walks up to find the owning Assembly
    # by parent group - a joint added as a loose doc.addObject() (the prior
    # code) has no such parent and setJointConnectors crashes with
    # "'NoneType' object has no attribute 'Type'" deep inside JointObject.py,
    # which silently landed every real joint in the record fallback (found
    # live 2026-09-20: dragging a "successfully created" joint's component
    # moved it anywhere with no constraint at all - the joint object existed
    # but had never actually been wired up). Fix: create it inside a real
    # Assembly::JointGroup and call setJointConnectors with the SAME
    # [[obj, [sub, sub]], ...] shape the GUI's own selection handler builds
    # (confirmed against JointObject.py's own source).
    jg = _get_or_make_joint_group(doc, asm)
    engine = "solver"
    obj = None
    _orig = getattr(UtilsAssembly, "activeAssembly", None)
    UtilsAssembly.activeAssembly = lambda *a, **k: asm
    try:
        type_index = list(JointObject.JointTypes).index(jtype)
        obj = jg.newObject("App::FeaturePython", "Joint")
        JointObject.Joint(obj, type_index)
        obj.JointType = jtype
        obj.Proxy.setJointConnectors(
            obj, [[c1, [sub1 or "", sub1 or ""]], [c2, [sub2 or "", sub2 or ""]]]
        )
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

    # asm.solve() is a real call, not a no-op headless - it returns an int rc
    # (0 = success; -1 solver error, -2 redundant, -3 conflicting, -4
    # over-constrained, -5 malformed, -6 no parts fixed) and was previously
    # only wrapped in try/except, so any nonzero-but-non-throwing rc silently
    # reported solved=True. Confirmed live (2026-09-20): a Revolute joint
    # built from adjacent-box Edge references crashes the C++ solver
    # (vector::_M_range_check) - solve() then returns -1 and leaves Placement
    # untouched, which the old code could not distinguish from success.
    solved = engine == "solver"
    rc = None
    try:
        if hasattr(asm, "solve"):
            rc = asm.solve()
            solved = solved and rc == 0
        doc.recompute()
    except Exception:
        solved = False
    return {"id": obj.Name, "type": jtype, "solved": solved, "engine": engine, "solveRc": rc}


# --------------------------------------------------------------------------- #
# live drag: real solver, called once per pointer-move (no scratch document -
# unlike sketch.dragStart/Move/End, an assembly component's Placement IS the
# real persisted state, there is no separate preview-vs-commit split to make)
# --------------------------------------------------------------------------- #
_drag_sessions = {}
_drag_seq = [0]


def drag_start(doc, component_id):
    """Begin a live-drag gesture on one component. Returns a dragId plus every
    component's starting placement, so the caller can compute per-frame mouse
    deltas against a known-good baseline and restore on Escape/abort."""
    link = doc.getObject(component_id)
    if link is None:
        raise RpcError(APP_ERROR, "no component %r" % component_id)
    _drag_seq[0] += 1
    did = "asmdrag%d" % _drag_seq[0]
    _drag_sessions[did] = {"doc": doc.Name, "component": component_id}
    return {"dragId": did, **tree(doc)}


def drag_move(doc, drag_id, base, axis, angle_deg):
    """Move the dragged component to an absolute placement, then solve. Real
    FreeCAD solver call (Assembly::AssemblyObject.solve(), backed by
    libOndselSolver), not an approximation - measured ~1.3ms/call on a small
    assembly, so a per-pointer-move round trip is affordable the same way
    sketch.dragMove's kept-alive scratch sketch is (see its docstring). A
    joint on the dragged component projects the requested placement onto
    whatever the joint allows (e.g. a Revolute joint keeps the shared pivot
    point fixed and only lets rotation about its axis through) rather than
    accepting it verbatim - and can move OTHER components too if they're
    downstream of a joint chain, which is why this returns every component's
    placement, not just the dragged one.

    solve()'s return code is checked, not just swallowed by try/except: 0 is
    success, anything else (over-constrained, conflicting, malformed, a
    solver-internal crash on a degenerate reference) means the placement was
    rejected - the component's Placement is restored to what it was before
    this call so a bad drag frame never leaves geometry in a broken state
    the next frame has to recover from."""
    s = _drag_sessions.get(drag_id)
    if s is None:
        raise RpcError(APP_ERROR, "no drag session %r (expired or never started)" % drag_id)
    link = doc.getObject(s["component"])
    if link is None:
        raise RpcError(APP_ERROR, "no component %r" % s["component"])
    from FreeCAD import Vector, Rotation, Placement
    prev = link.Placement
    link.Placement = Placement(Vector(*base), Rotation(Vector(*axis), float(angle_deg)))
    doc.recompute()
    asm = None
    for o in doc.Objects:
        if o.TypeId == "Assembly::AssemblyObject":
            asm = o
            break
    rc = 0
    if asm is not None and hasattr(asm, "solve"):
        try:
            rc = asm.solve()
        except Exception:
            rc = -1
    if rc != 0:
        link.Placement = prev
        doc.recompute()
    result = tree(doc)
    result["dragId"] = drag_id
    result["solveRc"] = rc
    result["accepted"] = rc == 0
    return result


def drag_end(doc, drag_id):
    """Close a drag session. The live document was already the thing being
    edited throughout (no scratch doc to discard) - this just forgets the
    session and does a final recompute so anything deferred during rapid
    per-frame moves settles before the next real RPC call reads state."""
    _drag_sessions.pop(drag_id, None)
    doc.recompute()
    return {"ok": True}


# --------------------------------------------------------------------------- #
# exploded view: a per-component offset layered ON TOP of the assembled
# (joint-solved) Placement, not a replacement for it - so turning explode off
# always restores exactly whatever the joints/drag left the assembly at,
# never a separately-drifting second copy of position state.
# --------------------------------------------------------------------------- #
_EXPLODE_PROP = "GwtExplodeOffset"
_EXPLODE_STATE_PROP = "GwtExploded"


def _explode_links(doc):
    return [o for o in doc.Objects if o.TypeId == "App::Link"]


def _ensure_explode_prop(link):
    if _EXPLODE_PROP not in link.PropertiesList:
        link.addProperty("App::PropertyVector", _EXPLODE_PROP, "GWT",
                          "Exploded-view offset, added on top of the assembled Placement")
    return link


def explode_auto(doc, distance=1.5):
    """Compute a default per-component offset: push each component away from
    the assembly's overall centre along the line from that centre to the
    component's own bounding-box centre, scaled by `distance` (a multiplier
    on the assembly's own bounding radius, not an absolute mm value, so the
    same call gives a sensible spread whether the assembly is a 40mm PCB
    stack or a 2m enclosure). A component sitting exactly on the assembly
    centre (radial direction undefined) falls back to +Z so it still moves
    instead of staying put and overlapping everything else.

    This only WRITES the offsets (as a per-link property, not a live
    Placement change) - explode_set_active applies/removes them. Splitting
    "compute" from "apply" lets the UI show a distance slider that re-applies
    instantly without recomputing directions each time."""
    import Part
    from FreeCAD import Vector
    links = _explode_links(doc)
    if len(links) < 2:
        return {"components": []}
    centers = []
    overall = App.BoundBox()
    for link in links:
        shape = Part.getShape(link, transform=True)
        bb = shape.BoundBox
        centers.append((link, bb.Center))
        overall.add(bb)
    assembly_center = overall.Center
    radius = max(overall.DiagonalLength / 2.0, 1.0)
    out = []
    for link, center in centers:
        direction = center - assembly_center
        if direction.Length < 1e-6:
            direction = Vector(0, 0, 1)
        else:
            direction.normalize()
        offset = direction * radius * float(distance)
        _ensure_explode_prop(link)
        setattr(link, _EXPLODE_PROP, offset)
        out.append({"id": link.Name, "offset": [offset.x, offset.y, offset.z]})
    doc.recompute()
    return {"components": out}


def explode_set(doc, component_id, offset):
    """Set one component's explode offset directly (drag-a-slider / type-a-
    distance path, as an alternative to explode_auto's computed spread)."""
    link = doc.getObject(component_id)
    if link is None:
        raise RpcError(APP_ERROR, "no component %r" % component_id)
    from FreeCAD import Vector
    _ensure_explode_prop(link)
    setattr(link, _EXPLODE_PROP, Vector(*offset))
    doc.recompute()
    return {"id": component_id, "offset": list(offset)}


def explode_set_active(doc, active):
    """Toggle exploded view on/off. ON: each link's Placement.Base gets its
    stored GwtExplodeOffset added, on top of whatever the assembled
    (joint-solved) position currently is. OFF: the offset is subtracted back
    out, exactly restoring the assembled position - explode never overwrites
    or forgets the assembled placement, it only displaces the render/export
    view of it. A link with no offset property yet (explode_auto/explode_set
    never called for it) is left untouched either way."""
    from FreeCAD import Vector
    active = bool(active)
    for link in _explode_links(doc):
        offset = getattr(link, _EXPLODE_PROP, None)
        if offset is None or offset.Length < 1e-9:
            continue
        currently = bool(getattr(link, _EXPLODE_STATE_PROP, False))
        if active and not currently:
            link.Placement.Base = link.Placement.Base + offset
        elif not active and currently:
            link.Placement.Base = link.Placement.Base - offset
        if _EXPLODE_STATE_PROP not in link.PropertiesList:
            link.addProperty("App::PropertyBool", _EXPLODE_STATE_PROP, "GWT",
                              "Whether this component's explode offset is currently applied")
        setattr(link, _EXPLODE_STATE_PROP, active)
    doc.recompute()
    return tree(doc)


def explode_state(doc):
    """Current per-component offsets and whether explode is active - for the
    panel to restore its sliders/toggle on reopen without re-running
    explode_auto (which would silently discard any hand-tuned offsets)."""
    out = []
    any_active = False
    for link in _explode_links(doc):
        offset = getattr(link, _EXPLODE_PROP, None)
        if offset is None:
            continue
        active = bool(getattr(link, _EXPLODE_STATE_PROP, False))
        any_active = any_active or active
        out.append({
            "id": link.Name,
            "offset": [offset.x, offset.y, offset.z],
            "active": active,
        })
    return {"components": out, "active": any_active}


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
            linked_path = None
            try:
                target = o.LinkedObject
                if target is not None and getattr(target, "Document", None) is not None:
                    linked_path = target.Document.FileName or None
            except Exception:
                linked_path = None
            comps.append({
                "id": o.Name,
                "label": o.Label,
                "grounded": bool(getattr(o, "Grounded", False)),
                # the file this link's target currently lives in - NOT
                # necessarily the original source (a pinned component is
                # linked at a resolved cache-file path; the companion
                # .gwtcad-asm.json tracks the real source path + pin ref)
                "linkedPath": linked_path,
                "placement": {
                    "base": [p.Base.x, p.Base.y, p.Base.z],
                    "axis": [p.Rotation.Axis.x, p.Rotation.Axis.y, p.Rotation.Axis.z],
                    "angle": p.Rotation.Angle,
                },
            })
        elif o.TypeId == "App::FeaturePython" and (
            hasattr(o, "JointType") or o.Name.startswith("GroundedJoint")
        ):
            # was a name-prefix match on "Joint"/"GroundedJoint" - collided
            # with the Assembly::JointGroup container itself (named "Joints",
            # which also startswith "Joint") once joints started living in a
            # real JointGroup instead of loose at the document root (found
            # live 2026-09-20: the group showed up as a phantom "Grounded"
            # joint in the panel). Check for the real joint marker properties
            # instead of the object's name.
            joints.append({
                "id": o.Name,
                "label": o.Label,
                "type": getattr(o, "JointType", "Grounded"),
            })
    return {"assembly": asm.Name, "components": comps, "joints": joints}
