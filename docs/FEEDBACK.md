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

### Batch 15 (in progress)

Done and removed: sketch origin point + in-plane axes; reference dimensions
drawn on sketch geometry with witness lines + arrowheads (not just a box);
hover pre-highlight in the sketch; hide ASSEMBLE tab with < 2 bodies; Select
group trimmed to paint/window with a "Select" fold-out for the kind filters;
Inspect tools pinned by default; turntable orbit rewrite (no roll drift / pole
spazz, right-drag also orbits); prompt fields auto-focus so you can type + Enter.

Still open:

- [ ] hover pre-highlight should happen EVERYWHERE, not just in a sketch (main
      3D view: edges + vertices too, not only faces)
- [ ] Offset Plane: live preview of the plane, a Distance / To-Object mode
      switch (To-Object picks a point / face / edge, plus an extra offset), and
      a draggable handle (arrow/dot) to set the distance live. If in Distance
      mode and the user picks geometry, auto-switch to To-Object with offset 0.
- [ ] Sketch: snapping a point onto the origin / an axis should auto-add the
      constraint (coincident to origin, point-on-object for an axis).
- [ ] Sketch: draw the constraint symbols where they exist. A default rectangle
      = 4 lines, coincident corners, H/V on the sides, and separate equal
      constraints on top/bottom and left/right (so not square by default).
- [ ] Sketch: hovering a constraint symbol highlights it AND its partners
      (equal always comes in a pair/group).
- [ ] Double-click a dimension to edit its value.
- [ ] Drag under-constrained sketch geometry freely (DOF-aware dragging).
- [ ] Sketch background: adaptive grid that rescales with zoom.
- [ ] TOOLS tab: pin everything on it to the ribbon by default.
- [ ] Move the Insert group onto the SOLID tab.