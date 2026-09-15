"""Active document state for the sidecar.

One document at a time for now. Milestone 2 (assemblies) turns this into a small
document set keyed by path.
"""
import time

import FreeCAD as App

_DEFAULT_NAME = "GWTCAD"
_state = {"name": _DEFAULT_NAME, "path": None}

# Origin geometry (planes/axes/point) has no reliable headless Visibility flag,
# so the sidecar tracks which datum object names the user has switched on.
_shown_datums = set()


def datum_shown(name):
    return name in _shown_datums


def set_datum_shown(name, shown):
    if shown:
        _shown_datums.add(name)
    else:
        _shown_datums.discard(name)


# Rollback marker per body: the feature name the timeline marker sits AFTER.
# None / absent => marker is at the end (normal editing). This is the source of
# truth for "what exists at this point in history"; body.Tip is set from it for
# geometry but a pre-first-solid marker leaves Tip alone and flags rolled-empty.
_marker = {}
_rolled_empty = set()


def set_marker(body_name, feature_name, tip_at_rollback=None):
    if feature_name is None:
        _marker.pop(body_name, None)
    else:
        _marker[body_name] = {"feature": feature_name, "tip": tip_at_rollback}


def marker(body_name):
    m = _marker.get(body_name)
    return m["feature"] if m else None


def marker_tip(body_name):
    m = _marker.get(body_name)
    return m["tip"] if m else None


def clear_markers():
    _marker.clear()
    _rolled_empty.clear()


# Named user parameters: {name: expression string}. Referenceable from any
# dimension input. Session-scoped; persisted with the document sidecar json.
_params = {}


def params():
    return dict(_params)


def set_param(name, expr):
    _params[name] = expr


def del_param(name):
    _params.pop(name, None)


def clear_params():
    _params.clear()


# Per-feature dimension expressions: {featureName: {prop: "1in + 2mm"}}.
# The feature's numeric property is kept in sync; this remembers the formula so
# editing shows it again, and lets a parameter change re-drive the model.
_feature_exprs = {}


def feature_exprs(name):
    return dict(_feature_exprs.get(name, {}))


def feature_expr(name, prop):
    return _feature_exprs.get(name, {}).get(prop)


def set_feature_expr(name, prop, expr):
    if not expr:
        _feature_exprs.get(name, {}).pop(prop, None)
        return
    _feature_exprs.setdefault(name, {})[prop] = expr


def all_feature_exprs():
    return {n: dict(m) for n, m in _feature_exprs.items()}


def clear_feature_exprs():
    _feature_exprs.clear()


def set_rolled_empty(body_name, empty):
    if empty:
        _rolled_empty.add(body_name)
    else:
        _rolled_empty.discard(body_name)


def is_rolled_empty(body_name):
    return body_name in _rolled_empty


# Per-object display colour [r,g,b] 0-1 (headless has no ViewObject).
_colors = {}


def set_body_color(name, rgb):
    if rgb is None:
        _colors.pop(name, None)
    else:
        _colors[name] = list(rgb)


def body_color(name):
    return _colors.get(name)


# --------------------------------------------------------------------------- #
# Appearances (view state): per-object visual record + document render settings.
# All of this is a GWT-CAD view concern - three.js renders it live - but it is
# persisted in the .gwtcad companion so it round-trips, and colour/opacity are
# additionally mirrored onto obj.ShapeAppearance by gwtcad.appearance so a bare
# FreeCAD shows something close.
# --------------------------------------------------------------------------- #

# {objName: {"color":[r,g,b]|None, "opacity":0..1, "finish":str,
#            "edges": {...}|None}}
_appearance = {}

# Document-wide render settings; None keys fall back to the client defaults.
_render_settings = {}

# Saved appearance presets: {id: {"id","name","scope":"object"|"document",
#   "appearance": {partial}, "render": {partial}}}. Persisted with the document
# for now (a user-level library can come later).
_appearance_presets = {}


def object_appearance(name):
    return dict(_appearance.get(name, {})) if name in _appearance else None


def set_object_appearance(name, rec):
    if rec is None:
        _appearance.pop(name, None)
    else:
        _appearance[name] = dict(rec)


