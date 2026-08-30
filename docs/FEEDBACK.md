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

Batch 17 (part 1) - all addressed: window (box) select in the sketch (L-to-R
contain, R-to-L crossing); rectangle sides stay welded on drag and resize
instead of tearing (local relaxation solver: coincident welds + H/V + length
dims + axis anchors); drawing a point onto another entity's point records a
Coincident; fully-constrained geometry is drawn grey (new headless
`sketch.solve` in a throwaway doc reports per-element free DoF); Delete /
Backspace removes selected sketch geometry and reindexes its constraints;
constraint buttons work click-first ("pick the constraint, then the geometry")
when there is no live selection; Midpoint constraint (Symmetric about a line's
endpoints) + midpoint snapping while drawing.

-I can't seem to actually extrude a face from a sketch?? Also, I need the same 'to-object' (with optional offset thing) for the extrude distance. I also need extrude to not just have a 'cut' check box but a 'join', 'cut', 'intersect', etc. drop-down. The textbox currently also seems to extend off the side of the window... (the textbox extending off the window seems to be prevelent in a LOT of places)
-when I rename a sketch it also takes forever to load?? Again. Anytime you can handle something client-side first and, have responsiveness and then load it to/from FCAD, that's the best and only choice. It needs to be fast (or, at least feel it)