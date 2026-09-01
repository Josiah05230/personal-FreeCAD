# Status

Updated 2026-08-31. Live-test feedback batches 1-30 addressed (open partials: full parametric
sketch tools, section analysis tab, optimistic datum row). All 16 feature-op RPCs smoke-tested
end-to-end headless. All roadmap milestones have a
working first version. `docs/FEEDBACK.md` tracks the live-test checklist. KiCad interop has a first
slice (board import + placeholders); next: component STEP models + connector->joint mapping.

## Working (verified: headless engine tests + app boots clean each pass)

### Shell / UX
- Electron + React + three.js over a headless FreeCAD 1.1 sidecar (JSON-RPC).
  ~48 RPC methods.
- Dark theme. App bar, data-driven ribbon (per-group dropdown menus), doc tabs,
  status bar, command palette on `s` (fuzzy, runs wired commands).
- Data Panel (left banner, dir browser trimmed to folders with `.FCStd`, push
  layout). History (Git) panel (branch, dirty, per-file `git log --follow`).
- View cube: 150px, hover-highlights the face, click to snap, right-click Set as
  Front/Top/Right, Home button. Free orbit (no pole lock).
- Floating browser: eyes on every row incl. origin point/axes/planes and
  construction datums; group rows toggle all children.
- Timeline: full-width, draggable rollback marker between chips, Play/Stop,
  double-click edit, right-click "Move timeline here". Model rebuilds to the
  marker. Click a chip to SELECT it (Shift = range, Ctrl/Cmd = toggle);
  Delete/Backspace or right-click removes / suppresses the selected group.
  Clicking a chip no longer rolls history.
- Live feature preview: first change builds the feature, then each keystroke
  takes an in-place fast path (feature.previewUpdate: ~8ms, one body re-meshed,
  no undo, no scene refresh) for extrude/revolve/fillet/chamfer/shell/draft/hole.
- Ribbon "Select" dropdown: paint/window radios + entity-kind checkboxes; gates
  picking.

### Modelling (real PartDesign)
- Interactive sketcher: line / rect / circle / arc on a plane or face, grid +
  endpoint + origin snapping, rubber-band, chained lines, undo; Finish adds
  coincident + H/V constraints -> real Sketcher sketch, auto-selected.
- Extrude, Revolve (both on a sketch), Loft (2+ sketches), Sweep (profile+path),
  Box, Cylinder, Fillet, Chamfer, Shell, Hole, Draft, Combine, Rectangular +
  Circular Pattern, Mirror, Offset (datum) Plane.
- Viewport picking (faces via faceGroups, per-edge lines, sketches, datums),
  hover highlight, Shift/Ctrl multi-select; ops read the selection.
- History rollback (Body.Tip), rename / delete. Vocabulary layer: never shows
  "Pad" etc.

### Inspect
- Measure: edge length, face area + perimeter, vertex coords, 2-entity min
  distance + angle. Live readout.
- Section: real-time three.js clipping plane (XY/XZ/YZ + offset + flip).

### Files
- Save / Save As / Open `.FCStd`; Export STEP / STL; Import STEP / IGES / BREP.

### Drawings (headless TechDraw)
- front / top / right / iso ... projected views (hidden-line removed) as SVG.
- Auto overall width/height dims; click-two-points Dimension tool; title block;
  BOM table (from assembly components); Export PDF (printToPDF) + DXF (R12).

### Assemblies (built-in Assembly wb, headless)
- Create assembly, insert saved `.FCStd` as `App::Link` components, position,
  ground (real GroundedJoint), add joints (Fixed/Revolute/Cylindrical/Slider/
  Ball) from a 2-face pick.

### Packaging
- electron-builder: AppImage + NSIS, FreeCAD bundled as extraResources, runtime
  path resolution, `scripts/package.sh`. `--dir` build verified.

## Batch 29 additions

- The "not a closed loop" extrude error was Batch 28's own pre-check being too
  strict. Replaced with `_strip_redundant_constraints(sk, d)` - iterates delete
  + re-solve over FreeCAD's Redundant / PartiallyRedundant list (removing one
  exposes the next), up to 8 passes; conflicting left alone. `sketch.finish`
  and `feature.extrude` both call it; the hard reject is gone.
- `_auto_constrain` H/V dedup keys off `FirstPos == 0` (line-level) instead of
  a fragile Second check, so it stops re-adding H/V the editor already sent.
- Verified: rect@origin, center rect, dimension-opposite-sides all extrude
  clean (scratch/b29_redund.py).

## Batch 28 additions

