# Status

Updated 2026-09-02. A Fusion-360-style front-end (Electron + React + three.js)
over a headless FreeCAD 1.1.1 kernel (Python sidecar, JSON-RPC 2.0). All roadmap
milestones M0-M5 have a working first version; ~85 sidecar RPC methods. Live
feedback is tracked in `docs/FEEDBACK.md`; per-change detail is in git history.
Verified each pass by headless engine tests (`scratch/*.py`) + a UI-driven E2E
suite (`bash test/e2e/run.sh`: `workflow.js`, `repro.js`, `editfeature.js`,
`monkey.js`, `fuzz.js`, `op_commit.js`, `part_asm.js`). `op_commit.js` opens
every operation dialog, makes a minimal valid selection, and asserts the OK
button actually enables (getState().opReady + the real DOM button) then that
apply keeps the engine healthy - the class of "preview renders but OK stays
greyed out" bug. `bash test/e2e/fuzz-loop.sh` runs a seeded random walk
over every action + ribbon command forever until an invariant breaks (engine
dead / error state / ErrorBoundary / stuck queue / blank viewport), printing
the seed + step + trace tail to replay.

## Working

### Shell / UX
- Dark theme, app bar, data-driven ribbon (pinnable groups, right-click Pin /
  Set hotkey), doc tabs, status bar, command palette on `s`.
- Data Panel (dir browser trimmed to `.FCStd` folders, rename / move / git /
  trash, thumbnails). Read-only Git (History) panel.
- Constrained turntable orbit (yaw about +Z, elevation clamped, no roll drift);
  pivot = geometry under the cursor. View cube (hover highlight, click-snap,
  Set as Front/Top/Right, 90deg roll arrows, Home).
- Floating browser with per-row visibility (incl. origin planes / axes / point).
- Timeline: full-width, draggable rollback marker, Play/Stop, "Move timeline
  here". Click a chip to SELECT (Shift range, Ctrl/Cmd toggle); Delete /
  Backspace / right-click removes or suppresses the group. Double-click opens
  the feature's real edit dialog. Clicking never rolls history.
- Serialised command queue for every model mutation (ordered, one at a time, a
  failed command is reported + resynced). ErrorBoundary + sidecar auto-respawn.
- Incremental scene reconcile: only the changed body / sketch / datum node is
  rebuilt, never the whole three.js scene.

### Modelling (real PartDesign, vocabulary-mapped - never shows "Pad")
- Interactive 2D sketcher: line / rect (corner + centre) / circle (+ 3-pt) /
  arc (centre + 3-pt) / spline, snapping, window-select, welded drags with a
  local relaxation solver, manual constraints + a Dimension tool (unit
  expressions), construction toggle, over-dimension veto, per-action undo.
  Reopen restores geometry + constraints. Individual geometry POINTS (line
  ends, circle / arc centres) are selectable: dimension centre-to-centre /
  centre-to-line, and Coincident / Horizontal / Vertical between two points.
- Features: Extrude (Join / Cut / Intersect / New body), Revolve (each on a
  sketch OR a flat model face; an Axis dropdown - sketch V/H, X/Y/Z, or a
  selected edge / datum), Loft, Sweep, Fillet, Chamfer, Shell, Hole
  (counterbore / countersink), Draft, Combine, Rectangular + Circular Pattern,
  Mirror (each with Type = Body / Features / Faces and Operation = Join / Cut /
  Intersect / New body), Rib (real or offset-wire fallback), Datum Plane /
  Axis / Point. All references come from viewport / browser / timeline
  selection - no geometry dropdowns.
- Extrude Cut auto-corrects its direction (flips Reversed if the first attempt
  removes nothing) and rejects a profile that never meets the solid.
- Mirror / Pattern transform the whole solid by default (every feature up to the
  tip), not just the last one; Type = Features acts on the timeline chip
  selection, Type = Faces on the features owning the selected faces; Operation
  re-expresses the copies as a Cut / Common / new body. Mirror / Linear /
  Polar pattern are editable features (reopen -> change plane/axis/count/scope).
- Datum Plane / Axis / Point: one reference model (plain click replaces the
  reference, Ctrl-click adds); the reference set picks the geometry type
  (1 face = on it + Offset; 1 edge = on the edge + Angle; 2 edges = through
  both; 2 faces = mid-plane; 3 points = through them; axis along an edge / face
  normal / two-point line / face intersection; point at a vertex / edge
  midpoint / edge intersection).
