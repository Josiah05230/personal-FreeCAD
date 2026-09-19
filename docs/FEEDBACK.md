# Feedback tracker

Live-test feedback only. Fully-done items are **deleted** (git history + the
per-batch notes in `docs/status.md` keep the record). `[~]` = partial,
`[ ]` = open. New feedback goes under "User added"; fold it into the list and
clear it as you go.

## Open / partial

- [~] Live feature preview: in-place fast path (`feature.previewUpdate`, one
      body re-meshed, ~10ms, debounce 130ms). Editing an existing feature
      previews via `feature.editPreview`; a dress-up edge/face set change goes
      through `feature.previewSetBase` in place. Still on the slow full-rebuild
      path: rib, extrude "To object", extrude Intersect, pattern / mirror /
      combine. No "committed vs preview" visual tell.
- [~] Press-pull a model face (extrude / revolve with no sketch): works for one
      FLAT face + (revolve) an axis. NOT yet: selecting several faces and
      pulling them together.
- [~] Edit feature: Pad / Revolution / Fillet / Chamfer / Shell / Draft / Hole
      reopen their real dialog with values + refs editable. Patterns / mirror /
      combine / datums still fall back to the one-number "Edit Value…" prompt.
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

- **A single-part document had no way to start an assembly at all.**
  "Insert Component" lived only on the ASSEMBLE tab, which only appears once
  2+ bodies already have features - exactly the state inserting the FIRST
  component would create. Reproduced live: a fresh document with one part
  had no ASSEMBLE tab and no "Insert Component" anywhere in the whole app.
  Fixed the same way as the Drawing entry point below: also added to SOLID's
  Insert group. Verified end-to-end - inserted a real second .FCStd as an
  `App::Link` component (`assembly.tree` showed it linked correctly).
