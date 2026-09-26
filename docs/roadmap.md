# Roadmap

Scope agreed with the user: a daily-driver replacement for Fusion 360 covering
part modeling, assemblies, drawings, sheet metal, and non-planar body splitting.
Linux and Windows. No Mac. No visible "workbench" concept anywhere.

Feel is a hard requirement: someone closing Fusion 360 and opening this should not
feel a downgrade in the viewport or the interaction model.

This file tracks scope and status, not a day-to-day task list - see git history
for what changed recently and when. Last brought back in sync with reality:
2026-09-26 (it had gone stale since the milestones below were first written -
Milestone 0 was still shown as in-progress checkboxes long after every item in
it, and several milestones past it, were actually built and in daily use).

## Status summary

| Milestone | Status |
|---|---|
| 0 - viewport feel checkpoint | Done - passed its go/no-go long ago |
| 1 - single-part modeling | Done - sketching, features, timeline, browser, measure/section/appearance, save/export all real and in daily use |
| 2 - assemblies | Done - multi-document links, joints, assembly tree, explode |
| 3 - sheet metal + surface splitting | Surface splitting done; sheet metal has one real op (base flange) - most of the milestone's sheet-metal scope is still ahead |
| 4 - drawings | Done - the largest single subsystem (40+ RPC methods): views, dimensions, GD&T-adjacent tables, sheet templates, PDF export |
| 5 - packaging | Linux (.deb/AppImage) and Windows (NSIS) installers both real and building; auto-update not started |
| (unplanned) Company PN registry + git sync | Done, and bigger in practice than any single milestone above - see below |

## Milestone 0 - viewport feel checkpoint (done)

Goal: prove the architecture and let the user judge orbit / pan / zoom feel.

