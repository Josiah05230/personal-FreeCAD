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

Milestone 0: the pipeline is built and verified end to end (headless FreeCAD ->
sidecar RPC -> Electron -> three.js). The one thing left for M0 is subjective and
needs a person: **orbit / pan / zoom feel**. Run it and judge. See
`docs/status-M0.md` and `docs/roadmap.md`.

## Running (dev)

Requires a local FreeCAD 1.1+ (AppImage extracted, or a system install that
provides `freecadcmd`). Copy `config.example.json` to `config.local.json` and set
the `freecadcmd` path.

```bash
cp config.example.json config.local.json   # edit "freecadcmd"
cd app && npm install && cd ..

scripts/dev.sh          # full app (Electron spawns the sidecar itself)
scripts/sidecar-dev.sh  # optional: run just the sidecar, poke it with curl
```

`scripts/dev.sh` clears `ELECTRON_RUN_AS_NODE` (some shells export it, which stops
Electron opening a window).

### Viewport controls (Fusion default map)

| Input | Action |
|---|---|
| Middle-drag | Pan |
| Shift + middle-drag | Orbit (constrained, horizon locked) |
| Wheel | Dolly, zoomed toward the cursor |
