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
- [~] Datum create: dialog dismisses instantly and the ghost is now held on
      screen until the real datum lands, so it reads as instant. A truly
      synthesized optimistic datum (tree row before the engine answers) is still
      not done.
- [~] Parametric sketch tools: 3-point circle / arc now pin to any drawn point
      that snapped onto existing geometry (PointOnObject), and center-rectangle
      carries its construction diagonals. FULLY parametric versions (a real
      construction POINT entity at each pick, symmetric-about-centre) need a new
      point entity type in the sketcher - not done yet.
- [~] Live feature preview works for extrude / revolve / fillet / chamfer /
      shell / hole / draft / rib (260 ms debounce, engine builds it, previous
      attempt rolled back first). Not yet: a "committed vs preview" visual tell,
      and preview for pattern / mirror / combine.
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

## Recently addressed - Batch 28

- "Extrude / live preview does nothing" root cause: dimensioning two opposite
  sides of a rectangle left a redundant constraint that collapsed the sketch to
  NO closed wire -> `build.pad` NULL shape -> `feature.extrude` crashed on
  `.Shape.isValid()`, which broke every later op and blanked the scene.
  * `sketch.finish` strips FreeCAD's reported redundant constraints and re-solves
  * `feature.extrude` checks the profile up front, handles a null shape safely,
    and removes an invalid pad instead of leaving the model broken
  * live preview parses each field as a finite non-zero number (no NaN sends) and
    shows the engine error in the hint bar instead of silent retries
- `setDimension` and drag-release now run the REAL solver immediately (not a
  240 ms timer), so a dimensioned rectangle snaps exact and an over-dimension is
  vetoed at once.
- Dragging a fully-sized rectangle's edge translates the whole rectangle
  rigidly instead of stretching it.

## Recently addressed - Batch 27

- Delete a sketch dimension: click its value label (it highlights), press
  Delete. Works on this-session dimensions and reopen-era ones (sketch.finish
  removes the matching real constraint).
- Over-dimensioning is now actually blocked - sketch.solve maps its diagnostics
  through a per-constraint applied list, so a redundant / conflicting / rejected
  dimension is caught by the pre-prompt check and the post-add veto.
- A fully-defined entity (or a fully-constrained sketch) will not start a drag.
- Blank viewport on extrude / live preview: a non-finite tessellation vertex is
  dropped, a NaN camera frame is refused, buildScene is wrapped - a bad vertex
  can no longer strand the camera.
