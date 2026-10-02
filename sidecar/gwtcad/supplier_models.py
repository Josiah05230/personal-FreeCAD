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
     finds ZIPs not yet organized, unzips the .stp into pn-cad-files/<project>/<type>/,
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
from . import hasher as _hasher_mod
import Part

from .registry import method, RpcError, APP_ERROR
from . import partnumbers as _pn
from . import drawing as _drawing
from . import tables as _tables
from . import sheet_templates as _sheet_templates
from . import firebase_storage as _storage
from . import session as _session


def _coarsen_views(doc):
    """Supplier reference drawings use TechDraw's polygonal ("coarse")
    hidden-line removal instead of the exact one. Exact HLR on vendor
    models with helical threads (every McMaster screw) takes ~30s PER VIEW,
    and FreeCAD redoes it on every file OPEN - CMB0010 took ~96s to open
    (and generation, which recomputes the views several times while
    fitting the layout, far longer). Coarse: ~11s open, visually the same
    at drawing scale (compared rendered sheets side by side)."""
    for o in doc.Objects:
        if hasattr(o, "CoarseView") and not o.CoarseView and not getattr(o, "_gwt_exact", ""):
            o.CoarseView = True


def _cad_repo_path(cfg, pn):
    # A supplier-fetched model has no meaningful "project" of its own beyond
    # whatever project code the PN itself carries (e.g. CMG0010 -> project
    # "CM") - _repo_path_for already resolves any project code to its
    # configured repoPath, so this is just that same lookup keyed off the PN
    # string rather than a row already in hand.
    project = pn[:2]
    return _pn._repo_path_for(cfg, project)


def _part_folder(cfg, repo, pn, row=None):
    """The folder PN's files actually live in inside `repo` - NOT always
    one fixed shape (the layout has moved from <pn>/ to <project>/<type>/
    <pn>/ to today's flat <project>/<type>/). Honors the registry's
    repo_relpath hint via the same self-healing lookup partnumbers.py
    itself uses, so this never drifts from wherever pn.resolve would
    actually find the part. Falls back to the new-part convention
    (<project>/<type>/) only when the part has no file on disk yet at all -
    the first-time sync_supplier_models case, where there's nothing to
    look up yet."""
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
    return os.path.join(repo, project, type_)


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
# the iso box's CENTRE: its top (centre - 25) sits 4mm inside the sheet
# border - at 30 a full-height iso ran 5mm above the border (CME0030)
_ISO_X, _ISO_TARGET_W, _ISO_TARGET_H = 330.0, 65.0, 50.0
_ISO_Y = _MARGIN + 4.0 + _ISO_TARGET_H / 2.0
_IMAGE_INSET = 4.0  # view images keep at least this far inside the border


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


def _title_block_problem(pn, row):
    """Why `row` can't title a drawing yet, or None. The user's standing
    rules for every drawing: PART NAME is one word (the registry's name
    column - "SCREW", "CONNECTOR"), and the manufacturer part number appears
    ONLY in the IS EQUIVALENT TO note, never in the name or description.
    Earlier versions titled supplier drawings "Deutsch DT04-2P" and kept
    descriptions like "flat head screw (92010A114)". A row that breaks a
    rule blocks the drawing until the registry is fixed - never patched
    over with a guessed or placeholder name."""
    name = (row.get("name") or "").strip()
    if len(name.split()) != 1:
        return ("%s needs a one-word part name in the registry (has %r) before a "
                "drawing can be generated." % (pn, name))
    mfg_pn = (row.get("mfg_pn") or "").strip()
    if mfg_pn and mfg_pn.lower() in (row.get("description") or "").lower():
        return ("%s's registry description contains its manufacturer part number %s - "
                "that belongs only in the drawing note; take it out of the description "
                "first." % (pn, mfg_pn))
    return None


def _title_block_text(row):
    """PART NAME / DESCRIPTION for a generated drawing, straight from the
    registry row (the portal shows the same description as Component name,
    so the two can never disagree). Call _title_block_problem first."""
    return row["name"].strip().upper(), (row.get("description") or "").strip()


# how far (sheet mm) an overall dimension's line sits outside its view
_OVERALL_DIM_OFFSET = 7.0


def _add_overall_dimensions(doc, page_id, group_views):
    """Overall size on a generated drawing, so its scale can be read off
    the sheet (user, 2026-09-28: "There are also not dimensions in the
    drawing for me to be able to tell scale"): width and height on Front,
    depth on Right. Each goes on the side facing the next view - Front's
    width toward Top, its height toward Right, Right's depth into the open
    space above it - since the group itself is spread toward the sheet
    edges. Each measures the view's own drawn outline, so every body and
    any curved silhouette counts - see drawing.DIM_EXTENT_TAG."""
    by_dir = {v["direction"]: doc.getObject(v["id"]) for v in group_views}
    # (view, extent spec): "x+" width drawn above, "y+" height drawn right
    wanted = [("front", "x+"), ("front", "y+"), ("right", "x+")]
    for direction, spec in wanted:
        view = by_dir.get(direction)
        if view is None or not view.Source:
            continue
        # the ref only anchors the dimension to its view - an extent-tagged
        # dimension measures the view's outline, not the referenced edge
        dim = _drawing.add_dimension(doc, page_id, view.Name, [{"sub": "Edge1"}], "Distance")
        dim_obj = doc.getObject(dim["id"])
        _drawing._tag(dim_obj, _drawing.DIM_EXTENT_TAG, spec)
        pts = _drawing._dimension_linear_points(dim_obj)
        if not pts:
            _drawing.remove_dimension(doc, dim["id"])
            continue
        p1, p2 = pts
        vis, hid = _drawing._part_view_payload(view)
        min_x, min_y, max_x, max_y = _drawing._view_bbox(vis, hid)
        # a group item's UV frame is sheet mm already; a plain view's is model mm
        is_item = view.TypeId == "TechDraw::DrawProjGroupItem"
        off = _OVERALL_DIM_OFFSET if is_item else _OVERALL_DIM_OFFSET / max(float(view.Scale), 1e-9)
        if spec.startswith("x"):
            label = ((p1[0] + p2[0]) / 2.0, max_y + off)
        else:
            label = (max_x + off, (p1[1] + p2[1]) / 2.0)
        _drawing.set_dimension_geom(doc, dim["id"], label)


