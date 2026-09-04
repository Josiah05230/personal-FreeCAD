# Fusion 360 parity - SOLID + MESH

Scope the user asked for: everything in Fusion 360's **Design workspace, SOLID
tab and MESH tab**, plus the utilities that sit next to them (Inspect, Construct,
Select). Sculpt/Form, Surface, Sheet-Metal, Render, Simulation, Manufacture,
Drawings, Generative are OUT of this parity pass (Drawings and a thin
Sheet-Metal already exist; Surface is a stub tab).

Legend: [x] done and matches F360 - [~] present but needs correcting -
[ ] missing.

---

## SOLID tab

### CREATE

| F360 command | What it does in F360 | GWT-CAD |
|---|---|---|
| New Component | empty component (opt. from bodies), activates it | [~] `New Component` exists via Browser; no ribbon Create entry, no "from bodies" |
| Create Sketch | pick a plane/face, enter sketch | [x] `Create Sketch` |
| Create Form | T-Splines sculpt | OUT |
| Derive | link geometry/params from another doc | OUT |
| **Extrude** (E) | profile/face -> prism. Directions: One Side / Two Sides / Symmetric. Extent: Distance / To Object / All. Taper angle. Operation: New Body / Join / Cut / Intersect / New Component. | [~] have Distance / To object, Symmetric, Flip, Operation. MISSING: **Two Sides** (independent +/- distances), **Taper angle**, **All** extent, To-Object **offset direction/chain**. |
| **Revolve** | profile/face about an axis. Angle / Full / To Object. Operation set. | [~] axis dropdown + angle + cut. MISSING: **Full** toggle, **To Object**, **Two Sides**, Operation set (only Cut checkbox). |
| **Sweep** | profile along path. Chain, Orientation (Path/Parallel), Taper, Twist, Distance (partial sweep). Operation set. | [~] `feature.sweep` exists, no dialog fields (taper/twist/orientation/partial), no Operation. |
| **Loft** | sections + optional rails/centerline + guide. End conditions (tangent/direction). Operation set. | [~] `loft` sketches only, `cut` checkbox. MISSING: rails/guides, end conditions, Operation set. |
| **Rib** | open profile thickened to a solid down to the body. Depth options. | [~] `rib` thickness + flip. OK-ish. |
| **Web** | like Rib but a network of thin walls between profiles. | [ ] |
| **Emboss** | raise/recess text or sketch onto a face. | [ ] |
| **Hole** | simple / clearance / counterbore / countersink / spotface; drill point; depth = distance / to / all; thread. | [~] have simple / cbore / csink, diameter/depth/through. MISSING: **spotface**, **drill point angle** as its own field, **clearance-fit table**, thread. |
| **Thread** | cosmetic or modeled thread on a cylindrical face. | [ ] (FreeCAD PartDesign has no native thread; cosmetic-only note) |
| **Box** | 2-corner + height. Operation set. | [~] `primitive.box` w/h/d only - no place-on-face, no Operation, no dialog. |
| **Cylinder** | circle (center+radius) on a plane + height. Operation set. | [~] `primitive.cylinder` d/h only - same gaps. |
| **Sphere** | center + radius. | [ ] |
| **Torus** | center + inner path radius + section radius. | [ ] |
| **Coil** | on a plane: type (spiral/helix), diameter, revolutions, height/pitch, section (circular/square/...). Operation set. | [ ] |
| **Pipe** | path + section size + hollow (wall thickness). Operation set. | [ ] |
| Pattern (Rect / Circ / Path) | see Pattern group | [~] Rect + Circ (no Path). |
| Mirror | see Pattern group | [x] |
| Thicken / Boundary Fill / etc | surface | OUT |

### MODIFY