- [x] Headless FreeCAD confirmed (1.1.1 AppImage, `freecadcmd`, PartDesign + tessellate)
- [x] Sidecar: JSON-RPC server, demo pad, scene buffers (faces + edges), tree
- [x] Electron shell: main process spawns + supervises sidecar (with auto-respawn
      on a hard OCCT crash, plus periodic autosave-to-temp + a recover-on-reopen
      prompt so a crash doesn't also cost unsaved work)
- [x] three.js viewport: shaded solid + crisp edge overlay, Z-up
- [x] Orbit / pan / zoom controls - free trackball orbit (tumbles past either
      pole; the original Fusion-style pole-locked mapping was tried first, then
      replaced after the user found it too constrained)
- [x] Nav cube
- [x] Ribbon + browser + timeline strip - real, not placeholder
- [x] Run instructions verified on this machine

Exit criterion (met): user orbits the demo pad and says the feel is close enough to
commit.

## Milestone 1 - single-part modeling (done)

- [x] Sketch environment: plane/face pick, line/rect/circle/arc, drag, dimension,
      constraints, live solve (Sketcher solver headless)
- [x] Features: Extrude (Pad/Pocket), Revolve, Hole, Fillet, Chamfer, Shell, Rib,
      Draft, Combine, Mirror, Pattern (rect/circular), datum planes/axes/points
- [x] Timeline: reorder (drag), rollback marker, edit-on-double-click, error badges,
      groups
- [x] Browser: origin, sketches, bodies, construction; rename; show/hide; folders;
      recursive search by name AND by registry name/description (e.g. searching
      "connector" finds a part whose filename gives no hint)
- [x] Selection: face/edge/vertex pick mapped to stable FreeCAD topology refs
- [x] Measure, section analysis, appearance/color
- [x] Save/open `.FCStd`, export STEP/STL/3MF

## Milestone 2 - assemblies (done)

- [x] Multi-document: components link external `.FCStd` by relative path
- [x] Joints: rigid, revolute, slider, cylindrical, planar, ball; as-built joints
- [x] Joint origins / triad snapping UI
- [x] Assembly-level browser tree, per-instance transforms in the viewport, explode view
- [ ] Interference check, contact sets, motion drag - not built yet

## Milestone 3 - sheet metal + surface splitting (partial)

- [ ] Sheet metal via the SheetMetal addon: only base flange (`sheet.baseFlange`)
      exists so far. Edge flange, miter, hem, unfold/flat pattern, bend allowance
      (K-factor), and corner relief are all still ahead.
- [x] Surface splitting: real surface creation (ruled, fill, stitch, offset) and
      splitting a solid body by a surface (`body.split`, `feature.splitFace`)

## Milestone 4 - drawings (done)

The single largest subsystem in the app (40+ RPC methods) - built well past
the milestone's original scope:

- [x] Custom 2D environment on top of the TechDraw projection engine: view
      placement (front/top/right/iso + custom), section/detail/broken views,
      click-to-dimension, dimension tables, balloons, BOM/kit tables, title
      blocks, sheet templates (including a company-branded one)
- [x] PDF export (headless, via `rsvg-convert` - FreeCAD's own print-to-PDF can't
      run headless)
- [ ] DXF / SVG export - not built (PDF covers the actual workflow so far)

(The interim "just embed real TechDraw" option in the original plan was never
needed - the custom environment above shipped directly.)

## Milestone 5 - packaging (mostly done)

- [x] Bundle FreeCAD headless as the sidecar per OS, trimmed (GUI/FEM/BIM/CAM/
      OpenVINO/LLVM stripped, verified against a full headless round-trip)
- [x] Linux: AppImage + .deb, both self-contained (nothing else to install)
- [x] Windows: NSIS installer (buildable from Linux via wine, or natively)
- [ ] Auto-update (electron-updater) - not started; version bumps today are
      manual (`scripts/package.sh`) and distributed by hand
- [x] First-run wizard: viewport background/shading, mesh import fidelity cap
      (not the original "units, theme, mouse mapping preset" list verbatim,
      but the same idea - the choices that turned out to actually matter)

## Company PN registry + git sync (built after the original plan, not in it)

Not part of the original Fusion-360-replacement scope at all, but now one of
the largest and most load-bearing subsystems in the app - a real company part-
numbering system with git as its concurrency control:

- [x] PN registry: reserve/list/history/lifecycle, one shared git repo per
      project + a shared registry repo, unique-PN collision handling via
      pull-mutate-commit-push retry (28 RPC methods across partnumbers.py +
      supplier_models.py)
- [x] Company parts repo organized `<project>/<type>/<PN>/<PN>.FCStd` (grouped
      for browsing by hand, not flat)
- [x] Supplier-model pipeline: auto-fetch a purchased part's 3D model, generate
      a minimal reference drawing, promote to `active` with STEP+PDF export to
      the dealer portal
- [x] Auto git-sync on open/save (pull-before-open, push-after-save, offline
      indicator), a standalone-open blocking lock with staleness-based reclaim,
      and a soft upstream-change watch (Sync / Review-as-a-peek / Push-mine-
      over-theirs) for assembly components and already-open files
- [x] A real automated test suite for this subsystem (`sidecar/tests/`, run via
      `sidecar/scripts/run_tests.sh`) - added after a flat-path assumption broke
      silently during the folder reorg above and was only caught by a manual
      audit; the tests exist so that class of regression fails on its own next time

## Cross-cutting / known risks

- Interactive sketching fluidity is the single biggest UI subsystem - still true,
  and still holds up.
- Topological naming: FreeCAD can renumber faces/edges on edits; picking layer
  must resolve refs defensively and surface "lost reference" like Fusion does.
- Mesh transfer over JSON is fine for parts; assemblies needing binary transfer
  (Draco / meshopt or a raw ArrayBuffer channel) hasn't come up as a real
  bottleneck yet - revisit if a large assembly's scene payload becomes slow.
- TechDraw has some historical GUI coupling; every op has been verified under
  freecadcmd as it was built, not assumed.
- The sidecar holds exactly one live FreeCAD document at a time - a hard crash
  loses in-memory state (mitigated by autosave-to-temp + recovery prompt, not
  eliminated), and a genuine side-by-side version comparison (see the git-sync
  "Review" feature) is a read-only peek, not two real documents open at once.
