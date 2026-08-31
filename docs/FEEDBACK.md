# Feedback tracker

Live-test feedback. `[x]` = done and **deleted** from this file (keep it short);
`[~]` = partial; `[ ]` = open. Newest batch at the bottom. When a task is fully
done, remove its line entirely rather than leaving a checked box.

## Open / partial

- [~] Sheet metal: only Base Flange (SheetMetal addon or pad fallback). Richer
      flange / unfold / bend features deferred (low priority).

## Deferred / not done

- KiCad interop next steps: component STEP models (Windows env-var paths),
  connector -> assembly-joint mapping, and a filesystem watch for automatic
  live sync. First slice (board solid + placeholders + import/re-sync) done.
- Assembly joint SOLVING (joints recorded + round-trip; MbD solver is GUI-coupled
  headless) - needs a headless-solver path or an embedded GUI session.
- Drawing hidden (dashed) lines: TechDraw headless getHiddenEdges() returns
  nothing, so drawings show visible edges only.
- Thicken / offset-surface - needs surface bodies, which this shell does not
  model yet (everything is a solid PartDesign body).
- PartDesign::Rib is missing from the bundled FreeCAD 1.1.1 build, so Rib uses an
  offset-wire + symmetric-pad fallback; swap to the real feature if a later
  FreeCAD build provides it.
- Canvas: multi-page PDF underlays.
- Git panel write ops (commit / checkout / diff from the UI).
- File-embedded colours on STEP / 3MF import (GUI-only in FreeCAD).
- Live packaged build with the real ~1GB bundled FreeCAD (pipeline verified with
  `--dir`; run `scripts/package.sh linux`).

## User added

Drop new feedback here between sessions; it gets folded into a batch and this
space cleared. As tasks complete, delete them from the batch above so this file
stays short.

Batch 22 - addressed:
- View-cube text is back (the transparent label quads did not render; they are
  opaque face decals now, still oriented per-face so all six read relative to
  FRONT).
- "Nothing visible after clicking a face / finishing a sketch": the camera was
  being left stranded on the sketch plane. It now snapshots the view on sketch
  enter and restores it on exit. Undoing an extrude also re-shows the sketch it
  consumed (sidecar _reshow_loose_sketches + App clears manual hide state on
  undo/redo).
- Multi-face pick locks to the first face's plane: once one face is selected,
  only coplanar faces are added; clear the selection to switch planes. (Picker
  now returns the face normal.)
- SKETCH ribbon groups are pinnable fold-outs like every other ribbon group.
- New draw tools: Center Rectangle, 3-Point Circle, 3-Point Arc, Spline
  (Enter / double-click to finish a spline).