# GWT-CAD

A Fusion-360-style CAD application (parametric part modeling, assemblies,
drawings, sheet metal, KiCad interop) with its own Electron + React + three.js
front end, running FreeCAD headless as the geometry and parametric kernel. No
FreeCAD workbenches, no FreeCAD GUI - a single, own-designed environment
talking to FreeCAD over local JSON-RPC.

Everything you build stays a real, native `.FCStd` file: a genuine
`PartDesign::Body` feature tree (Sketch, Pad, Fillet, Mirror, ...) that opens
correctly in stock FreeCAD, with the full parametric history intact and
editable there too.

## Why this exists

FreeCAD's kernel (OCCT geometry, the parametric document model, PartDesign,
the Sketcher constraint solver, TechDraw, the SheetMetal addon) is solid. Its
GUI is the part that feels wrong coming from Fusion 360. This project keeps
the kernel and replaces the entire front end:

- Custom application shell (Electron + React): data-driven ribbon, timeline,
  browser, parameters panel, command palette, operation dialogs.
- Custom 3D viewport (three.js): orbit / pan / zoom / select / manipulators
  tuned to Fusion's feel, incremental scene reconcile.
- FreeCAD runs headless as a sidecar process, driven over local JSON-RPC, and
  writes real `.FCStd` files - git history, other FreeCAD installs, and the
  rest of the FreeCAD ecosystem keep working with what you save here.

## Status

All of Part Design (sketch, extrude/revolve/sweep/loft/rib, fillet/chamfer/
shell/draft/hole, patterns/mirror, primitives, datums, Move/Copy/Scale/Align),
a MESH tab, assemblies (insert/place/ground/joint), drawings (TechDraw-backed),
a first Sheet Metal slice, and KiCad PCB import have a working implementation
today - see `docs/status.md` for the full list and `docs/fusion-parity.md` for
a command-by-command comparison against Fusion 360's Design workspace (what
matches, what's approximated, what's not done and why). `docs/FEEDBACK.md` is
the live issue queue.

Every change is verified by headless FreeCAD engine tests plus a UI-driven
end-to-end suite that drives the real app through its `window.__gwtcad` test
bridge (`bash test/e2e/run.sh`), including a scenario that opens every
operation dialog and asserts its OK button actually becomes pressable
(`op_commit.js`) and a always-on fuzzer (`test/e2e/fuzz-loop.sh`).

## Architecture

```
+-------------------+        JSON-RPC over        +--------------------------+
|  Electron shell    |  localhost HTTP (loopback) |  FreeCAD headless sidecar |
|  React + three.js  | <------------------------> |  freecadcmd + server.py   |
|  (renderer)         |                            |  OCCT / PartDesign / etc.|
+-------------------+                             +--------------------------+
        |  spawns + supervises the sidecar (Electron main process)
```

- `sidecar/` - Python, runs under FreeCAD's own bundled interpreter
  (`freecadcmd`). A threaded JSON-RPC server with one dedicated engine worker
  thread; owns the one open FreeCAD document.
- `app/` - Electron + Vite + React + TypeScript. The shell and viewport.
- `test/e2e/` - the end-to-end suite and the always-on fuzzer.
- `scripts/` - dev / build / packaging helpers.
- `docs/` - design decisions, status, the Fusion-parity gap list, live feedback.

## Running (dev)

Requires a local FreeCAD 1.1+ (AppImage extracted, or a system install that
provides `freecadcmd`) and Node.js 18+.

```bash
cp config.example.json config.local.json   # edit the "freecadcmd" path
cd app && npm install && cd ..

scripts/dev.sh          # full app (Electron spawns the sidecar itself)
scripts/sidecar-dev.sh  # optional: run just the sidecar, poke it with curl
```

`scripts/dev.sh` clears `ELECTRON_RUN_AS_NODE` (some shells export it, which
stops Electron from opening a window).

### Running the test suite

```bash
bash test/e2e/run.sh                 # every scenario
bash test/e2e/run.sh test/e2e/scenarios/op_commit.js   # one scenario
bash test/e2e/fuzz-loop.sh            # seeded random walker, runs until it finds something
```

### Packaging a standalone build

`scripts/package.sh` builds an installer (AppImage / NSIS) via electron-builder
with FreeCAD bundled, so an end user does not need FreeCAD installed at all.
This is still early - see `docs/status.md`'s known gaps before relying on it.

## Viewport controls (Fusion default map)

| Input | Action |
|---|---|
| Middle-drag | Pan |
| Shift + middle-drag | Orbit (constrained, horizon locked) |
| Wheel | Dolly, zoomed toward the cursor |

## Contributing

Issues and PRs are welcome. `docs/decisions.md` has the reasoning behind the
big architectural calls (why a custom shell instead of a FreeCAD workbench,
why headless FreeCAD instead of reimplementing a kernel); `docs/fusion-parity.md`
is a good place to look for a well-scoped next task. No em dashes in code,
comments, or docs by house style - plain hyphens only.

## License

MIT - see `LICENSE`. FreeCAD itself is LGPL2+; a packaged build that bundles a
FreeCAD binary distributes it as a separate, unmodified interpreter invoked as
a subprocess (not linked into this code), per `THIRD_PARTY_NOTICES.md`.
