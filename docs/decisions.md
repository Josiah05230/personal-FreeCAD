# Design decisions

Running log. Newest first. Each entry: what was decided, why, what it rules out.

## D-0004 - Per-face tessellation with hard edges between faces

Tessellate each `Shape.Face` separately and do NOT weld vertices across face
boundaries. Per-vertex normals are averaged only within a face. Result: smooth
shading inside a face, crisp normal discontinuity at every real edge - the
classic CAD look. Edges are streamed separately as polylines for a black overlay.
Rules out: a single welded mesh (would round off every edge visually).

## D-0003 - three.js viewport, not native GL, not Coin3D

The viewport is where "feels like Fusion" is won or lost, so it must be fully
ours. three.js gives a mature camera/controls/postprocessing ecosystem (orbit
inertia, OutlinePass selection, nav-cube implementations) so we tune feel instead
of writing matrix math. Rules out: reusing FreeCAD's Coin3D view (the thing we
are replacing), and hand-rolled WebGPU for v1 (revisit if perf demands).

## D-0002 - Electron + React + Vite + TypeScript for the shell

Web stack = fastest path to matching Fusion's visual density and iterating on
layout, plus three.js lives there natively. Cost: mesh data crosses a process
boundary as JSON for now. Accepted for v1; binary channel planned at Milestone 2.
Rules out: a from-scratch Qt/PySide shell (native, no IPC, but far more viewport
code and slower styling iteration) and a FreeCAD GUI fork (unbounded C++ merge
maintenance for a solo dev; still stuck with Coin3D).

## D-0001 - FreeCAD headless as the geometry/parametric kernel

`freecadcmd` runs the full document model, PartDesign, Sketcher solver, OCCT, and
export with no GUI. We drive it over local JSON-RPC and it writes real `.FCStd`,
so git history, the auto-commit addon, TechDraw, FEM, and assemblies all still
work. Rules out: building on raw OCCT / pythonocc (would mean reimplementing the
parametric document and the Sketcher solver) and skinning the FreeCAD GUI (feel
ceiling below requirement; workbench concept can only be hidden, not removed).

## D-0000 - Custom front-end over reskin

User requirement: viewport feel and a single streamlined environment with no
visible workbenches. A config/addon reskin cannot deliver either (Coin3D
viewport, Task-panel paradigm, workbench machinery all remain). Chosen path is a
new front-end (option C). Accepted cost: 12-20 months to full scope, sketching /
drawings / assemblies are the schedule risks.
