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


def _resolve_param_ref(name):
    """Resolve a bare `=NAME` table-cell reference: string PN fields first
    (PN/NAME/DESCRIPTION, the model's own part number/name/description - the
    same three GwtPartNumber/GwtPartName/GwtPartDescription document
    properties document.save mirrors onto the raw .FCStd), then numeric
    document parameters (session.params(), the same names params.set /
    the Parameters panel manage) evaluated as a length expression. Raises
    ValueError if NAME resolves to neither, so the caller can fall back to
    showing the literal text (e.g. "=TYPO" reads as a mistake, not silently
    as blank)."""
    from . import expr as _expr

    pn = session.part_number() or {}
    upper = {"PN": pn.get("pn", ""), "NAME": pn.get("name", ""), "DESCRIPTION": pn.get("description", "")}
    # `name in upper` alone is the right check - upper always has exactly
    # these three known keys, so membership (not truthiness of the value)
    # is what distinguishes "a real PN-field reference" from "an unknown
    # parameter name". Gating on truthiness too was a real bug: a part
    # with a genuinely blank description (e.g. no supplier metadata
    # available) fell through to the params/exception path below and
    # rendered the literal text "=DESCRIPTION" instead of a blank cell -
    # confirmed live generating drawings for several manually-supplied
    # vendor STEP files with no metadata sidecar.
    if name in upper:
        return upper[name]
    params = session.params()
    if name in params:
        return _expr.evaluate(params[name], "length", params)
    raise ValueError("unknown parameter %r" % name)


def _cell_value(row, col):
    src = col.get("source", "")
    if src == "index":
        return str(row.get("index", ""))
    if src.startswith("fixed:"):
        return src[len("fixed:"):]
    raw = row.get(src, "")
    # a cell whose typed value is literally "=NAME" (user question,
    # 2026-09-20: "have the part name and description be parameters that
    # are able to be driven/grabbed in drawing tables with some sort of
    # '=PARAMETER_NAME'") - resolved fresh every time the table is rebuilt
    # (make_table re-derives every cell from row data, so this stays live
    # as the referenced parameter/PN field changes, no manual refresh step).
    if isinstance(raw, str) and raw.startswith("=") and len(raw) > 1:
        name = raw[1:].strip()
        try:
            value = _resolve_param_ref(name)
            return ("%g" % value) if isinstance(value, float) else str(value)
        except Exception:
            return raw  # unresolved reference - show the literal "=NAME" so it reads as a mistake, not blank
    return str(raw)


def make_table(doc, page_id, rows, columns=None, template=None, table_id=None, style=None):
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

    # remember the RAW (unresolved) row data too - the spreadsheet cell
    # itself only ever holds the resolved display text (_cell_value's
    # output), so a "=BoltHoleDia" cell would otherwise freeze at whatever
    # value the parameter had on the last edit, rather than staying live
    # across a reopen the way params.set's other consumers (feature dims)
    # already do (user question, 2026-09-20: part name/description/hole
    # size "driven/grabbed in drawing tables with some sort of
    # '=PARAMETER_NAME'"). page_contents() re-runs _cell_value against this
    # raw data on every read, same as make_table does here.
    if "_gwt_rawrows" not in sheet.PropertiesList:
        try:
            sheet.addProperty("App::PropertyString", "_gwt_rawrows", "GWT").setEditorMode("_gwt_rawrows", 2)
        except Exception:
            pass
    try:
        sheet._gwt_rawrows = json.dumps(rows)
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
    if style:
        _apply_table_style(view, style)
    elif "_gwt_style" not in view.PropertiesList:
        # brand-new table, no style passed - persist the same defaults the
        # frontend has always applied client-side, so the very first
        # page_contents() after creation already has something to read
        # instead of the caller needing a round-trip just to establish one.
        _apply_table_style(view, {"showGrid": True, "gridColor": "#111111", "rowHeight": 5})
    doc.recompute()

    return {
        "id": view.Name, "sheetId": sheet.Name, "pageId": page.Name,
        "columns": columns, "rows": rows, "style": table_style(view),
    }


