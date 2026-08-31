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
- [~] Parametric sketch tools: 3-point circle / arc now pin to any drawn point
      that snapped onto existing geometry (PointOnObject), and center-rectangle
      carries its construction diagonals. FULLY parametric versions (a real
      construction POINT entity at each pick, symmetric-about-centre) need a new
      point entity type in the sketcher - not done yet.
- [ ] Live feature preview: extrude / fillet / chamfer / etc. should re-render
      as the value changes in the dialog, then commit to the engine in the
      background. Needs a preview/commit/rollback path around the op RPCs; not
      started. (Datum plane already previews via its ghost.)
- [~] Section: cross-hatching is drawn (a hatched quad in the cut plane). "OK ->
      Analysis tab in the tree + timeline item" (a persisted section feature) is
      not done - section is still a live view-only tool.
- [~] Hole: you place it by clicking the face (click again to move the point) and
      the dialog now says so. A live on-face position marker is still to add.

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

## Recently addressed - Batch 24

- Corners no longer carry a permanent dot. The vertex point cloud is an
  invisible raycast target; a small sphere appears ON a corner only when the
  cursor is within ~12 px of it (blue on hover, orange when selected, held
  until deselect). No marker on the pointer.
- Measure: click to add a probe (face / edge / vertex - vertex was missing),
  rolls at two, no shift and no coplanar lock; panel shows the count + Reset.
- 3-point circle / arc pin to snapped existing geometry (PointOnObject);
  center rectangle gets construction diagonals. (Full parametric = partial.)
- Section: hatched quad drawn in the cut plane so it reads as a cut face.
- Hole: dialog says to click the face to place the point (re-click to move it).
- Coplanar-face lock is now extrude-only, so Shell / Draft can take faces on
  different planes again. Shell + Mirror verified working headless.
- Export: all formats (STEP / IGES / BREP / STL / OBJ / 3MF / PLY / OFF) go
  through io.export and are verified headless - 3MF writes fine. (The old
  3MF error was the pre-Batch-23 exportStep-only path; fixed there.)
- Mirror / Shell dialogs now have a hint saying what to select.