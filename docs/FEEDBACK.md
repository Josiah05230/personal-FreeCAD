# Feedback tracker

Live-test feedback. `[x]` = done and **deleted** from this file (keep it short);
`[~]` = partial; `[ ]` = open. Newest batch at the bottom. When a task is fully
done, remove its line entirely rather than leaving a checked box.

## Open / partial

- [~] Sheet metal: only Base Flange (SheetMetal addon or pad fallback). Richer
      flange / unfold / bend features deferred (low priority).
- [~] Draggable dimension labels work (drag the value bubble; witness / leader
      lines follow). The nudge is client-side only - it resets when the sketch is
      closed and reopened. Persist it in the recorded constraint next.
- [~] Draw tool variants: 10 tools ship (corner + center rect, circle + 3-pt
      circle, center + 3-pt arc, spline, ...). 2-point circle, tangent arc and
      rotated 3-point rectangle still to add if wanted.
- [~] Datum create: the dialog now dismisses instantly and the ghost previews
      the result, but there is still a short engine gap before the real datum
      lands in the tree / viewport (no synthesized optimistic datum yet).

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

(nothing pending)

## Recently addressed - Batch 23

- Drag now drops motion along already-constrained directions: a fully-solved
  entity will not drag at all (hint bar says why), and corner-dragging a
  dimensioned rectangle no longer shears - the dimensioned side stays rigid.
- SKETCH ribbon fold-outs actually open now (they were position:absolute and
  clipped by the ribbon body's overflow; now position:fixed like every other
  ribbon group, anchored to the group button, with pin toggles).
- Dimension value labels are draggable (see partial note above).
- Extrude "nothing visible": the viewport now re-frames the first time a solid
  appears, sketch-only scenes contribute to the bounding box so Fit lands on
  them, and finishing a sketch refreshes meshes. The phantom "Body" was the
  starter body showing up as soon as it held a sketch - the browser now only
  lists a body once it has a real solid feature.
- File menu says just "Import..." / "Export...". Export offers STEP / IGES /
  BREP / STL / OBJ / 3MF / PLY / OFF and dispatches by extension through the
  engine's generic io.export (import already accepted the same set).
- Offset-Plane arrow highlights on hover (brightens + grows) and takes hover
  priority so planes behind it no longer light up through it.
- Datum features renamed: "Plane" / "Axis" / "Point" (was "Construction ...").
- Construction group in the browser has a group visibility toggle.
- Delete is fully optimistic now - the feature vanishes from tree, viewport
  meshes / sketches / datums and selection immediately; engine reconciles after.
- Operation dialogs dismiss the instant you click apply; the rebuild runs behind
  the status spinner.