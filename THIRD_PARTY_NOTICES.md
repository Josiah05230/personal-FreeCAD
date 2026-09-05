# Third-party notices

## FreeCAD

This project drives FreeCAD (https://www.freecad.org/) as a headless
subprocess (`freecadcmd`) over local JSON-RPC. FreeCAD is not modified,
statically linked, or otherwise combined with this project's own code - it is
invoked as a separate, unmodified interpreter/engine process, and every
FreeCAD Python module this project imports (`FreeCAD`, `Part`, `PartDesign`,
`Sketcher`, `TechDraw`, `Mesh`, `MeshPart`, `Materials`, ...) is used only at
runtime through that subprocess boundary.

FreeCAD is licensed under the GNU Lesser General Public License v2.1 or later
(LGPL-2.1-or-later); some FreeCAD modules and bundled dependencies carry their
own compatible licenses. See https://github.com/FreeCAD/FreeCAD/blob/main/LICENSE
and https://wiki.freecad.org/Licence for the authoritative terms.

A packaged build of this application (`scripts/package.sh`) may bundle an
unmodified FreeCAD AppImage/build alongside the Electron app so a fresh
install does not require a separate FreeCAD installation. The bundled copy's
own license file is included in that distribution.

## Node.js / npm dependencies

`app/package.json` and `app/package-lock.json` list every JavaScript/
TypeScript dependency (Electron, React, three.js, Vite, and their
transitive dependencies) along with the license each package declares on
npm. Run `npx license-checker` from `app/` for a full report.
