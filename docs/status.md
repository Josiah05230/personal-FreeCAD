# Status

Updated 2026-08-29. Batches 1-8 of live-test feedback all addressed. All roadmap milestones now have a
working first version. `docs/FEEDBACK.md` tracks the live-test checklist.

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
- Window-select is a radio but still behaves as paint (no drag box yet).
- View cube hover highlight is faces only (no edge/corner sub-cubes).
- Drawings: dimension tool is linear only; no GD&T / section / detail views.
- Git panel is read-only (no commit / checkout / diff from the UI).
- Sheet metal, surface / body-split: not started (user: low priority).
- Sketch constraints are auto-only (no manual dimension/constraint entry yet).
- Packaged build not run end to end with a real bundled FreeCAD (needs the ~1GB
  copy; `scripts/package.sh` does it).
