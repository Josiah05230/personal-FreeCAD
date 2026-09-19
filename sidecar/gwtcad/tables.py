"""Drawing tables: parametric BOM + custom table templates.

A table on the sheet is a real Spreadsheet::Sheet + TechDraw::
DrawViewSpreadsheet pair (both native FreeCAD objects, so they round-trip
with the .FCStd like everything else in drawing.py). BOM row data (part
name/qty/material/description) is computed here in Python by grouping the
assembly's App::Link components - the same grouping DrawingSheet.tsx already
did client-side, moved server-side so it can feed a real spreadsheet and be
re-run to refresh quantities after the assembly changes.

Custom table templates (font/spacing/columns, "save my own BOM template")
are a small JSON preset file independent of any one document, the same
pattern materials.py uses for ~/.gwtcad/materials.json custom material
presets.
"""
import json
import os

import FreeCAD as App

from . import session
from .registry import RpcError, APP_ERROR

_TEMPLATES_PATH = os.path.expanduser("~/.gwtcad/table_templates.json")

_DEFAULT_BOM_COLUMNS = [
    {"key": "item", "header": "ITEM", "source": "index"},
    {"key": "label", "header": "PART", "source": "label"},
    {"key": "qty", "header": "QTY", "source": "qty"},
    {"key": "material", "header": "MATERIAL", "source": "material"},
    {"key": "description", "header": "DESCRIPTION", "source": "description"},
]


def _link_group_key(link):
    """Identify "the same source part" for BOM grouping. FreeCAD
    auto-uniquifies App::Link.Label per document (three links to the same
    part end up "Bracket"/"Bracket001"/"Bracket002" - confirmed live), so
    grouping by Label would wrongly split identical components into
    separate rows. Group by the linked object's real identity instead: its
    source document path + internal Name, falling back to the link's own
    label only when there is no resolvable target (a broken/unset link)."""
    try:
        target = link.LinkedObject
        if target is not None:
            doc_path = getattr(getattr(target, "Document", None), "FileName", "") or ""
            return (doc_path, target.Name)
    except Exception:
        pass
    return (None, link.Label)


def _link_display_label(link):
    """A grouped row's display name: the linked part's own Label (shared by
    every link to it) rather than this particular link's auto-uniquified
    one, so "3x Bracket" reads as one BOM line, not three."""
    try:
        target = link.LinkedObject
        if target is not None:
            return target.Label
    except Exception:
        pass
    return link.Label


def bom_rows(doc, source=None):
    """Group the document's assembly App::Link components by the part they
    each link to -> [{label, qty, material, description}], same grouping
    DrawingSheet.tsx already did client-side from assembly.tree().

    A document with no App::Link at all is not an assembly - it's a single
    part - and a BOM is still a meaningful thing to want on its drawing (one
    row, qty 1, same material/description convention). Fall back to listing
    each top-level PartDesign::Body directly rather than returning an empty
    table just because there is nothing to "link"."""
    if doc is None:
        return []
    links = [o for o in doc.Objects if o.TypeId == "App::Link"]
    if source is not None and hasattr(source, "Group"):
        names = {c.Name for c in getattr(source, "Group", [])}
        links = [l for l in links if l.Name in names] or links

    if links:
        return _grouped_rows(links, _link_group_key, _link_display_label)

    bodies = [o for o in doc.Objects if o.TypeId == "PartDesign::Body"]
    if source is not None and hasattr(source, "Group"):
        names = {c.Name for c in getattr(source, "Group", [])}
        bodies = [b for b in bodies if b.Name in names] or bodies
    if not bodies:
        return []
    return _grouped_rows(bodies, lambda b: (None, b.Name), lambda b: b.Label)


def _grouped_rows(objs, group_key, display_label):
    counts = {}
    order = []
    meta = {}
    for obj in objs:
        key = group_key(obj)
        if key not in counts:
            counts[key] = 0
            order.append(key)
            material = ""
            try:
                target = getattr(obj, "LinkedObject", obj)
                mat = getattr(target, "ShapeMaterial", None) if target is not None else None
                if mat is not None and getattr(mat, "Name", None) and mat.Name != "Default":
                    material = mat.Name
            except Exception:
                pass
            extra = session.material_extra(obj.Name)
            meta[key] = {
                "label": display_label(obj),
                "material": material,
                "description": extra.get("description", ""),
            }
        counts[key] += 1

    rows = []
    for i, key in enumerate(order, 1):
        rows.append({
            "index": i, "label": meta[key]["label"], "qty": counts[key],
            "material": meta[key]["material"],
            "description": meta[key]["description"],
        })
    return rows


def _cell_value(row, col):
    src = col.get("source", "")
    if src == "index":
        return str(row.get("index", ""))
    if src.startswith("fixed:"):
        return src[len("fixed:"):]
    return str(row.get(src, ""))


