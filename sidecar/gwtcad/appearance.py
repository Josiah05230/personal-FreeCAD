"""Appearances: the GWT-CAD view layer for how bodies look in the viewport.

Everything here is view state - three.js renders colour / opacity / surface
finish / edge display / shading / lighting live, with no FreeCAD round-trip on
the hot path. This module's job is persistence and round-trip fidelity:

  * the full per-object record + the document render settings + saved presets
    are written into the .gwtcad companion (session.dump_state / load_state), so
    reopening a part restores exactly how it looked;
  * base colour + opacity are ALSO mirrored onto obj.ShapeAppearance /
    obj.ViewObject-less headless equivalents so a plain FreeCAD opening the
    .FCStd shows something close (finish / edges / shading have no FreeCAD
    concept, so those only live in the companion).

Presets overrule ONLY the keys they define (partial merge) - see
`_apply_preset`. `gwtcad.methods` imports this module; cross-module imports are
lazy inside each function to dodge the load-time cycle, same as materials.py.
"""
from .registry import method, RpcError, APP_ERROR
from . import session

# recognised finish names -> physically-based render hints the client turns into
# three.js MeshPhysicalMaterial params. Kept here too so a headless caller /
# test can see the catalogue; the client has its own copy in appearance.ts.
FINISHES = (
    "plastic", "matte", "glossy", "satin", "metal", "brushed-metal",
    "polished-metal", "glass", "rubber", "ceramic", "clay", "chrome",
    "anodized", "painted", "wireframe-only",
)

_APPEARANCE_KEYS = ("color", "opacity", "finish", "edges", "faces")
_RENDER_KEYS = (
    "shading", "lighting", "background", "backgroundColor", "edgeMode",
    "edgeColor", "tangentEdges", "hiddenEdges", "outlineOnly", "ao", "exposure",
)


def _doc():
    d = session.doc(create=False)
    if d is None:
        raise RpcError(APP_ERROR, "no document")
    return d


def _obj(d, name):
    o = d.getObject(name) if name else session.active_body(d)
    if o is None:
        raise RpcError(APP_ERROR, "no object %r" % (name or "(active body)"))
    return o


def _clean_appearance(rec):
    out = {}
    for k in _APPEARANCE_KEYS:
        if k not in rec or rec[k] is None:
            continue
        if k == "color":
            c = rec[k]
            if isinstance(c, (list, tuple)) and len(c) == 3:
                out["color"] = [max(0.0, min(1.0, float(x))) for x in c]
        elif k == "opacity":
            out["opacity"] = max(0.0, min(1.0, float(rec[k])))
        elif k == "finish":
            out["finish"] = str(rec[k])
        elif k == "edges":
            e = rec[k]
            if isinstance(e, dict):
                out["edges"] = {kk: e[kk] for kk in
                                ("show", "color", "width", "tangent", "hidden")
                                if kk in e}
        elif k == "faces":
            # {"Face3": [r,g,b] | null, ...} - null clears one face override
            f = rec[k]
            if isinstance(f, dict):
                clean = {}
                for sub, col in f.items():
                    if col is None:
                        clean[sub] = None
                    elif isinstance(col, (list, tuple)) and len(col) == 3:
                        clean[sub] = [max(0.0, min(1.0, float(x))) for x in col]
                out["faces"] = clean
    return out


def _mirror_to_freecad(o, rec):
    """Best-effort: push base colour + opacity onto the real FreeCAD object so a
    bare FreeCAD render is close. Never fatal - headless has no ViewObject and
    ShapeAppearance is version-dependent."""
    col = rec.get("color")
    op = rec.get("opacity")
    # 1) session body colour (what scene.get / tessellate already read back)
    if col is not None:
        session.set_body_color(o.Name, list(col))
    # 2) native ShapeAppearance (FreeCAD 1.1+) - a Material-like appearance slot
    try:
        appr = getattr(o, "ShapeAppearance", None)
        if appr is not None and len(appr):
            m = appr[0]
            if col is not None:
                m.DiffuseColor = (float(col[0]), float(col[1]), float(col[2]), 1.0)
            if op is not None:
                m.Transparency = float(max(0.0, min(1.0, 1.0 - op)))
            o.ShapeAppearance = appr
    except Exception:
        pass
    # 3) plain ViewObject when a GUI is somehow present (never headless, cheap to try)
    try:
        vo = getattr(o, "ViewObject", None)
        if vo is not None:
            if col is not None:
                vo.ShapeColor = (float(col[0]), float(col[1]), float(col[2]))
            if op is not None:
                vo.Transparency = int(round((1.0 - op) * 100))
    except Exception:
        pass


