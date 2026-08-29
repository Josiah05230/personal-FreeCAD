# Feedback tracker

Running checklist of user feedback from live testing. `[x]` done, `[~]` partial,
`[ ]` open. Newest batches at the bottom.

## Batch 1 - first look

- [x] View cube missing (top-right)
- [x] Browser: float it, drop the docked-sidebar / folder style
- [x] Tabs for multiple open designs
- [x] Waffle opens a left vertical banner that browses file directories
- [x] Timeline full-width, left-aligned (not centered)
- [x] Never show "Pad" / FreeCAD op names
- [x] Ribbon tools need icons
- [x] Add color (Fusion blue), not all grey
- [x] Remove the ground grid
- [x] Fix see-through / wireframe faces (double-sided material)

## Batch 2 - after run

- [x] View cube too small (bumped 96 -> 132; batch 5 says still too small)
- [x] Timeline needs play/stop
- [x] Timeline buttons too small
- [x] Timeline: no right scrollbar; horizontal only
- [x] Timeline needs a scrubber
- [x] Timeline items: double-click + right-click actions
- [x] Waffle open shifts ribbon + tabs right (push layout)
- [x] Model-tree visibility toggles
- [x] Ribbon too short / had a scrollbar
- [x] "Create" etc. dropdowns show the feature list
- [~] Wire the actual tools (box/cyl/fillet/chamfer/shell/hole/pattern/mirror/
      plane done; revolve/loft/draft/combine/circular done; sweep needs 2 sketches)
- [x] Dark theme background + material
- [x] "s" command-palette search
- [~] Save / Save As / export / import (save/open/STEP/STL/import wired; no PDF/DXF)
- [x] Data Panel: trim folders to those with compatible files
- [x] Git-tracked models + history/branch view (read-only history panel)

## Batch 3 - build everything

- [x] Interactive 2D sketcher (line/rect/circle/arc, grid + endpoint snap,
      finish -> real Sketcher sketch -> extrude/revolve)
- [x] Revolve / Sweep / Loft / Draft / Combine / Circular Pattern wired
- [x] Drawings: auto overall dims + click-to-dimension tool, title block, BOM
      table (assemblies), PDF (printToPDF) + DXF (R12) export
- [x] Measure (length/area/distance/angle) + Section (live clipping plane)
- [~] Sheet metal: Base Flange (SheetMetal addon or pad fallback). Richer
      flange/unfold features deferred (low priority)
- [x] Body split by a plane (SURFACE > Split Body). Full surface modelling
      deferred (low priority)
- [x] Packaging: electron-builder config (AppImage + NSIS), FreeCAD bundled as
      extraResources, runtime path resolution, scripts/package.sh; --dir build
      verified

## Batch 4 - timeline / origin / visibility

- [x] Scrubber should be a draggable marker (vertical line + grab handle
      between features), not a scrollbar
- [x] Model must reflect the rolled-back state
- [x] Right-click "Move timeline here"
- [x] Multiple bodies from "sketch + extrude" was confusing -> real sketcher
      means Extrude adds to the sketch's body; primitives still make new bodies
- [x] Hidden bodies looked "permanently gone" -> tree still lists them, eye
      toggles them back; group toggles added
- [x] Origin needs the origin point + 3 axes (not just planes)
- [x] Control visibility of sketches + planes (origin + construction datums)
- [x] Group visibility (all bodies / all origin / all sketches)

## Batch 5 - offset plane / dropdowns / selection filter

- [x] Offset plane "did nothing" -> new datums now auto-show
- [x] Offset Plane now consumes a plane/face selection (needs 'plane'); the
      old dropdown is gone
- [x] Create/Modify dropdowns did nothing -> fixed (were clipped by overflow)
- [x] Selection filter tool (paint / window / face / edge / point ...)
- [x] Move selection filter into the ribbon as a dropdown with checkboxes;
      paint vs window select mutually exclusive (radios)

## Batch 6 - view cube / selection filter placement

- [x] View cube still too small (now 150px, reads mount size)
- [x] View cube needs a Home button
- [x] View cube hover highlight (faces; edges/corners still TODO)
- [x] View cube right-click a face -> Set as Front / Top / Right, cube follows
- [x] Orbit locks past 90deg -> now free orbit (yaw stays level, pitch tumbles
      over the poles without clamping)
- [x] Selection filter -> ribbon dropdown w/ checkboxes; paint vs window radios
- [x] Window select: drag a rubber-band box; faces whose centroid is inside get
      added to the selection
- [x] View cube: 26 pick zones (6 faces + 12 edges + 8 corners), hover-highlit,
      click any to snap

## Batch 7 - formats / insert / data panel / select group / view cube / scale / sketch planes

- [x] Import/export: STEP/IGES/BREP + STL/OBJ/3MF/PLY/OFF; multi-body files land
      as separate objects, each a distinct palette colour. (File-embedded colours
      still not read - limited headless.)
- [~] Insert canvas: image on a plane via the INSERT tab, calibrate by ratio,
      and it now persists (companion `<file>.gwtcad.json`). In-viewport
      drag-a-line-to-calibrate and PDF pages are still TODO.
- [x] Data Panel: New Design / New Folder buttons at any level
- [x] Selection filter is now a "Select" group on the SOLID tab
- [x] View cube: selectable edges + corners (26-zone cube)
- [x] Modify > Scale (factor) + Convert Units (mm/cm/m/in/ft/thou)
- [x] Create Sketch: click an origin/construction plane or a face in the
      viewport (ghost planes, no popup); visibility not auto-toggled

## Batch 8 - progress UI / timeline insert / tool selection / drawings

- [x] Busy spinner + "Working..." in the status bar during any RPC call
- [x] New feature inserts at the rollback marker; the marker follows the tip
      forward so the scrubber lands just after what you made
- [x] Right-click a sketch -> "Edit Sketch" (reopens with its geometry); the
      context menu is clamped to the viewport (no more overflow scrollbars)
- [x] Rolled-back features are suppressed: not rendered, greyed + non-toggleable
      in the tree
- [x] Tool selection reworked: model-tree rows selectable; Mirror / Offset Plane
      / Circular Pattern take a plane/axis from the selection (tree plane or flat
      face), no dropdowns; Combine takes selected bodies; sidecar resolves
      origin/construction/face/edge refs
- [x] Can Claude drive the UI live? No - no display capture/input in this env
- [x] Inspect (Measure/Section) moved to a group on the SOLID tab
- [x] Drawings rebuilt: opens a blank ISO-A3 sheet (border + title block); Add
      View one at a time + drag to place; Auto-layout is an explicit button

## Deferred / not done

- Assembly joint SOLVING (joints recorded + round-trip; MbD solver is GUI-coupled
  headless) - needs a headless-solver path or an embedded GUI session
- Sheet metal beyond Base Flange; the SheetMetal addon's richer features
- Canvas: drag-a-line-on-the-image calibration, multi-page PDF underlays
- Git panel write ops (commit / checkout / diff from the UI)
- Manual sketch constraints + dimensions (auto H/V/coincident only today)
- File-embedded colours on STEP/3MF import (GUI-only in FreeCAD)
- Live packaged build with the real ~1GB bundled FreeCAD (pipeline verified with
  --dir; run `scripts/package.sh linux`)
