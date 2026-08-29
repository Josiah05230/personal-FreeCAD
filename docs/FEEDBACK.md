# Feedback tracker

Running checklist of user feedback from live testing. `[x]` done, `[~]` partial,
`[ ]` open. Newest batches at the bottom.

## Batch 2 - after run

- [~] Wire the actual tools (box/cyl/fillet/chamfer/shell/hole/pattern/mirror/
      plane done; revolve/loft/draft/combine/circular done; sweep needs 2 sketches)
- [~] Save / Save As / export / import (save/open/STEP/STL/import wired; no PDF/DXF)

## Batch 3 - build everything

- [~] Sheet metal: Base Flange (SheetMetal addon or pad fallback). Richer
      flange/unfold features deferred (low priority)

## Batch 4 - timeline / origin / visibility

- [x] Scrubber should be a draggable marker (vertical line + grab handle
      between features), not a scrollbar
- [x] Model must reflect the rolled-back state
- [x] Right-click "Move timeline here"
- [x] Multiple bodies from "sketch + extrude" was confusing -> real sketcher
      means Extrude adds to the sketch's body; primitives still make new bodies
- [x] Hidden bodies looked "permanently gone" -> tree still lists them, eye
      toggles them back; group toggles added
- [x] Origin needs the origin point + 3 axes (not just planes)
- [x] Control visibility of sketches + planes (origin + construction datums)
- [x] Group visibility (all bodies / all origin / all sketches)

## Batch 5 - offset plane / dropdowns / selection filter

- [x] Offset plane "did nothing" -> new datums now auto-show
- [x] Offset Plane now consumes a plane/face selection (needs 'plane'); the
      old dropdown is gone
- [x] Create/Modify dropdowns did nothing -> fixed (were clipped by overflow)
- [x] Selection filter tool (paint / window / face / edge / point ...)
- [x] Move selection filter into the ribbon as a dropdown with checkboxes;
      paint vs window select mutually exclusive (radios)

## Batch 6 - view cube / selection filter placement

- [x] View cube still too small (now 150px, reads mount size)
- [x] View cube needs a Home button
- [x] View cube hover highlight (faces; edges/corners still TODO)
- [x] View cube right-click a face -> Set as Front / Top / Right, cube follows
- [x] Orbit locks past 90deg -> now free orbit (yaw stays level, pitch tumbles
      over the poles without clamping)
- [x] Selection filter -> ribbon dropdown w/ checkboxes; paint vs window radios
- [x] Window select: drag a rubber-band box; faces whose centroid is inside get
      added to the selection
- [x] View cube: 26 pick zones (6 faces + 12 edges + 8 corners), hover-highlit,
      click any to snap

## Batch 7 - formats / insert / data panel / select group / view cube / scale / sketch planes

- [x] Import/export: STEP/IGES/BREP + STL/OBJ/3MF/PLY/OFF; multi-body files land
      as separate objects, each a distinct palette colour. (File-embedded colours
      still not read - limited headless.)
- [~] Insert canvas: image on a plane via the INSERT tab, calibrate by ratio,
      and it now persists (companion `<file>.gwtcad.json`). In-viewport
      drag-a-line-to-calibrate and PDF pages are still TODO.
- [x] Data Panel: New Design / New Folder buttons at any level
- [x] Selection filter is now a "Select" group on the SOLID tab
- [x] View cube: selectable edges + corners (26-zone cube)
- [x] Modify > Scale (factor) + Convert Units (mm/cm/m/in/ft/thou)
- [x] Create Sketch: click an origin/construction plane or a face in the
      viewport (ghost planes, no popup); visibility not auto-toggled

## Batch 8 - progress UI / timeline insert / tool selection / drawings

- [x] Busy spinner + "Working..." in the status bar during any RPC call
- [x] New feature inserts at the rollback marker; the marker follows the tip
      forward so the scrubber lands just after what you made
- [x] Right-click a sketch -> "Edit Sketch" (reopens with its geometry); the
      context menu is clamped to the viewport (no more overflow scrollbars)
- [x] Rolled-back features are suppressed: not rendered, greyed + non-toggleable
      in the tree
- [x] Tool selection reworked: model-tree rows selectable; Mirror / Offset Plane
      / Circular Pattern take a plane/axis from the selection (tree plane or flat
      face), no dropdowns; Combine takes selected bodies; sidecar resolves
      origin/construction/face/edge refs
- [x] Can Claude drive the UI live? No - no display capture/input in this env
- [x] Inspect (Measure/Section) moved to a group on the SOLID tab
- [x] Drawings rebuilt: opens a blank ISO-A3 sheet (border + title block); Add
      View one at a time + drag to place; Auto-layout is an explicit button

## Batch 9 - sketch UX / responsiveness

- [ ] No separate sketch popup: sketch tools live in a contextual SKETCH ribbon
      tab that only shows in sketch mode (auto-selected on enter)
- [ ] Sketch on a face is at the face, with the face's edges + vertices as
      reference geometry you can snap to (centre on a point, land on an edge)
- [ ] Manual constraints in the sketch tab: H / V / parallel / perpendicular /
      equal / coincident / tangent / concentric
- [ ] Canvas drag-a-line calibration (draw over a known length, type the real mm)
- [ ] Finish Sketch was slow -> single round trip (geometry + constraints +
      recompute in one call)
- [ ] Finishing a sketch must never leave it visible-but-"before the timeline";
      finish resumes the build (marker clears)
- [ ] Way more responsive: visibility toggles are client-side first, no full
      scene refetch on every eye-click

## Batch 10 - scale / prompts / view cube / select / data panel / construction

- [ ] Convert Units folds into Scale as unit presets (not its own tool)
- [ ] Scale threw "prompt() is not supported" -> in-app dialog, no window.prompt
- [ ] Right-click face > Set as Front/Top/Right must actually reorient the cube
- [ ] Select tools regressed in the ribbon; restore the earlier richer set +
      interactions, keep the ribbon placement
- [ ] Drag to resize the left data (waffle) panel
- [ ] Double-click to open a part from the data panel
- [ ] Data-panel right-click: delete / rename / git history / move to folder,
      for files and folders
- [ ] Data-panel thumbnails: screenshot the part on save / close, use as preview
- [ ] Sketch construction-geometry toggle: button + `x` keybind

## Batch 11 - scrubber caching / open-into-tab

- [ ] Timeline scrubber is slow to move; cache tessellation per rollback
      position so scrubbing back and forth is instant
- [ ] Opening a part drew a cube on top of it: Open must reset the doc (drop the
      boot demo body) and load into a NEW tab, not the current scene

## Deferred / not done

- Assembly joint SOLVING (joints recorded + round-trip; MbD solver is GUI-coupled
  headless) - needs a headless-solver path or an embedded GUI session
- Sheet metal beyond Base Flange; the SheetMetal addon's richer features
- Canvas: drag-a-line-on-the-image calibration, multi-page PDF underlays
- Git panel write ops (commit / checkout / diff from the UI)
- Manual sketch constraints + dimensions (auto H/V/coincident only today)
- File-embedded colours on STEP/3MF import (GUI-only in FreeCAD)
- Live packaged build with the real ~1GB bundled FreeCAD (pipeline verified with
  --dir; run `scripts/package.sh linux`)
