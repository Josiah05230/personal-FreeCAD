# Status

Updated 2026-08-29. Live-test feedback batches 1-15 all addressed. All roadmap milestones now have a
working first version. `docs/FEEDBACK.md` tracks the live-test checklist. Next queued epic: KiCad
interop (StepUp-style PCB <-> assembly, connector-driven joints).

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
  marker.
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
