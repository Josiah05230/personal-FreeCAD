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

Batch 17 - all addressed.
Part 1 (sketcher): window (box) select in the sketch (L-to-R contain, R-to-L
crossing); rectangle sides stay welded on drag and resize instead of tearing
(local relaxation solver: coincident welds + H/V + length dims + axis anchors);
drawing a point onto another entity's point records a Coincident;
fully-constrained geometry is drawn grey (new headless `sketch.solve` in a
throwaway doc reports per-element free DoF); Delete / Backspace removes selected
sketch geometry and reindexes its constraints; constraint buttons work
click-first ("pick the constraint, then the geometry") when there is no live
selection; Midpoint constraint (Symmetric about a line's endpoints) + midpoint
snapping while drawing.
Part 2 (extrude + dialogs): Extrude gained an Operation select (New body / Join
/ Cut) replacing the bare Cut checkbox, plus an Extent select (Blind / To
object) with an Offset field (extra distance past the face). `feature.extrude`
takes `operation` + `offset`; `pad`/`pocket` set `.Offset` on UpToFace. The
operation dialog no longer overflows: it is wider, `box-sizing` fixed, fields
wrap, and long selects render label-above-control (`.opdlg-field.col`). Rename
is now instant - it updates the tree in place and persists on the quiet path;
`feature.rename` no longer recomputes.