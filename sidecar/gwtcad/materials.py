"""Materials: assign a real FreeCAD Material (appearance + physical
properties) to a body, from the ~200 built-in presets or a user-saved custom
one. Every RPC returns the project's standard tree payload where it mutates
anything; `gwtcad.methods` imports this module, so cross-module imports are
done lazily inside each function to dodge the load-time import cycle.

Design: the REAL, native FreeCAD Material - name, appearance (color / gloss /
transparency), and whatever physical properties its model supports (density,
Young's modulus, ...) - always lands on obj.ShapeMaterial, so a custom
material is a genuine FreeCAD Material object that round-trips in any FreeCAD
install, same as a stock preset. A few properties FreeCAD's Material system
has no slot for at all (friction coefficient, a free-text finish/pattern tag)
ride in this project's own per-document extras (session.material_extra),
saved in the .gwtcad.json companion - real FreeCAD does not see those, only
GWT-CAD does. Custom preset DEFINITIONS (so they show up as a preset in a
different project too) live in a small user-level JSON library, independent
of any one document.

Known FreeCAD limitation: a custom material built by cloning a stock preset's
UUID and renaming/recolouring it does not reliably survive a real close then
reopen of the .FCStd in a fresh FreeCAD session - it can silently revert to
the stock preset's original name/appearance (this reproduces with plain
FreeCAD API calls alone, nothing GWT-CAD-specific). `reapply_custom_materials`
works around it for GWT-CAD's own view by re-materialising every recorded
custom assignment on document.open; a plain FreeCAD user opening the same
file may see the stock preset's look instead of the custom one until they,
too, have something replay the override. The physical "family" data and this
project's own extras (friction, pattern, notes) are unaffected either way.
"""
import json
import os
import uuid as _uuidlib

from .registry import method, RpcError, APP_ERROR
from . import session

_LIBRARY_PATH = os.path.expanduser("~/.gwtcad/materials.json")

# Common physical properties across FreeCAD's material models, in a sensible
# display order. Not every material's model supports every one of these -
# presetDetail / assign only touch what the material actually has.
_PHYSICAL_KEYS = (
    "Density", "YoungsModulus", "PoissonRatio", "ShearModulus",
    "YieldStrength", "UltimateTensileStrength", "ThermalConductivity",
    "ThermalExpansionCoefficient", "SpecificHeat",
)
_APPEARANCE_KEYS = (
    "DiffuseColor", "AmbientColor", "SpecularColor", "EmissiveColor",
    "Shininess", "Transparency",
)
# GWT-CAD-only extras: FreeCAD's Material system has no property for these.
_EXTRA_KEYS = ("frictionStatic", "frictionDynamic", "pattern", "notes")


def _mgr():
    from Materials import MaterialManager
    return MaterialManager()


def _target_obj(targetId=None):
    """A body (default: the active one) or any named object with ShapeMaterial."""
    d = session.doc(create=False)
    if d is None:
        raise RpcError(APP_ERROR, "no document")
    if targetId:
        o = d.getObject(targetId)
        if o is None:
            raise RpcError(APP_ERROR, "no object %r" % targetId)
    else:
        o = session.active_body(d)
        if o is None:
            raise RpcError(APP_ERROR, "no active body - select one or open a part first")
    if not hasattr(o, "ShapeMaterial"):
        raise RpcError(APP_ERROR, "%r cannot carry a material (meshes cannot yet)" % o.Name)
    return d, o


def _father_of(m):
    try:
        return m.PhysicalProperties.get("Father") or "Other"
    except Exception:
        return "Other"