def all_object_appearances():
    return {n: dict(r) for n, r in _appearance.items()}


def render_settings():
    return dict(_render_settings)


def set_render_settings(rec):
    _render_settings.clear()
    if rec:
        _render_settings.update(rec)


def appearance_presets():
    return {k: dict(v) for k, v in _appearance_presets.items()}


def set_appearance_preset(pid, preset):
    if preset is None:
        _appearance_presets.pop(pid, None)
    else:
        _appearance_presets[pid] = dict(preset)


# Linked KiCad board: {"path": ..., "placements": {ref: [x, y, rot, side]}}
_kicad = {}


def set_kicad_link(path, placements):
    _kicad.clear()
    _kicad.update({"path": path, "placements": placements})


def kicad_link():
    return dict(_kicad) if _kicad else None


# Inserted 2D canvases (image underlays). Session-scoped for now; the renderer
# holds the pixels, the sidecar holds placement + real-world size.
_canvases = {}
_canvas_seq = [0]

# Section views. The cut itself is a live three.js clip in the renderer; the
# sidecar just persists each one (plane / offset / flip / visible / label) in the
# .gwtcad companion so it round-trips like a datum plane and shows in the tree.
_sections = {}
_section_seq = [0]

# Drawing pages (TechDraw::DrawPage objects). The page + everything on it
# (views/dims/notes/tables) is a real native object living in the .FCStd, so
# it round-trips for free on save/open with no help from here - this registry
# only remembers id->label (+ ordering) so the Browser tree has stable labels
# across reopen, since a bare TechDraw::DrawPage has no GWT-CAD-specific slot
# for that beyond its own .Label.
_drawings = {}
_drawing_seq = [0]

# Per-dimension format override: {dimId: {"precision":int, "leadingZero":bool,
# "trailingZeros":bool, "unitSuffix":bool}}. FreeCAD's own FormatSpec render
# (FormattedValue) needs a GUI ViewProvider and is empty headlessly, so
# GWT-CAD formats dimension text itself client-side from the raw value; this
# is just the override storage, keyed by the DrawViewDimension's object name.
_dim_formats = {}

# Document-wide default dimension format; None means "use the built-in
# default" (2 decimals, leading zero, no trailing-zero stripping, unit shown).
_dim_format_default = {}


def add_section(plane="XY", offset=0.0, flip=False, label=None):
    _section_seq[0] += 1
    sid = "Section%d" % _section_seq[0]
    _sections[sid] = {
        "id": sid,
        "label": label or ("Section %d" % _section_seq[0]),
        "plane": str(plane),
        "offset": float(offset),
        "flip": bool(flip),
        "visible": True,
    }
    return _sections[sid]


def set_section(sid, **kw):
    if sid not in _sections:
        # allow the client to define one with its own id (e.g. restored on open)
        _sections[sid] = {"id": sid, "label": kw.get("label") or sid,
                          "plane": "XY", "offset": 0.0, "flip": False, "visible": True}
        try:
            n = int(sid.replace("Section", ""))
            _section_seq[0] = max(_section_seq[0], n)
        except Exception:
            pass
    for k, v in kw.items():
        if v is not None:
            _sections[sid][k] = v
    return _sections[sid]


def sections():
    return list(_sections.values())


def remove_section(sid):
    _sections.pop(sid, None)


def add_drawing(label=None, drawing_id=None):
    if drawing_id and drawing_id not in _drawings:
        did = drawing_id
    else:
        _drawing_seq[0] += 1
        did = "Drawing%d" % _drawing_seq[0]
    _drawings[did] = {"id": did, "label": label or did}
    try:
        n = int(did.replace("Drawing", ""))
        _drawing_seq[0] = max(_drawing_seq[0], n)
    except Exception:
        pass
    return _drawings[did]


def rename_drawing(did, label):
    if did in _drawings:
        _drawings[did]["label"] = label
    return _drawings.get(did)


def drawings():
    return list(_drawings.values())


def remove_drawing(did):
    _drawings.pop(did, None)
    _dim_formats.pop(did, None)


def dim_format(dim_id):
    return dict(_dim_formats[dim_id]) if dim_id in _dim_formats else None


