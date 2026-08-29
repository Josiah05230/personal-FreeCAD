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
- [ ] Sheet metal (low priority)
- [ ] Surface / body-split (low priority)
- [ ] Packaging: bundled installer (Win + Linux), signing, auto-update

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
- [ ] Offset-plane creation should filter selection to planes only (low prio -
      the op doesn't consume selection yet)
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
- [ ] Window select not yet functional (radio switches, still behaves as paint)
- [ ] View cube hover highlight for edges + corners
