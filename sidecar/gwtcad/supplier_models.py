"""Organizes supplier-fetched 3D models into pn-cad-files, and generates a
minimal "purchased part" reference drawing (isometric view + a GWT PN <->
supplier PN callout) for parts that have no real CAD source of their own.

Two-stage pipeline, matching the split this feature's design settled on:
  1. GrainWavePartners' Cloud Function fetches a supplier's 3D model (Aptiv's
     open HawkSearch API, currently the only supplier with one - see
     tryFetchSupplierModel in functions/index.js) at PN-reservation time and
     drops the raw ZIP in Firebase Storage at
     cad-exports/<PN>/<PN>_supplier_model.zip. That side never touches git
     or FreeCAD - it has neither.
  2. This module (GWT-CAD, which has both) does the rest: sync_supplier_models
     finds ZIPs not yet organized, unzips the .stp into pn-cad-files/<PN>/,
     and commits+pushes; generate_supplier_drawing builds the reference
     FCStd+PDF for a PN that has a .stp but no drawing yet, uploading the
     PDF to cad-exports/<PN>/<PN>.pdf (same path export.py's promote-to-active
     pipeline already uses, so the portal's admin CAD Files viewer shows it
     with zero portal-side changes).

Both are meant to run from TWO triggers (see this feature's design
conversation): automatically on GWT-CAD startup (catches anything reserved
while GWT-CAD wasn't running), and on-demand from a UI button (so a user
doesn't have to relaunch the app to get a drawing generated right when they
need one).
"""
import datetime
import io
import json
import os
import tempfile
import zipfile

import FreeCAD as App
import Part

from .registry import method, RpcError, APP_ERROR
from . import partnumbers as _pn
from . import drawing as _drawing
from . import tables as _tables
from . import sheet_templates as _sheet_templates
from . import firebase_storage as _storage
from . import session as _session


def _cad_repo_path(cfg, pn):
    # A supplier-fetched model has no meaningful "project" of its own beyond
    # whatever project code the PN itself carries (e.g. CMG0010 -> project
    # "CM") - _repo_path_for already resolves any project code to its
    # configured repoPath, so this is just that same lookup keyed off the PN
    # string rather than a row already in hand.
    project = pn[:2]
    return _pn._repo_path_for(cfg, project)


def _part_folder(cfg, repo, pn, row=None):
    """Where PN's own folder actually lives inside `repo` - NOT always
    <repo>/<pn>/ (that assumption broke once parts got grouped into
    <project>/<type>/<pn>/ subfolders). Honors the registry's repo_relpath
    hint via the same self-healing lookup partnumbers.py itself uses, so
    this never drifts from wherever pn.resolve would actually find the
    part. Falls back to the new-part convention (<project>/<type>/<pn>/)
    only when the part has no file on disk yet at all - the first-time
    sync_supplier_models case, where there's nothing to look up yet."""
    if row is None:
        rows = _pn._read_registry(cfg)
        row = _pn._current_row(rows, pn[:-1])
    if row is not None:
        seq_type = row.get("type") or pn[2:3]
        filename = _pn._filename_for(row["project"], seq_type, int(row["seq"]), int(row["rev"]))
        abspath, _relpath = _pn._find_part_file(repo, filename, row.get("repo_relpath"))
        if abspath is not None:
            return os.path.dirname(abspath)
    project, type_ = pn[:2], pn[2:3]
    return os.path.join(repo, project, type_, pn)


_SHEET_W, _SHEET_H = 420.0, 297.0  # matches drawing.py's _SHEET_W_DEFAULT/_SHEET_H_DEFAULT and DrawingSheet.tsx's SHEET_W/SHEET_H
_MARGIN = 10.0  # matches DrawingSheet.tsx's own MARGIN

