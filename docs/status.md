# Status

Updated 2026-09-02. A Fusion-360-style front-end (Electron + React + three.js)
over a headless FreeCAD 1.1.1 kernel (Python sidecar, JSON-RPC 2.0). All roadmap
milestones M0-M5 have a working first version; ~85 sidecar RPC methods. Live
feedback is tracked in `docs/FEEDBACK.md`; per-change detail is in git history.
Verified each pass by headless engine tests (`scratch/*.py`) + a UI-driven E2E
suite (`bash test/e2e/run.sh`: `workflow.js`, `repro.js`, `editfeature.js`,
`monkey.js`, `fuzz.js`). `bash test/e2e/fuzz-loop.sh` runs a seeded random walk
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
  Reopen restores geometry + constraints.
- Features: Extrude, Revolve (each on a sketch OR a flat model face - revolve
  needs an axis pick), Loft, Sweep, Fillet, Chamfer, Shell, Hole
  (counterbore / countersink), Draft, Combine, Rectangular + Circular Pattern,
  Mirror, Rib (real or offset-wire fallback), Offset Plane / Axis / Point.
  All references come from viewport / browser selection - no geometry
  dropdowns.
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