| F360 command | F360 behavior | GWT-CAD |
|---|---|---|
| **Press Pull** (Q) | context tool: edge -> Fillet, face -> Offset Face, sketch profile -> Extrude. One entry point. | [ ] |
| **Fillet** (F) | edges/faces/features. Constant / Variable radius, Chord length, Setback at corners, Rolling ball vs Smooth. Faces = all their edges. | [~] edges + (now) faces, constant radius only. MISSING variable radius, chord, setback. |
| **Chamfer** | Equal distance / Two distances / Distance-and-angle. Edges/faces. | [~] one distance only. MISSING two-distance + distance-angle modes. |
| **Shell** | remove faces, inside/outside/both, per-face thickness override. | [~] faces + one thickness. MISSING direction (in/out/both). |
| **Draft** | pull direction (plane/edge) + faces + angle; parting line / fixed plane. | [~] faces + angle + neutral. OK-ish. |
| **Scale** | body/sketch/component; Uniform or Non-Uniform (x/y/z); scale point. | [~] `body.scale` uniform factor only. MISSING non-uniform, scale point, dialog. |
| **Combine** | Target + Tools, Join / Cut / Intersect, Keep Tools, New Component. | [~] `feature.combine` op + keepTools. Verify UI selection model (target vs tools). |
| **Offset Face** | move selected faces normal by a distance (adds/removes material). | [ ] |
| **Replace Face** | replace face(s) with another surface/face. | [ ] (surface-ish, low priority) |
| **Split Face** | split a face with a plane / surface / sketch / along a direction. | [ ] |
| **Split Body** | body + splitting tool (plane/face/sketch/surface); keep both halves as bodies. | [~] `body.split` by plane only. MISSING face/sketch tool. |
| **Silhouette Split** | split body/face by the silhouette from a view direction. | [ ] (niche) |
| **Move/Copy** (M) | selection: bodies / components / faces / sketch objects / features. Modes: **Translate** (free XYZ manipulator), **Rotate** (axis + angle), **Point to Point**, **Point to Position**. **Create Copy** checkbox (+ copies count for translate/rotate). Set Pivot. | [~] `moveBody` (dx/dy/dz + rx/ry/rz at once) and separate `copyBody`. NOT F360: no modes, no point-to-point, no Create Copy on the move, no face/feature move. **THIS IS THE FLAGSHIP GAP.** |
| **Align** | align a body/component/face by picking from-geometry then to-geometry. | [ ] |
| **Physical Material / Appearance** | assign material / appearance. | [~] body colour only (Appearance-lite). |
| **Change Parameters** | the parameters table. | [x] `Parameters` panel. |
| **Delete** | delete selected feature/body/sketch. | [x] timeline / browser delete. |
| **Remove** (Delete Face) | defeature: remove face(s) and heal. | [ ] |

### ASSEMBLE
Component insert, Joint, Rigid Group, As-Built Joint, Joint Origin, Motion,
Contact. GWT-CAD has Insert Component + Joint (2-face) + ground; solving is
experimental. Rigid Group is a stub. Not part of this parity pass beyond
wiring `Rigid Group`.

### CONSTRUCT
Offset Plane, Plane at Angle, Tangent Plane, Midplane, Plane Through Two Edges,
Plane Through Three Points, Plane Tangent to Face at Point, Plane Along Path;
Axis Through Cylinder/Cone/Torus, Axis Perp at Point, Axis Through Two Planes,
Axis Through Two Points, Axis Through Edge, Axis Perp to Face at Point;
Point at Vertex, Point Through Two Edges, Point Through Three Planes, Point at
Center of Circle/Sphere/Torus, Point at Edge and Plane, Point Along Path.

GWT-CAD: **the datum rework already collapses these** into Plane / Axis / Point
with reference-set detection (1 face+offset, 1 edge+angle, 2 edges, 2 faces =
midplane, 3 points, edge-axis, face-normal-axis, 2-plane-intersection-axis,
vertex-point, edge-midpoint-point, 2-edge-point). [x] for the common variants;
"Along Path" and "tangent to face at point" not covered - [ ].

### INSPECT
Measure [x] - Interference [ ] - Curvature Comb/Map, Zebra, Draft Analysis [ ]
(analysis-only, low priority) - Section Analysis [~] (live Section tool, not a
saved analysis) - Center of Mass [ ] - Component Color Cycling [n/a].

### SELECT
Selection filter menu [x].

---

## MESH tab

Fusion shows this tab in mesh mode / when a mesh body is present.