_ANALYTIC_SURFACES = ("Plane", "Cylinder", "Cone", "Sphere", "Toroid")


def _hlr_coarse(sources):
    """Whether this model's views should use coarse (polygon) hidden-line
    removal. Exact HLR is fast on analytic geometry and crawls on freeform
    surfaces (a screw's helical thread: ~30s per view); coarse is the reverse
    - a perfboard's 540 hole cylinders took 101s coarse vs 0.6s exact for one
    view, because every circle becomes dozens of segments. So: coarse only
    when freeform faces are a real share of the model."""
    total = free = 0
    for o in sources:
        for f in o.Shape.Faces:
            total += 1
            if f.Surface.__class__.__name__ not in _ANALYTIC_SURFACES:
                free += 1
    return free > 40 or (total and free > 0.2 * total)


def _iso_extent(bb):
    """Width/height of a bounding box's iso projection (the eight corners
    onto the view plane) - the iso view's size at scale 1, near enough to
    draw it once at its final scale."""
    import math
    d = App.Vector(*_drawing._DIRS["iso"]).normalize()
    u = App.Vector(0, 0, 1).cross(d)
    u = u.normalize() if u.Length > 1e-9 else App.Vector(1, 0, 0)
    v = d.cross(u).normalize()
    xs, ys = [], []
    for x in (bb.XMin, bb.XMax):
        for y in (bb.YMin, bb.YMax):
            for z in (bb.ZMin, bb.ZMax):
                p = App.Vector(x, y, z)
                xs.append(p.dot(u))
                ys.append(p.dot(v))
    return max(max(xs) - min(xs), 1e-6), max(max(ys) - min(ys), 1e-6)


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
    sources = part_obj if isinstance(part_obj, (list, tuple)) else [part_obj]
    bb3 = sources[0].Shape.BoundBox
    for o in sources[1:]:
        bb3.add(o.Shape.BoundBox)
    heavy = _hlr_cost(sources) > _FAST_VIEW_COST
    if heavy:
        # image views carry no live dimensions - state the size instead
        notes = list(notes or []) + ["OVERALL SIZE %.1f x %.1f x %.1f MM" % (
            bb3.XLength, bb3.YLength, bb3.ZLength)]

    _place_sheet_furniture(doc, page_id, tpl, title_block, rows, columns, style,
                           table_x, table_y, table_h, notes)

    # Start at the scale the 3D bounding box already implies (a front view
    # is the part's X by Z extent), so hidden-line removal - the slow part -
    # runs at roughly the final size instead of first at 1x and then again.
    budget_w = (_ISO_X - _GROUP_MIN_CLEARANCE - _GROUP_EDGE_BREATHING_ROOM) - _GROUP_LEFT
    budget_h = ((table_y - _GROUP_MIN_CLEARANCE - _VIEW_LABEL_FOOTPRINT - _GROUP_EDGE_BREATHING_ROOM) - _GROUP_TOP
                if table_y is not None else _SHEET_H - _MARGIN - _GROUP_TOP)
    if heavy:
        # thousands of faces: TechDraw's hidden-line views take minutes
        # (an ESP8266 module 371s, a large perfboard over 10 min); fastview
        # draws all four from one mesh in seconds. TechDraw stays the
        # fallback if it fails.
        try:
            _fast_group_views(doc, page_id, sources, bb3, budget_w, budget_h)
            return
        except Exception:
            pass
    # front + right side by side, top above front, one gap each way
    span_w = max(bb3.XLength + bb3.YLength, 1e-6)
    span_h = max(bb3.ZLength + bb3.YLength, 1e-6)
    est_scale = min((budget_w - _GROUP_SPACING) / span_w, (budget_h - _GROUP_SPACING) / span_h,
                    _PART_TARGET_W / max(bb3.XLength, 1e-6), _PART_TARGET_H / max(bb3.ZLength, 1e-6), 8.0)
    est_scale = max(est_scale, 1e-3)
    # ...and spread from the start: at that scale the three views need
    # span * scale, so the rest of each axis's budget is its gap (the user
    # wants front/top/right toward the sheet edges, not huddled together)
    est_sp_x = max(_GROUP_SPACING, (budget_w - est_scale * span_w) * 0.97)
    est_sp_y = max(_GROUP_SPACING, (budget_h - est_scale * span_h) * 0.97)
    coarse = _hlr_coarse(sources)
    probe = _drawing.make_projection_group(doc, page_id, part_obj, group_dirs, anchor="front",
                                           scale=est_scale, coarse=coarse, spacing=(est_sp_x, est_sp_y))
    if not coarse:
        for v in probe["views"]:
            _drawing._tag(doc.getObject(v["id"]), "_gwt_exact", "1")  # _coarsen_views leaves these
    grp = doc.getObject(probe["groupId"])
    grp.ScaleType = "Custom"
    _coarsen_views(doc)

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

    anchor_id = next(v["id"] for v in probe["views"] if v["isAnchor"])
    anchor_item = doc.getObject(anchor_id)

    last = {}

    def _measure(scale, spacing_x, spacing_y):
        # every recompute re-runs hidden-line removal on all three views -
        # skip it when nothing actually changed
        if last.get("v") != (scale, spacing_x, spacing_y):
            grp.Scale = scale
            grp.spacingX = spacing_x
            grp.spacingY = spacing_y
            doc.recompute()
            last["v"] = (scale, spacing_x, spacing_y)
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
    # the probe is already at the estimated scale and final spacing: measure
    # it as it stands, and only recompute if it doesn't fit
    scale = est_scale
    spacing_x, spacing_y = est_sp_x, est_sp_y
    last["v"] = (scale, spacing_x, spacing_y)
    fp = _measure(scale, spacing_x, spacing_y)
    for _ in range(3):
        fp_w, fp_h = fp[2] - fp[0], fp[3] - fp[1]
        ratio_w = budget_w / max(fp_w, 1e-6)
        ratio_h = budget_h / max(fp_h, 1e-6)
        scale_ratio = min(ratio_w, ratio_h)
        # fits on both axes, and the tighter one has at most 10% to spare -
        # chasing an exact fill made the old loop bounce up to 8 times, each
        # a full hidden-line pass
        if ratio_w >= 0.97 and ratio_h >= 0.97 and scale_ratio <= 1.10:
            break
        scale *= min(scale_ratio, 1.0) if scale_ratio < 1.0 else scale_ratio
        spacing_x *= ratio_w
        spacing_y *= ratio_h
        fp = _measure(scale, spacing_x, spacing_y)

    # Spread the views out: with the scale settled, grow each axis's gap by
    # that axis's leftover room so front/top/right sit toward the sheet
    # edges rather than huddled together (the user asked for this spread).
    # A gap is one-for-one with the footprint on its axis, so this lands in
    # one step; if the result somehow overshoots, keep the tighter layout.
    spare_w = budget_w - (fp[2] - fp[0])
    spare_h = budget_h - (fp[3] - fp[1])
    if spare_w > budget_w * 0.05 or spare_h > budget_h * 0.05:
        tight = (spacing_x, spacing_y, fp)
        spacing_x += max(spare_w, 0.0) * 0.97
        spacing_y += max(spare_h, 0.0) * 0.97
        fp = _measure(scale, spacing_x, spacing_y)
        if (fp[2] - fp[0]) > budget_w * 1.03 or (fp[3] - fp[1]) > budget_h * 1.03:
            spacing_x, spacing_y, fp = tight
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

    _add_overall_dimensions(doc, page_id, probe["views"])

    # an iso view is never wider or taller than the part's 3D diagonal, so
    # this starting scale always fits; rescale only if it leaves real room
    iso_w, iso_h = _iso_extent(bb3)
    iso_est = min(_ISO_TARGET_W / iso_w, _ISO_TARGET_H / iso_h, 8.0) * 0.97
    # The iso is a small 3D reference drawn by fastview's own hidden-line
    # renderer (a depth buffer over a coarse mesh): TechDraw's HLR took
    # minutes on a heavy model - 161s for an ESP8266 module, never finishing
    # on a large perfboard - where this takes seconds for anything. TechDraw
    # stays the fallback if the renderer fails.
    try:
        if _render_iso_image(doc, page_id, sources) is not None:
            return
    except Exception:
        pass
    iso_src = sources
    iso_result = _drawing.make_view(doc, page_id, iso_src, direction="iso", scale=iso_est, coarse=coarse,
                                    x=_ISO_X, y=_ISO_Y)
    iso_view = doc.getObject(iso_result["id"])
    if not coarse:
        _drawing._tag(iso_view, "_gwt_exact", "1")
    # "Page" (the default) ignores Scale in this session but flips to
    # "Custom" when the file is reopened - the iso was laid out and printed
    # 1x here yet showed 8x everywhere else
    iso_view.ScaleType = "Custom"
    grow = _fit_scale(iso_result["bbox"], _ISO_TARGET_W, _ISO_TARGET_H, cap=8.0 / iso_est)
    if grow > 1.15:
        iso_view.Scale = iso_est * grow
        doc.recompute()