- Fillet / chamfer / shell / draft / hole: plain viewport click replaces the
  edge/face set, Ctrl / Shift / Cmd-click adds one; the preview updates in place
  (feature.previewSetBase) as the set changes instead of rebuilding.
- **Editable features**: double-click (or "Edit Feature…") reopens the op
  dialog pre-filled; values AND references editable, live-previewed against
  just that feature, applied in place. Timeline rolls to the feature while
  editing, home on Update.
- Live preview: in-place fast path (`feature.previewUpdate` ~10ms, one body
  re-meshed, debounce 130ms) for extrude / revolve / fillet / chamfer / shell /
  draft / hole; `feature.editPreview` for edits.
- A sketch is never "consumed": extrude / revolve the same sketch repeatedly;
  the internal copy is hidden and garbage-collected.
- Bad feature builds roll back surgically (`build.finalize_or_rollback`) - the
  new feature is removed and the tip restored, existing work untouched.
- History rollback (Body.Tip + marker), rename, delete, suppress.

### Inspect / files / drawings / assemblies
- Measure (length / area / perimeter / vertex / 2-entity distance + angle).
  Section (live three.js clipping, XY/XZ/YZ + offset + flip, hatched cut quad).
- Save / Open `.FCStd`; import STEP / IGES / BREP / STL / OBJ / 3MF / PLY / OFF;
  export via `io.export` (all the same formats). Companion `.gwtcad.json` holds
  params / canvases / colours / feature expressions / KiCad link.
- Drawings (headless TechDraw): projected hidden-line views as SVG, auto + click
  dimensions, title block, BOM, PDF + DXF export.
- Assemblies: create, insert `.FCStd` as `App::Link`, position, ground, add
  joints from a 2-face pick (solving is experimental headless).
- Parameters panel + unit-aware expression evaluator (`expr.py`); a feature dim
  typed "OD*2 + 3mm" persists and re-drives when a param changes.
- KiCad: headless `.kicad_pcb` import (board solid + labelled placeholders),
  `kicad.import` / `reimport` / `status`.
- Packaging: electron-builder AppImage + NSIS, FreeCAD bundled
  (`scripts/package.sh`); `--dir` build verified.

## Recent notable changes

- **Fusion-parity pass 4**: Split Body now accepts a face or a sketch as the
  tool, not just a plane. Found a real bug while wiring it: a face on a body
  that had been moved via Move/Copy resolved its PRE-move position, because
  `PartDesign::Body.Tip.Shape` (what refs resolve through) does not include
  the body's own Placement - only `Body.Shape` does. Fixed in `body_split` by
  composing the owning body's Placement back onto the resolved face.
- **Fusion-parity pass 3**: Sweep is now a real dialog (Operation, Orientation,
  Transition), Loft gained Operation + Ruled/Closed. Fixed a real crash in the
  shared cut/intersect/newbody tail (`_finish_transform`) that read a deleted
  FreeCAD object's TypeId - affected Mirror/Pattern/Revolve too, just harder to
  trigger there.
- **Fusion-parity pass 2**: hotkeys reset to F360's actual documented defaults
  (E extrude, F fillet, Q press pull, H hole, M move, J joint, I measure - was
  wrongly bound to M); Extrude Two Sides (independent per-side distances) and
  an "All" (through everything) extent; primitive Box/Cylinder/Sphere/Torus
  honour a picked placement plane/face. `docs/fusion-parity.md` tracks what is
  left (Sweep/Loft dialogs, parametric Scale/Split Face, Move/Copy of
  faces/features, ...).
- **Fusion-parity pass 1** (`docs/fusion-parity.md` tracks the full gap list).
  New SOLID commands: Move/Copy (Translate / Rotate / Point-to-Point +
  Create Copy, replaces the old Move + Copy Body), Scale (uniform / per-axis),
  Align, Press Pull (Q), Offset Face, Split Face, and the primitives Box /
  Cylinder / Sphere / Torus / Coil / Pipe (dialog + Operation New body / Join /
  Cut / Intersect). Revolve gained the Operation set + a Full toggle; Chamfer
  gained Equal / Two-distance / Distance-and-angle modes. Inspect gained
  Interference and Center of Mass. A new **MESH tab**: BRep to Mesh, Reduce,
  Smooth, Plane Cut, Reverse Normals, Repair, Separate, Convert Mesh. Sidecar
  code in new modules `primitives.py` / `xform.py` / `meshtools.py`; driven E2E
  by `test/e2e/scenarios/fusion_features.js` (61 checks).