| F360 command | Behavior | GWT-CAD |
|---|---|---|
| Insert Mesh | import STL/OBJ/3MF as a mesh body, with units/position | [~] import exists (goes straight to a mesh body) |
| Mesh from BRep... no - **BRep to Mesh** (Modify) | tessellate a solid body into a mesh body, controllable density | [ ] |
| Mesh primitives (Box/Sphere/Cylinder/Torus/Plane) | mesh versions of the primitives | [ ] (low priority) |
| **Remesh** | rebuild triangulation (adaptive/uniform), density slider, preserve sharp edges/boundaries | [ ] |
| **Reduce** | decimate to a target face count / proportion / max deviation | [ ] |
| **Smooth** | Laplacian-style smoothing, strength + iterations, keep boundary | [ ] |
| **Plane Cut** | cut the mesh with a plane; keep one/both sides; optionally fill the cut | [ ] |
| **Make Closed Mesh** | wrap/offset into a watertight mesh | [ ] (approx via repair + hole fill) |
| **Erase and Fill** | delete selected faces and re-triangulate the hole | [ ] |
| **Delete Faces** | delete selected mesh faces | [ ] |
| **Separate** | split disconnected shells into separate mesh bodies | [ ] |
| **Repair** | fix non-manifold edges, flipped normals, small holes, self-intersections | [ ] |
| **Reverse Normals** | flip face normals (all or selected) | [ ] |
| **Scale** | scale a mesh body (uniform / non-uniform) | [~] via `body.scale` if it targets meshes |
| **Generate Face Groups** | segment the mesh into planar/curved face groups | [ ] (feeds "prismatic" convert) |
| **Convert Mesh** (BRep) | mesh -> solid: Faceted / Prismatic / Organic | [~] a basic "Convert Mesh" exists (faceted only) |

---

## Implementation plan for this pass (priority order)

1. **Move/Copy** - real F360 model. New `move` op replacing `moveBody`/`copyBody`.
   Modes Translate / Rotate / Point to Point; `Create Copy` (+ count); selection
   = bodies (faces/features are a follow-up). Sidecar `body.moveCopy`.
2. **Primitives**: `box`, `cylinder`, `sphere`, `torus` as first-class ops with a
   dialog (dims + Operation New Body/Join/Cut/Intersect + optional plane/face
   placement). Additive PartDesign primitives so they land in the timeline.
   `coil` and `pipe` too.
3. **Extrude**: Two Sides (start/end distance), Taper angle, "All" extent.
   **Revolve**: Full toggle, Operation set (New Body/Join/Cut/Intersect),
   Two Sides. **Chamfer**: Equal / Two distances / Distance-angle.
   **Shell**: direction (Inside/Outside/Both).
4. **Modify** additions: `pressPull` (context wrapper), `offsetFace`,
   `splitFace`, `scale` dialog (uniform / non-uniform), Split Body by
   face/sketch, `align`, `deleteFace` (defeature best-effort).
5. **Inspect**: `interference`, `centerOfMass`.
6. **MESH tab**: `mesh.fromBRep`, `mesh.reduce`, `mesh.smooth`, `mesh.planeCut`,
   `mesh.flipNormals`, `mesh.repair`, `mesh.separate`, `mesh.deleteFaces`,
   `mesh.toSolid` (faceted/prismatic/organic where the kernel allows).
7. Ribbon: reorganise SOLID Create/Modify/Construct/Inspect to mirror F360's
   panel order and names; add a real **MESH** tab.

Deferred (noted, not done this pass): Thread, Web, Emboss, Silhouette Split,
Replace Face, curvature/zebra/draft analysis, Derive, Create Form, mesh
primitives, "Plane Along Path" / "Tangent to face at point" datums, generative
face groups. Each is a small ticket on top of the framework this pass builds.

---

## Done in the first parity pass (commit set on top of `bd8dfef`)

- **Move/Copy** (`move`): replaces the old `moveBody` + `copyBody`. Modes
  Translate (X/Y/Z) / Rotate (axis + angle) / Point to Point; **Create Copy**
  with a copies count. Sidecar `body.moveCopy` (`sidecar/gwtcad/xform.py`).
- **Scale** (`scale`): Uniform factor or per-axis, dialog-driven. `body.scaleBody`
  (bakes a derived Part::Feature, hides the source - noted non-parametric).
