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

-the orbit stuff is still certainly bad/wrong. Keybind/controls are fine, just something is wrong. Maybe it needs to be based around the center of existing geometry? Around the origin? I don't know.
-when I double click to edit a dimension, I type '4' (for example) and hit enter. The dimension doesn't change and, the size isn't updated...what's that?
-If I drag or, place a sketch point (rect corner, circle center, etc.) on the origin or one of those edges, you should auto-add the necessary coincident constraint.
-objects that are hidden, should not be able to be selectable. Example, after my sketch, it kept highlighting like I was trying to select planes. I wasn't. They are hidden.
-sketch faces that are valid/closed, should be filled in with a lighter blue and be selectable (pending the selection settings are on too)
-Pending the dimensions start working, when I type into a dimension and hit enter, that should be locked (unchangable/draggable) without double clicking to edit/delete the dimension
-I was wrong about the dimensions being shown by default, they shouldn't be. I should have to make/assign them.
-When I select 'V' for vertical dimension on a rectangle, it should only highlight the 2 edges with 'v' specifically and the 'v' constraint symbols. which, they should be symbols, not actually 'v' and, they shouldn't have the box. They are kinda clunky right now. Keep that methodoligy for coincidents, and all other constraints. Ideally match their symbol in the ribbon.
-the view cube should have curved arrows above it in the top right corner that, allow me to rotate my view 90deg by clicking them. Looking at the same face but, 90deg rotated if that makes sense.
-the section view thing, needs the same draggable stuff as the offset plane
--that said, the offset plane interactability seems completely broken
-calibrate canvas shouldn't be a tool under insert, it should be within importing a canvas, when I right-click the canvas in the model tree, it should let me 'calibrate'
-I believe FCAD had something that, worked nice with KiCad. It would be good if, the KiCad stuff could still work and load well in this GUI stuff. Mainly, in assemblies, connections/joints/references being updated well and, updating the viewer as/when changes are being made (maybe need some push-pull process? Maybe it's just automatic?)
-when I select/hover over a plane, it seems to highlight a 'c' shape? It should just highlight the edges and face of the plane...

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