def set_dim_format(dim_id, fmt):
    if fmt is None:
        _dim_formats.pop(dim_id, None)
    else:
        _dim_formats[dim_id] = dict(fmt)


def all_dim_formats():
    return {k: dict(v) for k, v in _dim_formats.items()}


def dim_format_default():
    return dict(_dim_format_default)


def set_dim_format_default(fmt):
    _dim_format_default.clear()
    if fmt:
        _dim_format_default.update(fmt)


def add_canvas(plane_role, w_mm, h_mm, image=None):
    _canvas_seq[0] += 1
    cid = "Canvas%d" % _canvas_seq[0]
    _canvases[cid] = {"id": cid, "plane": plane_role, "w": float(w_mm), "h": float(h_mm),
                      "offset": [0.0, 0.0], "rot": 0.0, "image": image}
    return _canvases[cid]


def load_state(blob):
    """Restore session-only extras (canvases, colours) from a companion file."""
    _canvases.clear()
    for c in blob.get("canvases", []):
        _canvases[c["id"]] = c
    _sections.clear()
    for s in blob.get("sections", []):
        if s.get("id"):
            _sections[s["id"]] = s
    _section_seq[0] = 0
    for sid in _sections:
        try:
            _section_seq[0] = max(_section_seq[0], int(sid.replace("Section", "")))
        except Exception:
            pass
    _drawings.clear()
    for dw in blob.get("drawings", []):
        if dw.get("id"):
            _drawings[dw["id"]] = dw
    _drawing_seq[0] = 0
    for did in _drawings:
        try:
            _drawing_seq[0] = max(_drawing_seq[0], int(did.replace("Drawing", "")))
        except Exception:
            pass
    _dim_formats.clear()
    _dim_formats.update(blob.get("dimFormats", {}) or {})
    _dim_format_default.clear()
    _dim_format_default.update(blob.get("dimFormatDefault", {}) or {})
    _colors.clear()
    _colors.update(blob.get("colors", {}))
    _params.clear()
    _params.update(blob.get("params", {}))
    _feature_exprs.clear()
    _feature_exprs.update(blob.get("featureExprs", {}))
    _kicad.clear()
    _kicad.update(blob.get("kicad", {}) or {})
    _material_extra.clear()
    _material_extra.update(blob.get("materialExtra", {}) or {})
    _material_custom.clear()
    _material_custom.update(blob.get("materialCustom", {}) or {})
    _material_prop_only.clear()
    _material_prop_only.update(blob.get("materialPropOnly", {}) or {})
    _appearance.clear()
    _appearance.update(blob.get("appearance", {}) or {})
    _render_settings.clear()
    _render_settings.update(blob.get("renderSettings", {}) or {})
    _appearance_presets.clear()
    _appearance_presets.update(blob.get("appearancePresets", {}) or {})
    mx = 0
    for cid in _canvases:
        try:
            mx = max(mx, int(cid.replace("Canvas", "")))
        except Exception:
            pass
    _canvas_seq[0] = mx


def dump_state():
    return {"canvases": list(_canvases.values()), "colors": dict(_colors),
            "params": dict(_params), "featureExprs": all_feature_exprs(),
            "kicad": dict(_kicad), "materialExtra": all_material_extra(),
            "materialCustom": all_object_custom_materials(),
            "materialPropOnly": all_object_property_only_materials(),
            "appearance": all_object_appearances(),
            "renderSettings": render_settings(),
            "appearancePresets": appearance_presets(),
            "sections": list(_sections.values()),
            "drawings": list(_drawings.values()),
            "dimFormats": all_dim_formats(),
            "dimFormatDefault": dim_format_default()}


def canvases():
    return list(_canvases.values())


def update_canvas(cid, **kw):
    if cid not in _canvases:
        return None
    _canvases[cid].update({k: v for k, v in kw.items() if v is not None})
    return _canvases[cid]


def remove_canvas(cid):
    _canvases.pop(cid, None)


# Per-object material properties FreeCAD's own Material system has no slot for
# (friction coefficient, a free-text pattern/finish tag, notes, ...). Keyed by
# object name; the real FreeCAD Material (name/appearance/density/mechanical)
# still lives natively on obj.ShapeMaterial and needs no help from here.
_material_extra = {}