ISO_RENDER_TAG = "_gwt_isoRender"  # any fastview-drawn view image (name kept for files already tagged)
_FAST_VIEW_COST = 3000  # above this, TechDraw's hidden-line views take minutes


def _hlr_cost(sources):
    """Rough hidden-line cost: freeform faces weigh ten plain ones (a
    1100-face PCB model, all B-spline, took TechDraw 5.5 min; a perfboard's
    6870 planes and cylinders took about as long)."""
    cost = 0
    for o in sources:
        for f in o.Shape.Faces:
            cost += 1 if f.Surface.__class__.__name__ in _ANALYTIC_SURFACES else 10
    return cost


def _render_view_image(doc, page_id, sources, direction, x, y, centered, scale=None,
                       max_w=None, max_h=None, mesh=None, image=None, label=None):
    """Draw one view of `sources` with fastview and place it (or, given
    `image`, replace that image in place): at `scale`, or fitted to
    max_w x max_h; (x, y) is its centre when `centered`, else its top-left.
    The image is tagged with how it was made so a later revision can
    re-render it from the new geometry."""
    import tempfile
    from . import fastview as _fastview
    svg, w, h = _fastview.render_view_svg([o.Shape for o in sources], direction, max_w, max_h,
                                          scale=scale, mesh=mesh)
    path = os.path.join(tempfile.mkdtemp(prefix="gwtcad-view-"), "view.svg")
    with open(path, "w", encoding="utf-8") as f:
        f.write(svg)
    if image is not None:
        # re-rendering keeps it wherever it sits now (a person may have
        # moved it); a centred image stays centred on its current centre
        x, y = ((float(image.X) + float(image.Width) / 2, float(image.Y) + float(image.Height) / 2)
                if centered else (float(image.X), float(image.Y)))
    px, py = (x - w / 2.0, y - h / 2.0) if centered else (x, y)
    # never past the sheet border, whatever position it was handed: a batch
    # redraw by a sidecar still running pre-121791d code centred the iso at
    # y=30 again (CME0030/60/70, PSA0031), and a re-render keeps that spot
    px = min(max(px, _MARGIN + _IMAGE_INSET), _SHEET_W - _MARGIN - _IMAGE_INSET - w)
    py = min(max(py, _MARGIN + _IMAGE_INSET), _SHEET_H - _MARGIN - _IMAGE_INSET - h)
    if image is None:
        dto = _drawing.add_image(doc, page_id, path, x=px, y=py, width=w, height=h)
        image = doc.getObject(dto["id"])
        if label:
            image.Label = label
    else:
        image.ImageFile = path
        image.X, image.Y, image.Width, image.Height = px, py, w, h
        doc.recompute()
    _drawing._tag(image, ISO_RENDER_TAG, json.dumps({
        "src": [o.Name for o in sources], "dir": list(direction), "x": x, "y": y,
        "centered": centered, "scale": scale, "maxW": max_w, "maxH": max_h}))
    return image


