# Milestone 0 status

Updated 2026-08-29.

## Verified working on this machine

- **Headless FreeCAD kernel** (FreeCAD 1.1.1 AppImage, extracted): `freecadcmd`
  runs the sidecar with no GUI. PartDesign Body > Sketch > Pad builds; shape is
  valid; tessellation and STEP export succeed.
- **Sidecar JSON-RPC server** (`sidecar/server.py`): loopback HTTP, 7 methods,
  single-threaded dispatch, orphan self-exit guard. Smoke-tested with curl:
  `ping`, `demo.pad`, `scene.get` (6 faceGroups + 12 edges + correct 60x40x15
  bbox), `io.exportStep`, error path.
- **Electron shell** builds clean (`electron-vite build`), typechecks clean
  (renderer + main). Launches, spawns the sidecar on an ephemeral port, runs
  `ping` -> `demo.pad` -> `scene.get` + `tree.get` over IPC with no renderer
  errors and no WebGL failures. Clean shutdown.
- **UI shell** present: Fusion-style ribbon (SOLID tab wired to build the demo
  pad via "Extrude"), fixed-shape browser, floating bottom-center timeline strip
  reading the real feature tree.

## Not yet checked (needs the user, or is next up)

- **The actual reason for M0: viewport feel.** Nobody has orbited the pad yet.
  `CadControls` implements the Fusion default map (middle=pan, shift+middle=orbit,
  wheel=zoom-to-cursor), constrained orbit, exponential inertia. All of it needs
  a human hand to judge. This is the go / no-go.
- Screenshotless environment here (no xvfb / screen-grab tools, Wayland
  compositor not capturable), so no rendered image was produced by the build
  process. Run `scripts/dev.sh` locally to see it.
- Nav cube not built yet.
- Selection / picking not built yet (faceGroups are already streamed for it).

## Known issues / follow-ups

- Sidecar lifecycle: if the Electron main is SIGKILLed, the sidecar now
  self-exits when it detects it has been reparented to PID 1. A tighter coupling
  (parent holds the child's stdin; child exits on EOF) is the real fix - do it
  before packaging.
- Renderer bundle is ~1 MB (three.js). Fine for desktop; split later.
- `demo.*` RPC methods are throwaway scaffolding, removed at Milestone 1.

## How to run

```bash
cp config.example.json config.local.json   # then edit "freecadcmd" path
scripts/sidecar-dev.sh                       # (optional) sidecar alone + curl
scripts/dev.sh                               # full app
```