- A negative value in a directional field (extrude Distance, revolve Angle,
  datum-plane Offset) folds to its magnitude + the Flip toggle. Enter commits a
  ready op dialog; Esc cancels it from anywhere in the dialog.
- Fillet / Chamfer accept a picked face (round/chamfer all of its edges).
- Revolve would not let you press OK with a flat model face as the profile
  (only a sketch cleared the dialog's `ready` gate), even though the live
  preview rendered. Revolve now accepts a sketch OR a single flat face, like
  extrude. New `op_commit.js` E2E asserts the OK gate for every op so this
  class of bug cannot recur silently; the dialog reports `opReady` through the
  test bridge.
- Sketch geometry points are first-class: `SketchController.pickPoint` /
  `selectedPts`, point handles, point-to-point + point-to-line Distance, and
  Coincident / H / V between two points. Sidecar `_apply_sketch_constraints`
  + `_reopen_constraints` carry the PosIds through finish + reopen.
- Mirror / Pattern gained an Operation (Join / Cut / Intersect / New body,
  `_apply_result_boolean` - the transform's net shape re-expressed as a
  Boolean or a new body) and are now editable features (`_TYPE_KIND` +
  `feature_get` / `_set_feature_*` for Mirrored / LinearPattern / PolarPattern).
- Datum Plane / Axis / Point reworked: one reference model (click replaces,
  Ctrl-click adds), `_attach_datum` picks the FreeCAD Attacher MapMode from the
  reference set (mid-plane / edge-intersection points computed manually where
  the Attacher mode is missing in this build).
- E2E: `test/e2e/scenarios/part_asm.js` drives a real multi-feature part AND a
  two-component assembly + joint through the `window.__gwtcad` bridge
  (`selectFeatures`, `addComponentFile` added).
- Mirror / Pattern were transforming only the tip feature (Originals=[tip]) - the
  '46mm vs 30mm' mirror. Now Originals is the whole solid-feature chain, with a
  Body / Features / Faces scope (`_transform_originals`, Timeline
  `onSelectFeatures`).
- Revolving a model face silently no-op'd ('The graph must be a DAG.') because
  the axis ref resolved through `body.Tip` after it had advanced to the
  half-built Revolution. Refs for revolve / mirror / pattern are now resolved
  before `body.newObject`, and `finalize_or_rollback(check_made=True)` fails a
  feature that produced no shape.
- Extrude gained Intersect (scratch body + PartDesign::Boolean Common, filtered
  from the tree via `_boolean_consumed_bodies`); Cut flips direction if it
  removes nothing and errors if the profile never meets the solid.
- Dress-up preview updates its Base in place (`feature.previewSetBase`) instead
  of drain + rebuild; the dialog live-preview effect de-dupes identical fires
  (extrude Blind-mode flicker).
- Sidecar HTTP server is threaded with one dedicated engine worker - overlapping
  requests no longer stall seconds behind an idle keep-alive socket (boot scene
  refresh ~8s -> ~0.15s).
- Timestamped trace (`app/src/renderer/trace.ts` + `registry._trace`): every
  action / command-queue transition / RPC (both sides, paired, with ms) to
  `/tmp/gwtcad-run.log`. On by default; `gwtcad.trace=0` / `GWTCAD_TRACE=0`.
- Editable features (`feature.get` / `feature.update` / `feature.editPreview`).
- Revolve on a model face; fillet / extrude honour the whole selected ref set;
  invisible + GC'd sketch reuse copies; feature dialogs narrow viewport picking
  to the kinds the op consumes; a miss-click no longer wipes an open dialog's
  profile; Finish no longer deletes the feature it just committed.
- Fixes to the "extrude does nothing" / crash-on-bad-sketch class:
  `_strip_redundant_constraints`, null-shape guards, surgical invalid-feature
  removal, `build._set_profile` refusing a `(None, ...)` profile.

## Known gaps / next

- Multi-face press-pull; a client-side predictive mesh if preview still is not
  instant enough.
- Full edit dialogs for patterns / mirror / datums (they fall back to the
  one-number "Edit Value…" prompt).
- Assembly joint SOLVING (MbD solver is GUI-coupled headless).
- Drawings: linear dims only, no GD&T / section / detail views. Hidden/dashed
  lines (TechDraw headless returns none).
- Sheet metal beyond Base Flange; surface bodies / Thicken.
- `PartDesign::Rib` absent from the bundled build (fallback in use).
- Git panel write ops; embedded colours on STEP / 3MF import.
- Packaged build not run end to end with the real ~1GB bundled FreeCAD.