def _render_iso_image(doc, page_id, sources, mesh=None):
    return _render_view_image(doc, page_id, sources, _drawing._DIRS["iso"], _ISO_X, _ISO_Y, True,
                              max_w=_ISO_TARGET_W, max_h=_ISO_TARGET_H, mesh=mesh, label="Iso view")


def _fast_group_views(doc, page_id, sources, bb3, budget_w, budget_h):
    """Front / top / right (third angle) and the iso of a heavy model, all
    drawn by fastview from one mesh: seconds where TechDraw took minutes.
    Same layout rules as the TechDraw group - one scale, spread toward the
    sheet edges within the budget."""
    from . import fastview as _fastview
    mesh = _fastview.model_mesh([o.Shape for o in sources])
    min_gap = 15.0
    span_w = max(bb3.XLength + bb3.YLength, 1e-6)
    span_h = max(bb3.ZLength + bb3.YLength, 1e-6)
    scale = min((budget_w - min_gap) / span_w, (budget_h - min_gap) / span_h, 8.0)
    fw, fh = bb3.XLength * scale, bb3.ZLength * scale
    th = bb3.YLength * scale
    gx = max(min_gap, budget_w - (fw + bb3.YLength * scale))
    gy = max(min_gap, budget_h - (th + fh))
    left, top = _GROUP_LEFT, _GROUP_TOP
    views = (("Top view", (0, 0, 1), left, top),
             ("Front view", (0, -1, 0), left, top + th + gy),
             ("Right view", (1, 0, 0), left + fw + gx, top + th + gy))
    for label, direction, x, y in views:
        _render_view_image(doc, page_id, sources, direction, x, y, False, scale=scale, mesh=mesh, label=label)
    _render_iso_image(doc, page_id, sources, mesh=mesh)
    return scale


def rerender_iso_images(doc, page):
    """Re-draw every fastview view image on `page` from its sources' current
    geometry (a new revision must not show the previous one's part)."""
    from . import fastview as _fastview
    meshes = {}
    for v in list(page.Views):
        raw = _drawing._get_tag(v, ISO_RENDER_TAG) if v.TypeId == "TechDraw::DrawViewImage" else ""
        if not raw:
            continue
        try:
            info = json.loads(raw)
        except Exception:
            continue
        if isinstance(info, list):  # first-generation tag: an iso, source names only
            info = {"src": info, "dir": list(_drawing._DIRS["iso"]), "x": _ISO_X, "y": _ISO_Y,
                    "centered": True, "scale": None, "maxW": _ISO_TARGET_W, "maxH": _ISO_TARGET_H}
        srcs = [doc.getObject(n) for n in info["src"] if doc.getObject(n) is not None]
        if not srcs:
            continue
        key = tuple(o.Name for o in srcs)
        if key not in meshes:
            meshes[key] = _fastview.model_mesh([o.Shape for o in srcs])
        _render_view_image(doc, page.Name, srcs, tuple(info["dir"]), info["x"], info["y"], info["centered"],
                           scale=info.get("scale"), max_w=info.get("maxW"), max_h=info.get("maxH"),
                           mesh=meshes[key], image=v)