# Real third-angle projection group (front anchor; top and right are true
# TechDraw::DrawProjGroup projections, not independently-scaled views - see
# drawing.make_projection_group), placed so its OWN bounding box's top-left
# corner sits at (_GROUP_LEFT, _GROUP_TOP) - AutoDistribute already arranges
# front/top/right correctly relative to EACH OTHER (standard third-angle
# layout, confirmed by direct rendering), so this only ever translates the
# whole already-correct group as one unit, never repositions its members
# individually.
#
# Sizing is deliberately split into two independent knobs, not one combined
# target box: _PART_TARGET_W/H sizes each INDIVIDUAL view's own geometry
# (what the convergence loop below fits grp.Scale to, measured off the
# anchor/Front item alone) and _GROUP_SPACING is the fixed gap AutoDistribute
# puts between neighboring views on top of that geometry size. Fitting the
# WHOLE group footprint (geometry + gaps) to one combined target - the
# earlier approach - meant widening the gap just shrank the part to
# compensate, so the views never actually looked farther apart. Sizing the
# part alone and letting a generous fixed gap add on top of it is what
# actually spaces the views out.
_GROUP_LEFT, _GROUP_TOP = 20.0, 25.0
# AutoDistribute's own default inter-view gap (15mm/15mm) packs Top/Right
# in tight against Front - widened so Top/Right sit clearly apart from
# Front, near the group's own outer edges, rather than merely
# not-touching it (confirmed real DrawProjGroup.spacingX/Y properties,
# live: each mm of spacing shifts the neighboring item's offset by exactly
# that much, on top of the part's own bbox size). This is a STARTING
# value only - _fit_group_to_budget below shrinks both this and the part's
# own scale together, proportionally, if the resulting footprint would
# overlap the title block/notes or run off the sheet, so this can be set
# generously without separately re-deriving "is this safe" by hand.
_GROUP_SPACING = 70.0
# Same idea for the part's own per-view target size - a generous starting
# point that _fit_group_to_budget scales down (spacing and part size
# together, preserving their ratio) only as much as the real measured
# budget actually requires.
_PART_TARGET_W, _PART_TARGET_H = 90.0, 90.0
# The real (derived, not guessed) vertical footprint of a view's own
# direction label below its geometry bbox - export_page_svg draws it at
# local y=(h+4) in 3.4mm text (see that function's "view label under the
# view" comment/literal), so the label's baseline sits 4mm below the
# geometry and its glyphs reach a bit further down still (descender
# allowance, ~0.25x font size) - computed from that literal formula so it
# tracks correctly if export_page_svg's own numbers ever change, rather
# than an independently-guessed constant that can drift out of sync with
# what's actually rendered.
_VIEW_LABEL_OFFSET = 4.0
_VIEW_LABEL_FONT_SIZE = 3.4
_VIEW_LABEL_FOOTPRINT = _VIEW_LABEL_OFFSET + _VIEW_LABEL_FONT_SIZE * 0.25
# Minimum real clearance enforced (see _apply_grainwave_template) between
# the group's true measured bottom edge (geometry + _VIEW_LABEL_FOOTPRINT)
# and the actual top edge of the title-block table/NOTES callout below it -
# a live check against those real, computed positions, not a fixed sheet-Y
# ceiling guessed in isolation.
_GROUP_MIN_CLEARANCE = 15.0
# Extra slack subtracted from the convergence fit's budget (see
# _apply_grainwave_template) ON TOP OF _GROUP_MIN_CLEARANCE, purely so the
# fit settles with genuine visual breathing room instead of maximizing
# right up to the edge of what the hard assertion allows - the assertion
# alone only guarantees "no overlap", not "looks comfortably spaced".
_GROUP_EDGE_BREATHING_ROOM = 15.0
_ISO_X, _ISO_Y, _ISO_TARGET_W, _ISO_TARGET_H = 330.0, 30.0, 65.0, 50.0


def _fit_scale(bbox, target_w, target_h, cap=8.0):
    min_x, min_y, max_x, max_y = bbox
    w = max(max_x - min_x, 1e-6)
    h = max(max_y - min_y, 1e-6)
    return min(target_w / w, target_h / h, cap)


def _projection_group_footprint(doc, group_views):
    """The REAL combined bbox of a just-created projection group's laid-out
    views - NOT simply the union of each view's own bbox (those are each
    centered in their own LOCAL frame, e.g. front/top/right all individually
    spanning roughly (-10,-10) to (10,10) around their own origins - unioning
    them directly says nothing about the group's actual on-sheet footprint
    and drastically underestimates it, confirmed live: that naive union
    reported ~21x40mm for a part whose real laid-out group spans ~57x77mm,
    producing a wildly oversized fit-scale that ran the whole drawing off
    the sheet). AutoDistribute's own item.X/item.Y (relative to the group,
    set once the group actually lays itself out) are what place each view's
    local bbox into the group's shared frame - this sums bbox + offset per
    item, THEN unions across items, which is the real footprint the fit
    scale must be computed against."""
    min_x = min_y = 1e9
    max_x = max_y = -1e9
    for v in group_views:
        item = doc.getObject(v["id"])
        vmin_x, vmin_y, vmax_x, vmax_y = v["bbox"]
        ox, oy = float(item.X), float(item.Y)
        min_x = min(min_x, vmin_x + ox)
        min_y = min(min_y, vmin_y + oy)
        max_x = max(max_x, vmax_x + ox)
        max_y = max(max_y, vmax_y + oy)
    return [min_x, min_y, max_x, max_y]


def _supplier_title_block_text(mfg, mfg_pn, meta, registry_description=None):
    """PART NAME / DESCRIPTION text for a purchased part's title block.

    DESCRIPTION always equals the registry's own description column,
    full stop - it must never diverge from what the portal/inventory
    shows for the same PN (confirmed live: an earlier version of this
    function derived its own "N PIN WP FEMALE"-style text from Aptiv's
    componentType/cavities/gender metadata instead, which silently drifted
    out of sync with CMC0010's real registry description - the registry
    row is the single source of truth for this text, this function must
    never invent a competing one). PART NAME still prefers the supplier's
    structured componentType field (e.g. "CONNECTOR") when available,
    since that's a category label, not a description, and has no registry
    counterpart to diverge from."""
    component_type = (meta or {}).get("componentType")
    name = component_type.upper() if component_type else (" ".join(filter(None, [mfg, mfg_pn])) or "PART")
    return name, registry_description or ""


