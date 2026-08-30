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

Batch 18 - addressed:
- Over-dimensioning / redundant constraints are now blocked. `sketch.solve`
  reports conflicting / redundant / partially-redundant / malformed constraint
  indices; the editor pulls the just-added constraint back out and shows an
  orange notice bar ("already fully defined here - delete one first"). Applies
  to dimensions and manual constraints alike.
- Dragging a rectangle side stays a rectangle the whole way - the local
  relaxation now anchors welds to the directly-dragged point (and then to axis
  anchors) instead of any "fixed" key, so it no longer skews then snaps back.
- The little dots on the rectangle are gone: Coincident / PointOnObject /
  Symmetric no longer draw a glyph (the geometry already shows the join).
- Snapping a line's endpoint to another line's midpoint while drawing now
  records a real Midpoint (Symmetric) constraint, and the relaxation keeps it
  centred through drags.
- A finished sketch's fill + outline highlight on hover / selection, so the
  filled face is an obvious Extrude / Revolve target.

-Extrude still needs a proper re-test after the closed-profile + selection-
 highlight fixes; if a specific case still fails, note the exact steps.