def _place_sheet_furniture(doc, page_id, tpl, title_block, rows, columns, style,
                           table_x, table_y, table_h, notes):
    """Notes, title-block table, logo and legal note. Placed BEFORE any
    view exists: adding them after made FreeCAD recompute the page and re-run
    hidden-line removal on the views already on it."""
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
    unzipped into pn-cad-files yet (checked by whether <PN>.stp already
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
        organized = []
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
                organized.append(dest)
                meta = os.path.join(os.path.dirname(dest), "%s_supplier_meta.json" % pn)
                if os.path.isfile(meta):
                    organized.append(meta)
            except Exception as e:
                results.append({"pn": pn, "ok": False, "error": str(e)})
        if changed:
            _pn._commit_and_push(
                repo,
                "Organize %d supplier-fetched 3D model(s)" % sum(1 for r in results if r.get("path")),
                lambda: True, paths=organized,
            )
    return results


@method("supplierModels.generateDrawing")
def generate_supplier_drawing(pn):
    """See _generate_supplier_drawing. Wrapped so the SESSION's part number
    (shared with whatever document the user has open) is always put back:
    generating tags the session with the generated PN so the title-block
    cells resolve, and that used to leak into the user's open document -
    its title block showed the last generated part, and its next Save
    wrote that wrong PN into the user's file."""
    prev = _session.part_number()
    try:
        return _generate_supplier_drawing(pn)
    finally:
        _session.set_part_number(prev or None)


def _bodies_of(shape):
    """The separate bodies in an imported STEP: every solid, plus every
    shell that isn't part of one (surface-only vendor models), walking
    nested compounds. Anything left (loose faces/edges) stays together as
    one extra body; a shape with no solids or shells comes back whole."""
    bodies, loose = [], []

    def walk(s):
        if s.ShapeType == "Compound" or s.ShapeType == "CompSolid":
            for c in s.childShapes():
                walk(c)
        elif s.ShapeType in ("Solid", "Shell"):
            bodies.append(s)
        else:
            loose.append(s)

    walk(shape)
    if not bodies:
        return [shape]
    if loose:
        bodies.append(Part.makeCompound(loose))
    return bodies


def _generate_supplier_drawing(pn):
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

    # A real vendor part number is REQUIRED before this function can write
    # its "<PN> IS EQUIVALENT TO <MFG> <MFG_PN>" note - a .stp with no mfg
    # AND no mfg_pn in the registry means nobody has ever actually recorded
    # who this part comes from, so there is nothing true to write there.
    # Confirmed live: an earlier version silently fell back to a literal
    # "?" for mfg_pn (and "PART" for the title block's PART NAME) rather
    # than refusing - which shipped a real, misleading placeholder onto a
    # real generated drawing (CMC0020: "IS EQUIVALENT TO SUPPLIER ?").
    # That must never happen again - a missing fact is a hard block the
    # user has to resolve (fill in mfg/mfg_pn on the registry row, or this
    # PN's .stp doesn't belong to a real supplier part and shouldn't be
    # going through this pipeline at all), never a guessed-at fact quietly
    # written into a document.
    if not (row.get("mfg") or "").strip() or not (row.get("mfg_pn") or "").strip():
        return {"pn": pn, "ok": False,
                "errors": ["%s has a supplier .stp on file but no mfg/mfg_pn recorded in the "
                           "registry - fill those in before a drawing can be generated "
                           "(never auto-filled with a placeholder)." % pn]}
    problem = _title_block_problem(pn, row)
    if problem:
        return {"pn": pn, "ok": False, "errors": [problem]}

    result ={"pn": pn, "ok": True, "pdfUploaded": False, "errors": []}
    tmpdir = tempfile.mkdtemp(prefix="gwtcad-supplier-drawing-")
    try:
        doc = _hasher_mod.new_document(pn)
        try:
            shape = Part.Shape()
            shape.read(stp_path)
            # one object per body, not one fused compound - a multi-part
            # vendor model (housing + terminals + seal) used to come in as a
            # single object, so CMC0020 showed 1 body where the STEP has 4
            label = row.get("mfg_pn") or pn
            bodies = _bodies_of(shape)
            part_obj = []
            for i, body in enumerate(bodies):
                o = doc.addObject("Part::Feature", "SupplierModel")
                o.Shape = body
                o.Label = label if len(bodies) == 1 else "%s body %d" % (label, i + 1)
                part_obj.append(o)
            doc.recompute()

            title_name, title_description = _title_block_text(row)

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
            # mfg/mfg_pn are both guaranteed non-empty here by the hard
            # gate above - deliberately NOT using an `or "?"` / `or
            # "SUPPLIER"` fallback, so that if that guarantee ever breaks
            # this raises loudly (caught by this function's own
            # except Exception below) instead of silently writing a
            # placeholder into a real drawing again.
            notes = ["%s IS EQUIVALENT TO %s %s" % (pn, row["mfg"].upper(), row["mfg_pn"])]
            _apply_grainwave_template(doc, page_id, part_obj, pn, title_name, title_description, notes=notes)
            _coarsen_views(doc)  # catches the iso view too
            doc.recompute()
            _stamp_auto_drawing(doc, doc.getObject(page_id), pn, title_name, title_description, notes)

            # persist the PN into the file itself (plain doc.saveAs skips the
            # document.save RPC that normally does this) - otherwise every
            # later open had a blank title block
            from .methods import _apply_part_number_props
            _apply_part_number_props(doc)
            doc.saveAs(fcstd_path)
            _drawing.mark_pages_lazy_on_disk(fcstd_path, doc)

            upload_page_pdf(doc, page_id, pn)
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
            paths=_pn._part_paths(fcstd_path),
        )

    return result


def _has_drawing_page(fcstd_path):
    """Opens fcstd_path (briefly) and checks for a real TechDraw::DrawPage -
    the actual gate condition for "this part has a drawing", not just "the
    file exists" (a designed part's FCStd obviously exists; that says
    nothing about whether anyone's actually drawn it yet).

    A file that's already open (the part being promoted is normally the
    one on screen) is read in place and left open: App.openDocument hands
    back that same document, so closing it here used to close the user's
    open part out from under the session."""
    real = os.path.realpath(fcstd_path)
    for d in App.listDocuments().values():
        if d.FileName and os.path.realpath(d.FileName) == real:
            return any(o.TypeId == "TechDraw::DrawPage" for o in d.Objects)
    doc = App.openDocument(fcstd_path)
    try:
        return any(o.TypeId == "TechDraw::DrawPage" for o in doc.Objects)
    finally:
        App.closeDocument(doc.Name)


# --------------------------------------------------------------------------- #
# Drawings across a revision: an auto-generated drawing nobody has touched
# is regenerated from the new revision's geometry when that revision goes
# active; one a person has edited is kept (its views already follow the
# model live) with only its title block brought up to the new PN.
# --------------------------------------------------------------------------- #

# what a person can change on a sheet: placement, scale, orientation, text,
# dimension/table content. Computed geometry is left out on purpose - moving
# a body changes the views' lines but is a model edit, not a drawing edit.
_SIG_PROPS = ("X", "Y", "Scale", "Rotation", "Direction", "XDirection",
              "Caption", "Text", "FormatSpec", "Arbitrary", "Type", "References2D",
              "CellStart", "CellEnd", "TextSize", "Font", "spacingX", "spacingY",
              "ProjectionType", "_gwt_rawrows", "_gwt_style")