def _apply_grainwave_template(doc, page_id, part_obj, pn, name, description, notes=None):
    """Ports DrawingSheet.tsx's loadSheetTemplate (the real "Load Template"
    action a user drives by hand in the GUI) into a headless, scripted
    equivalent for the auto-generated purchased-part drawing - same
    template ("GrainWave Technologies": real title-block table + logo +
    legal note, defined in sheet_templates.py), same underlying
    drawing/tables API calls, just invoked directly instead of through a
    button click.

    Views are a REAL projection group (drawing.make_projection_group) -
    front/top/right genuinely linked at one shared scale, not three
    independent views that can drift out of scale with each other (see
    this feature's dev history: that's exactly what happened with the
    first version of this function) - stacked two rows tall on the left,
    plus a smaller standalone iso view in the top-right corner as a quick
    3D reference, not the headline view.

    `notes` (a list of strings, optional) renders as a numbered NOTES
    callout in the sheet's bottom-left - e.g. "<PN> IS EQUIVALENT TO
    <SUPPLIER> <SUPPLIER PN>" for a purchased part with no CAD source of
    its own, so anyone reading the drawing knows immediately that the
    geometry shown is a supplier's part, not a GWT design.

    pn_tag_document is called first so the title-block table's live
    "=PN"/"=NAME"/"=DESCRIPTION" cell references (see tables._cell_value)
    resolve to this part's real values, exactly the same mechanism a
    hand-drawn part's title block already relies on - not a separate,
    parallel text-injection path."""
    _pn.pn_tag_document(pn, name, description)

    tpl = _sheet_templates.load_sheet_template("GrainWave Technologies")["spec"]

    # Compute the title block's real geometry FIRST - table_h/table_x/table_y
    # depend only on the (static) template spec, not on anything the group
    # below creates, so this is safe to hoist ahead of it. Doing so gives
    # the group's own placement a REAL measured floor (table_y) to check
    # its true bottom edge against, rather than a ceiling constant guessed
    # in isolation from what the table/notes actually occupy - see the
    # clearance check right after the group is placed, below.
    title_block = tpl.get("titleBlockTable")
    table_h = table_x = table_y = None
    columns = rows = style = None
    if title_block:
        columns = title_block["columns"]
        # DATE/ENGINEER are blank in the SHARED template spec (a hand-drawn
        # part fills them in by hand once, per this template's own design) -
        # copy the row list rather than mutate tpl's own dict, and fill in
        # only THIS drawing's copy, so a real designed part loading the same
        # "GrainWave Technologies" template later still gets the normal
        # blank fields, not today's date leaking in from an unrelated
        # auto-generated drawing that happened to load the template first.
        today = datetime.datetime.now().strftime("%Y-%m-%d")
        rows = []
        for row in title_block["rows"]:
            row = dict(row)
            if row.get("label") == "DATE":
                row["value"] = today
            elif row.get("label") == "ENGINEER":
                row["value"] = "Auto-Generated"
            rows.append(row)
        style = title_block.get("style") or {}
        row_height = float(style.get("rowHeight", 5))
        col_widths = style.get("colWidths") or []
        hide_header = bool(style.get("hideHeader", False))
        table_w = sum(col_widths) if col_widths else len(columns) * 30
        table_h = row_height * (len(rows) + (0 if hide_header else 1))
        table_x = _SHEET_W - _MARGIN - table_w
        table_y = _SHEET_H - _MARGIN - table_h

    # "bottom" (not "top") is the direction that actually lands ABOVE "front"
    # once ProjectionType is "Third angle" - confirmed by direct rendering
    # test: FreeCAD's own AutoDistribute places "Top"'s item at Y=+30
    # (BELOW front, since page Y grows downward) and "Bottom"'s item at
    # Y=-30 (ABOVE front) in third-angle mode, the reverse of the plain
    # English reading of those names. Geometrically "bottom" here still
    # shows the same face a hand-drawn third-angle top view would (the
    # face away from the viewer, which is what belongs above front) -
    # confirmed by comparing the rendered geometry against the earlier
    # "top" projection, not just the label.
    group_dirs = ["front", "bottom", "right"]
    probe = _drawing.make_projection_group(doc, page_id, part_obj, group_dirs, anchor="front", scale=1.0)
    grp = doc.getObject(probe["groupId"])
    grp.ScaleType = "Custom"

    # Relabel the "bottom" item as "Top" on the sheet - it occupies the
    # position and shows the face a reader expects from a "Top" view (see
    # the group_dirs comment above), so the on-page callout should say
    # "Top", not leak FreeCAD's own inverted-from-third-angle-convention
    # internal type name to a reader who has no reason to know about it.
    for v in probe["views"]:
        if v["direction"] == "bottom":
            item = doc.getObject(v["id"])
            item.Label = "Top"
            _drawing._tag(item, "_gwt_dir", "top")
            v["direction"] = "top"

    # Real available budget for the group's WHOLE footprint (geometry +
    # spacing), measured against actual sheet geometry - not a guessed
    # ceiling. Width: from _GROUP_LEFT to clear of the iso view's own
    # column. Height: from _GROUP_TOP down to table_y (the title block's
    # real, already-computed top edge - the lowest real floor on the
    # sheet, since NOTES' own start is pinned to table_y too). A second
    # margin (_GROUP_EDGE_BREATHING_ROOM) is subtracted from both budgets
    # on top of _GROUP_MIN_CLEARANCE/_VIEW_LABEL_FOOTPRINT so the fit
    # settles with genuine slack rather than hugging the floor/column to
    # within a fraction of a mm (confirmed live: without it, Front's real
    # bottom landed only ~0.85mm above table_y - technically safe per the
    # assertion below, but visually flush rather than "slightly further
    # from the edges").
    budget_w = (_ISO_X - _GROUP_MIN_CLEARANCE - _GROUP_EDGE_BREATHING_ROOM) - _GROUP_LEFT
    budget_h = ((table_y - _GROUP_MIN_CLEARANCE - _VIEW_LABEL_FOOTPRINT - _GROUP_EDGE_BREATHING_ROOM) - _GROUP_TOP
                if table_y is not None else _SHEET_H - _MARGIN - _GROUP_TOP)

    anchor_id = next(v["id"] for v in probe["views"] if v["isAnchor"])
    anchor_item = doc.getObject(anchor_id)

    def _measure(scale, spacing_x, spacing_y):
        grp.Scale = scale
        grp.spacingX = spacing_x
        grp.spacingY = spacing_y
        doc.recompute()
        views_now = []
        for v in probe["views"]:
            item = doc.getObject(v["id"])
            vis, hid = _drawing._part_view_payload(item)
            views_now.append({"id": v["id"], "bbox": _drawing._view_bbox(vis, hid)})
        return _projection_group_footprint(doc, views_now)

    # Converge scale, spacingX and spacingY TOGETHER toward the largest
    # size that fills the real budget on EACH axis independently -
    # re-measuring after each attempt since neither a view's bbox nor
    # (especially) AutoDistribute's own gap scales linearly with a single
    # guess (confirmed in this feature's own dev history). Spacing is
    # solved per-axis (not one shared value) because the SAME absolute gap
    # reads very differently on each axis: Right's own column is much
    # narrower than Front+Top's combined height, so a shared spacing tied
    # to whichever axis is tighter left real slack on the other axis
    # unused (confirmed live: horizontal and vertical gaps came out nearly
    # equal in absolute mm while the sheet's real horizontal budget out to
    # the iso column was almost 2x the vertical budget down to the title
    # block). grp.Scale still applies to geometry uniformly (TechDraw
    # enforces one shared Scale across the group), so it converges against
    # whichever axis is tightest, while spacingX/spacingY each grow to use
    # their own axis's real remaining room.
    vis, hid = _drawing._part_view_payload(anchor_item)
    anchor_bbox_at_1 = _drawing._view_bbox(vis, hid)
    part_w0 = max(anchor_bbox_at_1[2] - anchor_bbox_at_1[0], 1e-6)
    part_h0 = max(anchor_bbox_at_1[3] - anchor_bbox_at_1[1], 1e-6)
    scale = min(_PART_TARGET_W / part_w0, _PART_TARGET_H / part_h0, 8.0)
    spacing_x = spacing_y = _GROUP_SPACING
    fp = _measure(scale, spacing_x, spacing_y)
    for _ in range(8):
        fp_w, fp_h = fp[2] - fp[0], fp[3] - fp[1]
        ratio_w = budget_w / max(fp_w, 1e-6)
        ratio_h = budget_h / max(fp_h, 1e-6)
        scale_ratio = min(ratio_w, ratio_h)
        if 0.97 <= ratio_w <= 1.03 and 0.97 <= ratio_h <= 1.03:
            break  # both axes within 3% of their real budget
        scale *= min(scale_ratio, 1.0) if scale_ratio < 1.0 else scale_ratio
        spacing_x *= ratio_w
        spacing_y *= ratio_h
        fp = _measure(scale, spacing_x, spacing_y)

    # Place the group by TRANSLATING its already-measured footprint (fp,
    # relative to the anchor's own origin) so its min corner lands at the
    # chosen sheet position - NOT by guessing grp.X/Y directly. AutoDistribute
    # already arranges front/top/right correctly relative to EACH OTHER
    # (confirmed by direct rendering: touching, aligned, standard
    # third-angle layout) - the only thing this function should still
    # decide is where that whole, already-correct arrangement sits on the
    # page as a unit. Fighting AutoDistribute's own internal placement
    # decisions (what earlier versions of this function did, computing
    # grp.X/Y from hand-derived per-part-shape offsets) is exactly what
    # produced a wrong arrangement - AutoDistribute never needed correcting,
    # only translating.
    anchor_x = _GROUP_LEFT - fp[0]
    anchor_y = _GROUP_TOP - fp[1]
    _drawing.set_projection_group_position(doc, probe["groupId"], anchor_x, anchor_y)

    # Hard verification, not a hope: the group's real absolute bbox (plus
    # the label footprint below it) must land fully on the sheet and clear
    # of the title block/notes floor and the iso column - the convergence
    # loop above should already guarantee this, but a supplier .stp can
    # have pathological proportions (e.g. extremely long/thin) where a
    # single-axis fit still leaves the OTHER axis oversized; this check
    # catches that rather than silently shipping a drawing with real
    # off-page or overlapping geometry.
    real_min_x = anchor_x + fp[0]
    real_max_x = anchor_x + fp[2]
    real_min_y = anchor_y + fp[1]
    real_max_y = anchor_y + fp[3] + _VIEW_LABEL_FOOTPRINT
    assert real_min_x >= _MARGIN - 1e-6, "group runs off the sheet's left edge: %s" % real_min_x
    assert real_max_x <= _ISO_X - _GROUP_MIN_CLEARANCE + 1e-6, "group overlaps the iso view's column: %s" % real_max_x
    assert real_min_y >= _MARGIN - 1e-6, "group runs off the sheet's top edge: %s" % real_min_y
    if table_y is not None:
        assert real_max_y <= table_y - _GROUP_MIN_CLEARANCE + 1e-6, (
            "group overlaps the title block/notes: bottom=%s table_y=%s" % (real_max_y, table_y))
    else:
        assert real_max_y <= _SHEET_H - _MARGIN + 1e-6, "group runs off the sheet's bottom edge: %s" % real_max_y

    iso_result = _drawing.make_view(doc, page_id, part_obj, direction="iso", scale=1.0)
    iso_view = doc.getObject(iso_result["id"])
    iso_view.Scale = _fit_scale(iso_result["bbox"], _ISO_TARGET_W, _ISO_TARGET_H)
    doc.recompute()
    _drawing.set_view_position(doc, iso_result["id"], _ISO_X, _ISO_Y)

    if notes:
        numbered = "NOTES:\n" + "\n".join("%d. %s" % (i, n) for i, n in enumerate(notes, start=1))
        note_text_size = 4.0
        # A note's Y is its FIRST line's baseline, and grows DOWNWARD from
        # the sheet's top edge - same direction as everything else on this
        # sheet (view.Y, table.Y) - confirmed by direct rendering test
        # (y=15 landed near the top, y=280 near the bottom). "Float them a
        # little" + "top of notes = top of table": start the block a bit
        # right of the sheet's own left margin, with its first line at the
        # SAME Y the table's own top edge sits at, rather than jammed into
        # the bottom-left corner - table_y already accounts for the
        # template's real row count/height (see above), computed once and
        # shared by both.
        notes_y = table_y + note_text_size if table_y is not None else _SHEET_H - _MARGIN - (note_text_size * (1 + 1.2 * numbered.count("\n")))
        _drawing.add_note(doc, page_id, numbered, x=_MARGIN + 8.0, y=notes_y,
                           font="osifont", textSize=note_text_size)

    if not title_block:
        return  # template has no real title block defined - views alone still export fine

    _tables.make_table(doc, page_id, rows, columns=columns, style=style)
    # make_table's own view object is whatever it just created/reused - the
    # frontend addresses it by the id make_table's own return value carries;
    # mirror that instead of re-deriving it, so this stays correct even if
    # make_table's internal object-naming ever changes.
    table_view_id = None
    for o in doc.Objects:
        if o.TypeId == "TechDraw::DrawViewSpreadsheet":
            table_view_id = o.Name
    if table_view_id:
        table_view = doc.getObject(table_view_id)
        table_view.X = table_x
        table_view.Y = table_y
    doc.recompute()

    logo_asset = tpl.get("logoAsset")
    if not logo_asset:
        return
    logo_path = _sheet_templates.logo_asset_path(logo_asset)
    aspect = float(tpl.get("logoAspect") or 2.0)
    has_note = bool(tpl.get("legalNote"))
    logo_frac = float(tpl.get("logoHeightFrac", 0.55)) if has_note else 1.0
    logo_h = table_h * logo_frac
    logo_w = logo_h * aspect
    note_w = max(logo_w, 55.0) if has_note else logo_w
    panel_w = max(logo_w, note_w)
    panel_right = table_x - 2.0
    logo_x = panel_right - panel_w / 2 - logo_w / 2
    logo_y = table_y
    _drawing.add_image(doc, page_id, logo_path, x=logo_x, y=logo_y, width=logo_w, height=logo_h)

    legal_note = tpl.get("legalNote")
    if legal_note:
        note_x = panel_right - panel_w
        note_top = logo_y + logo_h + 2.0
        note_h = table_h - logo_h - 2.0
        lines = [l for l in legal_note.split("\n") if l]
        line_span = max(1.0, 1 + 1.2 * (len(lines) - 1))
        note_text_size = max(1.4, min(2.2, (note_h * 0.85) / line_span))
        _drawing.add_note(doc, page_id, legal_note, x=note_x, y=note_top + note_text_size,
                           font="osifont", textSize=note_text_size)