- Extrude crash fixed: dimensioning opposite sides of a rect -> redundant
  constraint -> sketch has 0 closed wires -> `build.pad` NULL shape ->
  `feature.extrude` raised on `.Shape.isValid()` and left a broken model.
  `sketch.finish` now `delConstraint`s the reported Redundant / PartiallyRedundant
  and re-solves (returns `droppedRedundant`); `feature.extrude` pre-checks the
  profile wire, null-guards the shape check, removes an invalid pad.
- `SketchController.setDimension` and `onUp` call `runSolve()` immediately (was
  240 ms `scheduleSolve` only) - dimensioned geometry snaps exact and the
  over-dimension veto fires at once.
- Live preview (`App.previewCall`) parses each field via `num()` (finite,
  non-zero) so an expression / partial value cannot send NaN; `runLivePreview`
  puts the engine error in `sketchNotice` instead of a silent retry loop.
- `applyDrag`: grabbing a fully-sized rectangle edge ('whole') translates all 4
  loop lines rigidly instead of stretching against a pinned far edge.

## Batch 27 additions

- Delete a sketch dimension: click the value label (amber highlight) + Delete.
  `SketchController.selectedDim` / `deleteDimension`; reopen-era dims are queued
  in `removedBaseConstraints` and sent to `sketch.finish(removedConstraints=)`
  which `_remove_matching_constraints` deletes from the real sketch (rebuilds the
  reopen entity-index -> geoId map to match).
- Over-dimension detection made reliable: `_apply_sketch_constraints` returns a
  per-client-constraint `applied` list (1-based sketch index or None-if-rejected);
  `sketch.solve` maps ConflictingConstraints / RedundantConstraints through it and
  also flags any client constraint FreeCAD rejected. Fixes the pre-prompt
  `dimensionPrecheck` and the `runSolve` veto silently no-op'ing.
- `onDown` refuses to start a drag on an entity in `constrainedSet` or when
  `sketchFullyConstrained` (from `res.fullyConstrained`).
- Blank-viewport guards: `buildScene` skips meshes / sketch polys with non-finite
  vertices, clamps NaN centre/radius, is wrapped in try/catch in Viewport;
  `CadControls.frame` refuses a NaN / degenerate frame.

## Batch 26 additions

- Timeline scrubber position reads body.marker (the rolled-to feature), not
  body.Tip which never moves on rollback - step forward/back and marker
  tracking now work. Chips grey out via the afterTip flag.
- Datum ghost is held from Apply until the real datum lands (feels instant).
- Tip-position edits quietly pre-cache the previous 1-2 build stages.
- Timeline marker grip: z-index + fat invisible hit area.
- ASSEMBLE ribbon buttons (Insert Component / Joint) wired (were dead).
- Import / Export command + menu titles no longer name a file type.
- Smoke test (scratch/b26_allops.py): fillet, chamfer, hole, shell, draft,
  pattern.linear, pattern.circular, mirror, datum plane/axis/point, measure
  (edge + distance), move, scale, export - all OK end-to-end.

## Batch 24 additions

- Model corners: the vertex point object is invisible (raycast target only);
  a small sphere marks a corner only when the cursor is within ~12 px of it
  (Picker.nearOnScreen), blue on hover / orange on select. No permanent dots.
- Measure: click adds a probe (face / edge / vertex), rolls at two, no shift /
  no coplanar lock; panel shows the count and a Reset button.
- 3-point circle / arc add PointOnObject to any drawn point that snapped onto
  existing geometry; center rectangle adds its two construction diagonals.
- Section: a hatched quad is drawn in the cut plane (hatchTexture, sized to the
  model bbox) so the section reads as a cut face.
- Coplanar-face lock is now extrude-only (opRef); Shell / Draft can select
  faces on multiple planes again. Shell + Mirror verified working headless.
- Mirror / Shell / Hole dialogs gained hints describing what to select.
- Export: all of io.export's formats verified headless including 3MF.

Partials still open: fully-parametric sketch tools (need a point entity),
live feature preview (needs preview/commit/rollback around op RPCs), section
"OK -> Analysis tab" (persisted section feature).

## Batch 23 additions

- Drag honours constraints directionally: a fully-solved entity does not drag
  (hint bar explains); dragging a corner of a dimensioned rectangle keeps the
  dimensioned side rigid instead of shearing. `clampDragTarget` drops the
  locked component(s) of the drag target.
- SKETCH ribbon fold-outs open (were absolute-positioned and clipped by the
  ribbon body overflow; now fixed-positioned like every other ribbon group).
- Dimension value labels are draggable - grab the bubble, the witness / leader
  lines re-route. Offset is client-side only for now (resets on reopen).