# a projection group's items are placed and scaled by the group (and
# FreeCAD re-derives them on reopen: ScaleType Page -> Custom, X/Y from
# AutoDistribute) - the group's own X/Y/Scale/spacing is what a person moves
_SIG_SKIP_ON_GROUP_ITEMS = ("X", "Y", "Scale")


def _sig_value(v):
    if hasattr(v, "Value") and hasattr(v, "Unit"):  # Base.Quantity (X, Y, ...)
        v = v.Value
    if isinstance(v, float):
        return round(v, 3)
    if hasattr(v, "x") and hasattr(v, "y") and hasattr(v, "z"):
        return (round(v.x, 4), round(v.y, 4), round(v.z, 4))
    if isinstance(v, (list, tuple)):
        return [_sig_value(x) for x in v]
    if hasattr(v, "Name"):
        return v.Name
    return str(v)


def _page_sig_items(page):
    items = []
    for o in sorted(_drawing._page_objects(page), key=lambda o: o.Name):
        props = {}
        for name in _SIG_PROPS:
            if o.TypeId == "TechDraw::DrawProjGroupItem" and name in _SIG_SKIP_ON_GROUP_ITEMS:
                continue
            # a fastview image changes size when re-rendered; what a person
            # moves is where it sits - fingerprint its centre (below)
            if name in ("X", "Y") and getattr(o, ISO_RENDER_TAG, ""):
                continue
            if name in o.PropertiesList:
                try:
                    props[name] = _sig_value(getattr(o, name))
                except Exception:
                    pass
        if getattr(o, ISO_RENDER_TAG, ""):
            props["center"] = [round(float(o.X) + float(o.Width) / 2, 2), round(float(o.Y) + float(o.Height) / 2, 2)]
        items.append([o.Name, o.TypeId, props])
    return items


def page_signature(page):
    import hashlib
    return hashlib.sha1(json.dumps(_page_sig_items(page), sort_keys=True).encode("utf-8")).hexdigest()


def _stamp_auto_drawing(doc, page, pn, title_name, title_description, notes):
    """Mark a page as generated for `pn`, with the fingerprint it had when
    it was. A later fingerprint that still matches means nobody has edited
    it."""
    doc.recompute()
    _drawing._tag(page, "_gwt_autogen", json.dumps({
        "kind": "supplier", "pn": pn, "sig": page_signature(page),
        "titleName": title_name, "titleDescription": title_description, "notes": notes or [],
    }))


def _auto_drawing_info(page):
    raw = _drawing._get_tag(page, "_gwt_autogen")
    if not raw:
        return None
    try:
        return json.loads(raw)
    except Exception:
        return None


def _drawing_sources(doc, page):
    """The model objects a page draws - taken from its own projection
    group, so a regenerated page shows exactly what the original did."""
    for o in _drawing._page_objects(page):
        if o.TypeId == "TechDraw::DrawProjGroup" and o.Source:
            return list(o.Source)
    solids = [o for o in doc.Objects
              if o.TypeId in ("Part::Feature", "PartDesign::Body") and getattr(o, "Visibility", True)
              and not o.TypeId.startswith("TechDraw")]
    return [o for o in solids if getattr(o, "Shape", None) is not None and not o.Shape.isNull()]


def _recompute_page_views(doc, page):
    """Force every view on `page` to recompute from the current model - a
    lazy page (KeepUpdated off on disk) or a stale cached view must never
    show the previous revision's geometry on this revision's drawing."""
    _drawing._ensure_page_live(doc, page)
    _drawing.refresh_snapshots(doc)
    for o in _drawing._page_objects(page):
        if o.TypeId.startswith("TechDraw::"):
            o.touch()
    doc.recompute()
    rerender_iso_images(doc, page)