def _extract_stp_from_zip(zip_bytes):
    """The ONE .stp/.step file inside a fetched ZIP (Aptiv's ZIPs contain
    exactly one), or None if the archive is empty/unexpected - a malformed
    or unexpected ZIP shape is a skip, not a crash, since a future supplier
    integration might package things differently and this should degrade
    gracefully rather than take down the whole sync pass."""
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        names = [n for n in zf.namelist() if n.lower().endswith((".stp", ".step"))]
        if not names:
            return None
        return zf.read(names[0])


@method("supplierModels.sync")
def sync_supplier_models():
    """Finds every cad-exports/<PN>/<PN>_supplier_model.zip that hasn't been
    unzipped into pn-cad-files yet (checked by whether <PN>/<PN>.stp already
    exists in the repo - idempotent, safe to call on every startup), and
    commits the extracted .stp for each. Returns a per-PN result list so a
    caller can report exactly what happened rather than a single pass/fail.
    """
    cfg = _pn._load_config()
    results = []

    names = _storage.list_objects("cad-exports/")
    zip_paths = [n for n in names if n.endswith("_supplier_model.zip")]

    # Group by repo so each repo is pulled/pushed once for the whole batch,
    # not once per part - a startup scan could easily find a dozen at once.
    by_repo = {}
    for storage_path in zip_paths:
        # cad-exports/<PN>/<PN>_supplier_model.zip
        pn = storage_path.split("/")[1]
        try:
            repo = _cad_repo_path(cfg, pn)
        except RpcError as e:
            results.append({"pn": pn, "ok": False, "error": e.message})
            continue
        by_repo.setdefault(repo, []).append((pn, storage_path))

    for repo, items in by_repo.items():
        _pn._sync_pull(repo)
        changed = False
        for pn, storage_path in items:
            dest = os.path.join(_part_folder(cfg, repo, pn), "%s.stp" % pn)
            if os.path.isfile(dest):
                results.append({"pn": pn, "ok": True, "skipped": "already organized"})
                continue
            try:
                zip_bytes = _storage.download_bytes(storage_path)
                if zip_bytes is None:
                    results.append({"pn": pn, "ok": False, "error": "zip vanished from Storage"})
                    continue
                stp_bytes = _extract_stp_from_zip(zip_bytes)
                if stp_bytes is None:
                    results.append({"pn": pn, "ok": False, "error": "no .stp/.step found in zip"})
                    continue
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                with open(dest, "wb") as f:
                    f.write(stp_bytes)
                # The metadata sidecar (componentType/cavities/gender/etc -
                # see tryFetchSupplierModel in functions/index.js) is
                # best-effort: its absence never blocks organizing the
                # actual .stp, which is the part that matters - a missing
                # or malformed meta.json just means generate_supplier_drawing
                # falls back to the plain registry description later.
                try:
                    meta_bytes = _storage.download_bytes(
                        storage_path.replace("_supplier_model.zip", "_supplier_meta.json"))
                    if meta_bytes is not None:
                        with open(os.path.join(os.path.dirname(dest), "%s_supplier_meta.json" % pn), "wb") as f:
                            f.write(meta_bytes)
                except Exception:
                    pass
                changed = True
                results.append({"pn": pn, "ok": True, "path": dest})
            except Exception as e:
                results.append({"pn": pn, "ok": False, "error": str(e)})
        if changed:
            _pn._commit_and_push(
                repo,
                "Organize %d supplier-fetched 3D model(s)" % sum(1 for r in results if r.get("path")),
                lambda: True,
            )
    return results


