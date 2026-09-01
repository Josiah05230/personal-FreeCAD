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
- [~] Live feature preview: in-place fast path (feature.previewUpdate ~8-15ms,
      only the changed body re-meshed, no undo, no full scene refresh; debounce
      130ms). First preview also uses the light single-body path now. Covers
      extrude / revolve / fillet / chamfer / shell / draft / hole. Still on the
      slow rebuild path: rib, "To object" extent, pattern / mirror / combine.
      No "committed vs preview" visual tell. If still not instant enough the next
      step is a client-side predictive mesh (zero engine round-trip).
- [~] Extrude a model face with no sketch (F360 press-pull): works for FLAT faces
      - Join pulls out, Cut pushes in, New body. Direction = face normal, Reversed
      flips. Curved faces / bodies with no solid are rejected with a message.
      NOT yet: selecting several faces and pulling them together.
- [~] Section: cross-hatching is drawn (a hatched quad in the cut plane). "OK ->
      Analysis tab in the tree + timeline item" (a persisted section feature) is
      not done - section is still a live view-only tool.
- [~] Hole: you place it by clicking the face (click again to move the point) and
      the dialog now says so. A live on-face position marker is still to add.

## Recently addressed

- Finish on extrude/revolve/etc no longer rebuilds: the live-preview feature is
  kept as the committed one (same profile+operation), so Finish is ~instant
  instead of undo + re-extrude + full scene re-tessellation.
- Geometry engine crash resilience: headless FreeCAD hard-aborts on a malformed
  feature (seen: face-extrude against a body with no solid). Now guarded in
  build._set_profile, and if the sidecar dies anyway the main process
  auto-respawns it and the renderer refetches + warns (model state is lost -
  reopen the file).

- Timeline: clicking a feature chip used to roll history to that point (which
  scrolled the timeline and rebuilt the viewport). Now a click SELECTS the chip;
  Shift-click ranges, Ctrl/Cmd-click toggles. Delete/Backspace removes the
  selected group (one confirm), right-click on a multi-selection has
  "Delete N features" / "Suppress N features". Rolling history is now only the
  marker, the transport buttons, or right-click "Move timeline here".

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