@method("drawing.refreshForRevision")
def refresh_drawing_for_revision(rebuild=True):
    """Bring the open part's drawings up to date for its current revision.
    Every page, edited or not, gets its views recomputed from the current
    geometry and its table cells (the title block's =PN/=NAME/=DESCRIPTION)
    re-resolved, so a sheet never shows the previous revision's part or PN.
    With `rebuild` (a revision going active), a page generated for an
    earlier revision and untouched since (fingerprint matches) is instead
    rebuilt from scratch - same template, notes and title text - so its
    layout fits the new geometry.
    Returns {"pages": [{"id", "label", "action": "regenerated"|"updated"}]}."""
    doc = _session.doc(create=False)
    if doc is None:
        raise RpcError(APP_ERROR, "no document")
    pn = (_session.part_number() or {}).get("pn")
    out = []
    for page in [o for o in doc.Objects if o.TypeId == "TechDraw::DrawPage"]:
        _drawing._ensure_page_live(doc, page)
        info = _auto_drawing_info(page)
        label = page.Label
        # drawn for an earlier revision and untouched since: rebuild it
        if rebuild and pn and info and info.get("pn") != pn and info.get("sig") == page_signature(page):
            sources = _drawing_sources(doc, page)
            if sources:
                # the equivalence note names the PN and the supplier part:
                # write it fresh from the registry (never carry a stale or
                # placeholder supplier forward), else move the old one to this PN
                cfg = _pn._load_config()
                row = _pn._current_row(_pn._read_registry(cfg), pn[:-1]) if cfg.get("registryPath") else None
                fresh = None
                if row and (row.get("mfg") or "").strip() and (row.get("mfg_pn") or "").strip():
                    fresh = "%s IS EQUIVALENT TO %s %s" % (pn, row["mfg"].upper(), row["mfg_pn"])
                # no registry mfg/mfg_pn: drop the equivalence note rather than
                # carry the old one's supplier text (possibly "SUPPLIER ?") onto
                # this PN - the caller is told so the user can fill it in
                notes = [fresh if " IS EQUIVALENT TO " in n else n
                         for n in info.get("notes", []) if fresh or " IS EQUIVALENT TO " not in n]
                dropped_note = not fresh and any(" IS EQUIVALENT TO " in n for n in info.get("notes", []))
                # title text comes from the registry (the stamp may hold an old
                # revision's text, or the old "PART"/"<mfg> <mfg_pn>" name);
                # a row that can't title a drawing leaves the page as it is
                problem = _title_block_problem(pn, row) if row else "%s has no registry row." % pn
                if problem:
                    _recompute_page_views(doc, page)
                    _tables.refresh_live_cells(doc, page)
                    out.append({"id": page.Name, "label": page.Label, "action": "updated", "warning": problem})
                    continue
                name, description = _title_block_text(row)
                _drawing.delete_page(doc, page.Name)
                new_page = _drawing.create_page(doc, label=label)
                _apply_grainwave_template(doc, new_page["id"], sources, pn, name, description, notes=notes)
                _coarsen_views(doc)
                doc.recompute()
                page = doc.getObject(new_page["id"])
                _stamp_auto_drawing(doc, page, pn, name, description, notes)
                entry = {"id": page.Name, "label": page.Label, "action": "regenerated"}
                if dropped_note:
                    entry["warning"] = ("%s has no mfg/mfg_pn in the registry, so its "
                                        "IS EQUIVALENT TO note was left off - fill those in "
                                        "and refresh the drawing." % pn)
                out.append(entry)
                continue
        _recompute_page_views(doc, page)
        _tables.refresh_live_cells(doc, page)
        out.append({"id": page.Name, "label": page.Label, "action": "updated"})
    return {"pages": out}


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

    if os.path.isfile(fcstd_path):
        # a part file with geometry of its own draws from that
        real = os.path.realpath(fcstd_path)
        open_doc = next((d for d in App.listDocuments().values()
                         if d.FileName and os.path.realpath(d.FileName) == real), None)
        if open_doc is not None:
            # the part on screen: draw it in place (the session keeps its PN)
            if _draw_part_in_doc(open_doc, fcstd_path, pn, row):
                return {"pn": pn, "ok": True, "hadDrawing": False, "autoGenerated": True}
        else:
            gen = generate_part_drawing(pn)
            if gen.get("generated"):
                return {"pn": pn, "ok": True, "hadDrawing": False, "autoGenerated": True}

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


def _file_has_drawing(fcstd_path):
    """Cheap check straight from the .FCStd's Document.xml - no FreeCAD open."""
    try:
        with zipfile.ZipFile(fcstd_path) as zf:
            return b"TechDraw::DrawPage" in zf.read("Document.xml")
    except Exception:
        return True  # unreadable: never try to "fix" it


def _drawable_bodies(doc):
    """The geometry a part's own drawing should show: top-level visible
    bodies and shapes with faces (not TechDraw, not helpers hidden inside a
    Body)."""
    out = []
    for o in doc.Objects:
        # App::Link: an assembly's components (their Shape carries placement)
        if o.TypeId not in ("PartDesign::Body", "Part::Feature", "App::Link") and not o.TypeId.startswith("Part::"):
            continue
        if any(p.TypeId == "PartDesign::Body" for p in o.InList):
            continue  # a feature inside a Body - the Body stands for it
        if o.TypeId != "PartDesign::Body" and any(p.TypeId.startswith("Part::") for p in o.InList):
            continue  # consumed by a boolean/compound above it
        if not getattr(o, "Visibility", True):
            continue
        shape = getattr(o, "Shape", None)
        # surface models (imported shells, no closed solid) draw just as well
        if shape is None or shape.isNull() or not (shape.Solids or shape.Faces):
            continue
        out.append(o)
    return out


def upload_page_pdf(doc, page_id, pn):
    """Export a drawing page to PDF and put it where the GrainWavePartners
    portal reads it (cad-exports/<PN>/<PN>.pdf). Raises on failure."""
    import shutil
    import subprocess
    tmpdir = tempfile.mkdtemp(prefix="gwtcad-drawing-pdf-")
    try:
        svg_path = os.path.join(tmpdir, "%s.svg" % pn)
        with open(svg_path, "w", encoding="utf-8") as f:
            f.write(_drawing.export_page_svg(doc, page_id))
        pdf_path = os.path.join(tmpdir, "%s.pdf" % pn)
        r = subprocess.run(["rsvg-convert", "-f", "pdf", "-o", pdf_path, svg_path],
                           capture_output=True, text=True, timeout=60)
        if r.returncode != 0 or not os.path.isfile(pdf_path):
            raise RuntimeError("rsvg-convert failed: %s" % (r.stderr or r.stdout))
        _storage.upload_file(pdf_path, "cad-exports/%s/%s.pdf" % (pn, pn), "application/pdf")
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def _draw_part_in_doc(doc, fcstd_path, pn, row):
    """Add the GrainWave drawing for `pn` to `doc` from its own solids and
    save it. False when there is nothing solid to draw."""
    bodies = _drawable_bodies(doc)
    if not bodies:
        return False
    notes = []
    if (row.get("mfg") or "").strip() and (row.get("mfg_pn") or "").strip() and row.get("mfg") != "GWT":
        notes = ["%s IS EQUIVALENT TO %s %s" % (pn, row["mfg"].upper(), row["mfg_pn"])]
    name, description = _title_block_text(row)
    page = _drawing.create_page(doc, label="Drawing")
    _apply_grainwave_template(doc, page["id"], bodies, pn, name, description, notes=notes)
    _stamp_auto_drawing(doc, doc.getObject(page["id"]), pn, name, description, notes)
    from .methods import _apply_part_number_props
    _apply_part_number_props(doc)
    doc.save()
    _drawing.mark_pages_lazy_on_disk(fcstd_path, doc)
    # the portal shows cad-exports/<PN>/<PN>.pdf; drawings made here used to
    # stay inside the .FCStd, so 40 parts had a drawing nobody could see.
    # Best effort: no Firebase key or offline must not cost the drawing.
    try:
        upload_page_pdf(doc, page["id"], pn)
    except Exception as e:
        App.Console.PrintWarning("%s: drawing saved, PDF not uploaded: %s\n" % (pn, e))
    return True


