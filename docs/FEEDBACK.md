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

(Batch 26 - timeline / rollback - pending)

-what's the deal with loading after clicking ok on a construction plane? Why is that not instant to the user?
-my scrubber in the timeline is behind the plane (by default, issue) AND I CAN STILL SEE IT. THAT SHOULD NOT BE POSSIBLE IF I AM BEHIND A FEATURE
-when I try and step the timeline forward, it loads/buffers but, doesn't seem to actually do anything? That's a problem.
-it seems the view window moves back to before the first extrude but, the timeline scrubber doesn't?
--also, moving back/forth can be a little laggy. If possible, can you cache versions/stages of the model as it's built? Like, if I make an extrude or hole, and step back one step in the model tree, that should be instant because, that was the file and what was rendered genuinely seconds ago typically.

## Recently addressed - Batch 25

- The "huge ball on the mouse" is gone: vertex select is OFF by default (turn it
  on in the Select dropdown); the marker is a small screen-constant dot shown
  only within ~8 px of a real corner.
- Extrude accepts a flat model face as the profile, not just a sketch.
- Live feature preview: extrude / revolve / fillet / chamfer / shell / hole /
  draft / rib re-render in the engine as you change the value (260 ms debounce,
  prior attempt rolled back). Apply keeps it, Cancel rolls it back.