- **Align** (`align`): pick FROM face then TO face, mates them. `body.align`.
- **Primitives**: `box` / `cylinder` / `sphere` / `torus` / `coil` / `pipe`
  as first-class ops with a dialog (dims + Operation New body/Join/Cut/Intersect).
  Native `PartDesign::Additive*` / `Subtractive*`; coil = helix pipe-shell;
  pipe = swept section along picked path edges (hollow supported).
  `sidecar/gwtcad/primitives.py`. (planeRef placement accepted but not yet
  honoured - primitives build on the body origin.)
- **Press Pull** (`pressPull`, hotkey Q): edge -> fillet, face -> offset face.
- **Offset Face** (`offsetFace`): face pad/pocket by a signed distance.
- **Split Face** (`splitFace`): imprint a plane onto a face (derived
  Part::Feature, non-parametric).
- **Revolve**: gained the Operation set (New body / Join / Cut / Intersect) and
  a **Full (360)** toggle. New body / Intersect route through the same
  `_finish_transform` path Mirror/Pattern use.
- **Chamfer**: Equal / Two distances / Distance and angle modes
  (`PartDesign::Chamfer.ChamferType`).
- **Inspect**: `interference` (pairwise common volume) and `centerOfMass`
  (`sidecar/gwtcad/xform.py`), surfaced as ribbon commands.
- **MESH tab** (new): BRep to Mesh, Reduce, Smooth, Plane Cut, Reverse Normals,
  Repair, Separate, Convert Mesh. `sidecar/gwtcad/meshtools.py`. Plane Cut keeps
  whole facets by side (no re-triangulation along the cut); Convert Mesh
  prismatic/organic degrade to faceted in this FreeCAD build.
- Ribbon reorganised toward F360 panel order; `test/e2e/scenarios/fusion_features.js`
  drives all of the above through the real dialog + bridge (61 checks).

Still to correct next: Extrude Two Sides + Taper + "All" extent; Shell direction
(Inside/Outside/Both); Sweep dialog (taper/twist/orientation/partial); Loft
rails/guides + end conditions; Combine target-vs-tools UI; primitive placement
on a picked plane/face; Split Body by face/sketch; parametric Scale / Split Face;
Move/Copy of faces + features (not just bodies).

---

## Done in the second parity pass

- **Hotkeys reset to F360's actual documented defaults** (help.autodesk.com +
  the Autodesk shortcuts page - most Fusion commands have NO default binding;
  only ~20 do). Fixed a real conflict: Measure was wrongly on `M` (that's
  Move in F360) - now `I` (F360 default). Added `H` Hole, `M` Move/Copy,
  `J` Joint. Left `E` Extrude, `F` Fillet, `Q` Press Pull as they already
  matched; kept GWT-CAD's own sketch-tool letters (L/R/C/D/X already match
  F360 too) and non-conflicting extras (`c s` Create Sketch, `f6` Fit) since
  F360 leaves those unbound rather than using something else.
- **Extrude Two Sides**: independent distances per side. `PartDesign::Pad`'s
  `Type="TwoLengths"` produces a null shape in this FreeCAD 1.1.1 build (a
  broken `?`-prefixed enum option) - implemented instead as two sequential
  additive pads of the same profile in opposite directions (join only for now).
- **Extrude "All"**: a `throughAll` checkbox (Cut + Blind only) -> Pad/Pocket
  `Type="ThroughAll"`.
- **Primitive placement**: Box/Cylinder/Sphere/Torus honour a picked plane /
  datum / face via `AttachmentSupport` + `MapMode="FlatFace"` (was ignored).
  Coil/Pipe still build on the origin.
- **Combine** dialog hint clarifies the target-then-tools pick order (the
  underlying `feature.combine` already treats the first selected body as the
  target, the rest as tools - this was a documentation gap, not a code one).
- `fusion_features.js` extended: Two Sides, All/Cut, primitive-on-plane,
  and a hotkey-dispatch check for the F360 defaults (91 checks total).

Still open: Sweep/Loft richer dialogs, Split Body by face/sketch, parametric
Scale / Split Face (both currently bake a derived, non-parametric shape),
Move/Copy of faces + features, Two Sides for Cut/Intersect/New-body, Align of
non-planar refs, coil/pipe plane placement.
