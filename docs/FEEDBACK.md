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

Batch 21 (part 1) - addressed:
- Ctrl+Z in a sketch now reverts one whole action: a rectangle (4 lines + its
  constraints) undoes in a single step, as does a drag, a dimension, a manual
  constraint, or a delete. Full pre-action snapshots, ~120 deep.
- Placing an over-dimension is caught BEFORE the number prompt: the dimension
  request runs a trial solve first and, if the geometry is already fully
  defined there, shows the orange notice and never opens the input.
- The boot scrim now stays up until the first scene + tree have actually
  loaded, so the app never looks "ready" while it is still populating.
- Extrude no longer assumes "the only sketch" - you pick one (click its outline
  or filled face); a real miss gives a clear message.
- Sketch fill is hardened: a degenerate profile can no longer inject NaN
  geometry (dropped the needless vertex-normal pass, added a finite-value
  guard, wrapped the region fill + selection overlays in try/catch) - this was
  what could blank the viewport.

Batch 21 (part 2) - addressed:
- Delete Feature is optimistic now: the feature leaves the tree + selection
  immediately, the engine rebuild runs behind the status-bar spinner and
  reconciles when done. Cancelling a brand-new sketch likewise leaves the
  editor at once and deletes in the background.
- View-cube labels are drawn on their own oriented quads (not the box UVs), so
  every face reads relative to FRONT: the four side labels are upright with
  +Z up, TOP / BOT align to the FRONT edge.

Still open from this batch:
-when I click a face to sketch on it, it can get "stuck/locked to the same plane"; the plane / face picker only offers shown sketches, not hidden ones. Needs a concrete repro.
-sections in the sketch ribbon should be a dropdown like every other ribbon group (with pin-to-ribbon support).
-more draw tools: center-point rectangle, 3-point circle, arc variants, splines.