def _mat_dto(uuid_str, m, extra=None):
    dto = {
        "uuid": uuid_str,
        "name": m.Name,
        "family": _father_of(m),
        "physical": {},
        "appearance": {},
    }
    for k in _PHYSICAL_KEYS:
        try:
            if m.hasPhysicalProperty(k):
                # getPhysicalValue returns a Base.Quantity (value + unit) - not
                # JSON-serialisable; str() gives the same "2.7e-06 kg/mm^3" form
                # that setValue() accepts back, so it round-trips either way.
                dto["physical"][k] = str(m.getPhysicalValue(k))
        except Exception:
            pass
    for k in _APPEARANCE_KEYS:
        try:
            if m.hasAppearanceProperty(k):
                dto["appearance"][k] = m.getAppearanceValue(k)
        except Exception:
            pass
    if extra:
        dto["extra"] = dict(extra)
    return dto


@method("material.presets")
def material_presets():
    """All built-in FreeCAD materials, grouped by family (their 'Father'
    physical property - Metal, Wood, Glass, Thermoplast, ...)."""
    mm = _mgr()
    families = {}
    total = 0
    for uid, m in mm.Materials.items():
        try:
            name = m.Name
        except Exception:
            continue
        fam = _father_of(m)
        if len(fam) > 40:  # a handful of library entries misuse Father as a sentence
            fam = "Other"
        families.setdefault(fam, []).append({"uuid": uid, "name": name})
        total += 1
    out = [{"family": f, "materials": sorted(ms, key=lambda x: x["name"])}
           for f, ms in sorted(families.items())]
    return {"families": out, "total": total}


@method("material.presetDetail")
def material_preset_detail(uuid):
    mm = _mgr()
    m = mm.getMaterial(uuid)
    if m is None:
        raise RpcError(APP_ERROR, "no material %r" % uuid)
    return _mat_dto(uuid, m)


def _default_material():
    """FreeCAD's own placeholder material every new shape starts with - not a
    real user choice, so material.get reports it the same as unassigned."""
    mm = _mgr()
    for uid, m in mm.Materials.items():
        try:
            if m.Name == "Default":
                return uid, m
        except Exception:
            pass
    return None, None


@method("material.get")
def material_get(targetId=None):
    """The material currently on a body/feature (or the active body), plus any
    GWT-CAD-only extras recorded for it. None if nothing has been assigned."""
    d, o = _target_obj(targetId)
    m = getattr(o, "ShapeMaterial", None)
    if m is None or not getattr(m, "Name", None) or m.Name == "Default":
        return {"assigned": None}
    uid = getattr(m, "UUID", "") or ""
    extra = session.material_extra(o.Name)
    return {"assigned": _mat_dto(uid, m, extra)}


@method("material.assign")
def material_assign(targetId, uuid, extra=None):
    """Assign a built-in preset as-is (no overrides) to a body/feature."""
    d, o = _target_obj(targetId)
    mm = _mgr()
    m = mm.getMaterial(uuid)
    if m is None:
        raise RpcError(APP_ERROR, "no material %r" % uuid)
    o.ShapeMaterial = m
    session.set_material_extra(o.Name, {k: v for k, v in (extra or {}).items() if k in _EXTRA_KEYS})
    session.set_object_custom_material(o.Name, None)  # a stock preset, not a custom one
    d.recompute()
    from . import methods as _m
    return _m.tree_get()


@method("material.clear")
def material_clear(targetId=None):
    """Reset to FreeCAD's own placeholder material - ShapeMaterial has no
    concept of "no material", it always holds a real Material object, and
    assigning it None/empty raises (a TypeError previously silently swallowed
    here, so Clear looked like it worked but left the old material in place)."""
    d, o = _target_obj(targetId)
    _uid, default = _default_material()
    if default is not None:
        o.ShapeMaterial = default
    session.set_material_extra(o.Name, None)
    session.set_object_custom_material(o.Name, None)
    d.recompute()
    from . import methods as _m
    return _m.tree_get()


def _load_library():
    if not os.path.exists(_LIBRARY_PATH):
        return {}
    try:
        with open(_LIBRARY_PATH) as f:
            return json.load(f)
    except Exception:
        return {}