def _apply_table_style(view, style):
    """Persist a table's position + display style so it round-trips with the
    .FCStd instead of resetting to a hardcoded corner/default every reopen
    (previously 100% client-only React state - confirmed no sidecar RPC or
    FreeCAD property backed it, so any dragged table or edited row height
    silently reverted the moment the drawing was closed and reopened)."""
    from . import drawing as _drawing

    if "x" in style:
        try:
            view.X = float(style["x"])
        except Exception:
            pass
    if "y" in style:
        try:
            view.Y = float(style["y"])
        except Exception:
            pass
    rest = {k: v for k, v in style.items()
            if k in ("showGrid", "gridColor", "rowHeight", "colWidths", "rowHeights", "merges",
                     "font", "textSize", "bold", "italic", "hideHeader")}
    if rest:
        cur = table_style(view)
        cur.update(rest)
        _drawing._tag(view, "_gwt_style", json.dumps(cur))


def table_style(view):
    from . import drawing as _drawing

    raw = _drawing._get_tag(view, "_gwt_style", "")
    style = {}
    if raw:
        try:
            style = json.loads(raw)
        except Exception:
            style = {}
    style.setdefault("showGrid", True)
    style.setdefault("gridColor", "#111111")
    style.setdefault("rowHeight", 5)
    # colWidths/rowHeights: per-column/per-row overrides, empty = every
    # column/row uses the shared default (colW derived client-side,
    # rowHeight above). merges: cell-merge regions, {r, c, rs, cs} = the
    # merged region's top-left cell + how many rows/cols it spans - empty
    # means no merges, same "absent = uniform" convention.
    style.setdefault("colWidths", [])
    style.setdefault("rowHeights", [])
    style.setdefault("merges", [])
    # whole-table text style, same convention as a note's font/textSize/
    # textStyle - per-cell rich formatting isn't supported yet, only a
    # single style for every cell in the table.
    style.setdefault("font", "osifont")
    style.setdefault("textSize", 3.2)
    style.setdefault("bold", False)
    style.setdefault("italic", False)
    try:
        style["x"] = float(view.X)
        style["y"] = float(view.Y)
    except Exception:
        style.setdefault("x", 0.0)
        style.setdefault("y", 0.0)
    return style


def update_table_style(doc, table_id, style):
    view = doc.getObject(table_id)
    if view is None or view.TypeId != "TechDraw::DrawViewSpreadsheet":
        raise RpcError(APP_ERROR, "no such table: %r" % table_id)
    _apply_table_style(view, style or {})
    doc.recompute()
    return table_style(view)


def _get_table_view(doc, table_id):
    view = doc.getObject(table_id)
    if view is None or view.TypeId != "TechDraw::DrawViewSpreadsheet":
        raise RpcError(APP_ERROR, "no such table: %r" % table_id)
    return view


def merge_table_cells(doc, table_id, r, c, rs, cs):
    """Merge a rectangular block of cells starting at data-row r, column c
    (0-based, header row excluded - same indexing the rows/columns arrays
    already use), spanning rs rows and cs columns. Only the top-left cell's
    value is kept/shown; the covered cells are hidden by the renderer, not
    deleted (unmerging must be able to give their old values back)."""
    view = _get_table_view(doc, table_id)
    rs = max(1, int(rs))
    cs = max(1, int(cs))
    if rs == 1 and cs == 1:
        raise RpcError(APP_ERROR, "nothing to merge: a 1x1 region")
    style = table_style(view)
    merges = [m for m in style.get("merges", [])]

    def _overlaps(a, b):
        return not (a["c"] + a["cs"] <= b["c"] or b["c"] + b["cs"] <= a["c"]
                    or a["r"] + a["rs"] <= b["r"] or b["r"] + b["rs"] <= a["r"])

    new_region = {"r": int(r), "c": int(c), "rs": rs, "cs": cs}
    if any(_overlaps(new_region, m) for m in merges):
        raise RpcError(APP_ERROR, "that region overlaps an existing merge")
    merges.append(new_region)
    _apply_table_style(view, {"merges": merges})
    doc.recompute()
    return table_style(view)


def unmerge_table_cells(doc, table_id, r, c):
    """Remove whichever merge region (if any) has its top-left at (r, c)."""
    view = _get_table_view(doc, table_id)
    style = table_style(view)
    merges = [m for m in style.get("merges", []) if not (m["r"] == int(r) and m["c"] == int(c))]
    _apply_table_style(view, {"merges": merges})
    doc.recompute()
    return table_style(view)


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
