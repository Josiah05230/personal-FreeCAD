"""Drawing SHEET templates - distinct from tables.py's table/BOM column
templates. A sheet template is a small JSON preset describing what to put on
a brand-new page if/when the user opts in (title block text/style, a default
set of view directions to auto-add) - a fresh page from drawing.pageCreate
stays genuinely blank (no title block, no views) until this is explicitly
applied, per the user's ask that "new drawing" not silently pre-fill anything.

Same on-disk preset pattern as tables.py's ~/.gwtcad/table_templates.json and
materials.py's ~/.gwtcad/materials.json - independent of any one document.
"""
import json
import os

from .registry import RpcError, APP_ERROR

_PATH = os.path.expanduser("~/.gwtcad/sheet_templates.json")

_ASSETS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets")


def logo_asset_path(name):
    """Resolve a template's logoAsset (a bare filename, e.g.
    "grainwave_banner.png") to the real path of a bundled asset in
    sidecar/gwtcad/assets/ - never a client-supplied path, so a template
    stays portable across machines/installs instead of pointing at
    wherever one particular workstation happened to keep the source file."""
    path = os.path.join(_ASSETS_DIR, os.path.basename(str(name)))
    if not os.path.isfile(path):
        raise RpcError(APP_ERROR, "no such bundled logo asset: %r" % name)
    return path


# a real title-block table: label/value row pairs, wide enough that the two
# columns read as clearly separate (not "basically one column" - user
# report, 2026-09-22) with the value column noticeably wider since it holds
# the actual content. =PN/=NAME/=DESCRIPTION are the sidecar's own live
# parameter-reference convention (tables.py _resolve_param_ref) - these
# three cells re-resolve from the document's real part-number metadata
# every time the table rebuilds, not typed-once static text. Date/engineer
# have no live source, so they seed as an empty fill-in-yourself cell the
# user edits in place once per drawing.
#
# The logo is placed as a SEPARATE DrawingImage (tables have no
# image-in-cell support) immediately to the LEFT of the table, bottom-
# aligned to it and sized to the table's own total height, rather than
# floating above it with a gap - reads as one unified title block, the
# conventional layout (logo panel + field grid side by side) instead of a
# stacked pair that looked like two unrelated objects (user report,
# 2026-09-22: "the logo isn't in the table").
_GRAINWAVE_TITLE_BLOCK = {
    "columns": [
        {"key": "label", "header": "", "source": "label"},
        {"key": "value", "header": "", "source": "value"},
    ],
    "rows": [
        {"label": "PART NAME", "value": "=NAME"},
        {"label": "DESCRIPTION", "value": "=DESCRIPTION"},
        {"label": "PART NUMBER", "value": "=PN"},
        {"label": "DATE", "value": ""},
        {"label": "ENGINEER", "value": ""},
    ],
    "style": {
        "showGrid": True,
        "gridColor": "#111111",
        "rowHeight": 7,
        "colWidths": [28, 62],
        "font": "osifont",
        "textSize": 3.2,
    },
}

_BUILTIN = {
    "Blank": {"titleBlock": False, "views": []},
    "Basic 4-view": {
        "titleBlock": True,
        "views": ["front", "top", "right", "iso"],
    },
    "GrainWave Technologies": {
        "titleBlock": False,
        "views": ["front", "top", "right", "iso"],
        "titleBlockTable": _GRAINWAVE_TITLE_BLOCK,
        "logoAsset": "grainwave_banner.png",
        # native asset is ~3740x1900px (1.968:1) - logoWidth is computed
        # client-side now (loadSheetTemplate sizes it to the table's own
        # rendered height x this aspect ratio, so it always matches
        # regardless of row/column edits), logoAspect is the only fixed
        # number a template needs to carry.
        "logoAspect": 3740 / 1900,
    },
}


def _load():
    if not os.path.isfile(_PATH):
        return {}
    try:
        with open(_PATH) as f:
            return json.load(f)
    except Exception:
        return {}


def _save(data):
    os.makedirs(os.path.dirname(_PATH), exist_ok=True)
    with open(_PATH, "w") as f:
        json.dump(data, f, indent=2)


def list_sheet_templates():
    data = _load()
    out = [{"name": n, "spec": spec, "builtin": True} for n, spec in _BUILTIN.items()]
    out += [{"name": n, "spec": spec, "builtin": False} for n, spec in data.items() if n not in _BUILTIN]
    return out


def save_sheet_template(name, spec):
    if not name:
        raise RpcError(APP_ERROR, "template name required")
    if name in _BUILTIN:
        raise RpcError(APP_ERROR, "%r is a built-in template name" % name)
    data = _load()
    data[name] = dict(spec or {})
    _save(data)
    return {"name": name, "spec": data[name]}


def load_sheet_template(name):
    if name in _BUILTIN:
        return {"name": name, "spec": _BUILTIN[name]}
    data = _load()
    if name not in data:
        raise RpcError(APP_ERROR, "no such sheet template: %r" % name)
    return {"name": name, "spec": data[name]}