@method("supplierModels.generateDrawing")
def generate_supplier_drawing(pn):
    """Build the minimal reference drawing for a purchased part that has a
    supplier-fetched .stp in pn-cad-files but no FCStd/drawing of its own
    yet - an isometric view of the imported geometry plus a callout mapping
    the GWT PN to the supplier's own part number. Idempotent: a PN that
    already has <PN>.FCStd in its repo folder is treated as done, not
    regenerated (a real design might get hand-edited after the fact -
    this never overwrites a file it didn't just create in this same call).
    Returns a result dict; never raises for an expected "nothing to do"
    outcome (no .stp yet, already has a drawing), only for real
    misconfiguration (unknown PN, no registry entry)."""
    cfg = _pn._load_config()
    rows = _pn._read_registry(cfg)
    pn_seq = pn[:-1]
    row = _pn._current_row(rows, pn_seq)
    if row is None:
        raise RpcError(APP_ERROR, "unknown PN sequence: %s" % pn_seq)

    repo = _cad_repo_path(cfg, pn)
    part_folder = _part_folder(cfg, repo, pn, row)
    stp_path = os.path.join(part_folder, "%s.stp" % pn)
    fcstd_path = os.path.join(part_folder, "%s.FCStd" % pn)
    if not os.path.isfile(stp_path):
        return {"pn": pn, "ok": True, "skipped": "no supplier .stp on file"}
    if os.path.isfile(fcstd_path):
        return {"pn": pn, "ok": True, "skipped": "drawing already exists"}

    result = {"pn": pn, "ok": True, "pdfUploaded": False, "errors": []}
    tmpdir = tempfile.mkdtemp(prefix="gwtcad-supplier-drawing-")
    try:
        doc = App.newDocument(pn)
        try:
            shape = Part.Shape()
            shape.read(stp_path)
            part_obj = doc.addObject("Part::Feature", "SupplierModel")
            part_obj.Shape = shape
            part_obj.Label = row.get("mfg_pn") or pn
            doc.recompute()

            # Metadata sidecar (componentType/cavities/gender - see
            # tryFetchSupplierModel) organized alongside the .stp by
            # sync_supplier_models, if the supplier's fetch produced one.
            # Missing/unreadable is a normal, silent fallback case (a
            # manually-added vendor .stp has no sidecar at all), not an
            # error worth surfacing.
            meta = None
            meta_path = os.path.join(part_folder, "%s_supplier_meta.json" % pn)
            if os.path.isfile(meta_path):
                try:
                    with open(meta_path) as f:
                        meta = json.load(f)
                except Exception:
                    meta = None
            title_name, title_description = _supplier_title_block_text(
                row.get("mfg"), row.get("mfg_pn"), meta, row.get("description"))

            page_info = _drawing.create_page(doc, label="Drawing")
            page_id = page_info["id"]
            # Real GrainWave title-block template (logo, legal note, live
            # =PN/=NAME/=DESCRIPTION table) plus a real projection group
            # (front/top/right, genuinely linked/scaled) and a smaller iso
            # in the top-right - the exact same "Load Template" a user
            # would drive by hand, applied headlessly. The NOTES callout
            # states plainly that this PN is a supplier's part, not a GWT
            # design - anyone reading the drawing should know that at a
            # glance, not have to infer it from the title block alone.
            notes = ["%s IS EQUIVALENT TO %s %s" % (
                pn, (row.get("mfg") or "SUPPLIER").upper(), row.get("mfg_pn") or "?")]
            _apply_grainwave_template(doc, page_id, part_obj, pn, title_name, title_description, notes=notes)
            doc.recompute()

            doc.saveAs(fcstd_path)

            svg = _drawing.export_page_svg(doc, page_id)
            svg_path = os.path.join(tmpdir, "%s.svg" % pn)
            with open(svg_path, "w", encoding="utf-8") as f:
                f.write(svg)

            pdf_path = os.path.join(tmpdir, "%s.pdf" % pn)
            import subprocess
            r = subprocess.run(["rsvg-convert", "-f", "pdf", "-o", pdf_path, svg_path],
                                capture_output=True, text=True, timeout=60)
            if r.returncode != 0 or not os.path.isfile(pdf_path):
                raise RuntimeError("rsvg-convert failed: %s" % (r.stderr or r.stdout))

            _storage.upload_file(pdf_path, "cad-exports/%s/%s.pdf" % (pn, pn), "application/pdf")
            result["pdfUploaded"] = True
        finally:
            App.closeDocument(doc.Name)
    except Exception as e:
        result["ok"] = False
        result["errors"].append(str(e))
    finally:
        import shutil
        shutil.rmtree(tmpdir, ignore_errors=True)

    if result["ok"]:
        _pn._sync_pull(repo)
        _pn._commit_and_push(
            repo, "%s: add reference drawing from supplier 3D model" % pn, lambda: True,
        )

    return result


