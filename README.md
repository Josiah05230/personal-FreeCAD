# GWT-CAD

A streamlined, Fusion-360-style CAD front-end that runs FreeCAD headless as its
geometry and parametric engine. No workbenches. One environment. Own viewport.

Working title. Rename freely.

## Why this exists

FreeCAD's kernel (OCCT geometry, the parametric document model, PartDesign, the
Sketcher constraint solver, TechDraw, the SheetMetal addon) is solid. Its GUI is
the part that feels wrong coming from Fusion 360. This project keeps the kernel
and replaces the entire front-end:

- Custom application shell (Electron + React): ribbon, timeline, browser, dialogs.
- Custom 3D viewport (three.js): orbit / pan / zoom / select / manipulators tuned
  to match Fusion feel.
- FreeCAD runs as a headless sidecar process, driven over local JSON-RPC, and
  still writes real `.FCStd` files so git history and the rest of the FreeCAD
  ecosystem keep working.

## Architecture

```
+-------------------+        JSON-RPC over        +--------------------------+
|  Electron shell   |  localhost HTTP (loopback)  |  FreeCAD headless sidecar |
|  React + three.js | <------------------------->  |  freecadcmd + server.py   |
|  (renderer)       |                             |  OCCT / PartDesign / etc. |
+-------------------+                             +--------------------------+
        |  spawns + supervises the sidecar (Electron main process)
```

- `sidecar/` - Python. Runs under FreeCAD's bundled interpreter (`freecadcmd`).
  Long-running JSON-RPC server. Owns the FreeCAD document.
- `app/` - Electron + Vite + React + TypeScript. The shell and viewport.
- `scripts/` - dev helpers.
- `docs/` - design decisions and scope.

## Status

Milestone 0 (in progress): sidecar builds a demo pad headless and streams render
buffers; Electron shell renders it and you can orbit. This is the "does the
viewport feel right" checkpoint before committing to the full build.

See `docs/roadmap.md`.

## Running (dev)

Requires a local FreeCAD 1.1+ (AppImage extracted, or system install with
`freecadcmd`). Point `config.local.json` at it (copy from `config.example.json`).

```bash
# 1. sidecar smoke test (no Electron)
scripts/sidecar-dev.sh

# 2. full app (spawns the sidecar itself)
cd app && npm install && npm run dev
```
