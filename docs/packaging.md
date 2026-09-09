# Packaging a standalone GWT-CAD

Goal: an end user with no FreeCAD, no Python, and no command line downloads one
file, runs it, and clicks a desktop shortcut. Nothing else to install.

## What ships in the bundle

| Piece | Where it comes from | Where it lands |
|---|---|---|
| Electron app (main + preload + renderer) | `electron-vite build` | `resources/app.asar` |
| Python sidecar (`sidecar/`) | repo, minus `__pycache__` / `*.pyc` | `resources/sidecar/` |
| Headless FreeCAD 1.1.1 | `config.local.json` -> `freecadcmd` | `resources/freecad/` |

At runtime `app/src/main/sidecar.ts` resolves the engine as:

1. `resources/freecad/usr/bin/freecadcmd` (Linux) or
   `resources/freecad/bin/FreeCADCmd.exe` (Windows) - the bundled copy;
2. failing that, `config.local.json`'s `freecadcmd` (dev checkout);
3. failing that, bare `freecadcmd` on `PATH`.

So the same build runs from a dev tree and from an installed package.

## Build commands

```bash
scripts/package.sh linux     # AppImage + .deb
scripts/package.sh appimage  # just the AppImage
scripts/package.sh deb       # just the .deb
scripts/package.sh win       # NSIS installer (.exe); from Linux needs `wine` in PATH
scripts/package.sh dir       # unpacked dir, fast, for smoke testing
```

Outputs land in `app/release/`. `scripts/package.sh` first copies the FreeCAD
engine into `app/resources/freecad/`, then runs the matching
`npm run pack:*` (electron-builder).

electron-builder downloads a few small helper binaries on first run
(`appimage-*.7z`, electron itself if not cached, `fpm` for `.deb`). After that
it works offline.

## FreeCAD trim

A full FreeCAD 1.1.1 AppDir is ~3.1 GB. `scripts/package.sh` removes the parts
the headless sidecar never touches, bringing the bundle to ~2.3 GB:

- the GUI executable and `libFreeCADGui.so`
- every `Mod/*/Gui`
- GUI-only workbenches: Start, Web, Inspection, AddonManager, Help, BIM, Fem,
  CAM, OpenSCAD, Tux, Idf
- `share/doc`, `share/man`, `share/locale`, translations, bundled examples
- LLVM / libclang / OpenVINO (shader JIT + ML, unused headless)
- Python `test/` and `tests/` dirs, all `__pycache__`

After trimming, the script runs a headless import of
`Part, PartDesign, Sketcher, Mesh, MeshPart, Import, Materials, TechDraw, Draft`
and, if it fails, rebuilds the bundle untrimmed automatically. Set
`GWTCAD_NO_TRIM=1` to skip trimming entirely.

If you add a sidecar feature that imports another FreeCAD module, add it to the
verification import list in `scripts/package.sh` and re-test a packaged build.

## Windows

- `scripts/package.sh win` produces `GWT-CAD-Setup-<ver>.exe` (NSIS): a normal
  install wizard - choose folder, creates a desktop + Start-menu shortcut,
  offers "run now" at the end. Per-user by default (no admin prompt).
- Point `config.local.json`'s `freecadcmd` at a Windows FreeCAD's
  `bin\FreeCADCmd.exe`; the script detects the `bin/` layout and bundles that
  install tree verbatim (no trim on Windows).
- Building the `.exe` on a Windows host: `cd app && npm run pack:win`.
- Building it from Linux: install `wine` and run `scripts/package.sh win`.

## macOS

Not targeted. It needs a Mac to build and test, plus an Apple Developer ID for
code-signing and notarization (Gatekeeper blocks unsigned apps outright). See
`docs/roadmap.md`.

## Code signing

Left unconfigured so unsigned dev builds still produce.

- **Windows:** set `CSC_LINK` (path or base64 of a `.pfx`) and
  `CSC_KEY_PASSWORD` in the environment before `pack:win`. Without a cert,
  SmartScreen warns the user on first run.
- **Linux:** AppImage / `.deb` are not signed; distribute a `sha256sum`
  alongside.

## First run

`app/src/renderer/ui/FirstRun.tsx` shows once (guarded by a
`gwtcad.firstRun.done` localStorage flag), asking for viewport background +
shading and the mesh-import triangle cap. The E2E harness suppresses it via
`window.cad.isE2E`.

## Verifying a packaged build

```bash
scripts/package.sh dir
cd app/release/linux-unpacked
unset ELECTRON_RUN_AS_NODE          # otherwise electron starts as plain node and exits
DISPLAY=:1 ./gwt-cad
```

Expect `[main] sidecar ready on 127.0.0.1:<port>` and the sidecar process
running from `resources/freecad/usr/bin/freecadcmd`, then `scene.get` /
`tree.get` returning `200`.