def _has_drawing_page(fcstd_path):
    """Opens fcstd_path (briefly) and checks for a real TechDraw::DrawPage -
    the actual gate condition for "this part has a drawing", not just "the
    file exists" (a designed part's FCStd obviously exists; that says
    nothing about whether anyone's actually drawn it yet)."""
    doc = App.openDocument(fcstd_path)
    try:
        return any(o.TypeId == "TechDraw::DrawPage" for o in doc.Objects)
    finally:
        App.closeDocument(doc.Name)


@method("pn.ensureDrawingOrBlock")
def ensure_drawing_or_block(pn):
    """The promotion gate this feature's design settled on: every part
    (designed or purchased, including the assembly itself) must have a
    real drawing before it can go active. Call this BEFORE pn.setLifecycle
    for every PN about to be promoted (the top-level part AND every
    sub-component pn.cascadePromote is about to touch) - pn.setLifecycle
    itself does not enforce this (see this feature's design conversation:
    the gate lives here, one layer up, to avoid a circular import between
    partnumbers.py and this module).

    Three outcomes:
      - already has a TechDraw page: {"ok": True, "hadDrawing": True}
      - no drawing, but has a supplier .stp on file: auto-generates one via
        generate_supplier_drawing and returns its result with
        {"ok": True, "hadDrawing": False, "autoGenerated": True}
      - no drawing and nothing to auto-generate from: {"ok": False,
        "reason": "..."} - the CALLER must refuse to promote when ok is
        False, this function only reports, it doesn't raise, since a
        blocked promotion is an expected, common outcome, not an error."""
    cfg = _pn._load_config()
    rows = _pn._read_registry(cfg)
    pn_seq = pn[:-1]
    row = _pn._current_row(rows, pn_seq)
    if row is None:
        raise RpcError(APP_ERROR, "unknown PN sequence: %s" % pn_seq)

    repo = _cad_repo_path(cfg, pn)
    part_folder = _part_folder(cfg, repo, pn, row)
    fcstd_path = os.path.join(part_folder, "%s.FCStd" % pn)

    if os.path.isfile(fcstd_path) and _has_drawing_page(fcstd_path):
        return {"pn": pn, "ok": True, "hadDrawing": True}

    stp_path = os.path.join(part_folder, "%s.stp" % pn)
    if os.path.isfile(stp_path):
        gen = generate_supplier_drawing(pn)
        if gen.get("ok") and gen.get("pdfUploaded"):
            return {"pn": pn, "ok": True, "hadDrawing": False, "autoGenerated": True}
        # generate_supplier_drawing's OWN "already exists" skip means a
        # PREVIOUS call already made the FCStd but _has_drawing_page above
        # somehow didn't see it (shouldn't happen - generate_supplier_drawing
        # always adds a page - but re-check once rather than report a false
        # block if it does).
        if gen.get("skipped") == "drawing already exists" and os.path.isfile(fcstd_path) and _has_drawing_page(fcstd_path):
            return {"pn": pn, "ok": True, "hadDrawing": True}
        return {"pn": pn, "ok": False,
                "reason": "has a supplier .stp but drawing generation failed: %s" % (
                    "; ".join(gen.get("errors", [])) or gen.get("skipped") or "unknown error")}

    return {"pn": pn, "ok": False,
            "reason": "no drawing and no supplier 3D model on file - create a drawing (or add a vendor STEP) before promoting"}