def _save_library(lib):
    os.makedirs(os.path.dirname(_LIBRARY_PATH), exist_ok=True)
    tmp = _LIBRARY_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(lib, f, indent=2)
    os.replace(tmp, _LIBRARY_PATH)


@method("material.customList")
def material_custom_list():
    """User-saved custom presets (name + base + overrides), available in any
    project - independent of which document is open."""
    lib = _load_library()
    return {"presets": list(lib.values())}


@method("material.customSave")
def material_custom_save(name, baseUuid, appearance=None, physical=None, extra=None, id=None):
    """Create or update a custom preset definition in the user library. Does
    NOT touch any document - see material.customAssign to apply it."""
    mm = _mgr()
    base = mm.getMaterial(baseUuid)
    if base is None:
        raise RpcError(APP_ERROR, "no base material %r" % baseUuid)
    lib = _load_library()
    pid = id or str(_uuidlib.uuid4())
    lib[pid] = {
        "id": pid,
        "name": name,
        "baseUuid": baseUuid,
        "baseName": base.Name,
        "appearance": {k: v for k, v in (appearance or {}).items() if k in _APPEARANCE_KEYS},
        "physical": {k: v for k, v in (physical or {}).items() if k in _PHYSICAL_KEYS},
        "extra": {k: v for k, v in (extra or {}).items() if k in _EXTRA_KEYS},
    }
    _save_library(lib)
    return lib[pid]


@method("material.customDelete")
def material_custom_delete(id):
    lib = _load_library()
    lib.pop(id, None)
    _save_library(lib)
    return {"deleted": id}


def _materialize(preset):
    """A custom preset definition -> a live FreeCAD Material object: clone the
    base preset, rename, apply every override the base's model actually
    supports (best-effort - a property the base has no model for is skipped,
    not an error, since GWT-CAD's extras cover what FreeCAD cannot)."""
    mm = _mgr()
    base = mm.getMaterial(preset["baseUuid"])
    if base is None:
        raise RpcError(APP_ERROR, "base material %r no longer exists" % preset["baseUuid"])
    m = mm.getMaterial(preset["baseUuid"])  # a fresh, independent copy
    m.Name = preset["name"]
    for k, v in (preset.get("appearance") or {}).items():
        try:
            if m.hasAppearanceProperty(k):
                m.setValue(k, v)
        except Exception:
            pass
    for k, v in (preset.get("physical") or {}).items():
        try:
            if m.hasPhysicalProperty(k):
                m.setValue(k, v)
        except Exception:
            pass
    return m


@method("material.customAssign")
def material_custom_assign(targetId, customId):
    d, o = _target_obj(targetId)
    lib = _load_library()
    preset = lib.get(customId)
    if preset is None:
        raise RpcError(APP_ERROR, "no custom preset %r" % customId)
    m = _materialize(preset)
    o.ShapeMaterial = m
    session.set_material_extra(o.Name, preset.get("extra") or {})
    session.set_object_custom_material(o.Name, customId)
    d.recompute()
    from . import methods as _m
    return _m.tree_get()


def reapply_custom_materials():
    """Re-materialise and reassign every recorded custom-preset assignment.
    FreeCAD's Material system does not reliably keep a custom-named/recoloured
    material through a real close + reopen of the file (it can silently
    revert to the base preset it was cloned from) - called after
    session.load_state() on document.open so GWT-CAD's own view stays correct
    even when bare FreeCAD would show the reverted stock material."""
    d = session.doc(create=False)
    if d is None:
        return
    lib = _load_library()
    for obj_name, preset_id in session.all_object_custom_materials().items():
        preset = lib.get(preset_id)
        obj = d.getObject(obj_name)
        if preset is None or obj is None or not hasattr(obj, "ShapeMaterial"):
            continue
        try:
            obj.ShapeMaterial = _materialize(preset)
        except Exception:
            pass
    d.recompute()