def make_table(doc, page_id, rows, columns=None, template=None, table_id=None):
    from . import drawing as _drawing

    page = _drawing.get_page(doc, page_id)
    columns = columns or (template or {}).get("columns") or _DEFAULT_BOM_COLUMNS
    font = (template or {}).get("font", "osifont")
    text_size = float((template or {}).get("textSize", 3.0))

    # table_id is only ever the CALLER's existing view name (see below, not
    # this sheet's own name) - a fresh insert (table_id=None) previously fell
    # back to the SAME hardcoded "BOMSheet" name every time, so any second
    # "new" table silently reused (and overwrote the contents of) the first
    # one instead of actually being a second table (user report, 2026-09-19:
    # "When I hit insert BOM, it replaced my table... I should be able to
    # have a BOM and other tables all over the place"). Let FreeCAD's own
    # addObject auto-naming (BOMSheet, BOMSheet001, ...) give each fresh
    # table a genuinely distinct name, same pattern used everywhere else in
    # this file (e.g. DrawViewAnnotation "Note").
    if table_id:
        view = doc.getObject(table_id)
        sheet = view.Source if view is not None and view.TypeId == "TechDraw::DrawViewSpreadsheet" else None
        if sheet is None or sheet.TypeId != "Spreadsheet::Sheet":
            sheet = doc.addObject("Spreadsheet::Sheet", "BOMSheet")
    else:
        sheet = doc.addObject("Spreadsheet::Sheet", "BOMSheet")

    # remember the real column spec (header text alone is lossy - re-deriving
    # `source` from a lowercased header on reload would silently break any
    # column whose header text doesn't match its data key, e.g. "PART" vs
    # the "label" field it actually pulls from) so page_contents() can
    # rehydrate the exact same columns on reopen.
    if "_gwt_columns" not in sheet.PropertiesList:
        try:
            sheet.addProperty("App::PropertyString", "_gwt_columns", "GWT").setEditorMode("_gwt_columns", 2)
        except Exception:
            pass
    try:
        sheet._gwt_columns = json.dumps(columns)
    except Exception:
        pass

    for i, col in enumerate(columns):
        cell = "%s1" % chr(ord("A") + i)
        sheet.set(cell, str(col.get("header", col.get("key", ""))))
    for r, row in enumerate(rows, start=2):
        for i, col in enumerate(columns):
            cell = "%s%d" % (chr(ord("A") + i), r)
            sheet.set(cell, _cell_value(row, col))
    doc.recompute()

    # reuse the SAME view object already resolved above by its real id when
    # editing an existing table (table_id given); otherwise create a
    # genuinely new one with FreeCAD's own auto-naming, same as the sheet.
    view = doc.getObject(table_id) if table_id else None
    if view is None or view.TypeId != "TechDraw::DrawViewSpreadsheet":
        view = doc.addObject("TechDraw::DrawViewSpreadsheet", "BOMSheetView")
        page.addView(view)
    view.Source = sheet
    last_col = chr(ord("A") + max(len(columns) - 1, 0))
    last_row = max(len(rows) + 1, 1)
    view.CellStart = "A1"
    view.CellEnd = "%s%d" % (last_col, last_row)
    try:
        view.Font = font
        view.TextSize = text_size
    except Exception:
        pass
    doc.recompute()

    return {
        "id": view.Name, "sheetId": sheet.Name, "pageId": page.Name,
        "columns": columns, "rows": rows,
    }


def remove_table(doc, table_id):
    view = doc.getObject(table_id)
    if view is None or view.TypeId != "TechDraw::DrawViewSpreadsheet":
        raise RpcError(APP_ERROR, "no such table: %r" % table_id)
    sheet = view.Source
    doc.removeObject(view.Name)
    if sheet is not None:
        try:
            doc.removeObject(sheet.Name)
        except Exception:
            pass
    doc.recompute()
    return {"ok": True}


def _load_templates():
    if not os.path.isfile(_TEMPLATES_PATH):
        return {}
    try:
        with open(_TEMPLATES_PATH) as f:
            return json.load(f)
    except Exception:
        return {}


def _save_templates(data):
    os.makedirs(os.path.dirname(_TEMPLATES_PATH), exist_ok=True)
    with open(_TEMPLATES_PATH, "w") as f:
        json.dump(data, f, indent=2)


def save_table_template(name, spec):
    if not name:
        raise RpcError(APP_ERROR, "template name required")
    data = _load_templates()
    data[name] = dict(spec or {})
    _save_templates(data)
    return {"name": name, "spec": data[name]}


def list_table_templates():
    return [{"name": n, "spec": spec} for n, spec in _load_templates().items()]


def load_table_template(name):
    data = _load_templates()
    if name not in data:
        raise RpcError(APP_ERROR, "no such template: %r" % name)
    return {"name": name, "spec": data[name]}
