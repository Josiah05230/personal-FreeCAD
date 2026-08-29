# Status

Updated 2026-08-29. Supersedes `status-M0.md`.

## Working end to end (verified headless + app boots clean)

### Shell / UX
- Electron + React + three.js over a headless FreeCAD 1.1 sidecar (JSON-RPC / loopback HTTP)
- Dark theme; app bar, ribbon (data-driven, per-group dropdown menus), doc tabs,
  status bar
- Data Panel (left banner) - browses directories, trimmed to folders that hold a
  `.FCStd` within 3 levels; pushes the ribbon + canvas right when open
- History (Git) panel (right) - branch, dirty state, per-file `git log --follow`
- Command palette on **s** - fuzzy search over every command; runs the wired
  ones, lists the rest. Hotkeys: e, f, Ctrl+S/O/N, F6, Esc
- View cube (top-right) - click a face to snap, drag to orbit
- Floating browser with per-row visibility eye + right-click menu
- Timeline - full-width, left-aligned; Play/Stop marches the rollback marker;
  drag scrubber; double-click = edit, right-click = Edit/Rename/Roll-here/Delete

### Modelling (real, in the PartDesign tree)
- Primitives: Box, Cylinder
- Extrude (demo pad for now - see gaps), Fillet, Chamfer, Shell, Hole,
  Rectangular Pattern, Mirror, Offset (datum) Plane
- Selection: click faces / edges in the viewport, hover highlight, multi-select
  with Shift/Ctrl; ops read the selection (fillet/chamfer on edges, shell/hole
  on faces)
- History rollback via `Body.Tip`; rename / delete features
- Vocabulary layer - the UI never shows "Pad"/"Pocket"; features are
  Extrude1 / Fillet1 / Sketch1...

### Files
- Save / Save As / Open `.FCStd` (real OS dialogs)
- Export STEP / STL; Import STEP / IGES / BREP

### Drawings (TechDraw, headless)
- `Drawing from Design` builds front / top / right / iso views
- Each view = hidden-line-removed projection, rendered as SVG (solid = visible,
  dashed = hidden); add more directions from the drawing bar

### Assemblies (built-in Assembly workbench, headless)
- Create assembly; insert saved `.FCStd` designs as components (`App::Link`)
- Position components; **ground** a component (real `GroundedJoint`)
- Add joints (Fixed / Revolute / Cylindrical / Slider / Ball) from a 2-face
  selection - see gaps

## Known gaps / honest limitations

- **Interactive 2D sketching is not built.** You cannot draw a profile on a
  face and extrude it yet. "Create Sketch" currently seeds a Box. The sidecar
  has `sketch.onPlane` / `sketch.addGeometry` primitives ready for the 2D editor.
- **Assembly joint solving is experimental headless.** Joints are created and
  round-trip in the `.FCStd`, but the MbD solver in FreeCAD's Assembly wb is
  coupled to a GUI edit session; headless it falls back to recording the joint
  without moving parts. Grounding and manual placement do work.
- Revolve / Sweep / Loft / Draft / Combine / Circular Pattern: ribbon entries
  exist, not wired.
- Drawings: no dimensions, annotations, title block, or BOM yet; view geometry
  only. No PDF/DXF export yet.
- Git panel is read-only (no commit / checkout / diff from the UI yet).
- No measure / section analysis. No appearance editing. No multi-body per doc
  in the browser tree beyond a flat list. Undo/redo buttons are stubs.
- Packaging (installer, bundled FreeCAD) not started.

## Roadmap position

M0 done. M1 (single-part modelling) ~60%: primitives + dress-up ops + selection
+ rollback done; interactive sketch + revolve/sweep/loft remain. M2 (assemblies)
scaffolded: structure + placement + grounding done, joint solve pending. M3
(sheet metal + surface split) not started. M4 (drawings) first version done
(views only). M5 (packaging) not started.
