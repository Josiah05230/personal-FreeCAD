# Roadmap

Scope agreed with the user: a daily-driver replacement for Fusion 360 covering
part modeling, assemblies, drawings, sheet metal, and non-planar body splitting.
Linux and Windows. No Mac. No visible "workbench" concept anywhere.

Feel is a hard requirement: someone closing Fusion 360 and opening this should not
feel a downgrade in the viewport or the interaction model.

## Milestone 0 - viewport feel checkpoint (current)

Goal: prove the architecture and let the user judge orbit / pan / zoom feel.

- [x] Headless FreeCAD confirmed (1.1.1 AppImage, `freecadcmd`, PartDesign + tessellate)
- [ ] Sidecar: JSON-RPC server, demo pad, scene buffers (faces + edges), tree
- [ ] Electron shell: main process spawns + supervises sidecar
- [ ] three.js viewport: shaded solid + crisp edge overlay, Z-up
- [ ] Orbit / pan / zoom controls, first pass at Fusion-like mapping
- [ ] Nav cube
- [ ] Placeholder ribbon + browser + timeline strip (non-functional shell)
- [ ] Run instructions verified on this machine

Exit criterion: user orbits the demo pad and says the feel is close enough to
commit. This is a genuine go / no-go.

## Milestone 1 - single-part modeling

- Sketch environment: plane/face pick, line/rect/circle/arc, drag, dimension,
  constraints, live solve (Sketcher solver headless)
- Features: Extrude (Pad/Pocket), Revolve, Hole, Fillet, Chamfer, Shell, Rib,
  Draft, Combine, Mirror, Pattern (rect/circular), datum planes/axes/points
- Timeline: reorder (drag), rollback marker, edit-on-double-click, error badges,
  groups
- Browser: origin, sketches, bodies, construction; rename; show/hide; folders
- Selection: face/edge/vertex pick mapped to stable FreeCAD topology refs
- Measure, section analysis, appearance/color
- Save/open `.FCStd`, export STEP/STL/3MF

## Milestone 2 - assemblies

- Multi-document: components link external `.FCStd` by relative path
- Joints: rigid, revolute, slider, cylindrical, planar, ball; as-built joints
- Joint origins / triad snapping UI
- Interference check, contact sets, motion drag
- Assembly-level browser tree, per-instance transforms in the viewport

## Milestone 3 - sheet metal + surface splitting

- Drive the SheetMetal addon headless: base flange, edge flange, miter, hem,
  unfold / flat pattern, bend allowance (K-factor), corner relief
- Surface splitting: make/import a surface (or swept/extended surface from a
  sketch), split a solid body by it; keep both/either side

## Milestone 4 - drawings

- Interim: embed FreeCAD's real TechDraw window, restyled, so drawings work early
- Custom 2D environment on top of the TechDraw projection engine:
  view placement, click-to-dimension, GD&T, balloons, BOM table, title block,
  section/detail/broken views
- PDF / DXF / SVG export

## Milestone 5 - packaging

- Bundle FreeCAD headless as the sidecar per OS
- Linux: AppImage. Windows: Inno Setup installer + code-signing cert
- Auto-update (electron-updater)
- First-run: pick units, theme, mouse mapping preset

## Cross-cutting / known risks

- Interactive sketching fluidity is the single biggest UI subsystem
- Topological naming: FreeCAD can renumber faces/edges on edits; picking layer
  must resolve refs defensively and surface "lost reference" like Fusion does
- Mesh transfer over JSON is fine for parts; assemblies need binary transfer
  (Draco / meshopt or a raw ArrayBuffer channel) - revisit at Milestone 2
- TechDraw has some historical GUI coupling; verify each op under freecadcmd
