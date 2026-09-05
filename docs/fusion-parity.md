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

---

## Done in the third parity pass

- **Sweep** is now a real dialog (was an instant-apply direct-selection
  command): Operation (New body/Join/Cut/Intersect), Orientation (Path/Parallel
  -> AdditivePipe.Mode Frenet/Fixed), Transition (Transformed/Right corner/
  Round corner). Twist and partial-sweep Distance are not exposed - this
  FreeCAD 1.1.1 build's `AdditivePipe` has no Twist property and no percentage-
  along-path control.
- **Loft** gained Operation (same 4-way set) and Ruled / Closed checkboxes
  (`PartDesign::AdditiveLoft.Ruled`/`.Closed`). Rails/guide curves and
  tangent end-conditions are not exposed - not cleanly supported by this
  kernel's Loft binding.
- Both route cut/intersect/newbody through the same `_finish_transform` tail as
  Mirror/Pattern/Revolve now that it is generalised (`_FEATURE_NOUNS`),
  fixing a real crash along the way (see below).
- **Bug fix**: `_finish_transform`'s "no overlap" error path read `feat.TypeId`
  AFTER `d.removeObject(feat.Name)` had already deleted it, raising an opaque
  `ReferenceError: Cannot access attribute 'TypeId' of deleted object` instead
  of the intended message. Found via Sweep's new Intersect/New-body path;
  affects Mirror/Pattern/Revolve/Sweep/Loft alike. Fixed by capturing the
  feature's TypeId before any deletion.
- `fusion_features.js` extended to 81 checks (Sweep Join, Loft Ruled with a
  genuine offset section verified by bounding-box).

---

## Done in the fourth parity pass

- **Split Body by face or sketch**, not just a plane/datum (`needs: 'any'`,
  hint updated). Found and fixed two real bugs on the way:
  - A sketch reference resolves to `(sketch, ["Edge1"])` - an EDGE sub, not a
    face - so `body_split` was calling face-only `normalAt(u, v)` on an Edge
    and crashing with a wrong-arg-count TypeError. Now branches on the sub's
    own type instead of just truthiness.
  - **A real, higher-impact bug**: `PartDesign::Body.Tip.Shape` does NOT
    include the body's own `Placement`, only `Body.Shape` does. Every
    face/edge/vertex reference resolves through `Tip`, so referencing a face
    of a body that had been moved with the new Move/Copy (translate/rotate,
    no copy) silently used its PRE-move geometry. Tried making `_resolve_ref`
    return the Body instead of Tip generally - that breaks PartDesign's
    scoping rule (a new feature may only reference siblings in its OWN body's
    Group, not the Body container) with "Link(s) ... go out of the allowed
    scope" / "graph must be a DAG" for revolve axis / pattern direction /
    mirror plane - i.e. it fixed cross-body refs and broke the far more common
    same-body ones. Reverted that; fixed `body_split` locally instead by
    composing the owning body's `Placement` onto the extracted face's
    `CenterOfMass`/normal. Other cross-body-only consumers (Align, primitive
    placement, pipe path) were not hit by this in testing but carry the same
    latent risk if used against a moved body - noted in `_resolve_ref`'s
    docstring for the next pass to pick up if it bites.
- `fusion_features.js` extended to 88 checks (split by plane/face/sketch,
  including split by a face belonging to a body moved via Move/Copy).

---

## Done in the fifth parity pass

- **Extrude Two Sides now also works for Cut**, not just Join: a second
  pocket of the same profile, `Reversed` flipped, cutting the opposite way
  from the first. Verified: a 20mm-tall hole through the middle of a box,
  10mm cut each way from a mid-height datum plane, removes exactly the
  expected volume.
- `fusion_features.js` extended to 90 checks. Full suite green except the
  pre-existing `monkey.js` check 6.

Still open: Move/Copy of faces + features, Two Sides for Intersect/New-body,
Align of non-planar refs, coil/pipe plane placement, Sweep Twist/
partial-distance, Loft rails/guides.

---

## Done in the sixth parity pass

- **Scale is now a real, native, editable PartDesign feature**, not a baked
  derived shape. FreeCAD's PartDesign has no built-in Scale, but it does
  support scripted features (`PartDesign::FeaturePython`) that behave exactly
  like a native Pad/Fillet in the body's timeline - `body.newObject()` wires
  up `BaseFeature` and advances `body.Tip` automatically, same as any native
  feature. `sidecar/gwtcad/pdscale.py`'s `ScaleProxy.execute()` recomputes
  `BaseFeature.Shape` scaled by the current Uniform/Factor or per-axis
  properties every time - genuinely parametric (verified: edit the factor,
  the shape re-derives from the ORIGINAL pre-scale geometry every time, never
  compounding), editable through the real Scale dialog via `editFeature`
  (`feature.get`/`feature.update` disambiguate the shared
  `PartDesign::FeaturePython` TypeId by its own properties - `_scripted_kind`),
  and confirmed to survive a REAL close + reopen of the .FCStd with its Proxy
  correctly restored and still genuinely editable afterward. Bare
  `Part::Feature` targets (not inside a PartDesign body) and meshes keep the
  old baked/in-place approach - there is no PartDesign timeline to add a
  feature to.