- Extrude visibility fixes: the viewport re-frames the first time a solid
  appears; sketch geometry contributes to the scene bounding box so Fit lands
  on a sketch-only scene; finishing a sketch refreshes meshes. The browser
  only lists a Body once it has a real solid feature (a lone sketch / datum in
  the starter body no longer surfaces one).
- File menu: "Import..." / "Export...". Export offers STEP / IGES / BREP / STL
  / OBJ / 3MF / PLY / OFF through the engine's generic io.export.
- Offset-Plane arrow highlights on hover and takes hover priority over planes
  behind it.
- Datum ops renamed Plane / Axis / Point. Construction browser group has a
  visibility toggle. Delete is fully optimistic (tree + viewport + selection).
  Operation dialogs close the instant you apply.

## Batch 22 additions

- View-cube labels are opaque, per-face-oriented decals (the transparent quads
  did not render). All six read relative to FRONT.
- Sketch enter snapshots the camera and restores it on exit, so finishing /
  cancelling a sketch no longer leaves you staring at the empty plane.
- undo/redo re-shows any sketch a now-undone feature had consumed
  (_reshow_loose_sketches) and clears the client's manual hide state.
- Multi-face selection locks to the first face's plane (Picker returns the
  face normal); clear the selection to pick on a different plane.
- SKETCH ribbon groups are pinnable fold-outs like the rest of the ribbon.
- New sketch tools: Center Rectangle, 3-Point Circle, 3-Point Arc, Spline
  (new BSpline entity; interpolated on the sidecar; round-trips on reopen).

## Batch 21 additions

- Sketch Ctrl+Z reverts one whole action (a rectangle = 4 lines + constraints
  = one step); full pre-action snapshots. Drag, dimension, constraint, delete
  are each one step.
- An over-dimension is caught before the value prompt: the dimension request
  trial-solves first and shows the notice if the geometry is already defined.
- Boot scrim stays up until the first scene + tree load, so the app never looks
  ready while still populating.
- Delete Feature / cancel-new-sketch are optimistic - the tree updates now,
  the engine rebuild runs behind the status spinner.
- View-cube labels are oriented quads (not box UVs): every face reads relative
  to FRONT.
- Extrude no longer assumes "the only sketch"; sketch fill hardened against
  NaN geometry that could blank the viewport.

## Batches 19-20 additions

