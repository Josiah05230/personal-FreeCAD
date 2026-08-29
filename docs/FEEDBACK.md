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

## Batch 9 - sketch UX / responsiveness

- [x] No separate sketch popup: sketch tools live in a contextual SKETCH ribbon
      tab that only shows in sketch mode (auto-selected on enter)
- [x] Sketch on a face is at the face, with the face's edges + vertices as
      reference geometry you can snap to (centre on a point, land on an edge)
- [x] Manual constraints in the sketch tab: H / V / parallel / perpendicular /
      equal / coincident / tangent / concentric
- [x] Canvas drag-a-line calibration: INSERT > Calibrate Canvas, click the two
      ends of a known length, type the real mm, canvas rescales
- [x] Finish Sketch was slow -> single round trip (geometry + constraints +
      recompute in one call)
- [x] Finishing a sketch must never leave it visible-but-"before the timeline";
      finish resumes the build (marker clears)
- [x] Way more responsive: visibility toggles are client-side first, no full
      scene refetch on every eye-click

## Batch 10 - scale / prompts / view cube / select / data panel / construction

- [x] Convert Units folds into Scale as unit presets (not its own tool)
- [x] Scale threw "prompt() is not supported" -> in-app dialog, no window.prompt
- [x] Right-click face > Set as Front/Top/Right now reorients the cube frame
      (frameQuat) + Reset orientation
- [x] Select group: inline entity-kind toggles + paint/window switch in the
      ribbon (no dropdown)
- [x] Drag to resize the left data panel (width persisted)
- [x] Double-click to open a part from the data panel
- [x] Data-panel right-click: open / rename / move to folder / git history /
      delete (trash), for files and folders
- [x] Data-panel thumbnails: window screenshot on save, shown as preview
- [x] Sketch construction-geometry toggle: button + `x` keybind

## Batch 11 - scrubber caching / open-into-tab

- [x] Scrubber caches scene+tree per rollback position (rollCacheRef) so
      revisiting a spot is instant; drag is rAF-throttled + de-duped; cache
      clears on any edit
- [x] Open resets the sidecar doc and lands in a fresh tab; boot no longer
      creates a demo body (that was the "cube on top of my part")

## Batch 12 - revolve axis / no primitives / parameters / equation dimensions

- [x] Revolve axis is a selection (body edge / sketch line / datum axis); no
      dropdown, falls back to the sketch's vertical when nothing is picked
- [x] Box and Cylinder tools removed (sketch + extrude/revolve instead)
- [x] Parameter table (Modify > Parameters): named params, unit expressions,
      cross-references, persisted in the doc sidecar json
- [x] Feature dimension inputs accept unit equations ("15in + 2.4mm", "bore/2");
      live "= value" preview, evaluated on OK via expr.eval
- [~] Sketch dimensions do not exist yet as a numeric tool, so equation input
      there is still pending (the 2D editor has no dimension entry)

## Deferred / not done

- Assembly joint SOLVING (joints recorded + round-trip; MbD solver is GUI-coupled
  headless) - needs a headless-solver path or an embedded GUI session
- Sheet metal beyond Base Flange; the SheetMetal addon's richer features
- Canvas: multi-page PDF underlays
- Git panel write ops (commit / checkout / diff from the UI)
- Sketch dimensions (numeric drag-to-dimension in the 2D editor); manual
  constraints beyond the current set
- File-embedded colours on STEP/3MF import (GUI-only in FreeCAD)
- Live packaged build with the real ~1GB bundled FreeCAD (pipeline verified with
  --dir; run `scripts/package.sh linux`)

## User added
Needs to be done but, allows the user to update the task list without messages/prompts everytime. Add these items to batch(es) and complete them. Remove them from below when they are added to a batch.

(none pending - moved to Batch 12)