def set_material_extra(name, extra):
    if not extra:
        _material_extra.pop(name, None)
    else:
        _material_extra[name] = dict(extra)


def material_extra(name):
    return dict(_material_extra.get(name, {}))


def all_material_extra():
    return {n: dict(m) for n, m in _material_extra.items()}


def clear_material_extra():
    _material_extra.clear()


# Which user-library custom material preset (by id) is assigned to an object,
# if any. FreeCAD's own Material system does not reliably round-trip a
# custom-named/recoloured material through a real close + reopen of the file
# (it can revert to the base preset's stock name/colour - a FreeCAD Material
# system quirk, not something GWT-CAD's serialisation controls) - so on
# document.open this is replayed to re-materialise and reassign the real
# custom material, restoring the correct look within GWT-CAD even where plain
# FreeCAD would show the reverted stock one.
_material_custom = {}


def set_object_custom_material(name, preset_id):
    if not preset_id:
        _material_custom.pop(name, None)
    else:
        _material_custom[name] = preset_id


def all_object_custom_materials():
    return dict(_material_custom)


def clear_object_custom_materials():
    _material_custom.clear()


# Objects whose assigned material is "properties only" - its physical model is
# applied (density -> mass props) but its appearance was NOT (the body kept its
# own colour/finish). {objName: presetUuid}.
_material_prop_only = {}


def set_object_property_only_material(name, uuid):
    if not uuid:
        _material_prop_only.pop(name, None)
    else:
        _material_prop_only[name] = uuid


def all_object_property_only_materials():
    return dict(_material_prop_only)


def clear_object_property_only_materials():
    _material_prop_only.clear()


def _find(name):
    for d in App.listDocuments().values():
        if d.Name == name:
            return d
    return None


def _enable_undo(d):
    """Headless documents ship with undo off; turn it on so history.undo works."""
    try:
        d.UndoMode = 1
        d.UndoLimit = 64
    except Exception:
        pass
    return d


def doc(create=True):
    d = _find(_state["name"])
    if d is None and create:
        d = _enable_undo(App.newDocument(_DEFAULT_NAME))
        _state["name"] = d.Name
        _state["path"] = None
    return d


def reset():
    d = _find(_state["name"])
    if d is not None:
        _settle_detail_views(d)
        App.closeDocument(d.Name)
    d = _enable_undo(App.newDocument(_DEFAULT_NAME))
    _state["name"] = d.Name
    _state["path"] = None
    _shown_datums.clear()
    _kicad.clear()
    clear_markers()
    clear_params()
    clear_feature_exprs()
    clear_material_extra()
    clear_object_custom_materials()
    clear_object_property_only_materials()
    _colors.clear()
    _appearance.clear()
    _render_settings.clear()
    _appearance_presets.clear()
    _canvases.clear()
    _canvas_seq[0] = 0
    _sections.clear()
    _section_seq[0] = 0
    _drawings.clear()
    _drawing_seq[0] = 0
    _dim_formats.clear()
    _dim_format_default.clear()
    return d


def _settle_detail_views(d):
    """TechDraw::DrawViewDetail computes its cut on a background worker in
    this FreeCAD build; closing/opening a document that has one before it
    settles segfaults headlessly (confirmed live, both on document.open just
    having loaded one and on closeDocument of a document holding one). One
    more recompute + a short sleep reliably lets it finish first; skipped
    entirely when the document has no detail views, so a normal open/close
    pays nothing extra."""
    try:
        if any(o.TypeId == "TechDraw::DrawViewDetail" for o in d.Objects):
            d.recompute()
            time.sleep(0.3)
    except Exception:
        pass


def open_path(path):
    d = _find(_state["name"])
    if d is not None:
        _settle_detail_views(d)
        App.closeDocument(d.Name)
    d = _enable_undo(App.openDocument(path))
    _settle_detail_views(d)
    _state["name"] = d.Name
    _state["path"] = path
    return d


def set_path(path):
    _state["path"] = path


def path():
    return _state["path"]


def active_body(d=None):
    d = d or doc()
    bodies = [o for o in d.Objects if o.TypeId == "PartDesign::Body"]
    return bodies[-1] if bodies else None
