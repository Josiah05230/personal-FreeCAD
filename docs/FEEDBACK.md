# Feedback tracker

Live-test feedback only. Fully-done items are **deleted** (git history + the
per-batch notes in `docs/status.md` keep the record). `[~]` = partial,
`[ ]` = open. New feedback goes under "User added"; fold it into the list and
clear it as you go.

## Open / partial

- [~] Live feature preview: in-place fast path (`feature.previewUpdate`, one
      body re-meshed, ~10ms, debounce 130ms). Editing an existing feature
      previews via `feature.editPreview` (recomputes only that feature).
      Still on the slow full-rebuild path: rib, extrude "To object", pattern /
      mirror / combine. No "committed vs preview" visual tell. Next lever if
      still not instant: a client-side predictive mesh (no engine round-trip).
- [~] Press-pull a model face (extrude / revolve with no sketch): works for one
      FLAT face + (revolve) an axis. NOT yet: selecting several faces and
      pulling them together.
- [~] Edit feature: Pad / Revolution / Fillet / Chamfer / Shell / Draft / Hole
      reopen their real dialog with values + refs editable. Patterns / mirror /
      datums still fall back to the one-number "Edit Value…" prompt.
- [~] Sheet metal: Base Flange only. Richer flange / unfold / bend deferred.
- [~] Draggable dimension labels: the nudge is client-side and resets on sketch
      reopen. Persist it in the recorded constraint.
- [~] Draw tools: 10 ship. 2-point circle, tangent arc, rotated 3-point rect
      still to add if wanted.
- [~] Datum create: dialog + held ghost read as instant; a synthesized
      optimistic tree row (before the engine answers) is not done.
- [~] Parametric sketch tools: 3-pt circle/arc pin to snapped points;
      center-rect carries construction diagonals. A real construction POINT
      entity per pick (for symmetric-about-centre) needs a new sketcher entity
      type - not done.
- [~] Section: hatched quad is drawn; "OK -> persisted section feature +
      Analysis tab" is not done (still a live view-only tool).
- [~] Hole: placed by clicking the face (click again to move); a live on-face
      position marker is still to add.

## Recently addressed (this session)

- **Editable features.** Double-click any feature chip -> its operation dialog
  reopens pre-filled; values AND references (profile / edges / faces / axis)
  are editable and applied in place (`feature.get` / `feature.update` /
  `feature.editPreview`). The timeline rolls to that feature while editing and
  back to the tip on Update; downstream is not rebuilt until then. Cancel
  restores the committed params.
- **Revolve a model face** (no sketch), like press-pull - needs a flat face + an
  axis pick (edge / datum).
- **Fillet / extrude now honour the whole selected reference set.** `previewSig`
  hashed only the first ref, so edges added after the first preview never made
  it in ("fillet didn't round all the edges"). Fixed.
- **A sketch is never "consumed".** You can extrude / revolve the same sketch
  repeatedly; the copy PartDesign needs is hidden (`gwtRefCopy` tag), filtered
  from the timeline / browser / viewport, and garbage-collected when
  unreferenced. No more `Sketch (copy)` chips.
- **The "errors while the engine is still loading" cluster.** (1) The
  single-threaded sidecar HTTP server blocked new connections behind an idle
  keep-alive socket (~4s stalls); now threaded + one engine worker (boot
  refresh 8.2s -> 0.14s). (2) Finish deleted the feature it just committed
  (dialog-unmount drained the promoted preview); guarded with a `committing`
  flag. (3) A miss-click while a dialog was open wiped the profile sketch;
  it no longer clears the selection, and stray face-clicks on the preview
  solid are ignored.
- **Revolve no longer wipes the body.** A profile crossing the axis swept into
  itself and PartDesign returned it as a "valid" sliver; now rejected up front
  + built through `build.finalize_or_rollback` (bad feature removed, tip
  restored, existing work untouched).
- **Timestamped trace** (`app/src/renderer/trace.ts` + sidecar `registry`):
  every action / command-queue transition / RPC (both sides, paired, with ms)
  goes to `/tmp/gwtcad-run.log`. On by default; `localStorage gwtcad.trace=0`
  or `GWTCAD_TRACE=0` to silence.

## Deferred / not done

- KiCad interop next: component STEP models (Windows env paths), connector ->
  joint mapping, filesystem auto-watch. First slice (board + placeholders +
  import/re-sync) done.
- Assembly joint SOLVING - MbD solver is GUI-coupled headless.
- Drawing hidden/dashed lines - TechDraw headless `getHiddenEdges()` returns
  nothing.
- Thicken / offset-surface - needs surface bodies (this shell is solids only).
- `PartDesign::Rib` missing from the bundled FreeCAD 1.1.1 - Rib uses an
  offset-wire + symmetric-pad fallback.
- Canvas multi-page PDF underlays.
- Git panel write ops (commit / checkout / diff from the UI).
- Embedded colours on STEP / 3MF import (GUI-only in FreeCAD).
- Live packaged build with the real bundled FreeCAD (`scripts/package.sh linux`).

## User added

_(empty - drop new live-test feedback here)_