@method("appearance.get")
def appearance_get(targetId=None):
    """The appearance record on one object (or the active body), plus the
    document render settings and the merged effective values."""
    d = _doc()
    o = _obj(d, targetId)
    rec = session.object_appearance(o.Name) or {}
    return {
        "targetId": o.Name,
        "label": o.Label,
        "appearance": rec,
        "render": session.render_settings(),
    }


@method("appearance.set")
def appearance_set(targetId=None, appearance=None, merge=True):
    """Set (or merge into) one object's appearance record. Returns the fresh
    tree so the shell repaints. `merge=False` replaces the record wholesale."""
    d = _doc()
    o = _obj(d, targetId)
    incoming = _clean_appearance(appearance or {})
    if merge:
        rec = session.object_appearance(o.Name) or {}
        # deep-merge the sub-dicts so setting one face / one edge style does not
        # wipe the rest
        for sub_key in ("edges", "faces"):
            if sub_key in incoming and isinstance(rec.get(sub_key), dict):
                merged = dict(rec[sub_key])
                for kk, vv in incoming[sub_key].items():
                    if vv is None:
                        merged.pop(kk, None)
                    else:
                        merged[kk] = vv
                incoming[sub_key] = merged
        rec.update(incoming)
    else:
        rec = incoming
    session.set_object_appearance(o.Name, rec)
    _mirror_to_freecad(o, rec)
    try:
        d.recompute()
    except Exception:
        pass
    from . import methods as _m
    return _m.tree_get()


@method("appearance.clear")
def appearance_clear(targetId=None):
    d = _doc()
    o = _obj(d, targetId)
    session.set_object_appearance(o.Name, None)
    session.set_body_color(o.Name, None)
    from . import methods as _m
    return _m.tree_get()


@method("appearance.renderGet")
def appearance_render_get():
    return {"render": session.render_settings(), "finishes": list(FINISHES)}


@method("appearance.renderSet")
def appearance_render_set(render=None, merge=True):
    """Document-wide render settings (shading mode, lighting rig, background,
    global edge display). Pure view state - persisted in the companion."""
    incoming = {k: v for k, v in (render or {}).items() if k in _RENDER_KEYS}
    cur = session.render_settings() if merge else {}
    cur.update(incoming)
    session.set_render_settings(cur)
    return {"render": cur}


@method("appearance.presetList")
def appearance_preset_list():
    return {"presets": list(session.appearance_presets().values())}


@method("appearance.presetSave")
def appearance_preset_save(name, appearance=None, render=None, scope="object", id=None):
    """Save a partial appearance/render bundle as a named preset. Applying it
    later overrules ONLY the keys it defines - nothing else on the target
    changes. `scope`: "object" (colour/opacity/finish/edges) or "document"
    (shading/lighting/background) or "both"."""
    import uuid as _uuidlib
    pid = id or str(_uuidlib.uuid4())
    preset = {
        "id": pid,
        "name": str(name),
        "scope": scope if scope in ("object", "document", "both") else "object",
        "appearance": _clean_appearance(appearance or {}),
        "render": {k: v for k, v in (render or {}).items() if k in _RENDER_KEYS},
    }
    session.set_appearance_preset(pid, preset)
    return preset


@method("appearance.presetDelete")
def appearance_preset_delete(id):
    session.set_appearance_preset(id, None)
    return {"deleted": id}
