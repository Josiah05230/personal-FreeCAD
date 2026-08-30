# Feedback tracker

Live-test feedback. `[x]` = done and **deleted** from this file (keep it short);
`[~]` = partial; `[ ]` = open. Newest batch at the bottom. When a task is fully
done, remove its line entirely rather than leaving a checked box.

## Open / partial

- [~] Sheet metal: only Base Flange (SheetMetal addon or pad fallback). Richer
      flange / unfold / bend features deferred (low priority).

## Deferred / not done

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

-I believe FCAD had something that, worked nice with KiCad. It would be good if, the KiCad stuff could still work and load well in this GUI stuff. Mainly, in assemblies, connections/joints/references being updated well and, updating the viewer as/when changes are being made

### Batch 15 - all addressed

sketch origin + in-plane axes; reference dimensions with witness lines +
arrowheads ("from here to here", not a box); hover pre-highlight in the sketch
AND the main 3D view (faces/edges/vertices/datums, filter-aware); hide ASSEMBLE
tab with < 2 bodies; Select group = paint/window on the face + a "Select"
fold-out for the kind filters; Inspect pinned by default; turntable orbit (no
roll drift / pole spazz, right-drag orbits); prompt fields auto-focus so you
type + Enter; axis/origin snapping auto-records the constraint (PointOnObject /
Coincident-to-root); rectangles come in fully constrained (corner coincidents +
H/V) and _auto_constrain no longer piles on redundant constraints; constraint
symbols drawn where they exist, hovering one lights its partners; double-click a
dimension (or its geometry) to retype the value; free-drag under-constrained
sketch geometry (no live solver - re-solves on Finish); adaptive 1/2/5 sketch
grid; TOOLS tab pinned by default; Insert moved onto SOLID (INSERT tab gone);
Offset Plane Distance / To-object modes with auto-switch, a live ghost-plane
preview, and a draggable handle on the ghost to set the distance. The Select
kind checkboxes were then moved into the ribbon group's own fold-out (the
"Select ▾" button at the bottom of that section), not a separate popover.