@method("drawing.generateForPart")
def generate_part_drawing(pn, commit=True):
    """Give a part that already has its own .FCStd (a designed part, or a
    purchased part modelled directly) a drawing from that file's geometry:
    the same GrainWave template, layout and untouched-fingerprint the
    purchased-part generator makes. A no-op for a file that already has a
    drawing, has no solid geometry, or doesn't exist yet."""
    cfg = _pn._load_config()
    rows = _pn._read_registry(cfg)
    row = _pn._row_for_pn(rows, pn) or _pn._current_row(rows, pn[:-1])
    if row is None:
        raise RpcError(APP_ERROR, "unknown PN: %s" % pn)
    repo = _pn._repo_path_for_type(cfg, row["project"], row["type"])
    fcstd_path, _rel = _pn._find_part_file(repo, "%s.FCStd" % pn, row.get("repo_relpath"))
    if fcstd_path is None:
        return {"pn": pn, "ok": True, "skipped": "no part file"}
    if _file_has_drawing(fcstd_path):
        return {"pn": pn, "ok": True, "skipped": "drawing already exists"}
    problem = _title_block_problem(pn, row)
    if problem:
        return {"pn": pn, "ok": False, "errors": [problem]}
    real = os.path.realpath(fcstd_path)
    if any(d.FileName and os.path.realpath(d.FileName) == real for d in App.listDocuments().values()):
        return {"pn": pn, "ok": True, "skipped": "open in the app - generates on its next promotion"}
    saved_pn = _session.part_number()
    doc = App.openDocument(fcstd_path)
    try:
        made = _draw_part_in_doc(doc, fcstd_path, pn, row)
    finally:
        App.closeDocument(doc.Name)
        _session.set_part_number(saved_pn)
    if not made:
        return {"pn": pn, "ok": True, "skipped": "no solid geometry"}
    if commit:
        _pn._sync_pull(repo)
        _pn._commit_and_push(repo, "%s: add auto-generated drawing" % pn, lambda: True,
                             paths=_pn._part_paths(fcstd_path))
    return {"pn": pn, "ok": True, "generated": True, "path": fcstd_path, "repo": repo}


def missing_drawing_candidates():
    """(pn, path) for every current-revision part (in work or active) whose
    .FCStd has no drawing, lightest file first. Screened from each file's
    Document.xml, so parts that already have a drawing cost next to
    nothing."""
    cfg = _pn._load_config()
    if not cfg.get("registryPath"):
        return []
    out = []
    for row in _pn._current_rows(_pn._read_registry(cfg)):
        if row.get("lifecycle") == "discontinued":
            continue
        try:
            repo = _pn._repo_path_for_type(cfg, row["project"], row["type"])
        except RpcError:
            continue
        path, _rel = _pn._find_part_file(repo, "%s.FCStd" % row["pn"], row.get("repo_relpath"))
        if path is not None and not _file_has_drawing(path):
            out.append((row["pn"], path))
    out.sort(key=lambda t: os.path.getsize(t[1]))
    return out


def generate_missing_drawings():
    """Draw every missing_drawing_candidates() part in this process, one
    after another (the background job runs them in parallel instead - see
    draw_missing.py)."""
    out = []
    for pn, _path in missing_drawing_candidates():
        try:
            out.append(generate_part_drawing(pn))
        except Exception as e:
            out.append({"pn": pn, "ok": False, "error": str(e)})
    return out


@method("supplierModels.syncAndGenerateAll")
def sync_and_generate_all():
    """Startup scan: organize every pending supplier model and draw every
    PN that now has a .stp but no drawing, then start a background job that
    gives every other part with geometry but no drawing one from its own
    file. That job runs in its own process (the engine thread stays free)
    and even when the supplier half can't (no Firebase key, offline)."""
    sync_results, drawing_results = [], []
    try:
        sync_results = sync_supplier_models()
    except RpcError as e:
        sync_results = [{"ok": False, "error": e.message}]
    organized_pns = [r["pn"] for r in sync_results if r.get("ok") and (r.get("path") or r.get("skipped") == "already organized")]
    for pn in organized_pns:
        try:
            drawing_results.append(generate_supplier_drawing(pn))
        except RpcError as e:
            drawing_results.append({"pn": pn, "ok": False, "error": e.message})
    return {"sync": sync_results, "drawings": drawing_results,
            "missingDrawingsJob": start_missing_drawings_job()}


def start_missing_drawings_job():
    """generate_missing_drawings in a detached freecadcmd, so the engine
    thread (and the app) never waits on it. Returns its pid, or None when
    it couldn't start. The job itself keeps a single instance running."""
    import subprocess
    exe = os.path.join(App.getHomePath(), "bin", "freecadcmd")
    if not os.path.isfile(exe):
        return None
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    env = dict(os.environ, GWTCAD_SIDECAR_DIR=here)
    env.pop("GWTCAD_PORT", None)
    log = open(os.path.join(os.path.dirname(_pn._CONFIG_PATH), "draw-missing.log"), "a")
    try:
        p = subprocess.Popen([exe, os.path.join(here, "gwtcad", "draw_missing.py")], env=env,
                             stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                             start_new_session=True)
    except OSError:
        return None
    finally:
        log.close()
    return p.pid
