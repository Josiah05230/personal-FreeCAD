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

_BUILTIN = {
    "Blank": {"titleBlock": False, "views": []},
    "Basic 4-view": {
        "titleBlock": True,
        "views": ["front", "top", "right", "iso"],
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