def _walk_bom_tree(cfg, rows, pn, visited):
    """Every PN in pn's BOM, recursively, as a flat list of (pn, pn_seq,
    row) tuples - a sub-assembly's own BOM is walked too, so promoting a
    top-level assembly validates its ENTIRE tree, not just direct
    children (see this feature's design conversation: nested sub-
    assemblies should cascade all the way down). `visited` guards against
    a cyclic BOM (shouldn't happen in practice, but a bad hand-edit of
    bom.csv could produce one) - a PN already seen on this walk is not
    re-descended into, though it's still included once. Lives in this
    module (not partnumbers.py, where lifecycle itself lives) so
    pn_cascade_promote can enforce ensure_drawing_or_block per sub-part
    without a circular import - this module already imports partnumbers,
    the reverse would not work."""
    out = []
    for item in _pn._read_bom(cfg):
        if item.get("pn") != pn:
            continue
        child_pn = item.get("item_pn")
        if not child_pn or child_pn in visited:
            continue
        visited.add(child_pn)
        child_row = _pn._row_for_pn(rows, child_pn)
        if child_row is None:
            continue  # BOM references a PN that was never actually reserved - nothing to promote
        out.append((child_pn, child_row["pn_seq"], child_row))
        out.extend(_walk_bom_tree(cfg, rows, child_pn, visited))
    return out


