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

-uhh, now there is no text on the view cube?
-When I click a face in the extrude tool, there is no model or anything visible...that's a problem. It's been that way the whole time.
--when I cancel an extrude, it still says the body is there...I never extruded though...
--also, the sketch isn't visible anymore? Even after I show/hide, zoom in/out, home on the view cube, spin stuff, etc.

Still open from this batch:
-when I click a face to sketch on it, it can get "stuck/locked to the same plane"; the plane / face picker only offers shown sketches, not hidden ones. Needs a concrete repro.
--no, I am WANTING it to be stuck to only allowing me to select faces on the same plane after the first one. Unless I de-select all faces.
-sections in the sketch ribbon should be a dropdown like every other ribbon group (with pin-to-ribbon support).
-more draw tools: center-point rectangle, 3-point circle, arc variants, splines.