- Extrude: falls back to the sole sketch when none is selected ("finish the
  sketch, hit Extrude" works); dialog shows "using the only sketch". Sketch
  fill chains separate edge segments into closed loops, so a rectangle drawn as
  four lines gets one filled, pickable, hover-highlighted face.
- Rectangle drag pins the far side (opposite edge for an edge drag, opposite
  corner for a corner drag) so it resizes cleanly instead of shearing.
- Constraint glyphs restored and placed where they act: Coincident /
  PointOnObject small and exactly on the point; Symmetric at the symmetry
  line's midpoint; line relations still beside the edge.
- Reopen a sketch and its constraints + dimensions come back (`sketch.reopen`
  serializes them; only session-added constraints are re-sent on Finish).
- Cancelling a re-opened sketch leaves it exactly as it was (edits never left
  the editor); only a brand-new sketch is discarded.
- Sketch-plane picker shows the real origin / construction planes for the
  duration, highlights the one under the cursor, and restores visibility after
  - no more ghost planes.
- The scratch solver now sees the whole sketch with absolute-index refs, so DoF
  colouring and the over-constraint veto work on reopened sketches too.

## Batch 18 additions

- Over-dimensioning is blocked. `sketch.solve` also returns conflicting /
  redundant / partially-redundant / malformed constraint indices (0-based, only
  when every passed constraint maps 1:1). The editor tracks the last
  user-added constraint; if the solver flags it, it is removed again and an
  orange notice bar explains why. Covers dimensions and manual constraints.
- Dragging a rectangle side stays rectangular: the local relaxation anchors
  each coincident weld to the directly-dragged point first, then to axis
  anchors, so edges no longer skew mid-drag and snap back.
- Coincident / PointOnObject / Symmetric constraints no longer draw a glyph -
  the join is already visible, and dotting every corner was clutter.
- Snapping a draw point to a line's midpoint records a real Midpoint
  (Sketcher Symmetric about the line's endpoints); the relaxation keeps it
  centred through drags.
- A finished sketch's fill + outline highlight on hover / selection, making the
  filled face an obvious Extrude / Revolve target.

## Batch 17 additions

- Sketcher selection + editing: window (box) select inside the 2D sketch
  (left-to-right = fully contained, right-to-left = crossing); Delete /
  Backspace removes selected sketch geometry and reindexes constraints.
- Welded drags: dragging a rectangle side keeps the corners coincident and
  resizes it. A local Gauss-Seidel relaxation honours coincident welds,
  horizontal / vertical, length dimensions and axis anchors while dragging;
  the headless solver still runs the exact solve afterwards.
- Drawing a point onto another entity's point auto-records a Coincident.
- New headless `sketch.solve` (throwaway document) returns solved coordinates
  plus which elements still have free DoF - fully-constrained geometry is drawn
  grey and the editor reconciles to the solved shape.
- Constraint ribbon buttons are click-first when the selection does not already
  support them: click the constraint, then click the geometry.
- Midpoint constraint (Symmetric about a line's two endpoints) and a midpoint
  snap while drawing.
- Extrude: an Operation select (New body / Join / Cut) replaces the lone Cut
  checkbox; an Extent select (Blind / To object) with an Offset field for the
  extra distance past the target face. `feature.extrude` takes `operation` +
  `offset`; New body pads a copy of the sketch into a fresh Body.
- Operation dialog no longer overflows the window (wider, box-sizing, wrapping
  fields, long selects stacked label-over-control).
- Rename is instant: the tree updates in place and persists on the quiet path;
  `feature.rename` no longer recomputes.
- ~83 sidecar RPC methods.

## Batch 16 additions

- Orbit / pan pivot around the geometry under the cursor (raycast on press),
  model centre over empty space. This fixed "orbit feels wrong".
- Sketch: the rectangle tool commits four constrained lines (not one opaque
  rect); dimensions are only shown once assigned; a dimensioned entity locks
  (drag slides, does not resize); placing / dragging a point onto the origin
  or an axis auto-records the constraint; closed profiles get a light-blue
  fill and are pickable; constraint symbols are outlined ribbon glyphs with
  no box, and hovering one lights only its partner symbols + the edges they
  constrain.
- Hidden objects are no longer hover / click / window selectable (three's
  raycaster ignores .visible; Picker now walks the parent chain).
- Datum-plane hover overlay lights the outline + face (a LineLoop was being
  cloned as a Line, drawing an open "C").
- View cube: 90-degree screen-roll arrows (persistent rollAngle, reset by Fit
  and named views).
- Section plane gets the Offset Plane's draggable ghost + arrow handle; the
  Offset Plane handle was rebuilt (camera-sized arrow, the whole plane is
  grabbable).
- Calibrate Canvas is no longer a ribbon tool - inserting a canvas enters
  calibrate, and canvases have a browser row with Calibrate / Delete. Canvas
  icon is a camera.
- SURFACE tab: Ruled Surface, Boundary Fill, Stitch, Offset Surface (real
  Part / Surface ops); Split Body moved to the SOLID tab.
- KiCad: headless .kicad_pcb import (gwtcad/kicad.py) - Edge.Cuts -> board
  solid, footprints -> labelled placeholders; kicad.import / reimport /
  status; link persists in the doc sidecar json.
- ~82 sidecar RPC methods.

## Batches 14-15 additions

- Undo / redo: every mutating RPC runs in an App::Document transaction
  (registry wraps dispatch); Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y, AppBar buttons,
  clear-redo-on-edit. history.undo/redo clear the tessellation cache.
- Assembly grounded flag always set on the link; drawing view direction
  normalised (case / aliases) so Front/Top/Right/Iso actually differ.
- Fresh doc: the empty starter Body is not shown until it has geometry;
  blocking boot scrim while the engine starts; origin-plane sketch entry is
  instant (known frame up front, sketch object created in the background).
- Camera: constrained turntable orbit (yaw about +Z, elevation clamped clear
  of the poles, up pinned to +Z) - no roll drift or pole spazz; right-drag
  also orbits.
- Sketch: origin marker + in-plane axes on entry; adaptive 1/2/5 x 10^n grid;
  real linear dimensions (witness lines + arrowheads) on every entity plus a
  live readout; hover pre-highlight + colour-coded snap marker; axis/origin
  snapping records PointOnObject / Coincident-to-root; rectangles arrive
  fully constrained (corner coincidents + H/V), _auto_constrain de-dupes;
  constraint symbols with partner highlighting; double-click a dimension to
  edit; free-drag under-constrained geometry (re-solves on Finish).
- Main-view hover pre-highlight for faces / edges / vertices / datums
  (recursive pick + walk-up), filter-aware.
- Ribbon: ASSEMBLE tab hidden with < 2 bodies; Inspect + all of TOOLS pinned
  by default; Insert group moved onto SOLID (INSERT tab removed); Select
  group face = Paint/Window, kind checkboxes in the group fold-out.
- Offset Plane: Distance / To-object modes (auto-switch when a 2nd object is
  picked), datum.plane targetRef, live ghost-plane preview (datum.planePreview)
  with a draggable handle that drives the offset.
- ~75 sidecar RPC methods.

## Batches 9-13 additions

- Contextual SKETCH ribbon tab (no floating palette); enters on sketch, leaves
  back to the previous tab.
- Sketch-on-face reference geometry: the support face's edges + vertices are
  projected into the sketch plane and used as snap targets (points, on-edge).
- Manual sketch constraints (H/V/parallel/perp/equal/tangent/coincident/
  concentric) + a Dimension tool (line length / circle radius, number or unit
  expression) with on-canvas labels. Construction toggle (button + `x`).
- sketch.finish is one round trip (geometry + constraints + recompute); finishing
  clears the rollback marker so a fresh sketch is never "before" the timeline.
- Client-side visibility toggles (optimistic, no full refetch). Scrubber caches
  scene+tree per rollback position; timeline drag rAF-throttled.
- In-app PromptDialog (Electron has no window.prompt). Scale absorbs Convert
  Units. View cube "Set as Front/Top/Right" reorients a frame quaternion.
- Select group inline in the ribbon (kind toggles + paint/window), no dropdown.
- Data panel: resize handle, double-click open, right-click (rename / move / git
  history / delete-to-trash), thumbnails from a window screenshot on save.
- Open resets the sidecar doc into a fresh tab; boot no longer makes a demo body.
- Parameters panel + unit-aware expression evaluator (expr.py): dimension inputs
  in feature dialogs accept "15in + 2.4mm", "bore/2", sqrt()/sin()..., with a
  live "= value" preview. params persist in the doc sidecar json.
- No Box / Cylinder primitives. Revolve axis, Rectangular Pattern direction,
  Draft neutral plane, Sweep path (edge), Construction Axis / Point - all from
  selection, no geometry dropdowns.
- Real PartDesign::Hole with counterbore / countersink. Move / Rotate Body
  (body.transform). Suppress vs Delete (feature.suppress) with struck-through
  timeline chips.
- Vertex selection (pickable per-body points); Construction Point attaches to a
  picked vertex / edge / face centre. Rib (real PartDesign::Rib or an offset-
  wire + symmetric-pad fallback). Copy Body (independent duplicate). Combine
  "keep tool bodies".
- Canvas drag-a-line calibration (INSERT > Calibrate Canvas).
- Always-present origin (starter empty Body); sidecar tessellation cache
  (unchanged bodies skip OCCT meshing); visibility is pure client view state
  (viewport flips .visible, no rebuild); rebuild-content guarded by a data sig.
- Persisted expression dimensions: a feature dim typed as "OD*2 + 3mm" is stored
  (session + .gwtcad.json), shown again on "Edit Value...", and re-driven when a
  parameter changes (params.set re-evaluates all feature exprs).
- Customisable ribbon: slim pinned default set, right-click Pin/Unpin + Set
  hotkey on any command, data-driven hotkey dispatch (localStorage-backed).
- ~72 sidecar RPC methods.

## Batches 7-8 additions

- Import/export STEP/IGES/BREP + STL/OBJ/3MF/PLY/OFF, multi-body -> separate
  objects, palette colours
- In-viewport sketch-plane picking (ghost planes, no popup); Edit Sketch reopens
  with geometry
- Scale + Convert Units; Split Body (plane cut); Base Flange (SheetMetal addon
  or pad fallback)
- Model-tree rows selectable; Mirror / Offset Plane / Circular Pattern / Combine
  driven by selection, no dropdowns
- Timeline: features insert at the marker; rolled-back features fully suppressed
- View cube 26 pick zones; window (box) select; busy spinner
- Drawings rebuilt: blank ISO-A3 sheet, Add-View + drag, Auto-layout button
- Canvas insert persists via a companion .gwtcad.json
- Data Panel New Design / New Folder
- ~59 sidecar RPC methods

## Known gaps / next

- Assembly joint SOLVING is experimental headless (joints are recorded and
  round-trip; the MbD solver is GUI-coupled, so parts don't move yet).
- Drawings: dimension tool is linear only; no GD&T / section / detail views.
- Git panel is read-only (no commit / checkout / diff from the UI).
- Sheet metal beyond Base Flange; surface modelling / Thicken (no surface bodies
  in this shell yet).
- PartDesign::Rib is absent from the bundled FreeCAD 1.1.1, so Rib runs on an
  offset-wire + symmetric-pad fallback.
- Packaged build not run end to end with a real bundled FreeCAD (needs the ~1GB
  copy; `scripts/package.sh` does it).