@method("pn.cascadePromoteCheck")
def pn_cascade_promote_check(pn):
    """Dry run for pn.cascadePromote: walks pn's entire BOM tree (see
    _walk_bom_tree) and reports which sub-components are not yet active,
    split into safely-promotable (in_work) vs. needs-a-decision
    (discontinued - a deliberate state pn.cascadePromote must never
    silently override). Call this BEFORE pn.cascadePromote so the caller
    can show the discontinued list and ask the user to choose, rather than
    promoting blind and finding out after the fact. Does NOT check the
    drawing gate - that's enforced at promote time (pn.cascadePromote),
    since auto-generating a drawing is itself an action, not something a
    read-only dry run should trigger as a side effect."""
    cfg = _pn._load_config()
    _pn._sync_pull(_pn._registry_path(cfg))
    rows = _pn._read_registry(cfg)
    tree = _walk_bom_tree(cfg, rows, pn, set())
    toPromote, discontinued = [], []
    for child_pn, child_pn_seq, row in tree:
        lifecycle = row.get("lifecycle") or "active"
        if lifecycle == "active":
            continue
        entry = {"pn": child_pn, "pnSeq": child_pn_seq,
                 "description": row.get("description", "")}
        (discontinued if lifecycle == "discontinued" else toPromote).append(entry)
    return {"pn": pn, "toPromote": toPromote, "discontinued": discontinued}


@method("pn.cascadePromote")
def pn_cascade_promote(pn, overrideDiscontinued=None):
    """Promotes pn's entire BOM tree to active (see _walk_bom_tree) -
    called after promoting pn itself, so an assembly going active also
    validates everything underneath it rather than leaving sub-components
    stuck in_work indefinitely. A discontinued sub-component is never
    silently promoted: `overrideDiscontinued` must be an explicit list of
    the exact PNs the caller has confirmed should be promoted anyway (from
    a user picking "re-promote to active" in the dialog
    pn.cascadePromoteCheck's report drives) - any discontinued PN NOT in
    that list is left untouched and reported back, not promoted, so a
    caller that forgets to check first can't accidentally resurrect a
    discontinued part.

    Same drawing gate as a manual single-part promotion
    (ensure_drawing_or_block) applies to every sub-component here too -
    every part, designed or purchased, needs a real drawing before it can
    be active, auto-generated from a vendor .stp when possible. A
    sub-part that fails the gate is reported in `blocked`, not silently
    skipped or promoted anyway."""
    cfg = _pn._load_config()
    reg_repo = _pn._registry_path(cfg)
    _pn._sync_pull(reg_repo)
    rows = _pn._read_registry(cfg)
    tree = _walk_bom_tree(cfg, rows, pn, set())
    override = set(overrideDiscontinued or [])

    promoted, skipped, blocked = [], [], []
    for child_pn, child_pn_seq, row in tree:
        lifecycle = row.get("lifecycle") or "active"
        if lifecycle == "active":
            continue
        if lifecycle == "discontinued" and child_pn not in override:
            skipped.append({"pn": child_pn, "pnSeq": child_pn_seq, "reason": "discontinued"})
            continue
        gate = ensure_drawing_or_block(child_pn)
        if not gate.get("ok"):
            blocked.append({"pn": child_pn, "pnSeq": child_pn_seq, "reason": gate.get("reason", "no drawing")})
            continue
        _pn.pn_set_lifecycle(child_pn_seq, "active")
        promoted.append({"pn": child_pn, "pnSeq": child_pn_seq,
                          "autoGeneratedDrawing": bool(gate.get("autoGenerated"))})
    return {"pn": pn, "promoted": promoted, "skipped": skipped, "blocked": blocked}


@method("supplierModels.syncAndGenerateAll")
def sync_and_generate_all():
    """Convenience entry point for the startup-scan trigger: organize every
    pending supplier model, then generate a drawing for every PN that now
    has a .stp but no drawing yet. Returns both result lists."""
    sync_results = sync_supplier_models()
    organized_pns = [r["pn"] for r in sync_results if r.get("ok") and (r.get("path") or r.get("skipped") == "already organized")]
    drawing_results = []
    for pn in organized_pns:
        try:
            drawing_results.append(generate_supplier_drawing(pn))
        except RpcError as e:
            drawing_results.append({"pn": pn, "ok": False, "error": e.message})
    return {"sync": sync_results, "drawings": drawing_results}