- **Split Face is now also a real, native, editable PartDesign feature**,
  same `PartDesign::FeaturePython` approach: `sidecar/gwtcad/pdsplitface.py`'s
  `SplitFaceProxy.execute()` imprints a LIVE plane reference (an
  `App::PropertyLinkSub` to whatever it was picked from - an edge/face's
  owning object, a datum, or an origin plane) onto `BaseFeature.Shape` via
  `Part.Shape.generalFuse`. Editable (re-point the plane through the real
  dialog) and confirmed to survive close+reopen with the live reference
  intact. Found a real bug on the way: `generalFuse(shape, [tool_plane])`
  returns a compound of EVERY piece from both inputs, including the tool
  plane's own leftover slice outside the solid - the first version returned
  that whole compound as the feature's Shape, silently exploding the body's
  bounding box to the plane's own huge extent while still reading as "valid".
  Fixed by keeping only `compound.Solids` (the pieces that came from the base
  shape) and discarding the rest.
- `editfeature.js` extended (37 checks): both Scale and Split Face - create,
  edit via the real dialog, close+reopen, confirm still genuinely editable.

---

## Done in the seventh parity pass

- **MESH tab commands are now pinned to the ribbon face by default**
  (`ribbonPrefs.ts` `DEFAULT_PINNED`) - the tab is short enough that all nine
  commands fit without a fold-out.
- **`mesh.toSolid` now produces a real, fully-interactive `PartDesign::Body`**,
  not a bare `Part::Feature`. This was a real reported bug: a converted mesh
  used to be unsketchable (`sketch.onFace` calls `.newObject`/reads `.Origin`
  on the `bodyId` it is given, which only a `PartDesign::Body` has - a plain
  `Part::Feature` has neither and the call threw). Fixed by routing the
  converted shape through `build.scratch_body_from_shape` (the same
  `PartDesign::FeatureBase`-wrapping helper Mirror/Pattern's "New body" result
  already used) instead of `d.addObject("Part::Feature", ...)` directly.
  Verified via a headless script: sketch on a face of the converted body,
  fillet an edge of it (lands as a genuine `PartDesign::Fillet` in its
  timeline), then re-tessellate the result back to a mesh - all work.
- **Feature recognition: a new "Flats" conversion mode** rebuilds planar
  regions of the mesh as real, exact BRep faces instead of leaving them as
  hundreds of tiny triangle facets. Uses `Mesh.getPlanarSegments` (FreeCAD's
  own coplanar-region clustering - reliable and well-tested) to find regions,
  then `MeshPart.wireFromMesh` on a per-region sub-mesh to get each region's
  exact boundary wire(s), and `Part.Face` to build the real flat face (with
  holes cut from any interior wires). Only regions above a facet-count floor
  are accepted, so small planar tessellation noise (say, a rounded corner's
  tiny near-coplanar triangles) is not mistaken for a real designed flat.
  Everything left over (genuinely curved or freeform surface) stays faceted
  and is sewn together with the recognized flats into one shell/solid.
  Verified on a box-with-a-through-hole test case: 2 real flat faces
  recognized, remaining facets kept as-is, final solid valid with volume
  within 0.001% of the source. Round/cylindrical recognition (fitting a real
  `Part.Cylinder`/`Part.Cone` to a curved region) is NOT implemented - FreeCAD
  1.1.1's `getSegmentsByCurvature` needs a radius guess up front and did not
  reliably find anything on realistic test meshes even with a spread of
  guesses, so it was deferred rather than shipped fragile; "Flats" leaves
  rounds faceted. `mode="organic"` also degrades to this same flats pass
  (true NURBS surface fitting is unavailable in this build).
- **Mesh import fidelity**: a new Settings panel (`SettingsPanel.tsx`,
  `meshPrefs.ts`, localStorage-backed) lets the user cap imported mesh size -
  `io.importModel` now accepts `facetCap`/`autoSimplify` and, when a freshly
  imported `Mesh::Feature` exceeds the cap, decimates it down immediately
  (reusing `mesh.reduce`'s existing decimation) before it ever reaches the
  viewport. Default cap 200k triangles, toggle to disable. Guards against a
  raw scan / dense sculpt export (tens of millions of triangles) freezing the
  viewport and every mesh tool run on it.
- `fusion_features.js`'s MESH section gained 3 checks: `mesh.toSolid` with
  `mode:'flats'` produces a valid result, a new body appears in the tree, and
  - the actual regression test - picking a face of that body and hitting
  Create Sketch through the real bridge successfully enters the sketcher.

Still open (feature recognition): cylinder/cone recognition for rounds (fast
follow once a reliable fitting approach is found), NURBS/organic surface
fitting.