- **Full feature pass, verified live in a real running document (not just
  read in source):** Sketch -> Extrude, Revolve (profile off-axis -> real
  hollow washer), Fillet, Chamfer, Shell, Draft, Sweep (profile + path
  sketch -> real swept solid), Loft (two profiles at different heights via
  a Datum Plane -> real tapered frustum), Hole (with live counterbore
  preview), Combine/boolean Fuse (two bodies -> one, ASSEMBLE tab correctly
  appears/disappears as body count with features crosses 2), undo/redo, and
  the full save -> quit -> reopen round-trip (needed a new dev-only
  `GWTCAD_AUTO_SAVE_PATH` env var, see driver.mjs, since native save/open
  dialogs are outside Playwright's reach). Rectangular Pattern and Mirror
  both correctly rejected genuinely-invalid inputs (self-intersecting
  pattern spacing; an off-center non-symmetric mirror plane) with a clear
  error toast instead of corrupting the model - confirmed as correct
  behavior, not a bug. All features actually built real, inspectable
  geometry - no silent no-ops found in this pass.
- **"Drawing from Design" was only reachable from TOOLS.** A document with no
  drawing yet has no "Drawings" browser row and no DRAWING ribbon tab (both
  only appear once a drawing exists), so the sole entry point to create the
  FIRST one was an unlabeled button buried in TOOLS - not discoverable by a
  first-time user, and not where the app's own docs describe it (a whole
  DRAWING ribbon tab). Added the same command to SOLID's Insert group
  (Fusion's actual "Insert > Drawing" location), verified it now shows there.
- **Escape did not close an open ribbon/menu dropdown.** The SOLID/SKETCH
  ribbon group overflow ("Insert ▾" etc.) and every right-click context menu
  closed on outside-click but not on Escape, unlike the command palette and
  prompt dialogs - reproduced live (opened Insert, pressed Escape, menu stayed
  open, overlapping the next prompt). Fixed in the shared `ContextMenu` (fixes
  every right-click menu app-wide), the ribbon's own dropdown, the sketch
  ribbon's dropdown, and the File menu - each additively, so a mode-level
  Escape handler underneath (e.g. sketch tool cancel) still also runs.
- **A brand-new, never-touched document opened already flagged dirty**
  ("Untitled *" with no features, right after finishing the first-run
  wizard). The wizard's "apply my chosen viewport look" call went through
  `applyRenderSettings`, whose `markDirty(true)` is correct for a real
  mid-session appearance change but wrong for a one-time app-level
  preference on a document with nothing to lose yet. Fixed by explicitly
  clearing the dirty flag right after that one call; verified the title bar
  now reads "Untitled" with no asterisk on a fresh launch.
- **Data Panel hid every folder with no .FCStd in it.** `fs:listDir` used
  "does this dir contain a design within 3 levels" as a hard filter on
  DIRECTORIES, not just files - so a fresh/non-CAD folder (a company folder
  before its first design, Documents, Downloads, ...) silently never appeared,
  with no indication anything was hidden. Found by cold-launching the app and
  browsing `~` for real: only 2 of ~20 real folders showed up. Fixed: all
  folders now list, like a normal file browser; only files are filtered to
  `.FCStd`; "has a design nearby" is now a dim/bold visual cue on the folder
  name, not a gate. `docs/... index.ts` `fs:listDir` + `DataPanel.tsx`.
- **Drawing tables were effectively undraggable.** Each cell has its own
  full-size hit-rect on top (for double-click-to-rename / right-click), and
  in SVG a later sibling fully occludes pointer events to an earlier one at
  the same point - so a plain click-drag on ANY cell (i.e. anywhere a user
  would naturally grab the table) never reached the table's own whole-bbox
  drag-rect underneath. Reproduced live: dragging from a cell moved nothing,
  slow 40-step drag included, ruling out a timing race. Fixed by moving the
  drag-start `onPointerDown` to the table's parent `<g>` so it receives the
  bubbled event from any cell; verified live (create drawing -> Insert Table
  -> drag from a data cell -> table actually moves). `DrawingSheet.tsx`.
- **Materials panel** (new, user-requested): assign a real FreeCAD material
  (appearance + physical properties) from ~200 built-in presets or a custom
  one to a body; custom presets can override colour/glossiness/density and
  add GWT-CAD-only extras (friction, pattern/finish, notes), saved to a
  reusable user-level library. Ribbon: Modify > Material.
- **Fusion-parity pass 1.** Researched the F360 Design workspace SOLID + MESH
  ribbon (`docs/fusion-parity.md` = the full command-by-command gap list) and
  implemented the highest-value missing pieces: Move/Copy done the F360 way
  (modes + Create Copy, was just a bare dx/dy/dz), Scale dialog, Align, Press
  Pull, Offset Face, Split Face, the Box/Cylinder/Sphere/Torus/Coil/Pipe
  primitives, Revolve Operation set + Full, Chamfer modes, Interference +
  Center of Mass, and a whole MESH tab (Reduce / Smooth / Plane Cut / Repair /
  Separate / BRep<->Mesh). Remaining corrections listed at the bottom of
  `fusion-parity.md`.
- **Revolve OK stayed disabled after the preview rendered** when the profile
  was a flat model face (not a sketch). The dialog `ready` check only accepted
  a sketch for revolve; it now accepts a sketch OR one flat face, like extrude.
  New `op_commit.js` E2E opens every op dialog, makes a valid selection, and
  asserts the OK button truly enables (`getState().opReady` + the real DOM
  button `disabled`) before applying - so a "renders but will not commit" bug
  in any dialog now fails a test.
- **Sketch geometry points are selectable.** A circle / arc centre (and line
  endpoints) can be picked on their own: dimension centre-to-centre /
  centre-to-line, and Coincident / Horizontal / Vertical between two points.
  Survives finish + reopen. Deferred: Symmetric-between-points (needs the
  ribbon constraint enum widened), a visible dimension glyph for point
  distances (the constraint drives the solver, just no leader line yet).
- **Mirror / Pattern got an Operation** (Join / Cut / Intersect / New body,
  like extrude) and are now **editable features** - double-click a Mirror /
  Pattern chip to change its plane / axis / count / Type. Deferred: changing
  the Operation during an edit (a cut/intersect/new-body result is a Boolean /
  separate body whose chip has no dialog - it is create-time only for now).
- **Datum Plane / Axis / Point reworked.** One Offset field (no Distance vs To
  object split), plain click replaces the reference, Ctrl-click adds; the
  reference set decides the geometry (2 edges -> plane through both, 2 faces ->
  mid-plane, 1 edge -> plane on it tilted by Angle, etc.). Deferred: a live
  ghost for Axis / Point (Plane has one).
- **A real part + assembly E2E** (`part_asm.js`): sketch -> extrude -> cut ->
  fillet -> mirror one timeline-selected feature -> edit that mirror, then two
  components + a joint - all driven through the GUI bridge.
- **Mirror / Pattern transform the whole solid + a Type scope.** They set
  `Originals=[tip]`, so only the last feature was mirrored/patterned (the
  "46mm vs 30mm" mirror). Now the default is the whole solid-feature chain,
  with Type = Body / Features (timeline chips) / Faces (features owning the
  picked faces). Refs resolve before `body.newObject` and the build runs
  through `finalize_or_rollback`.
- **Revolving a model face did nothing** ("The graph must be a DAG.", null
  shape, RPC still OK) - the axis ref resolved through `body.Tip` after it had
  advanced to the half-built Revolution -> self-reference. Resolve the axis
  first; a face revolve that produces no shape now raises.
- **Revolve axis is pickable for a sketch too.** New Axis dropdown (sketch
  V/H, X/Y/Z, or a selected edge / datum); the live preview honours it (it
  used to hard-code null whenever a sketch was selected).
- **Extrude Cut removes material reliably** (flips Reversed if the first pass
  cuts into empty space; errors if the profile never meets the solid), and
  **Extrude Intersect** is a new operation (scratch body + Boolean Common).
- **Dress-up multi-select.** Plain click replaces the edge/face set,
  Ctrl/Shift/Cmd-click adds one; the preview updates its Base in place
  (`feature.previewSetBase`) instead of tearing down and rebuilding, so adding
  a fillet edge no longer makes the preview blink away.
- **Extrude preview flicker in Blind mode** - the dialog live-preview effect
  now de-dupes identical (kind, values, selection) fires.
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
