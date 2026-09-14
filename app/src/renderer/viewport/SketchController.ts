/**
 * Interactive 2D sketching on a plane inside the 3D viewport.
 *
 * Owns pointer input while a sketch is active: projects the cursor onto the
 * sketch plane, applies grid / endpoint / origin / model-edge snapping, runs a
 * small state machine per tool, records manual constraints, and renders
 * committed + rubber-band geometry in world space. Emits plane-local (u,v mm)
 * entities the sidecar feeds straight to Sketcher.
 */
import * as THREE from 'three'
import { trace } from '../trace'

export type SketchTool =
  | 'select'
  | 'line'
  | 'rect'
  | 'rect-center'
  | 'circle'
  | 'circle-3p'
  | 'arc'
  | 'arc-3p'
  | 'spline'
  | 'dimension'
  | 'project'

type SnapKind = 'grid' | 'origin' | 'point' | 'edge' | 'axis'
type DragHandle = 'a' | 'b' | 'ab' | 'ba' | 'c' | 'r' | 'a0' | 'a1' | 'whole'

export type SketchConstraintType =
  | 'Horizontal'
  | 'Vertical'
  | 'Parallel'
  | 'Perpendicular'
  | 'Equal'
  | 'Tangent'
  | 'Coincident'
  | 'Concentric'
  | 'Midpoint'
  | 'PointOnObject'

/** Result of a round-trip to the headless constraint solver. */
export interface SketchSolveResult {
  geometry: Array<
    | { type: 'line'; a: [number, number]; b: [number, number] }
    | { type: 'circle'; c: [number, number]; r: number }
    | { type: 'arc'; c: [number, number]; r: number; a0: number; a1: number }
    | null
  >
  free: number[]
  fullyConstrained: boolean
  /** 0-based indices into the constraints array that was passed in */
  conflicting?: number[]
  redundant?: number[]
  partiallyRedundant?: number[]
  malformed?: number[]
}

export type SketchSolveFn = (
  elements: SketchEntity[],
  constraints: RecordedConstraint[]
) => Promise<SketchSolveResult | null>

export interface SketchFrame {
  origin: [number, number, number]
  x: [number, number, number]
  y: [number, number, number]
  z: [number, number, number]
}

export interface SketchRefGeom {
  polys: number[][][]
  points: number[][]
}

export type SketchEntity = (
  | { type: 'line'; a: [number, number]; b: [number, number] }
  | { type: 'rect'; a: [number, number]; b: [number, number] }
  | { type: 'circle'; c: [number, number]; r: number }
  | { type: 'arc'; c: [number, number]; r: number; a0: number; a1: number }
  | { type: 'spline'; pts: [number, number][] }
) & { construction?: boolean; projected?: boolean }

export interface RecordedConstraint {
  type:
    | SketchConstraintType
    | 'Distance'
    | 'Radius'
    | 'Diameter'
    | 'Angle'
    | 'PointOnObject'
    | 'Symmetric'
  refs: Array<{ new?: number; geo?: number; sub?: number; pt?: number }>
  value?: number
}

/** an individual geometry point: pt 1 = start, 2 = end, 3 = centre.
 *  `e: -1` is the sketch ORIGIN point (pt is 1 by convention). */
export type PtRef = { e: number; pt: 1 | 2 | 3 }
export const ORIGIN_PT: PtRef = { e: -1, pt: 1 }

const GRID = 1 // mm snap
const SNAP_PX = 12
/** selection indices >= this address projected geometry: idx - PROJ_BASE is the
 *  slot in `this.projected`. Keeps the positive-index selection machinery. */
const PROJ_BASE = 100000

const isCurve = (e: SketchEntity | undefined): boolean =>
  !!e && (e.type === 'circle' || e.type === 'arc')
const isLine = (e: SketchEntity | undefined): boolean => !!e && e.type === 'line'

/** an arc's start (pt 1) or end (pt 2) rim point in sketch-plane coordinates */
const arcRimPoint = (
  e: { c: [number, number]; r: number; a0: number; a1: number },
  pt: 1 | 2
): [number, number] => {
  const ang = pt === 1 ? e.a0 : e.a1
  return [e.c[0] + Math.cos(ang) * e.r, e.c[1] + Math.sin(ang) * e.r]
}

/** a line's or arc's endpoint (1=start, 2=end); arcs report their rim point
 *  but cannot be moved by adjusting it directly (their shape is c/r/a0/a1) */
const entPoint = (e: SketchEntity, pt: 1 | 2): [number, number] =>
  e.type === 'line'
    ? pt === 1
      ? (e as { a: [number, number] }).a
      : (e as { b: [number, number] }).b
    : arcRimPoint(e as { c: [number, number]; r: number; a0: number; a1: number }, pt)

/** move a line's endpoint, or an arc's start/end angle, so its rim point lands
 *  exactly on `target` (radius held fixed - only the angle changes) */
const setEntPoint = (e: SketchEntity, pt: 1 | 2, target: [number, number]): void => {
  if (e.type === 'line') {
    if (pt === 1) (e as { a: [number, number] }).a = [...target]
    else (e as { b: [number, number] }).b = [...target]
  } else if (e.type === 'arc') {
    const arc = e as { c: [number, number]; a0: number; a1: number }
    const ang = Math.atan2(target[1] - arc.c[1], target[0] - arc.c[0])
    if (pt === 1) arc.a0 = ang
    else arc.a1 = ang
  }
}

export class SketchController {
  private group = new THREE.Group()
  private entGroup = new THREE.Group() // committed sketch entities (cleared each redraw)
  private fillGroup = new THREE.Group() // faint fill of closed profiles
  private preview = new THREE.Group()
  private refGroup = new THREE.Group()
  private fillMat = new THREE.MeshBasicMaterial({
    color: 0x5b8fd6,
    transparent: true,
    opacity: 0.16,
    side: THREE.DoubleSide,
    depthWrite: false
  })
  private plane: THREE.Plane
  private O: THREE.Vector3
  private X: THREE.Vector3
  private Y: THREE.Vector3
  private ray = new THREE.Raycaster()
  private tool: SketchTool = 'line'
  private pending: [number, number][] = []
  /** parallel to `pending`: which existing entity point (if any) each click landed on */
  private pendingSnaps: Array<{ idx: number; pt: number } | null> = []
  private entities: SketchEntity[] = []
  private baseCount = 0
  private cursorUV: [number, number] = [0, 0]
  private onChange: () => void
  private onSolve?: SketchSolveFn
  private onNotice?: (msg: string) => void

  /** entity point the cursor is currently snapped to (endpoint of another entity) */
  private snapRef: { idx: number; pt: number } | null = null
  /** line whose midpoint the cursor is snapped to (draw a point there -> Symmetric) */
  private snapMid: { idx: number } | null = null
  private pendingMids: Array<{ idx: number } | null> = []
  /** rubber-band window select (select tool, empty press) */
  private band: { a: [number, number]; b: [number, number] } | null = null
  /** "click the constraint, then click the geometry" mode */
  private pendingCon: SketchConstraintType | null = null
  /** entity indices the solver reports as fully constrained (drawn grey) */
  private constrainedSet = new Set<number>()
  /** whole-sketch DoF == 0 (from the last solve) */
  private sketchFullyConstrained = false
  private solveTimer: number | null = null
  private solveSeq = 0

  private refPolys: [number, number][][] = []
  private refPoints: [number, number][] = []
  /** projected (external) geometry from the model - real FreeCAD external
   *  geometry, addressed by its negative geoId. Kept OUT of `entities` so the
   *  drag / delete / local-solve paths never touch it; it is a snap + constraint
   *  target only, and is removed via "unproject", not Delete. */
  private projected: Array<{ geoId: number; ent: SketchEntity }> = []
  private selected: number[] = []
  /** individually-selected geometry points (line ends, circle/arc centres) */
  private selectedPts: PtRef[] = []
  private hoverPt: PtRef | null = null
  /** dimension tool: the picks collected so far (a point or a whole entity) -
   *  nothing fires until an empty-space click places it (see firePendingDim) */
  private dimPicks: Array<{ pt: PtRef } | { ent: number }> = []
  /** sketch-plane uv of the empty-space click that just placed the pending
   *  dimension - set right before onDimensionRequest fires, read once by
   *  dimRequestWorldPos, then cleared */
  private dimPlaceUV: [number, number] | null = null
  private hoverIdx = -1
  private drag: {
    idx: number
    handle: DragHandle
    last: [number, number]
  } | null = null
  private snapKind: SnapKind = 'grid'
  private constraints: RecordedConstraint[] = []
  /** constraints present at reopen - never re-sent on finish */
  private baseConstraintCount = 0
  /** reopen-era constraints the user deleted this session - sent to sketch.finish
   *  so they are removed from the real sketch too */
  private removedBaseConstraints: RecordedConstraint[] = []
  /** reopen-era geometry the user deleted this session, as entity indices into
   *  the reopened list - sent to sketch.finish (removedElements) so the real
   *  sketch loses them too */
  private removedBaseEntities: number[] = []
  /** same set as removedBaseEntities, for O(1) "is this base entity gone?"
   *  checks in the draw / pick / solve loops (its slot in `entities` stays so
   *  indices are stable, but it must not render or be pickable) */
  private deletedBaseSet = new Set<number>()
  /** reopened entity index -> new construction flag, for base geometry the user
   *  converted this session (sent to sketch.finish as convertedElements) */
  private convertedBase = new Map<number, boolean>()
  /** a snapshot of each BASE entity's geometry exactly as it was at reopen
   *  time, so finishSketch can tell "this reopened line/circle/arc's raw
   *  SHAPE was dragged this session" apart from "it was left alone" -
   *  sketch.finish's `elements` param is purely ADDITIVE (see
   *  _add_sketch_elements: every element is a fresh sk.addGeometry(), never
   *  a move of an existing one) and getNewEntities() only ever slices
   *  entities[baseCount:], so a drag that changes a REOPENED entity's raw
   *  geometry with no accompanying constraint change (no dimension driving
   *  it) had NO channel to reach the sidecar at all - the edit looked like
   *  it took in the editor, Finish silently dropped it, and anything built
   *  from that sketch (e.g. a Sweep) correctly saw no change because none
   *  was ever sent (real user report, 2026-09-14: "I hit finish sketch
   *  after dragging... the sweep of that sketch didn't error or update").
   *  Reuses the already-proven remove+re-add pipeline (removedElements +
   *  elements) rather than inventing a new "replace" RPC. */
  private baseGeometrySnapshot: SketchEntity[] = []
  /** set by pushRect for a Center Rectangle so commit() can anchor the crossing
   *  of its construction diagonals to the origin / axis / point the first pick
   *  landed on. Cleared right after it is consumed. */
  private centerRectAnchor: { d0: number; d1: number } | null = null
  /** index in `constraints` of the last one the user explicitly added, so the
   *  solver can veto it if it over-constrains; -1 once cleared */
  private lastUserConstraint = -1
  private construction = false
  private geomV = 0 // bumped whenever committed geometry / constraints change
  private dimV = -1 // last geomV the static dimensions were built for
  private dimHadLive = false
  /** per-owner-entity label nudge: [perp, along] mm for a linear dim, [du, dv]
   *  mm for a radial one. Set by dragging the dimension's value label. */
  private dimOffsets = new Map<number, [number, number]>()
  /** where each dim label currently sits (uv) + its kind, for hit-testing.
   *  'angle' dims are click-to-select but not yet drag-repositionable (no
   *  dimOffsets entry is meaningful for them) - a live-preview-only glyph
   *  otherwise, always drawn at the same default position. */
  private dimLabelUV = new Map<number, { uv: [number, number]; kind: 'linear' | 'radius' | 'angle' }>()
  private dimDrag: {
    owner: number
    kind: 'linear' | 'radius'
    startUV: [number, number]
    base: [number, number]
  } | null = null
  /** constraint index of the dimension whose label is selected (Delete removes it) */
  private selectedDim: number | null = null

  constructor(
    // a getter, not a captured camera - the app can be in orthographic mode
    // (the default), which is a DIFFERENT THREE.Camera object glued to the
    // perspective camera's pose every frame (see CadControls.syncOrtho); a
    // click raycast through the wrong one diverges more the further the
    // click is from screen centre, since ortho rays are parallel and
    // perspective rays are not - same fix as Picker's getCamera
    private readonly getCamera: () => THREE.PerspectiveCamera | THREE.OrthographicCamera,
    private readonly dom: HTMLElement,
    frame: SketchFrame,
    root: THREE.Object3D,
    onChange: () => void,
    refGeom?: SketchRefGeom | null,
    private readonly onDimensionRequest?: (
      entityIndex: number | null,
      kind: 'linear' | 'radius' | 'distance' | 'angle',
      pts?: PtRef[]
    ) => void,
    onSolve?: SketchSolveFn,
    onNotice?: (msg: string) => void
  ) {
    this.onSolve = onSolve
    this.onNotice = onNotice
    this.O = new THREE.Vector3(...frame.origin)
    this.X = new THREE.Vector3(...frame.x).normalize()
    this.Y = new THREE.Vector3(...frame.y).normalize()
    const N = new THREE.Vector3(...frame.z).normalize()
    this.plane = new THREE.Plane().setFromNormalAndCoplanarPoint(N, this.O)
    this.onChange = onChange

    if (refGeom) {
      this.refPolys = refGeom.polys.map((p) => p.map((q) => [q[0], q[1]] as [number, number]))
      this.refPoints = refGeom.points.map((q) => [q[0], q[1]] as [number, number])
    }

    root.add(this.group)
    root.add(this.preview)
    root.add(this.refGroup)
    this.group.add(this.fillGroup)
    this.group.add(this.entGroup)
    this.updateGrid()
    this.addAxes()
    this.drawRefGeom()
    this.redraw()

    this.dom.addEventListener('pointerdown', this.onDown)
    this.dom.addEventListener('pointermove', this.onMove)
    this.dom.addEventListener('dblclick', this.onDblClick)
    window.addEventListener('pointerup', this.onUp)
    window.addEventListener('keydown', this.onKey)
  }

  /** the live active camera (ortho or persp) - always current, see getCamera doc above */
  private get camera(): THREE.PerspectiveCamera | THREE.OrthographicCamera {
    return this.getCamera()
  }

  /** Double-click a dimension (or the geometry it drives) to retype its value. */
  private onDblClick = (ev: MouseEvent): void => {
    // finish a spline on double-click
    if (this.tool === 'spline' && this.pending.length >= 2) {
      ev.stopPropagation()
      this.commit()
      this.redraw()
      return
    }
    if (!this.onDimensionRequest) return
    this.ray.setFromCamera(this.ndcFor(ev.clientX, ev.clientY), this.camera)
    for (const h of this.ray.intersectObjects(this.dimGroup.children, true)) {
      let o: THREE.Object3D | null = h.object
      while (o && o.userData?.dimOwner == null) o = o.parent
      if (o && typeof o.userData.dimOwner === 'number') {
        ev.stopPropagation()
        this.onDimensionRequest(o.userData.dimOwner, o.userData.dimKind)
        return
      }
    }
    const idx = this.pickEntity(this.rawPointerUV(ev))
    if (idx >= 0) {
      const e = this.entities[idx]
      ev.stopPropagation()
      this.onDimensionRequest(idx, e.type === 'circle' || e.type === 'arc' ? 'radius' : 'linear')
    }
  }

  setTool(t: SketchTool): void {
    trace('sketch tool', { from: this.tool, to: t })
    this.tool = t
    this.pending = []
    this.pendingSnaps = []
    this.pendingMids = []
    this.hoverIdx = -1
    this.hoverPt = null
    this.dimPicks = []
    this.drag = null
    this.band = null
    this.dom.style.cursor = ''
    if (t !== 'select') this.selected = []
    if (t !== 'select' && t !== 'dimension') this.selectedPts = []
    if (t !== 'select') this.pendingCon = null
    this.redraw()
  }

  /** Enter "pick geometry for this constraint" mode (ribbon button, no live
   *  selection). Clears once enough entities are picked.
   *
   *  Must also clear selectedPts, not just selected: a constraint attempt
   *  abandoned after only ONE point pick (click a point, realise the aim
   *  was off, click the ribbon button again to retry) used to leave that
   *  point sitting in selectedPts. The retry's own first real click then
   *  completed the arity check against that STALE point instead of starting
   *  a fresh pick, silently welding two unrelated points together with no
   *  error or feedback at all - repeated indefinitely this looks exactly
   *  like "constraints don't apply no matter how many times I try" (real
   *  user report + trace, 2026-09-12; confirmed and reproduced in a real
   *  E2E test before this fix, and confirmed fixed after). */
  beginConstraint(t: SketchConstraintType): void {
    this.pendingCon = t
    this.tool = 'select'
    this.selected = []
    this.selectedPts = []
    this.dom.style.cursor = 'crosshair'
    this.redraw()
  }

  get pendingConstraint(): SketchConstraintType | null {
    return this.pendingCon
  }

  private conArity(t: SketchConstraintType): number {
    return t === 'Horizontal' || t === 'Vertical' ? 1 : 2
  }

  setConstruction(on: boolean): void {
    this.construction = on
  }

  toggleConstruction(): boolean {
    // If entities are selected, flip THEIR construction flag (Fusion / FreeCAD
    // behaviour: select geometry, hit the Construction button, it converts).
    // Otherwise flip the "draw as construction" mode for new geometry.
    const sel = this.selected.filter((i) => this.entities[i])
    if (sel.length) {
      this.snapshot()
      // if any selected entity is normal, make them all construction; else all normal
      const anyNormal = sel.some((i) => !this.entities[i].construction)
      for (const i of sel) {
        if (anyNormal) this.entities[i].construction = true
        else delete this.entities[i].construction
        // a base entity converting -> it must be re-sent so the real sketch's
        // geoId gets setConstruction; track it as removed+re-added is overkill,
        // instead record a light marker the finish path reads
        if (i < this.baseCount) this.convertedBase.set(i, !!this.entities[i].construction)
      }
      this.geomV++
      this.redraw()
      this.scheduleSolve()
      this.onChange()
      return this.construction
    }
    this.construction = !this.construction
    this.geomV++
    this.redraw()
    return this.construction
  }

  get isConstruction(): boolean {
    return this.construction
  }

  getEntities(): SketchEntity[] {
    return this.entities
  }

  // --------------------------------------------------------------------- //
  // Test / automation hooks. These drive the SAME code paths the pointer
  // handlers do (applyConstraint / setDimension / deleteSelected / commit),
  // so an E2E scenario can exercise the real controller without synthesising
  // pointer events. Not used by the UI.
  // --------------------------------------------------------------------- //

  /** Append a session entity as if it had just been drawn, running the same
   *  auto-constraint inference `commit()` does for that shape. Returns its
   *  entity index. `snapTo` = entity indices whose nearest point this entity's
   *  endpoints snapped onto (for auto-coincident / tangent). */
  testAddEntity(
    ent: SketchEntity,
    snapTo: Array<{ idx: number; pt: 1 | 2 | 3 } | null> = []
  ): number {
    this.snapshot()
    this.entities.push({ ...ent, ...(this.construction ? { construction: true } : {}) })
    const i = this.entities.length - 1
    const nw = i - this.baseCount
    if (ent.type === 'line') {
      // snap-based constraints before axis-anchoring, same reasoning as
      // commit(): a point that is both on-axis and coincident with real
      // geometry should only get the one meaningful constraint
      this.autoCoincident(i, [snapTo[0] ?? null, snapTo[1] ?? null])
      this.autoAngle(i)
      this.autoTangent(i, [snapTo[0] ?? null, snapTo[1] ?? null])
      this.anchorToAxes(i)
    } else if (ent.type === 'circle' || ent.type === 'arc') {
      // snapTo convention here mirrors commit()'s 3-click arc: [0]=centre,
      // [1]=start/radius point, [2]=end point (circle only ever uses [0])
      this.autoCoincident(i, [snapTo[0] ?? null])
      if (ent.type === 'arc') {
        this.autoCoincident(i, [snapTo[1] ?? null, snapTo[2] ?? null], [1, 2])
      }
      this.anchorToAxes(i)
    }
    void nw
    this.geomV++
    this.redraw()
    this.scheduleSolve()
    this.onChange()
    return i
  }

  /** Draw a multi-click tool (rect / rect-center / circle / arc / spline) through
   *  the real commit() path (test hook). `points` are the tool's clicks in world
   *  UV; `snapTo` optionally ties click k to an existing entity point so the
   *  same auto-constraints fire as an interactive draw. Returns the index of the
   *  first entity produced. */
  testCommitTool(
    tool: SketchTool,
    points: [number, number][],
    snapTo: Array<{ idx: number; pt: 1 | 2 | 3 } | null> = []
  ): number {
    const prevTool = this.tool
    this.tool = tool
    this.pending = points.slice(0, -1)
    this.cursorUV = points[points.length - 1]
    this.pending = points.slice()
    this.pendingSnaps = points.map((_, k) => {
      const s = snapTo[k]
      return s ? { idx: s.idx, pt: s.pt } : null
    })
    this.pendingMids = points.map(() => null)
    const before = this.entities.length
    this.commit()
    this.tool = prevTool
    this.pending = []
    this.pendingSnaps = []
    this.pendingMids = []
    this.geomV++
    this.redraw()
    this.scheduleSolve()
    this.onChange()
    return before - this.baseCount
  }

  /** Set the whole-entity selection by index (test hook). Does NOT clear a
   *  point selection - a point + an entity is a valid combined selection
   *  (point-on-object, coincident-to-centre). */
  testSelect(indices: number[]): void {
    this.selected = indices.slice()
    this.selectedDim = null
    this.redraw()
  }

  /** Set the geometry-point selection (test hook). Clears whole-entity
   *  selection unless you follow with testSelect(). */
  testSelectPoints(pts: Array<{ e: number; pt: 1 | 2 | 3 }>): void {
    this.selectedPts = pts.map((p) => ({ e: p.e, pt: p.pt }))
    this.selected = []
    this.redraw()
  }

  /** Select the dimension constraint driving entity `owner` (test hook). */
  testSelectDim(owner: number): boolean {
    const ci = this.dimConstraintIndex(owner)
    if (ci < 0) return false
    this.selectedDim = ci
    this.redraw()
    return true
  }

  /** Delete the current selection (test hook - same path as the Delete key). */
  testDeleteSelected(): void {
    this.deleteSelected()
  }

  /** Toggle construction (test hook - same as the Construction button: converts
   *  the selection if any, else flips draw-as-construction mode). */
  testToggleConstruction(): boolean {
    return this.toggleConstruction()
  }

  /** Entities added since the session began (for reopen -> only push the new). */
  getNewEntities(): SketchEntity[] {
    return this.entities.slice(this.baseCount)
  }

  getConstraints(): RecordedConstraint[] {
    return this.constraints
  }

  /** Constraints added this session (reopen -> only push the new ones). */
  getNewConstraints(): RecordedConstraint[] {
    return this.constraints.slice(this.baseConstraintCount)
  }

  /** Reopen-era constraints the user deleted this session (for sketch.finish). */
  getRemovedConstraints(): RecordedConstraint[] {
    return this.removedBaseConstraints.slice()
  }

  /** Reopen-era geometry the user deleted this session, as reopened-entity
   *  indices (for sketch.finish removedElements). */
  getRemovedEntities(): number[] {
    return this.removedBaseEntities.slice()
  }

  /** Base (reopen-era) entities whose raw geometry has genuinely changed
   *  since reopen - e.g. a radius/endpoint drag with no dimension recording
   *  it, which sketch.finish's additive-only `elements` and getNewEntities()
   *  (new-since-reopen only) would otherwise silently drop (see
   *  baseGeometrySnapshot's doc comment). Excludes anything already deleted
   *  or converted this session - those go through their own existing
   *  channels. finishSketch treats each returned index as "remove the old
   *  copy, add the new shape" using the SAME proven remove+re-add pipeline
   *  a real delete already uses - not a new sidecar operation. */
  getEditedBaseEntities(): Array<{ index: number; entity: SketchEntity }> {
    const out: Array<{ index: number; entity: SketchEntity }> = []
    for (let i = 0; i < this.baseGeometrySnapshot.length; i++) {
      if (this.deletedBaseSet.has(i) || this.convertedBase.has(i)) continue
      const before = this.baseGeometrySnapshot[i]
      const now = this.entities[i]
      if (!now) continue
      if (!SketchController.sameShape(before, now)) out.push({ index: i, entity: now })
    }
    return out
  }

  /** true when two entities of the SAME type occupy the same raw geometry
   *  (position/size only - construction flag and type are compared by the
   *  caller separately). A small epsilon absorbs float noise from the local
   *  solver's relaxation, not genuine edits. */
  private static sameShape(a: SketchEntity, b: SketchEntity): boolean {
    if (a.type !== b.type) return false
    const eq = (x: number, y: number): boolean => Math.abs(x - y) < 1e-7
    if (a.type === 'line' && b.type === 'line') {
      return eq(a.a[0], b.a[0]) && eq(a.a[1], b.a[1]) && eq(a.b[0], b.b[0]) && eq(a.b[1], b.b[1])
    }
    if (a.type === 'circle' && b.type === 'circle') {
      return eq(a.c[0], b.c[0]) && eq(a.c[1], b.c[1]) && eq(a.r, b.r)
    }
    if (a.type === 'arc' && b.type === 'arc') {
      return (
        eq(a.c[0], b.c[0]) &&
        eq(a.c[1], b.c[1]) &&
        eq(a.r, b.r) &&
        eq(a.a0, b.a0) &&
        eq(a.a1, b.a1)
      )
    }
    if (a.type === 'spline' && b.type === 'spline') {
      if (a.pts.length !== b.pts.length) return false
      return a.pts.every((p, i) => eq(p[0], b.pts[i][0]) && eq(p[1], b.pts[i][1]))
    }
    return true
  }

  /** Reopen-era geometry whose construction flag the user flipped this session,
   *  as [entityIndex, isConstruction] pairs (for sketch.finish
   *  convertedElements). */
  getConvertedEntities(): Array<[number, boolean]> {
    return [...this.convertedBase.entries()]
  }

  get constraintCount(): number {
    return this.constraints.length
  }

  get selectedCount(): number {
    return this.selected.length
  }

  loadExisting(
    ents: SketchEntity[],
    cons: RecordedConstraint[] = [],
    projected: Array<{ geoId: number } & SketchEntity> = []
  ): void {
    this.entities = ents.slice()
    this.baseCount = this.entities.length
    this.baseGeometrySnapshot = ents.map((e) => SketchController.cloneEnt(e))
    this.constraints = cons.map((c) => ({ ...c, refs: c.refs.map((r) => ({ ...r })) }))
    this.baseConstraintCount = this.constraints.length
    this.removedBaseConstraints = []
    this.removedBaseEntities = []
    this.deletedBaseSet = new Set()
    this.convertedBase = new Map()
    this.setProjected(projected)
    this.undoStack = []
    this.geomV++
    this.redraw()
    this.scheduleSolve()
  }

  /** Replace the projected-geometry set (from sketch.on / reopen / project). */
  setProjected(projected: Array<{ geoId: number } & SketchEntity>): void {
    this.projected = (projected ?? []).map((p) => {
      const { geoId, ...rest } = p
      return { geoId, ent: { ...(rest as SketchEntity), projected: true } as SketchEntity }
    })
    this.geomV++
    this.redraw()
  }

  getProjected(): Array<{ geoId: number; ent: SketchEntity }> {
    return this.projected
  }

  /** Full pre-action snapshot, so one Ctrl+Z reverts one user action (a
   *  rectangle is 4 lines + its constraints, but still one undo step). Also
   *  carries the reopen-era bookkeeping (removedBaseEntities/Constraints,
   *  deletedBaseSet, convertedBase) - undo used to restore `entities` /
   *  `constraints` only, so deleting or construction-toggling REOPENED
   *  geometry (not freshly drawn this session) looked undone in the data but
   *  stayed hidden/still-queued-for-removal on Finish - Ctrl+Z silently did
   *  nothing visible for that case (user report, 2026-09-12: "ctrl+z ... in
   *  ANY feature. Always."). */
  private undoStack: Array<{
    ents: SketchEntity[]
    cons: RecordedConstraint[]
    removedBaseEntities: number[]
    removedBaseConstraints: RecordedConstraint[]
    deletedBaseSet: Set<number>
    convertedBase: Map<number, boolean>
  }> = []

  private dragMoved = false
  private preDragSnap: {
    ents: SketchEntity[]
    cons: RecordedConstraint[]
    removedBaseEntities: number[]
    removedBaseConstraints: RecordedConstraint[]
    deletedBaseSet: Set<number>
    convertedBase: Map<number, boolean>
  } | null = null
  private noticeAt = 0

  /** Throttled one-liner to the hint bar, so a blocked drag does not spam. */
  private noticeOnce(msg: string): void {
    const now = Date.now()
    if (now - this.noticeAt < 2500) return
    this.noticeAt = now
    this.onNotice?.(msg)
  }

  /** Restrict a drag target so already-constrained directions do not move.
   *  Returns the (possibly axis-clamped) target, or null to block the drag
   *  entirely. This is what makes a fully-constrained sketch actually rigid and
   *  stops a dimensioned rectangle from shearing on a corner drag. */
  private clampDragTarget(
    idx: number,
    handle: DragHandle,
    target: [number, number]
  ): [number, number] | null {
    const e = this.entities[idx]
    if (!e) return target

    // whole-entity / body moves: blocked only when the entity is fully
    // solved - a PARTIALLY anchored line (one end welded/tangent, one end
    // free) still moves, just not as a rigid whole-body translation; see
    // applyDrag's 'whole' case, which degrades to moving only the free
    // endpoint in that case (same per-point mechanism an a/b drag already
    // uses safely). Only a line anchored at BOTH ends has nothing left to
    // give - user report, 2026-09-13: "if a line... CAN move AT ALL and I am
    // dragging it ANYWHERE along/on it, it should move but, ONLY in the
    // way(s) it's unconstrained" (this replaces an earlier, too-strict fix
    // that refused the whole drag the moment EITHER end was anchored).
    if (handle === 'whole' || handle === 'ab' || handle === 'ba') {
      if (this.constrainedSet.has(idx)) {
        this.noticeOnce(
          'This geometry is fully constrained - remove a dimension or constraint to move it.'
        )
        return null
      }
      if (e.type === 'line' && this.lineEndpointsAnchored(idx).every(Boolean)) {
        this.noticeOnce(
          'Both ends of this line are tied to another curve (tangent or coincident) - nothing left to drag.'
        )
        return null
      }
      return target
    }
    // an arc/circle's radius or centre handle: if the arc is tangent-joined
    // to ANOTHER entity at BOTH of its rim endpoints (arcTangentAnchored
    // requires 2, see its own comment): its radius is over-determined -
    // solveLocal's tangent pass re-pivots the centre about EACH
    // tangent-shared endpoint separately to keep the (now different) radius
    // tangent there, and those two pivots generally cannot agree on one
    // centre at once, fighting each other every relaxation pass and
    // producing the flipped, self-crossing shape from the "got all crazy"
    // report. A SINGLE tangent join is fine (one pivot, always solvable) and
    // is deliberately allowed through here unblocked.
    if ((handle === 'r' || handle === 'c') && e.type === 'arc' && this.arcTangentAnchored(idx)) {
      this.noticeOnce(
        'This arc is tangent to another curve - drag its endpoint instead, or remove the tangent constraint first.'
      )
      return null
    }
    if (handle !== 'a' && handle !== 'b') return target
    if (e.type !== 'line' && e.type !== 'rect') return target
    const cur: [number, number] = handle === 'a' ? [...e.a] : [...e.b]

    let lockX = false
    let lockY = false

    // inside a rectangle loop: a dimension on ANY horizontal side locks the X
    // slide, on any vertical side locks the Y slide (width / height are fixed)
    const loop = this.rectLoopOf(idx)
    if (loop) {
      for (const li of loop) {
        if (!this.entityHasDimension(li)) continue
        if (this.lineHasHV(li, 'Horizontal')) lockX = true
        else if (this.lineHasHV(li, 'Vertical')) lockY = true
      }
    }

    // point-level locks: origin / axis anchors, and (outside a rect) a
    // dimensioned H / V line through this exact endpoint
    const key = `${idx}:${handle === 'a' ? 1 : 2}`
    const grp = this.weldGroups().find((s) => s.has(key)) ?? new Set<string>([key])
    for (const k of grp) {
      for (const c of this.constraints) {
        const r0 = c.refs[0]
        if (!r0 || this.keyOfRef(r0) !== k) continue
        // (see lineEndpointsAnchored's note: geo <= -3 is projected external
        // geometry, just as fixed as the origin - entIdxOfRef aliases both
        // to the same -1, so this must check the raw ref directly)
        const r1geo = c.refs[1]?.geo
        if (c.type === 'Coincident' && (r1geo === -1 || (r1geo != null && r1geo <= -3))) {
          lockX = true
          lockY = true
        } else if (c.type === 'PointOnObject' && r1geo === -1) lockY = true
        else if (c.type === 'PointOnObject' && r1geo === -2) lockX = true
      }
      const ei = Number(k.split(':')[0])
      if (!loop && this.entities[ei]?.type === 'line' && this.entityHasDimension(ei)) {
        if (this.lineHasHV(ei, 'Horizontal')) lockX = true
        else if (this.lineHasHV(ei, 'Vertical')) lockY = true
        else {
          lockX = true
          lockY = true
        }
      }
    }

    if (lockX && lockY) {
      this.noticeOnce('That point is fully constrained here.')
      return null
    }
    if (!lockX && !lockY) return target
    return [lockX ? cur[0] : target[0], lockY ? cur[1] : target[1]]
  }

  /** [endpoint1Anchored, endpoint2Anchored] - true for whichever of line
   *  `idx`'s two endpoints is axis-anchored or shares a Tangent join with
   *  another entity (solveLocal only PIVOTS a joined arc about the shared
   *  point - it never slides the arc to follow, so translating that
   *  endpoint freely would tear the join apart every solve iteration
   *  instead of moving it cleanly). Used by applyDrag's 'whole' case to
   *  decide whether a whole-line drag can rigidly translate (neither
   *  anchored), must degrade to moving only the free end (exactly one
   *  anchored), or has nothing left to give (both anchored). Mirrors the
   *  per-point checks clampDragTarget already does for a single-endpoint
   *  (a/b) drag. */
  private lineEndpointsAnchored(idx: number): [boolean, boolean] {
    const groups = this.weldGroups()
    // NOTE: a weld to a DIFFERENT entity is deliberately NOT treated as
    // anchoring by itself - that other entity (a free line, say) can
    // perfectly well follow this point wherever the drag takes it (that is
    // exactly what the weld pass in solveLocal already does: "a pinned point
    // wins, the rest of its group follows"). Only checking every member of
    // the weld group for an axis anchor or Tangent join (below) correctly
    // finds the case that actually cannot follow. An earlier version of this
    // also flagged ANY cross-entity weld as anchored, which wrongly treated
    // "welded to another perfectly free line" as stuck - the exact bug the
    // user reported (2026-09-13, the "flag on a pole" repro: dragging the
    // flag's free end, welded only to an unconstrained pole, refused to
    // move at all).
    const anchoredAt = (pt: 1 | 2): boolean => {
      const key = `${idx}:${pt}`
      const grp = groups.find((s) => s.has(key)) ?? new Set<string>([key])
      for (const k of grp) {
        for (const c of this.constraints) {
          const r0 = c.refs[0]
          if (!r0) continue
          // a PLAIN edge Tangent (no pt ref at all, e.g. a line tangent to a
          // full circle with no shared endpoint) does not pin any specific
          // POINT position - keyOfRef defaults a missing pt to 1, which would
          // otherwise misreport an edge tangent as anchoring point 1 even
          // when the two entities do not share an endpoint at all (found via
          // a failing test: an endpoint-Tangent's pre-positioning step did
          // not land the two points within weld tolerance, so applyConstraint
          // fell back to pushing a plain edge Tangent - r0.pt undefined -
          // which this check must not treat as "anchors point 1"). Only an
          // EXPLICIT pt ref on this exact key counts.
          if (c.type === 'Tangent' && r0.pt == null) continue
          if (this.keyOfRef(r0) !== k) continue
          // a weld to PROJECTED (external) geometry (geo <= -3) is just as
          // fixed as one to the origin (-1) and must anchor this point too
          // (real user file, 2026-09-13: "the connected lines" welded to
          // projected geometry should "only... rotate about those", not
          // translate with a whole-body drag).
          const g1 = c.refs[1]?.geo
          if (c.type === 'Coincident' && (g1 === -1 || (g1 != null && g1 <= -3))) return true
          if (
            c.type === 'PointOnObject' &&
            (g1 === -1 || g1 === -2 || (g1 != null && g1 <= -3))
          )
            return true
          if (c.type === 'Tangent') return true
        }
      }
      return false
    }
    return [anchoredAt(1), anchoredAt(2)]
  }

  /** true if arc `idx` has a Tangent join at BOTH of its rim endpoints (1
   *  AND 2) - genuinely over-determined for a radius/centre drag: solveLocal's
   *  tangent pass pivots the centre about EACH shared endpoint separately to
   *  match a changed radius, and with joins at both ends those two pivots
   *  generally cannot agree on one centre (see clampDragTarget's call site).
   *  A SINGLE tangent join is fine - that one pivot always has a valid
   *  solution at any radius, so only the anchored end needs to be respected,
   *  not the whole drag refused (user report, 2026-09-13: "you have the
   *  dragging WAY too strict... if a line, arc, or anything CAN move AT ALL
   *  ... it should move but, ONLY in the way(s) it's unconstrained"). */
  private arcTangentAnchored(idx: number): boolean {
    let count = 0
    for (const pt of [1, 2] as const) {
      const key = `${idx}:${pt}`
      for (const c of this.constraints) {
        if (c.type !== 'Tangent') continue
        const r0 = c.refs[0]
        const r1 = c.refs[1]
        // a PLAIN edge Tangent (no pt ref - e.g. a curve tangent to a full
        // circle with no shared endpoint) does not anchor any specific rim
        // point; keyOfRef defaults a missing pt to 1, which would otherwise
        // misreport it as anchoring THIS arc's point 1 even when the two
        // entities share no endpoint at all. Only an explicit pt ref counts.
        if (r0?.pt == null && r1?.pt == null) continue
        const k0 = r0?.pt != null ? this.keyOfRef(r0) : null
        const k1 = r1?.pt != null ? this.keyOfRef(r1) : null
        if (k0 === key || k1 === key) {
          count++
          break
        }
      }
    }
    return count >= 2
  }

  private static cloneEnt(e: SketchEntity): SketchEntity {
    return e.type === 'spline' ? { ...e, pts: e.pts.map((p) => [p[0], p[1]] as [number, number]) } : { ...e }
  }

  private cloneEnts(): SketchEntity[] {
    return this.entities.map((e) => SketchController.cloneEnt(e))
  }

  private cloneCons(): RecordedConstraint[] {
    return this.constraints.map((c) => ({ ...c, refs: c.refs.map((r) => ({ ...r })) }))
  }

  /** current reopen-era bookkeeping, cloned - the part of a snapshot that
   *  isn't `entities`/`constraints` but must still round-trip through undo */
  private cloneBaseTracking(): {
    removedBaseEntities: number[]
    removedBaseConstraints: RecordedConstraint[]
    deletedBaseSet: Set<number>
    convertedBase: Map<number, boolean>
  } {
    return {
      removedBaseEntities: [...this.removedBaseEntities],
      removedBaseConstraints: this.removedBaseConstraints.map((c) => ({
        ...c,
        refs: c.refs.map((r) => ({ ...r }))
      })),
      deletedBaseSet: new Set(this.deletedBaseSet),
      convertedBase: new Map(this.convertedBase)
    }
  }

  private snapshot(): void {
    this.undoStack.push({ ents: this.cloneEnts(), cons: this.cloneCons(), ...this.cloneBaseTracking() })
    if (this.undoStack.length > 120) this.undoStack.shift()
  }

  undo(): void {
    // an in-progress polyline: drop the last placed point first
    if (this.pending.length) {
      this.pending.pop()
      this.pendingSnaps.pop()
      this.pendingMids.pop()
      this.geomV++
      this.redraw()
      this.onChange()
      return
    }
    const s = this.undoStack.pop()
    if (!s) return
    this.entities = s.ents
    this.constraints = s.cons
    this.removedBaseEntities = s.removedBaseEntities
    this.removedBaseConstraints = s.removedBaseConstraints
    this.deletedBaseSet = s.deletedBaseSet
    this.convertedBase = s.convertedBase
    if (this.baseCount > this.entities.length) this.baseCount = this.entities.length
    if (this.baseConstraintCount > this.constraints.length)
      this.baseConstraintCount = this.constraints.length
    this.selected = []
    this.geomV++
    this.redraw()
    this.scheduleSolve()
    this.onChange()
  }

  // --- geometry helpers ---
  private toWorld(u: number, v: number): THREE.Vector3 {
    return this.O.clone().addScaledVector(this.X, u).addScaledVector(this.Y, v)
  }

  /** public wrapper (test hook): sketch-plane uv -> world xyz */
  uvToWorld(u: number, v: number): [number, number, number] {
    const p = this.toWorld(u, v)
    return [p.x, p.y, p.z]
  }

  private worldToUV(p: THREE.Vector3): [number, number] {
    const d = p.clone().sub(this.O)
    return [d.dot(this.X), d.dot(this.Y)]
  }

  private pxPerMm(): number {
    const a = this.toWorld(0, 0).project(this.camera)
    const b = this.toWorld(1, 0).project(this.camera)
    return (Math.hypot(a.x - b.x, a.y - b.y) * this.dom.clientHeight) / 2
  }

  private snap(uv: [number, number]): [number, number] {
    const tolMm = SNAP_PX / Math.max(this.pxPerMm(), 0.001)
    const origin: [number, number] = [0, 0]
    this.snapRef = null
    this.snapMid = null

    // candidate points, each optionally tied to an entity point (so a click that
    // lands on one can record a Coincident) or a line midpoint (records Symmetric)
    type Cand = {
      p: [number, number]
      ref: { idx: number; pt: number } | null
      mid?: { idx: number }
    }
    const cands: Cand[] = []
    for (const p of this.refPoints) cands.push({ p, ref: null })
    for (const poly of this.refPolys) for (const p of poly) cands.push({ p, ref: null })
    for (const p of this.pending) cands.push({ p, ref: null })
    // projected geometry endpoints / centres are snap targets too - carry a
    // real ref (PROJ_BASE-encoded, like everywhere else that addresses
    // projected geometry) so a click that lands on one can actually record a
    // Coincident/PointOnObject against it, not just visually snap the cursor
    // there with nothing to show for it once the click commits
    this.projected.forEach(({ ent }, k) => {
      const idx = PROJ_BASE + k
      if (ent.type === 'line') {
        cands.push({ p: ent.a, ref: { idx, pt: 1 } })
        cands.push({ p: ent.b, ref: { idx, pt: 2 } })
        cands.push({
          p: [(ent.a[0] + ent.b[0]) / 2, (ent.a[1] + ent.b[1]) / 2],
          ref: null,
          mid: { idx }
        })
      } else if (ent.type === 'circle' || ent.type === 'arc') {
        cands.push({ p: ent.c, ref: { idx, pt: 3 } })
        // an arc also has two real rim endpoints (start/end) - a line drawn
        // to meet one of those must be able to snap there, not just onto the
        // centre. This was missing entirely: the cursor had nothing to lock
        // onto at an arc's endpoint while drawing, so a line could never
        // actually land there no matter how carefully you clicked, and no
        // constraint (auto or manual) ever had a snap to record against -
        // this is why the endpoint-tangent/coincident fixes earlier this
        // session never helped: they fire on a snap that was never happening
        // (user report, repeated: "can't have a line snap onto the end point
        // of an arc, or constrain it to do so").
        if (ent.type === 'arc') {
          cands.push({ p: arcRimPoint(ent, 1), ref: { idx, pt: 1 } })
          cands.push({ p: arcRimPoint(ent, 2), ref: { idx, pt: 2 } })
        }
      }
    })
    this.entities.forEach((e, idx) => {
      if (e.type === 'line') {
        cands.push({ p: e.a, ref: { idx, pt: 1 } })
        cands.push({ p: e.b, ref: { idx, pt: 2 } })
        cands.push({
          p: [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2],
          ref: null,
          mid: { idx }
        })
      } else if (e.type === 'circle' || e.type === 'arc') {
        cands.push({ p: e.c, ref: { idx, pt: 3 } })
        if (e.type === 'arc') {
          cands.push({ p: arcRimPoint(e, 1), ref: { idx, pt: 1 } })
          cands.push({ p: arcRimPoint(e, 2), ref: { idx, pt: 2 } })
        }
      }
    })

    // origin wins ties so it is easy to land on 0,0
    let best: Cand | null = null
    let bestD = tolMm
    let kind: SnapKind = 'grid'
    const dO = Math.hypot(uv[0], uv[1])
    if (dO < bestD) {
      bestD = dO
      best = { p: origin, ref: null }
      kind = 'origin'
    }
    for (const c of cands) {
      const d = Math.hypot(c.p[0] - uv[0], c.p[1] - uv[1])
      if (d < bestD) {
        bestD = d
        best = c
        kind = 'point'
      }
    }
    if (best) {
      this.snapKind = kind
      this.snapRef = best.ref
      this.snapMid = best.mid ?? null
      return [best.p[0], best.p[1]]
    }
    // then: the sketch axes themselves (u=0 is the Y axis, v=0 the X axis)
    const onU = Math.abs(uv[0]) < tolMm
    const onV = Math.abs(uv[1]) < tolMm
    if (onU || onV) {
      this.snapKind = onU && onV ? 'origin' : 'axis'
      return [onU ? 0 : uv[0], onV ? 0 : uv[1]]
    }
    // then: nearest point along a model edge (lets you land "on" an edge)
    let onEdge: [number, number] | null = null
    let onEdgeD = tolMm
    for (const poly of this.refPolys) {
      for (let i = 0; i + 1 < poly.length; i++) {
        const q = this.closestOnSeg(uv, poly[i], poly[i + 1])
        const d = Math.hypot(q[0] - uv[0], q[1] - uv[1])
        if (d < onEdgeD) {
          onEdgeD = d
          onEdge = q
        }
      }
    }
    if (onEdge) {
      this.snapKind = 'edge'
      return onEdge
    }
    // grid snap is a convenience, not a hard rule - like every other snap kind
    // above it only fires within the on-screen tolerance, otherwise the dot
    // visibly drifts away from the actual cursor at anything but a very
    // zoomed-out view (GRID is 1mm, which can be many screen px when zoomed in)
    const gx = Math.round(uv[0] / GRID) * GRID
    const gy = Math.round(uv[1] / GRID) * GRID
    if (Math.hypot(gx - uv[0], gy - uv[1]) < tolMm) {
      this.snapKind = 'grid'
      return [gx, gy]
    }
    this.snapKind = 'grid'
    return uv
  }

  private closestOnSeg(
    p: [number, number],
    a: [number, number],
    b: [number, number]
  ): [number, number] {
    const abx = b[0] - a[0]
    const aby = b[1] - a[1]
    const len2 = abx * abx + aby * aby || 1
    let t = ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / len2
    t = Math.max(0, Math.min(1, t))
    return [a[0] + abx * t, a[1] + aby * t]
  }

  private pointerUV(ev: PointerEvent): [number, number] {
    const r = this.dom.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((ev.clientX - r.left) / r.width) * 2 - 1,
      -((ev.clientY - r.top) / r.height) * 2 + 1
    )
    this.ray.setFromCamera(ndc, this.camera)
    const hit = new THREE.Vector3()
    if (!this.ray.ray.intersectPlane(this.plane, hit)) return this.cursorUV
    return this.snap(this.worldToUV(hit))
  }

  private ndcFor(clientX: number, clientY: number): THREE.Vector2 {
    const r = this.dom.getBoundingClientRect()
    return new THREE.Vector2(
      ((clientX - r.left) / r.width) * 2 - 1,
      -((clientY - r.top) / r.height) * 2 + 1
    )
  }

  private rawPointerUV(ev: { clientX: number; clientY: number }): [number, number] {
    this.ray.setFromCamera(this.ndcFor(ev.clientX, ev.clientY), this.camera)
    const hit = new THREE.Vector3()
    if (!this.ray.ray.intersectPlane(this.plane, hit)) return this.cursorUV
    return this.worldToUV(hit)
  }

  // --- distance from a uv to an entity, in mm (for select-mode picking) ---
  private distToEntity(uv: [number, number], e: SketchEntity): number {
    if (e.type === 'line') {
      const q = this.closestOnSeg(uv, e.a, e.b)
      return Math.hypot(q[0] - uv[0], q[1] - uv[1])
    }
    if (e.type === 'rect') {
      const c = [e.a, [e.b[0], e.a[1]], e.b, [e.a[0], e.b[1]]] as [number, number][]
      let m = Infinity
      for (let i = 0; i < 4; i++) {
        const q = this.closestOnSeg(uv, c[i], c[(i + 1) % 4])
        m = Math.min(m, Math.hypot(q[0] - uv[0], q[1] - uv[1]))
      }
      return m
    }
    if (e.type === 'spline') {
      const s = this.splineUVs(e.pts)
      let m = Infinity
      for (let i = 0; i + 1 < s.length; i++) {
        const q = this.closestOnSeg(uv, s[i], s[i + 1])
        m = Math.min(m, Math.hypot(q[0] - uv[0], q[1] - uv[1]))
      }
      return m
    }
    // circle / arc
    return Math.abs(Math.hypot(uv[0] - e.c[0], uv[1] - e.c[1]) - e.r)
  }

  private pickEntity(uv: [number, number]): number {
    const tolMm = SNAP_PX / Math.max(this.pxPerMm(), 0.001)
    let best = -1
    let bestD = tolMm
    for (let i = 0; i < this.entities.length; i++) {
      if (this.deletedBaseSet.has(i)) continue
      const d = this.distToEntity(uv, this.entities[i])
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    // projected geometry is pickable as a constraint / dimension target
    for (let k = 0; k < this.projected.length; k++) {
      const d = this.distToEntity(uv, this.projected[k].ent)
      if (d < bestD) {
        bestD = d
        best = PROJ_BASE + k
      }
    }
    return best
  }

  /** entity behind a selection index - real, or projected when idx >= PROJ_BASE */
  private entAt(idx: number): SketchEntity | undefined {
    return idx >= PROJ_BASE ? this.projected[idx - PROJ_BASE]?.ent : this.entities[idx]
  }

  /** the selectable points of one entity (line ends, circle/arc centre, arc
   *  ends) - `idx` may address projected (read-only) geometry via PROJ_BASE,
   *  same as everywhere else that takes an entity index */
  private entityPts(idx: number): PtRef[] {
    const e = this.entAt(idx)
    if (!e) return []
    if (e.type === 'line') return [{ e: idx, pt: 1 }, { e: idx, pt: 2 }]
    if (e.type === 'circle') return [{ e: idx, pt: 3 }]
    if (e.type === 'arc') return [{ e: idx, pt: 3 }, { e: idx, pt: 1 }, { e: idx, pt: 2 }]
    return []
  }

  /** world-uv of a geometry point */
  private ptUV(pr: PtRef): [number, number] {
    if (pr.e === -1) return [0, 0] // sketch origin
    const e = this.entAt(pr.e)
    if (!e) return [0, 0]
    if (pr.pt === 3) return e.type === 'circle' || e.type === 'arc' ? [...e.c] : this.endpointOf(e, 1)
    if (e.type === 'arc') {
      const a = pr.pt === 1 ? e.a0 : e.a1
      return [e.c[0] + Math.cos(a) * e.r, e.c[1] + Math.sin(a) * e.r]
    }
    return this.endpointOf(e, pr.pt)
  }

  private samePt(a: PtRef | null, b: PtRef | null): boolean {
    return !!a && !!b && a.e === b.e && a.pt === b.pt
  }

  /** nearest selectable geometry point to `uv`, within the snap tolerance */
  private pickPoint(uv: [number, number]): PtRef | null {
    const tol = SNAP_PX / Math.max(this.pxPerMm(), 0.001)
    let best: PtRef | null = null
    let bestD = tol
    // the sketch origin is always a selectable point (so you can constrain to it)
    {
      const d = Math.hypot(uv[0], uv[1])
      if (d < bestD) {
        bestD = d
        best = { e: -1, pt: 1 }
      }
    }
    for (let i = 0; i < this.entities.length; i++) {
      if (this.deletedBaseSet.has(i)) continue
      for (const pr of this.entityPts(i)) {
        const p = this.ptUV(pr)
        const d = Math.hypot(p[0] - uv[0], p[1] - uv[1])
        if (d < bestD) {
          bestD = d
          best = pr
        }
      }
    }
    // projected (external) geometry's endpoints / centre are pickable points
    // too - e.g. PointOnObject / Coincident against a projected edge's end
    for (let k = 0; k < this.projected.length; k++) {
      const idx = PROJ_BASE + k
      for (const pr of this.entityPts(idx)) {
        const p = this.ptUV(pr)
        const d = Math.hypot(p[0] - uv[0], p[1] - uv[1])
        if (d < bestD) {
          bestD = d
          best = pr
        }
      }
    }
    return best
  }

  private ptToHandle(pr: PtRef): DragHandle {
    if (pr.pt === 3) return 'c'
    // an arc's pt 1/2 are its rim endpoints (angle), not a line's a/b
    // (position) - dragging one must re-sweep the arc, not fall through
    // applyDrag's line-only 'a'/'b' cases as a silent no-op
    const e = this.entAt(pr.e)
    if (e && e.type === 'arc') return pr.pt === 2 ? 'a1' : 'a0'
    return pr.pt === 2 ? 'b' : 'a'
  }

  /** ref shape (geo / new + pt) for a recorded constraint */
  private ptRecRef(pr: PtRef): RecordedConstraint['refs'][number] {
    if (pr.e === -1) return { geo: -1, pt: 1 } // sketch origin point
    if (pr.e >= PROJ_BASE) return { geo: this.projected[pr.e - PROJ_BASE].geoId, pt: pr.pt }
    return pr.e < this.baseCount
      ? { geo: pr.e, pt: pr.pt }
      : { new: pr.e - this.baseCount, sub: 0, pt: pr.pt }
  }

  /** the dimension tool has collected 2 picks - ask the app for a value */
  private fireDistanceDim(): void {
    this.onDimensionRequest?.(null, this.dimPicksAreAngle() ? 'angle' : 'distance')
  }

  /** true when both dim picks are whole LINES that are not (nearly)
   *  parallel - "the same flow as distance": clicking two non-parallel
   *  lines auto-detects as an angle instead of a (geometrically meaningless
   *  for non-parallel lines) perpendicular-gap distance. A tolerance of a
   *  couple degrees keeps two genuinely-parallel-but-not-bit-exact lines
   *  reading as a distance, matching how they'd actually be drawn. */
  private dimPicksAreAngle(): boolean {
    if (this.dimPicks.length < 2) return false
    const [p0, p1] = this.dimPicks
    if (!('ent' in p0) || !('ent' in p1)) return false
    const e0 = this.entities[p0.ent]
    const e1 = this.entities[p1.ent]
    if (!e0 || !e1 || e0.type !== 'line' || e1.type !== 'line') return false
    const d0 = Math.hypot(e0.b[0] - e0.a[0], e0.b[1] - e0.a[1]) || 1
    const d1 = Math.hypot(e1.b[0] - e1.a[0], e1.b[1] - e1.a[1]) || 1
    const cross = ((e0.b[0] - e0.a[0]) / d0) * ((e1.b[1] - e1.a[1]) / d1) -
      ((e0.b[1] - e0.a[1]) / d0) * ((e1.b[0] - e1.a[0]) / d1)
    return Math.abs(cross) > Math.sin((2 * Math.PI) / 180) // > ~2 degrees off parallel
  }

  /** current angle (degrees) between the two dim-pick lines, in the SAME
   *  wedge makeAngleDim will actually draw - picks whichever of the two
   *  supplementary angles (θ or 180-θ) is nearer the placement point
   *  (dimPlaceUV, i.e. where the user clicked to drop it; falls back to the
   *  pick lines' own midpoint if not placed yet, e.g. while only hovering).
   *  Previously this always returned the raw 0-180 angle between the two
   *  direction vectors regardless of which side of the lines the cursor was
   *  on, so the value shown in the edit box could read e.g. 150 when the
   *  glyph on screen (which DOES pick the near wedge) was clearly showing
   *  the 30-degree angle instead - user report, 2026-09-14: "it needs to...
   *  actually place where my mouse is [and]... adding/subtracting units of
   *  90 and 180 degrees as needed". */
  angleValue(): number | null {
    if (this.dimPicks.length < 2) return null
    const [p0, p1] = this.dimPicks
    if (!('ent' in p0) || !('ent' in p1)) return null
    const e0 = this.entities[p0.ent]
    const e1 = this.entities[p1.ent]
    if (!e0 || !e1 || e0.type !== 'line' || e1.type !== 'line') return null
    const pivot = this.linesIntersectUV(e0, e1) ?? [
      (e0.a[0] + e0.b[0] + e1.a[0] + e1.b[0]) / 4,
      (e0.a[1] + e0.b[1] + e1.a[1] + e1.b[1]) / 4
    ]
    const near = this.dimPlaceUV ?? [
      (e0.a[0] + e0.b[0] + e1.a[0] + e1.b[0]) / 4,
      (e0.a[1] + e0.b[1] + e1.a[1] + e1.b[1]) / 4
    ]
    const a0 = Math.atan2(e0.b[1] - e0.a[1], e0.b[0] - e0.a[0])
    const a1 = Math.atan2(e1.b[1] - e1.a[1], e1.b[0] - e1.a[0])
    const nearAng = Math.atan2(near[1] - pivot[1], near[0] - pivot[0])
    const norm = (a: number): number => {
      let x = a
      while (x <= -Math.PI) x += 2 * Math.PI
      while (x > Math.PI) x -= 2 * Math.PI
      return x
    }
    // same 4-way candidate search makeAngleDim uses, so the value shown
    // always matches the wedge actually drawn
    const candidates: Array<[number, number]> = [
      [a0, a1],
      [a0, a1 + Math.PI],
      [a0 + Math.PI, a1],
      [a0 + Math.PI, a1 + Math.PI]
    ]
    let bestSweep = norm(a1 - a0)
    let bestScore = -Infinity
    for (const [s0, s1] of candidates) {
      const mid = norm(s0 + norm(s1 - s0) / 2)
      const score = Math.cos(mid - nearAng)
      if (score > bestScore) {
        bestScore = score
        bestSweep = norm(s1 - s0)
      }
    }
    const deg = (Math.abs(bestSweep) * 180) / Math.PI
    return deg
  }

  /** commit the pending angle-between-two-lines dimension (degrees) */
  setAngleDimension(valueDeg: number): boolean {
    if (!(valueDeg > 0) || this.dimPicks.length < 2) return false
    const [p0, p1] = this.dimPicks
    if (!('ent' in p0) || !('ent' in p1)) return false
    const e0 = this.entities[p0.ent]
    const e1 = this.entities[p1.ent]
    if (!e0 || !e1 || e0.type !== 'line' || e1.type !== 'line') return false
    this.snapshot()
    const refs: RecordedConstraint['refs'] = [this.dimPickRef(p0), this.dimPickRef(p1)]
    this.constraints.push({ type: 'Angle', refs, value: valueDeg })
    this.lastUserConstraint = this.constraints.length - 1
    this.dimPicks = []
    this.selectedPts = []
    this.geomV++
    this.redraw()
    void this.runSolve()
    this.scheduleSolve()
    this.onChange()
    return true
  }

  /** an empty-space click "places" whatever is currently armed in dimPicks -
   *  1 whole-entity pick -> that entity's own linear/radius dimension; 2
   *  picks (point/point, point/line, or line/line) -> a distance, or an
   *  angle when both are non-parallel lines. A single lone POINT with
   *  nothing else has no dimension of its own, so this is a no-op until a
   *  2nd pick arrives (ctrl-click adds one without placing). */
  private firePendingDim(uv: [number, number]): void {
    if (this.dimPicks.length >= 2) {
      this.dimPlaceUV = uv
      this.fireDistanceDim()
      this.dimPlaceUV = null
      return
    }
    const only = this.dimPicks[0]
    if (only && 'ent' in only) {
      const e = this.entities[only.ent]
      if (!e) {
        this.dimPicks = []
        this.redraw()
        return
      }
      this.dimPicks = []
      this.dimPlaceUV = uv
      this.onDimensionRequest?.(only.ent, e.type === 'circle' || e.type === 'arc' ? 'radius' : 'linear')
      this.dimPlaceUV = null
      return
    }
    // a lone point pick with nothing to measure against - keep it armed
    // (do not clear dimPicks) so the very next click can still add a 2nd
    // pick or place; only Escape / a plain click elsewhere actually drops it
    this.redraw()
  }

  /** sketch-plane uv of the midpoint of an entity (line midpoint, circle/arc
   *  centre) - used to anchor a whole-entity dim pick (no single point) */
  private entMidUV(idx: number): [number, number] {
    const e = this.entAt(idx)
    if (!e) return [0, 0]
    if (e.type === 'line') return [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2]
    if (e.type === 'circle' || e.type === 'arc') return [...e.c]
    return [0, 0]
  }

  /** the (infinite-line) intersection of two line entities, or null if they
   *  are truly parallel - used to pivot an angle dimension's arc glyph */
  private linesIntersectUV(
    e0: { a: [number, number]; b: [number, number] },
    e1: { a: [number, number]; b: [number, number] }
  ): [number, number] | null {
    const d0x = e0.b[0] - e0.a[0]
    const d0y = e0.b[1] - e0.a[1]
    const d1x = e1.b[0] - e1.a[0]
    const d1y = e1.b[1] - e1.a[1]
    const denom = d0x * d1y - d0y * d1x
    if (Math.abs(denom) < 1e-9) return null
    const t = ((e1.a[0] - e0.a[0]) * d1y - (e1.a[1] - e0.a[1]) * d1x) / denom
    return [e0.a[0] + d0x * t, e0.a[1] + d0y * t]
  }

  /** a RecordedConstraint ref for either a point pick or a whole-entity pick */
  private dimPickRef(p: { pt: PtRef } | { ent: number }): RecordedConstraint['refs'][number] {
    if ('pt' in p) return this.ptRecRef(p.pt)
    return p.ent < this.baseCount ? { geo: p.ent } : { new: p.ent - this.baseCount, sub: 0 }
  }

  /** current distance between the two dim picks - point-point, point-line,
   *  or line-line (perpendicular gap between two parallel lines) */
  distancePickValue(): number | null {
    if (this.dimPicks.length < 2) return null
    const [p0, p1] = this.dimPicks
    // point-anything: measured from that point
    const ptSide = 'pt' in p0 ? p0 : 'pt' in p1 ? p1 : null
    const otherSide = ptSide === p0 ? p1 : p0
    if (ptSide) {
      const a = this.ptUV(ptSide.pt)
      if ('pt' in otherSide) {
        const b = this.ptUV(otherSide.pt)
        return Math.hypot(b[0] - a[0], b[1] - a[1])
      }
      const e = this.entities[otherSide.ent]
      if (!e || e.type !== 'line') return null
      // perpendicular distance from point a to the infinite line
      const dx = e.b[0] - e.a[0]
      const dy = e.b[1] - e.a[1]
      const L = Math.hypot(dx, dy) || 1
      return Math.abs((a[0] - e.a[0]) * dy - (a[1] - e.a[1]) * dx) / L
    }
    // both are whole entities - only line-line (perpendicular gap) is
    // meaningful as a plain Distance; anything else has no single value here
    if ('ent' in p0 && 'ent' in p1) {
      const e0 = this.entities[p0.ent]
      const e1 = this.entities[p1.ent]
      if (!e0 || !e1 || e0.type !== 'line' || e1.type !== 'line') return null
      const dx = e1.b[0] - e1.a[0]
      const dy = e1.b[1] - e1.a[1]
      const L = Math.hypot(dx, dy) || 1
      return Math.abs((e0.a[0] - e1.a[0]) * dy - (e0.a[1] - e1.a[1]) * dx) / L
    }
    return null
  }

  /** commit the pending point-to-point / point-to-line / line-to-line
   *  distance dimension */
  setDistanceDimension(value: number): boolean {
    if (!(value > 0) || this.dimPicks.length < 2) return false
    const [p0, p1] = this.dimPicks
    // a Distance constraint needs at least one POINT side in this app's
    // convention - a line-line pick (both whole entities) anchors the FIRST
    // side at that line's own first endpoint instead, which is
    // geometrically equivalent for two parallel lines and keeps a single,
    // well-defined ref shape
    let first: { pt: PtRef } | { ent: number } = p0
    if (!('pt' in p0) && !('pt' in p1)) {
      const e0 = this.entities[p0.ent]
      if (!e0 || e0.type !== 'line') return false
      first = { pt: { e: p0.ent, pt: 1 } }
    }
    this.snapshot()
    const refs: RecordedConstraint['refs'] = [this.dimPickRef(first), this.dimPickRef(p1)]
    this.constraints.push({ type: 'Distance', refs, value })
    this.lastUserConstraint = this.constraints.length - 1
    this.dimPicks = []
    this.selectedPts = []
    this.geomV++
    this.redraw()
    void this.runSolve()
    this.scheduleSolve()
    this.onChange()
    return true
  }

  /** World-space anchor for a floating inline dimension editor: where the
   *  value label for this request currently sits (or will sit, for a brand
   *  new distance pick that has not been drawn yet). Lets the app pin a real
   *  HTML input directly over the dimension instead of a modal anywhere on
   *  screen - "floating off of the sketch part it's defining", per the user's
   *  own description of how other CAD programs do this. Returns null only if
   *  there is nothing sane to anchor to (should not happen for a live request). */
  dimRequestWorldPos(
    entityIndex: number | null,
    kind: 'linear' | 'radius' | 'distance' | 'angle'
  ): [number, number, number] | null {
    // an empty-space click PLACED this dimension right here - anchor the
    // editor at the actual click point, not a re-derived midpoint, so it
    // genuinely appears where the user chose to drop it
    if (this.dimPlaceUV) {
      const w = this.toWorld(this.dimPlaceUV[0], this.dimPlaceUV[1])
      return [w.x, w.y, w.z]
    }
    if (kind === 'distance' || kind === 'angle') {
      if (this.dimPicks.length < 2) return null
      const [p0, p1] = this.dimPicks
      const uvOf = (p: { pt: PtRef } | { ent: number }): [number, number] =>
        'pt' in p ? this.ptUV(p.pt) : this.entMidUV(p.ent)
      const a = uvOf(p0)
      const b = uvOf(p1)
      const mu = (a[0] + b[0]) / 2
      const mv = (a[1] + b[1]) / 2
      const w = this.toWorld(mu, mv)
      return [w.x, w.y, w.z]
    }
    if (entityIndex == null) return null
    const existing = this.dimLabelUV.get(entityIndex)
    if (existing) {
      const w = this.toWorld(existing.uv[0], existing.uv[1])
      return [w.x, w.y, w.z]
    }
    // not drawn yet (brand new dimension, label not placed until the next
    // redrawDims pass) - fall back to the entity's own midpoint / centre
    const e = this.entities[entityIndex]
    if (!e) return null
    if (e.type === 'circle' || e.type === 'arc') {
      const w = this.toWorld(e.c[0] + e.r * 0.7, e.c[1] + e.r * 0.7)
      return [w.x, w.y, w.z]
    }
    if (e.type === 'line') {
      const w = this.toWorld((e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2)
      return [w.x, w.y, w.z]
    }
    return null
  }

  /** Nearest dimension value-label to a uv, within a screen-sized tolerance. */
  /** constraint index of the Distance / Radius / Angle dimension driving
   *  entity `owner` - for Angle, `owner` is whichever line makeAngleDim was
   *  called with as its owner (the first ref) */
  private dimConstraintIndex(owner: number): number {
    return this.constraints.findIndex((c) => {
      if (c.type === 'Angle') {
        const r0 = c.refs[0]
        if (!r0) return false
        return this.entIdxOfRef(r0) === owner
      }
      if (c.type !== 'Distance' && c.type !== 'Radius' && c.type !== 'Diameter') return false
      const r0 = c.refs[0]
      if (!r0) return false
      // point-to-point / point-to-line distances are not an entity's own linear dim
      if (c.type === 'Distance' && (c.refs.length >= 2 || r0.pt != null)) return false
      const ei = r0.geo != null ? r0.geo : (r0.new ?? -999) + this.baseCount
      return ei === owner
    })
  }

  private pickDimLabel(uv: [number, number]): { owner: number; kind: 'linear' | 'radius' | 'angle' } | null {
    const tol = this.mmForPx(30)
    let best: { owner: number; kind: 'linear' | 'radius' | 'angle' } | null = null
    let bestD = tol
    for (const [owner, v] of this.dimLabelUV) {
      const d = Math.hypot(v.uv[0] - uv[0], v.uv[1] - uv[1])
      if (d < bestD) {
        bestD = d
        best = { owner, kind: v.kind }
      }
    }
    return best
  }

  private forceDimRedraw(): void {
    this.dimV = -1
    this.redraw()
  }

  // --- input ---
  private onDown = (ev: PointerEvent): void => {
    if (ev.button !== 0) return
    trace('sketch pointer down', { x: ev.clientX, y: ev.clientY, tool: this.tool, pendingCon: this.pendingCon })
    // the "Project geometry" tool picks MODEL geometry - let the click bubble to
    // the Viewport's handler which has the model picker
    if (this.tool === 'project') return
    if (this.tool === 'dimension') {
      ev.stopPropagation()
      const raw = this.rawPointerUV(ev)
      const hp = this.pickPoint(raw)
      const entIdx = hp ? -1 : this.pickEntity(raw)
      const pick: { pt: PtRef } | { ent: number } | null = hp ? { pt: hp } : entIdx >= 0 ? { ent: entIdx } : null
      // an empty-space click PLACES the dimension being previewed - nothing
      // fires until this happens, so the value floats near wherever you
      // actually clicked to drop it, not immediately at the first pick (per
      // spec: "click a line, it should show a preview... left-click in open
      // space to place it"). With nothing armed yet, an empty click is a
      // no-op (nothing to place).
      if (!pick) {
        if (this.dimPicks.length > 0) this.firePendingDim(raw)
        else this.redraw()
        return
      }
      const samePick = (a: { pt: PtRef } | { ent: number }, b: { pt: PtRef } | { ent: number }): boolean =>
        'pt' in a && 'pt' in b
          ? this.samePt(a.pt, b.pt)
          : 'ent' in a && 'ent' in b
            ? a.ent === b.ent
            : false
      if (ev.ctrlKey || ev.metaKey) {
        // ADD a second line/point to dimension between - up to 2 picks total;
        // a 3rd ctrl-click replaces the 2nd (matches "switch" for the active
        // slot rather than silently growing forever)
        if (!this.dimPicks.some((p) => samePick(p, pick))) {
          if (this.dimPicks.length >= 2) this.dimPicks[1] = pick
          else this.dimPicks.push(pick)
        }
      } else {
        // plain click: SWITCH which line/point is being dimensioned - starts
        // a fresh single-pick session, discarding anything else queued
        this.dimPicks = [pick]
      }
      this.redraw()
      return
    }
    if (this.tool === 'select') {
      const uv = this.rawPointerUV(ev)
      ev.stopPropagation()

      // grab a dimension's value label to reposition it (bubble + witness /
      // leader lines follow). Checked before geometry so the label wins.
      if (!this.pendingCon) {
        const dl = this.pickDimLabel(uv)
        if (dl) {
          // select the dimension (Delete removes it); an angle dim's label
          // is not yet drag-repositionable (always drawn at its default
          // spot), so only arm a drag for the kinds that support it
          this.selectedDim = this.dimConstraintIndex(dl.owner)
          this.selected = []
          if (dl.kind !== 'angle') {
            this.dimDrag = {
              owner: dl.owner,
              kind: dl.kind,
              startUV: uv,
              base: this.dimOffsets.get(dl.owner) ?? [0, 0]
            }
            this.dom.style.cursor = 'move'
          }
          this.forceDimRedraw()
          this.onChange()
          return
        }
      }
      if (this.selectedDim != null) {
        this.selectedDim = null
        this.dimV = -1
      }

      // a geometry POINT (line end, circle / arc centre) beats the curve under
      // it - including in "click the constraint, then click the geometry"
      // mode, so a center-point arc's centre / endpoints can be constrained
      // the same way whole entities can (otherwise pendingCon mode can only
      // ever grab the whole arc, and e.g. Coincident on two whole arcs is
      // meaningless and silently does nothing)
      const hitPt = this.pickPoint(uv)
      if (hitPt) {
        if (this.pendingCon) {
          if (!this.selectedPts.some((p) => this.samePt(p, hitPt))) {
            this.selectedPts.push(hitPt)
          }
          if (this.selectedPts.length + this.selected.length >= this.conArity(this.pendingCon)) {
            const t = this.pendingCon
            this.pendingCon = null
            this.dom.style.cursor = ''
            this.applyConstraint(t)
          }
          this.redraw()
          this.onChange()
          return
        }
        if (ev.shiftKey || ev.ctrlKey || ev.metaKey) {
          this.selectedPts = this.selectedPts.some((p) => this.samePt(p, hitPt))
            ? this.selectedPts.filter((p) => !this.samePt(p, hitPt))
            : [...this.selectedPts, hitPt]
        } else {
          this.selectedPts = [hitPt]
          this.selected = []
          // keep it draggable (the centre / an endpoint) unless it is locked
          const locked =
            this.constrainedSet.has(hitPt.e) ||
            (this.sketchFullyConstrained && !this.entities[hitPt.e]?.construction)
          if (!locked) {
            this.drag = { idx: hitPt.e, handle: this.ptToHandle(hitPt), last: uv }
            this.dragMoved = false
            this.preDragSnap = { ents: this.cloneEnts(), cons: this.cloneCons(), ...this.cloneBaseTracking() }
            trace('sketch drag start (point)', {
              idx: hitPt.e,
              pt: hitPt.pt,
              entType: this.entities[hitPt.e]?.type,
              handle: this.drag.handle
            })
          }
        }
        this.redraw()
        this.onChange()
        return
      }

      const idx = this.pickEntity(uv)

      // "click the constraint, then click the geometry" mode
      if (this.pendingCon) {
        if (idx >= 0 && !this.selected.includes(idx)) this.selected.push(idx)
        if (this.selectedPts.length + this.selected.length >= this.conArity(this.pendingCon)) {
          const t = this.pendingCon
          this.pendingCon = null
          this.dom.style.cursor = ''
          this.applyConstraint(t)
        }
        this.redraw()
        this.onChange()
        return
      }

      if (!ev.shiftKey) this.selectedPts = []
      if (idx < 0) {
        if (!ev.shiftKey) this.selected = []
        // empty press starts a rubber-band window select
        this.band = { a: uv, b: uv }
      } else if (ev.shiftKey) {
        this.selected = this.selected.includes(idx)
          ? this.selected.filter((i) => i !== idx)
          : [...this.selected, idx]
      } else {
        this.selected = [idx]
        // a fully-constrained entity (or a fully-constrained sketch) cannot be
        // dragged at all - do not even start a drag
        const locked =
          this.constrainedSet.has(idx) ||
          (this.sketchFullyConstrained && !this.entities[idx]?.construction)
        if (locked) {
          this.noticeOnce(
            'This geometry is fully defined - delete a dimension or constraint to move it.'
          )
        } else {
          this.drag = { idx, handle: this.grabHandle(idx, uv), last: uv }
          this.dragMoved = false
          this.preDragSnap = { ents: this.cloneEnts(), cons: this.cloneCons(), ...this.cloneBaseTracking() }
          trace('sketch drag start (entity)', { idx, entType: this.entities[idx]?.type, handle: this.drag.handle })
        }
      }
      this.redraw()
      this.onChange()
      return
    }
    ev.stopPropagation()
    const uv = this.pointerUV(ev)
    this.pending.push(uv)
    this.pendingSnaps.push(this.snapRef)
    this.pendingMids.push(this.snapMid)
    if (this.tool === 'spline') {
      // spline collects points until Enter / double-click
      this.redraw()
      return
    }
    const need =
      this.tool === 'arc' || this.tool === 'arc-3p' || this.tool === 'circle-3p' ? 3 : 2
    if (this.pending.length >= need) this.commit()
    this.redraw()
  }

  /** true if the entity carries a locked-in dimension (Distance / Radius) */
  private entityHasDimension(idx: number): boolean {
    return this.constraints.some((c) => {
      if (c.type !== 'Distance' && c.type !== 'Radius' && c.type !== 'Diameter') return false
      const r0 = c.refs[0]
      if (c.type === 'Distance' && (c.refs.length >= 2 || r0?.pt != null)) return false
      const ei = r0?.geo != null ? r0.geo : (r0?.new ?? -999) + this.baseCount
      return ei === idx
    })
  }

  /** Which part of an entity the cursor grabbed, for free-dragging. */
  private grabHandle(idx: number, uv: [number, number]): DragHandle {
    const e = this.entities[idx]
    // a dimensioned entity is locked: you can slide it, not resize it
    if (this.entityHasDimension(idx)) return 'whole'
    const tol = SNAP_PX / Math.max(this.pxPerMm(), 0.001)
    const near = (p: [number, number]): boolean => Math.hypot(p[0] - uv[0], p[1] - uv[1]) < tol
    if (e.type === 'line' || e.type === 'rect') {
      if (near(e.a)) return 'a'
      if (near(e.b)) return 'b'
      if (e.type === 'rect') {
        if (near([e.a[0], e.b[1]])) return 'ab'
        if (near([e.b[0], e.a[1]])) return 'ba'
      }
      return 'whole'
    }
    if (e.type === 'spline') return 'whole'
    if (near(e.c)) return 'c'
    // an arc's endpoints sit ON the radius ring, so they must be checked
    // BEFORE the generic ring-drag ('r') or they are never reachable - a
    // click near either end changes where the sweep starts/stops, not the
    // radius uniformly
    if (e.type === 'arc') {
      if (near(this.ptUV({ e: idx, pt: 1 }))) return 'a0'
      if (near(this.ptUV({ e: idx, pt: 2 }))) return 'a1'
    }
    if (Math.abs(Math.hypot(uv[0] - e.c[0], uv[1] - e.c[1]) - e.r) < tol) return 'r'
    return 'whole'
  }

  /** Move the dragged entity to follow the cursor. No solver - this is the
   *  "drag whatever is still free" behaviour; the sidecar re-solves on finish. */
  private applyDrag(raw: [number, number]): void {
    if (!this.drag) return
    const e = this.entities[this.drag.idx]
    // drop movement along directions the constraints already pin down
    const clamped = this.clampDragTarget(this.drag.idx, this.drag.handle, raw)
    if (!clamped) {
      this.drag.last = raw
      return
    }
    const uv = clamped
    const dx = uv[0] - this.drag.last[0]
    const dy = uv[1] - this.drag.last[1]
    const move = (p: [number, number]): [number, number] => [p[0] + dx, p[1] + dy]

    // dragging a dimensioned rectangle edge should translate the WHOLE rectangle
    // rigidly (dimensions preserved), not stretch it against a pinned far side
    if (this.drag.handle === 'whole' && e.type === 'line') {
      const loop = this.rectLoopOf(this.drag.idx)
      const sized =
        loop &&
        loop.some((li) => this.entityHasDimension(li) && this.lineHasHV(li, 'Horizontal')) &&
        loop.some((li) => this.entityHasDimension(li) && this.lineHasHV(li, 'Vertical'))
      if (loop && sized) {
        for (const li of loop) {
          const le = this.entities[li]
          if (le && le.type === 'line') {
            le.a = move(le.a)
            le.b = move(le.b)
          }
        }
        this.dragMoved = true
        this.drag.last = uv
        this.geomV++
        this.redraw()
        return
      }
      // a line anchored at exactly ONE end (welded/tangent to a fixed
      // neighbour) cannot rigidly translate - that end genuinely cannot
      // move - but it is NOT fully stuck either: degrade to moving just the
      // free endpoint, exactly like an a/b drag on that same point (the
      // mechanism already proven safe: solveLocal's weld/tangent pass holds
      // the anchored end and pivots the neighbour to match). Previously this
      // either force-translated both ends regardless (corrupting the
      // anchored join) or refused the whole drag outright the moment either
      // end was anchored (too strict - user report, 2026-09-13: "if a line
      // ... CAN move AT ALL ... it should move but, ONLY in the way(s) it's
      // unconstrained").
      const [aAnchored, bAnchored] = this.lineEndpointsAnchored(this.drag.idx)
      if (aAnchored !== bAnchored) {
        const i = this.drag.idx
        if (aAnchored) {
          e.b = [uv[0], uv[1]]
          this.solveLocal(new Set([`${i}:2`]), this.rectHoldKeys())
        } else {
          e.a = [uv[0], uv[1]]
          this.solveLocal(new Set([`${i}:1`]), this.rectHoldKeys())
        }
        this.dragMoved = true
        this.drag.last = aAnchored ? [...e.b] : [...e.a]
        this.geomV++
        this.redraw()
        return
      }
    }

    switch (this.drag.handle) {
      case 'whole':
        if (e.type === 'line' || e.type === 'rect') {
          e.a = move(e.a)
          e.b = move(e.b)
        } else if (e.type === 'spline') {
          e.pts = e.pts.map(move)
        } else e.c = move(e.c)
        break
      case 'a':
        if (e.type === 'line' || e.type === 'rect') e.a = [uv[0], uv[1]]
        break
      case 'b':
        if (e.type === 'line' || e.type === 'rect') e.b = [uv[0], uv[1]]
        break
      case 'ab':
        if (e.type === 'rect') {
          e.a = [uv[0], e.a[1]]
          e.b = [e.b[0], uv[1]]
        }
        break
      case 'ba':
        if (e.type === 'rect') {
          e.b = [uv[0], e.b[1]]
          e.a = [e.a[0], uv[1]]
        }
        break
      case 'c':
        if (e.type === 'circle' || e.type === 'arc') e.c = [uv[0], uv[1]]
        break
      case 'r':
        if (e.type === 'circle' || e.type === 'arc')
          (e as { r: number }).r = Math.max(0.1, Math.hypot(uv[0] - e.c[0], uv[1] - e.c[1]))
        break
      case 'a0':
        if (e.type === 'arc') e.a0 = Math.atan2(uv[1] - e.c[1], uv[0] - e.c[0])
        break
      case 'a1':
        if (e.type === 'arc') e.a1 = Math.atan2(uv[1] - e.c[1], uv[0] - e.c[0])
        break
    }
    // keep coincident corners welded and honour H / V while dragging - a
    // rectangle side stays a rectangle side (the sidecar still re-solves later)
    this.solveLocal(this.draggedKeys(), this.rectHoldKeys())
    this.dragMoved = true
    // Anchor the next delta to where the dragged handle ACTUALLY ended up after
    // the local solve, not where the cursor is. Without this, dragging against a
    // constraint lets the cursor run away from the geometry (it snaps back on
    // release) - misleading. Now the handle stays glued to the constrained
    // position and the drag simply resists.
    const dh = this.drag.handle
    if (dh === 'a' && (e.type === 'line' || e.type === 'rect')) this.drag.last = [...e.a]
    else if (dh === 'b' && (e.type === 'line' || e.type === 'rect')) this.drag.last = [...e.b]
    else if (dh === 'c' && (e.type === 'circle' || e.type === 'arc')) this.drag.last = [...e.c]
    else if (dh === 'a0' && e.type === 'arc') this.drag.last = this.ptUV({ e: this.drag.idx, pt: 1 })
    else if (dh === 'a1' && e.type === 'arc') this.drag.last = this.ptUV({ e: this.drag.idx, pt: 2 })
    else this.drag.last = uv
    this.geomV++
    this.redraw()
  }

  /** The 4 line-entity indices of a closed rectangle-ish loop through `startIdx`,
   *  in loop order, or null. Uses the recorded Coincident welds. */
  private rectLoopOf(startIdx: number): number[] | null {
    const e0 = this.entities[startIdx]
    if (!e0 || e0.type !== 'line') return null
    const groups = this.weldGroups()
    const at = (ent: number, pt: number): { ent: number; pt: number } | null => {
      const g = groups.find((s) => s.has(`${ent}:${pt}`))
      if (!g) return null
      for (const k of g) {
        const [ei, p] = k.split(':').map(Number)
        if (ei !== ent && this.entities[ei]?.type === 'line') return { ent: ei, pt: p }
      }
      return null
    }
    const loop = [startIdx]
    let cur = startIdx
    let enterPt = 1
    for (let i = 0; i < 4; i++) {
      const nx = at(cur, enterPt === 1 ? 2 : 1)
      if (!nx) return null
      if (nx.ent === startIdx) return loop.length === 4 ? loop : null
      if (loop.includes(nx.ent)) return null
      loop.push(nx.ent)
      cur = nx.ent
      enterPt = nx.pt
    }
    return null
  }

  /** While dragging inside a rectangle loop, pin the far side so it resizes
   *  cleanly rather than shearing: opposite edge for an edge drag, opposite
   *  corner for a corner drag. */
  private rectHoldKeys(): Set<string> {
    const out = new Set<string>()
    if (!this.drag) return out
    const loop = this.rectLoopOf(this.drag.idx)
    if (!loop) return out
    const opp = loop[(loop.indexOf(this.drag.idx) + 2) % 4]
    const oe = this.entities[opp]
    if (!oe || oe.type !== 'line') return out
    const de = this.entities[this.drag.idx] as { a: [number, number]; b: [number, number] }
    if (this.drag.handle === 'a' || this.drag.handle === 'b') {
      const dp = this.drag.handle === 'a' ? de.a : de.b
      const d1 = Math.hypot(oe.a[0] - dp[0], oe.a[1] - dp[1])
      const d2 = Math.hypot(oe.b[0] - dp[0], oe.b[1] - dp[1])
      out.add(d1 >= d2 ? `${opp}:1` : `${opp}:2`)
    } else {
      out.add(`${opp}:1`)
      out.add(`${opp}:2`)
    }
    return out
  }

  /** point keys ("idx:pt") the current drag handle directly controls */
  private draggedKeys(): Set<string> {
    const out = new Set<string>()
    if (!this.drag) return out
    const i = this.drag.idx
    switch (this.drag.handle) {
      case 'a':
        out.add(`${i}:1`)
        break
      case 'b':
        out.add(`${i}:2`)
        break
      case 'c':
      case 'r':
        // dragging either handle moves the WHOLE arc (both rim points move
        // too - 'r' changes their distance from centre, 'c' translates them
        // with it), so anything welded/tangent to a rim point must follow
        // the new rim position, not get averaged against it by the weld
        // pass in solveLocal. Previously only the centre (pt 3) was pinned
        // here, so a line coincident-welded to the arc's rim visually tore
        // away from it while radius-dragging - most visibly when the arc's
        // centre was ALSO independently welded to something else (a real
        // user file: "the arc became disconnected from the lines... why is
        // there the original version viewable, unchanged", 2026-09-13).
        out.add(`${i}:1`)
        out.add(`${i}:2`)
        out.add(`${i}:3`)
        break
      case 'a0':
        out.add(`${i}:1`)
        break
      case 'a1':
        out.add(`${i}:2`)
        break
      default:
        out.add(`${i}:1`)
        out.add(`${i}:2`)
        out.add(`${i}:3`)
    }
    return out
  }

  private onUp = (ev: PointerEvent): void => {
    if (this.dimDrag) {
      this.dimDrag = null
      this.dom.style.cursor = ''
      ev.stopPropagation()
      this.onChange()
      return
    }
    if (this.band) {
      this.commitBand()
      this.band = null
      this.redraw()
      ev.stopPropagation()
      this.onChange()
      return
    }
    if (!this.drag) return
    const idx = this.drag.idx
    this.drag = null
    // only a drag that actually moved something is an undo step
    if (this.dragMoved && this.preDragSnap) {
      this.undoStack.push(this.preDragSnap)
      if (this.undoStack.length > 120) this.undoStack.shift()
    }
    this.preDragSnap = null
    this.dragMoved = false
    // a point dropped on the origin / an axis gets auto-constrained (snapping
    // already put the coordinate exactly on it)
    this.anchorToAxes(idx)
    this.solveLocal(new Set())
    this.geomV++
    this.redraw()
    // snap to the EXACT constrained shape now, not 240 ms later - the local
    // relaxation is only an approximation, the real solver honours every
    // dimension. Without this a dimensioned rectangle stays visibly off.
    void this.runSolve()
    this.scheduleSolve()
    ev.stopPropagation()
    this.onChange()
  }

  /** Select every entity that falls inside the rubber-band box. Left-to-right =
   *  fully contained; right-to-left = anything it touches (CAD convention). */
  private commitBand(): void {
    if (!this.band) return
    const [ax, ay] = this.band.a
    const [bx, by] = this.band.b
    const minX = Math.min(ax, bx)
    const maxX = Math.max(ax, bx)
    const minY = Math.min(ay, by)
    const maxY = Math.max(ay, by)
    if (maxX - minX < 1e-4 && maxY - minY < 1e-4) return
    const crossing = bx < ax
    const inside = (p: [number, number]): boolean =>
      p[0] >= minX && p[0] <= maxX && p[1] >= minY && p[1] <= maxY
    const entPts = (e: SketchEntity): [number, number][] => {
      if (e.type === 'line') return [e.a, e.b, [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2]]
      if (e.type === 'circle' || e.type === 'arc')
        return [
          e.c,
          [e.c[0] + e.r, e.c[1]],
          [e.c[0] - e.r, e.c[1]],
          [e.c[0], e.c[1] + e.r],
          [e.c[0], e.c[1] - e.r]
        ]
      if (e.type === 'spline') return e.pts
      return [e.a, e.b]
    }
    const hits: number[] = []
    this.entities.forEach((e, i) => {
      if (this.deletedBaseSet.has(i)) return
      const n = entPts(e).filter(inside).length
      if (crossing ? n > 0 : n === entPts(e).length) hits.push(i)
    })
    // projected (external) geometry is a window-select target too, same as a
    // plain click already handles via pickEntity - this loop was missing
    // entirely, so a window-select could never pick up projected geometry no
    // matter how tightly the box was drawn around it (user report,
    // 2026-09-12: "I can't seem to even window-select projected geometry?").
    this.projected.forEach(({ ent }, k) => {
      const n = entPts(ent).filter(inside).length
      const total = entPts(ent).length
      if (crossing ? n > 0 : n === total) hits.push(PROJ_BASE + k)
    })
    this.selected = hits
  }

  private onMove = (ev: PointerEvent): void => {
    if (this.dimDrag && (ev.buttons & 1) === 1) {
      const cur = this.rawPointerUV(ev)
      const dU = cur[0] - this.dimDrag.startUV[0]
      const dV = cur[1] - this.dimDrag.startUV[1]
      const b = this.dimDrag.base
      if (this.dimDrag.kind === 'radius') {
        this.dimOffsets.set(this.dimDrag.owner, [b[0] + dU, b[1] + dV])
      } else {
        const e = this.entities[this.dimDrag.owner]
        if (e && e.type === 'line') {
          const dx = e.b[0] - e.a[0]
          const dy = e.b[1] - e.a[1]
          const L = Math.hypot(dx, dy) || 1
          const ux = dx / L
          const uy = dy / L
          const along = dU * ux + dV * uy
          const perp = dU * -uy + dV * ux
          this.dimOffsets.set(this.dimDrag.owner, [b[0] + perp, b[1] + along])
        }
      }
      this.forceDimRedraw()
      return
    }
    if (this.band && (ev.buttons & 1) === 1) {
      this.band.b = this.rawPointerUV(ev)
      this.redraw()
      return
    }
    if (this.drag && (ev.buttons & 1) === 1) {
      this.applyDrag(this.pointerUV(ev))
      return
    }
    // constraint-symbol hover works in any tool mode; it lights the symbol,
    // its partner symbols (same key) and the edges they constrain
    const symKey = this.pickSym(ev)
    if (symKey !== this.hoverSymKey) {
      this.hoverSymKey = symKey
      this.hoverSymEnts = symKey ? new Set(this.symEnts.get(symKey) ?? []) : new Set()
      this.applySymHighlight()
      this.redraw()
    }
    if (this.tool === 'select' || this.tool === 'dimension') {
      const raw = this.rawPointerUV(ev)
      const onLabel = this.tool === 'select' && !symKey && this.pickDimLabel(raw)
      const hp = symKey || onLabel ? null : this.pickPoint(raw)
      const idx = symKey || onLabel || hp ? -1 : this.pickEntity(raw)
      if (idx !== this.hoverIdx || !this.samePt(hp, this.hoverPt)) {
        this.hoverIdx = idx
        this.hoverPt = hp
        this.redraw()
      }
      this.dom.style.cursor = onLabel ? 'move' : hp || idx >= 0 || symKey ? 'pointer' : ''
      // the Dimension tool has something armed - track the cursor so the
      // live "follows the cursor toward wherever you place it" preview (see
      // redrawDims) actually updates every frame, not just when hover state
      // changes
      if (this.tool === 'dimension' && this.dimPicks.length > 0) {
        this.cursorUV = raw
        this.redraw()
      }
      return
    }
    if (this.hoverIdx !== -1) this.hoverIdx = -1
    this.cursorUV = this.pointerUV(ev)
    this.redraw() // keep the snap marker + live dimension under the cursor
  }

  private onKey = (ev: KeyboardEvent): void => {
    const t = ev.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return
    if (ev.key === 'Escape') {
      this.pending = []
      this.pendingSnaps = []
      this.pendingMids = []
      this.selected = []
      this.selectedPts = []
      this.dimPicks = []
      this.selectedDim = null
      this.dimV = -1
      this.band = null
      this.pendingCon = null
      this.dom.style.cursor = ''
      this.redraw()
    } else if (
      (ev.key === 'Delete' || ev.key === 'Backspace') &&
      this.tool === 'select' &&
      this.selectedDim != null
    ) {
      ev.preventDefault()
      this.deleteDimension()
    } else if (
      (ev.key === 'd' || ev.key === 'D') &&
      this.tool === 'select' &&
      this.selectedDim != null &&
      !ev.ctrlKey &&
      !ev.metaKey
    ) {
      // toggle the selected circle/arc dimension between radius and diameter
      if (this.toggleSelectedDimKind()) ev.preventDefault()
    } else if (ev.key === 'Enter' && this.tool === 'spline' && this.pending.length >= 2) {
      this.commit()
      this.redraw()
    } else if (ev.key === 'Enter' && this.tool === 'line') {
      this.pending = []
      this.pendingSnaps = []
      this.pendingMids = []
      this.redraw()
    } else if (
      (ev.key === 'Delete' || ev.key === 'Backspace') &&
      this.tool === 'select' &&
      (this.selected.length || this.selectedPts.length)
    ) {
      ev.preventDefault()
      this.deleteSelected()
    } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') {
      this.undo()
    }
  }

  /** Remove the dimension whose label is selected. Any Distance / Radius (base
   *  or session) can go - that is the whole point of "delete a dimension". */
  private deleteDimension(): void {
    const i = this.selectedDim
    this.selectedDim = null
    if (i == null || i < 0 || i >= this.constraints.length) {
      this.redraw()
      return
    }
    this.snapshot()
    if (i < this.baseConstraintCount) {
      // a dimension that came back from a reopen - queue it for removal from the
      // real sketch on Finish, and shift the base count so new refs stay aligned
      this.removedBaseConstraints.push(this.constraints[i])
      this.baseConstraintCount--
    }
    this.constraints.splice(i, 1)
    if (this.lastUserConstraint === i) this.lastUserConstraint = -1
    else if (this.lastUserConstraint > i) this.lastUserConstraint--
    this.geomV++
    this.redraw()
    this.scheduleSolve()
    this.onChange()
  }

  /** Delete the selected entities - session-drawn ones are spliced out; a
   *  reopened (base) one is queued for removal from the real sketch on Finish
   *  (removedElements) and hidden locally. Constraints that referenced a deleted
   *  entity are dropped; session-entity `new` refs are reindexed. Points-only
   *  selections resolve to their owning entities. */
  private deleteSelected(): void {
    // a points-only selection deletes the owning entities
    const targets = new Set<number>(this.selected)
    for (const pt of this.selectedPts) targets.add(pt.e)
    if (!targets.size) {
      this.selectedPts = []
      this.redraw()
      return
    }
    this.snapshot()

    const baseIdx = [...targets].filter((i) => i < this.baseCount).sort((a, b) => a - b)
    const sessRel = [...targets]
      .filter((i) => i >= this.baseCount)
      .map((i) => i - this.baseCount)
      .sort((a, b) => b - a)

    // base geometry: cannot splice (indices are the reopen contract) - mark it
    // removed, drop constraints touching it, and blank it so it stops drawing
    for (const bi of baseIdx) {
      if (!this.removedBaseEntities.includes(bi)) this.removedBaseEntities.push(bi)
      // any base constraint on it must also be removed from the real sketch
      for (const c of this.constraints) {
        if (
          this.constraints.indexOf(c) < this.baseConstraintCount &&
          c.refs.some((rf) => rf.geo === bi)
        ) {
          this.removedBaseConstraints.push({
            type: c.type,
            refs: c.refs.map((r) => ({ ...r }))
          })
        }
      }
      this.constraints = this.constraints.filter((c) => !c.refs.some((rf) => rf.geo === bi))
      this.baseConstraintCount = Math.min(this.baseConstraintCount, this.constraints.length)
    }
    // hide the deleted base entities locally without changing indices
    for (const bi of baseIdx) this.deletedBaseSet.add(bi)

    // session geometry: real splice + reindex
    for (const r of sessRel) {
      this.entities.splice(this.baseCount + r, 1)
      this.constraints = this.constraints.filter((c) => !c.refs.some((rf) => rf.new === r))
      for (const c of this.constraints)
        for (const rf of c.refs) if (rf.new != null && rf.new > r) rf.new--
    }

    this.selected = []
    this.selectedPts = []
    this.selectedDim = null
    this.dimOffsets.clear()
    this.geomV++
    this.redraw()
    this.scheduleSolve()
    this.onChange()
  }

  private commit(): void {
    this.snapshot() // one undo step per shape (a rectangle is 4 lines)
    const p = this.pending
    const snaps = this.pendingSnaps
    const mids = this.pendingMids
    const entsBefore = this.entities.length
    const consBefore = this.constraints.length
    trace('sketch commit', { tool: this.tool, points: p, snaps })
    this.geomV++
    const k = this.construction ? { construction: true } : {}
    if (this.tool === 'line') {
      this.entities.push({ type: 'line', a: p[0], b: p[1], ...k })
      const li = this.entities.length - 1
      // real/projected-geometry snaps FIRST, then axis-anchoring - so a point
      // that is BOTH on an axis and coincident with something real (e.g. a
      // projected edge that happens to land on the sketch's own axis) only
      // gets the one meaningful constraint instead of anchorToAxes piling a
      // redundant/over-constraining PointOnObject onto the axis as well
      this.autoCoincident(li, [snaps[0] ?? null, snaps[1] ?? null])
      this.autoMidpoint(li, [mids[0] ?? null, mids[1] ?? null])
      this.autoAngle(li) // near-horizontal / near-vertical -> real H/V constraint
      this.autoTangent(li, [snaps[0] ?? null, snaps[1] ?? null])
      this.anchorToAxes(li)
      this.pending = [p[1]] // chain
      this.pendingSnaps = [snaps[1] ?? null]
      this.pendingMids = [mids[1] ?? null]
    } else if (this.tool === 'rect' || this.tool === 'rect-center') {
      // a rectangle IS four constrained lines - build it that way so every
      // downstream path (dimensions, dragging, symbols) is uniform
      let x0: number, y0: number, x1: number, y1: number
      if (this.tool === 'rect-center') {
        const hw = p[1][0] - p[0][0]
        const hh = p[1][1] - p[0][1]
        x0 = p[0][0] - hw
        y0 = p[0][1] - hh
        x1 = p[0][0] + hw
        y1 = p[0][1] + hh
      } else {
        ;[x0, y0] = p[0]
        ;[x1, y1] = p[1]
      }
      this.pushRect(
        [
          [x0, y0],
          [x1, y0],
          [x1, y1],
          [x0, y1]
        ],
        this.tool === 'rect-center'
      )
      // anchor a Center Rectangle's centre to whatever the first pick landed on
      if (this.tool === 'rect-center' && this.centerRectAnchor) {
        const { d0, d1 } = this.centerRectAnchor
        const s0 = snaps[0] ?? null
        const wasOrigin = Math.hypot(p[0][0], p[0][1]) < 1e-6
        if (wasOrigin) {
          // crossing on the origin: each diagonal passes through it
          this.constraints.push({ type: 'PointOnObject', refs: [{ geo: -1, pt: 1 }, { new: d0, sub: 0 }] })
          this.constraints.push({ type: 'PointOnObject', refs: [{ geo: -1, pt: 1 }, { new: d1, sub: 0 }] })
        } else if (s0) {
          // crossing on a real geometry point: mirror it about the other
          // diagonal so the crossing tracks that point
          const tref =
            s0.idx < this.baseCount
              ? { geo: s0.idx, pt: s0.pt }
              : { new: s0.idx - this.baseCount, sub: 0, pt: s0.pt }
          this.constraints.push({ type: 'PointOnObject', refs: [tref, { new: d0, sub: 0 }] })
          this.constraints.push({ type: 'PointOnObject', refs: [tref, { new: d1, sub: 0 }] })
        }
      }
      this.centerRectAnchor = null
      this.pending = []
      this.pendingSnaps = []
      this.pendingMids = []
    } else if (this.tool === 'circle') {
      const r = Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1])
      this.entities.push({ type: 'circle', c: p[0], r, ...k })
      const ci = this.entities.length - 1
      this.anchorToAxes(ci)
      this.autoCoincident(ci, [snaps[0] ?? null])
      this.pending = []
      this.pendingSnaps = []
      this.pendingMids = []
    } else if (this.tool === 'circle-3p') {
      const cc = SketchController.circumcircle(p[0], p[1], p[2])
      if (cc) {
        this.entities.push({ type: 'circle', c: cc.c, r: cc.r, ...k })
        this.constrainThroughSnaps(this.entities.length - 1, [snaps[0], snaps[1], snaps[2]])
      }
      this.pending = []
      this.pendingSnaps = []
      this.pendingMids = []
    } else if (this.tool === 'arc') {
      const c = p[0]
      const r = Math.hypot(p[1][0] - c[0], p[1][1] - c[1])
      const a0 = Math.atan2(p[1][1] - c[1], p[1][0] - c[0])
      const a1 = Math.atan2(p[2][1] - c[1], p[2][0] - c[0])
      this.entities.push({ type: 'arc', c, r, a0, a1, ...k })
      const ai = this.entities.length - 1
      // centre-point arc: the FIRST click is the centre, same as the plain
      // circle tool - if it landed on another point, weld it with a real
      // Coincident (was only ever anchored to an axis, never to geometry;
      // the circle tool already did this correctly)
      this.autoCoincident(ai, [snaps[0] ?? null])
      // the SECOND (start/radius) and THIRD (end) clicks set the arc's rim
      // points - these can also snap onto existing geometry (another line's
      // endpoint, another arc's rim, a projected edge...) and used to be
      // silently dropped: only the centre ever got auto-constrained, so an
      // arc drawn to visually close a wire against another entity's endpoint
      // left that joint completely unconstrained - the wire read as open no
      // matter how precisely you clicked (user report, 2026-09-11: "it also
      // doesn't seem to want to make an enclosed face for my sketch").
      // myPtsOverride [1, 2] maps snaps[1]->pt 1 (arc start) and
      // snaps[2]->pt 2 (arc end); pass a matching 2-slot snap array since
      // autoCoincident indexes its own snaps positionally against myPts.
      this.autoCoincident(ai, [snaps[1] ?? null, snaps[2] ?? null], [1, 2])
      this.anchorToAxes(ai)
      this.pending = []
      this.pendingSnaps = []
      this.pendingMids = []
    } else if (this.tool === 'arc-3p') {
      // start, end, a point the arc passes through
      const cc = SketchController.circumcircle(p[0], p[1], p[2])
      if (cc) {
        const ang = (q: [number, number]): number =>
          Math.atan2(q[1] - cc.c[1], q[0] - cc.c[0])
        let a0 = ang(p[0])
        const aEnd = ang(p[1])
        const aMid = ang(p[2])
        const norm = (x: number): number => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
        // sweep CCW from a0; if the mid point is not inside that sweep, go CW
        let span = norm(aEnd - a0)
        if (norm(aMid - a0) > span) {
          a0 = aEnd
          span = 2 * Math.PI - span
        }
        this.entities.push({ type: 'arc', c: cc.c, r: cc.r, a0, a1: a0 + span, ...k })
        this.anchorToAxes(this.entities.length - 1)
        this.constrainThroughSnaps(this.entities.length - 1, [snaps[0], snaps[1], snaps[2]])
      }
      this.pending = []
      this.pendingSnaps = []
      this.pendingMids = []
    } else if (this.tool === 'spline') {
      if (p.length >= 2) {
        this.entities.push({ type: 'spline', pts: p.map((q) => [q[0], q[1]] as [number, number]), ...k })
        this.anchorToAxes(this.entities.length - 1)
      }
      this.pending = []
      this.pendingSnaps = []
      this.pendingMids = []
    }
    trace('sketch commit done', {
      newEntities: this.entities.length - entsBefore,
      newConstraints: this.constraints.length - consBefore
    })
    this.scheduleSolve()
    this.onChange()
  }

  /** Push a 4-corner loop as four coincident + H/V constrained line entities.
   *  `withDiagonals` adds the two construction diagonals (welded to the corners)
   *  so a center-rectangle reads as one and gives the centre something to snap
   *  to on later edits. */
  private pushRect(c: [number, number][], withDiagonals = false): void {
    const k = this.construction ? { construction: true } : {}
    const first = this.entities.length - this.baseCount
    for (let s = 0; s < 4; s++) this.entities.push({ type: 'line', a: c[s], b: c[(s + 1) % 4], ...k })
    if (!this.construction) {
      const g = (s: number): number => first + s
      for (let s = 0; s < 4; s++) {
        this.constraints.push({
          type: 'Coincident',
          refs: [
            { new: g(s), sub: 0, pt: 2 },
            { new: g((s + 1) % 4), sub: 0, pt: 1 }
          ]
        })
      }
      this.constraints.push({ type: 'Horizontal', refs: [{ new: g(0), sub: 0 }] })
      this.constraints.push({ type: 'Horizontal', refs: [{ new: g(2), sub: 0 }] })
      this.constraints.push({ type: 'Vertical', refs: [{ new: g(1), sub: 0 }] })
      this.constraints.push({ type: 'Vertical', refs: [{ new: g(3), sub: 0 }] })
      for (let s = 0; s < 4; s++) this.anchorToAxes(this.baseCount + first + s)

      if (withDiagonals) {
        // corner s is line s start (pt 1). Diagonals: 0-2 and 1-3.
        const d0 = this.entities.length - this.baseCount
        this.entities.push({ type: 'line', a: c[0], b: c[2], construction: true })
        this.entities.push({ type: 'line', a: c[1], b: c[3], construction: true })
        const weld = (dg: number, dp: number, cg: number): void => {
          this.constraints.push({
            type: 'Coincident',
            refs: [
              { new: dg, sub: 0, pt: dp },
              { new: first + cg, sub: 0, pt: 1 }
            ]
          })
        }
        weld(d0, 1, 0)
        weld(d0, 2, 2)
        weld(d0 + 1, 1, 1)
        weld(d0 + 1, 2, 3)
        // the two construction diagonals are welded to all four corners, so for
        // any rectangle they already cross at the exact centre - the midpoint
        // snap of either diagonal IS the centre point, no extra constraint.
        // commit() may still anchor that crossing to the origin / a real point
        // the first pick landed on.
        this.centerRectAnchor = { d0, d1: d0 + 1 }
      }
    }
  }

  /** Constrain a just-added curve to pass through whichever of the drawn points
   *  snapped onto existing geometry - so a 3-point circle / arc through real
   *  corners updates when those corners move. */
  private constrainThroughSnaps(
    entIdx: number,
    snaps: Array<{ idx: number; pt: number } | null>
  ): void {
    const nw = entIdx - this.baseCount
    if (nw < 0) return
    for (const s of snaps) {
      if (!s || s.idx === entIdx) continue
      const t = this.entities[s.idx]
      if (!t || t.construction) continue
      const pref =
        s.idx < this.baseCount
          ? { geo: s.idx, pt: s.pt }
          : { new: s.idx - this.baseCount, sub: 0, pt: s.pt }
      this.constraints.push({ type: 'PointOnObject', refs: [pref, { new: nw, sub: 0 }] })
    }
  }

  /** Circle through three points (circumcircle), or null if collinear. */
  private static circumcircle(
    a: [number, number],
    b: [number, number],
    c: [number, number]
  ): { c: [number, number]; r: number } | null {
    const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]))
    if (Math.abs(d) < 1e-9) return null
    const a2 = a[0] * a[0] + a[1] * a[1]
    const b2 = b[0] * b[0] + b[1] * b[1]
    const c2 = c[0] * c[0] + c[1] * c[1]
    const ux = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d
    const uy = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d
    return { c: [ux, uy], r: Math.hypot(a[0] - ux, a[1] - uy) }
  }

  /** A freshly drawn point that landed on another entity's point gets a
   *  Coincident constraint so the join survives the solve and drags together. */
  private autoCoincident(
    entIdx: number,
    snaps: Array<{ idx: number; pt: number } | null>,
    myPtsOverride?: number[]
  ): void {
    const e = this.entities[entIdx]
    if (e.construction) return
    if (e.type !== 'line' && e.type !== 'circle' && e.type !== 'arc') return
    const nw = entIdx - this.baseCount
    if (nw < 0) return
    // line: snaps[0] -> start (pt 1), snaps[1] -> end (pt 2); circle/arc: centre
    // (pt 3) by default. A centre-point arc ALSO has start/end rim points (pt
    // 1/2) that can snap onto existing geometry - myPtsOverride lets the arc
    // tool ask for those explicitly (snaps[1] -> pt 1, snaps[2] -> pt 2)
    // instead of assuming every circle/arc snap is a centre snap.
    const myPts = myPtsOverride ?? (e.type === 'line' ? [1, 2] : [3])
    snaps.forEach((s, k) => {
      if (!s || s.idx === entIdx) return
      const target = this.entAt(s.idx) // real OR projected (PROJ_BASE) entity
      if (!target || (target as { construction?: boolean }).construction) return
      const myPt = myPts[k]
      if (myPt == null) return
      // a line endpoint that snapped to a curve's RIM (pt 1/2, not its centre)
      // is handled by autoTangent as an endpoint-tangent, which already implies
      // coincidence - a Coincident here would over-constrain it
      if (e.type === 'line' && isCurve(target) && (s.pt === 1 || s.pt === 2)) return
      const tref =
        s.idx >= PROJ_BASE
          ? { geo: this.projected[s.idx - PROJ_BASE].geoId, pt: s.pt }
          : s.idx < this.baseCount
            ? { geo: s.idx, pt: s.pt }
            : { new: s.idx - this.baseCount, sub: 0, pt: s.pt }
      const dup = this.constraints.some(
        (c) =>
          c.type === 'Coincident' &&
          c.refs.some((r) => r.new === nw && r.pt === myPt) &&
          c.refs.some((r) => (r.new ?? r.geo) === (tref.new ?? tref.geo) && r.pt === s.pt)
      )
      if (dup) return
      this.constraints.push({
        type: 'Coincident',
        refs: [{ new: nw, sub: 0, pt: myPt }, tref]
      })
    })
  }

  /** A freshly drawn point that snapped to the middle of a line gets a real
   *  Midpoint (Symmetric about the line's endpoints) constraint, so it stays
   *  put through drags and the solve. */
  private autoMidpoint(entIdx: number, mids: Array<{ idx: number } | null>): void {
    const e = this.entities[entIdx]
    if (e.type !== 'line' || e.construction) return
    const nw = entIdx - this.baseCount
    if (nw < 0) return
    mids.forEach((m, k) => {
      if (!m || m.idx === entIdx) return
      const line = this.entAt(m.idx) // real OR projected (PROJ_BASE) entity
      if (!line || line.type !== 'line' || (line as { construction?: boolean }).construction) return
      const myPt = k === 0 ? 1 : 2
      const lref = (pt: number): RecordedConstraint['refs'][number] =>
        m.idx >= PROJ_BASE
          ? { geo: this.projected[m.idx - PROJ_BASE].geoId, pt }
          : m.idx < this.baseCount
            ? { geo: m.idx, pt }
            : { new: m.idx - this.baseCount, sub: 0, pt }
      const dup = this.constraints.some(
        (c) => c.type === 'Symmetric' && c.refs[2]?.new === nw && c.refs[2]?.pt === myPt
      )
      if (dup) return
      this.constraints.push({
        type: 'Symmetric',
        refs: [lref(1), lref(2), { new: nw, sub: 0, pt: myPt }]
      })
    })
  }

  /** A freshly drawn line within ANGLE_SNAP_DEG of horizontal / vertical gets a
   *  real Horizontal / Vertical constraint and is snapped exactly onto that
   *  axis direction, matching Fusion's inference-while-drawing. Skips a line
   *  that already carries H/V (e.g. a rectangle side) or is fully dimensioned. */
  private autoAngle(entIdx: number): void {
    const e = this.entities[entIdx]
    if (!e || e.type !== 'line') return
    const nw = entIdx - this.baseCount
    if (nw < 0) return
    const dx = e.b[0] - e.a[0]
    const dy = e.b[1] - e.a[1]
    const len = Math.hypot(dx, dy)
    if (len < 1e-6) return
    const ANGLE_SNAP_DEG = 3
    const t = Math.tan((ANGLE_SNAP_DEG * Math.PI) / 180)
    const already = (type: 'Horizontal' | 'Vertical'): boolean =>
      this.constraints.some(
        (c) => c.type === type && (c.refs[0]?.new === nw || c.refs[0]?.geo === entIdx)
      )
    if (Math.abs(dy) <= Math.abs(dx) * t && !already('Horizontal')) {
      e.b = [e.b[0], e.a[1]]
      this.constraints.push({ type: 'Horizontal', refs: [{ new: nw, sub: 0 }] })
    } else if (Math.abs(dx) <= Math.abs(dy) * t && !already('Vertical')) {
      e.b = [e.a[0], e.b[1]]
      this.constraints.push({ type: 'Vertical', refs: [{ new: nw, sub: 0 }] })
    }
  }

  /** If a freshly drawn line's endpoint snapped to a circle / arc, add an
   *  ENDPOINT tangent (line.end <-> curve endpoint). FreeCAD's endpoint-tangent
   *  already implies coincidence, so this must NOT be paired with a separate
   *  Coincident (that over-constrains: DoF goes negative and the sketch shows
   *  "conflicting"). `autoCoincident` skips the same rim snap for that reason. */
  private autoTangent(
    entIdx: number,
    snaps: Array<{ idx: number; pt: number } | null>
  ): void {
    const e = this.entities[entIdx]
    if (!e || e.type !== 'line') return
    const nw = entIdx - this.baseCount
    if (nw < 0) return
    // snaps[0] -> our start (pt 1), snaps[1] -> our end (pt 2)
    snaps.forEach((s, k) => {
      if (!s || s.idx === entIdx) return
      const t = this.entAt(s.idx) // real OR projected (PROJ_BASE) entity
      if (!t || !isCurve(t)) return
      // a snap onto the curve's CENTRE (pt 3) is a plain coincidence, already
      // recorded by autoCoincident - it is not a rim/endpoint touch, so it
      // must not also get a Tangent here (that would claim the line-end sits
      // on the rim, contradicting the real Coincident-to-centre and leaving
      // two constraints fighting over where the shared point actually is)
      if (s.pt === 3) return
      const myPt = k === 0 ? 1 : 2
      // a full circle has no endpoints - fall back to an edge tangent + a
      // PointOnObject so the line still meets the rim
      const curveIsArc = t.type === 'arc'
      const curvePt = s.pt === 1 || s.pt === 2 ? s.pt : 1
      const tref =
        s.idx >= PROJ_BASE
          ? { geo: this.projected[s.idx - PROJ_BASE].geoId }
          : s.idx < this.baseCount
            ? { geo: s.idx }
            : { new: s.idx - this.baseCount, sub: 0 }
      const dup = this.constraints.some(
        (c) =>
          c.type === 'Tangent' &&
          c.refs.some((r) => r.new === nw || r.geo === entIdx) &&
          c.refs.some((r) => (r.new ?? r.geo) === (tref.new ?? tref.geo))
      )
      if (dup) return
      if (curveIsArc) {
        // endpoint tangent - line.end <-> arc endpoint, implies coincidence
        this.constraints.push({
          type: 'Tangent',
          refs: [{ new: nw, sub: 0, pt: myPt }, { ...tref, pt: curvePt }]
        })
      } else {
        // circle: keep the endpoint ON the rim + an edge tangent
        this.constraints.push({
          type: 'PointOnObject',
          refs: [{ new: nw, sub: 0, pt: myPt }, tref]
        })
        this.constraints.push({ type: 'Tangent', refs: [{ new: nw, sub: 0 }, tref] })
      }
    })
  }

  /** If an entity's point sits on the origin or an axis (snapping / dragging put
   *  it there), record the matching constraint so it stays anchored through the
   *  solve. Dedupes, so it is safe to call again after a drag. */
  private anchorToAxes(entIdx: number, tolMm = 1e-6): void {
    const e = this.entities[entIdx]
    if (e.construction) return
    const nw = entIdx - this.baseCount
    if (nw < 0) return
    const has = (type: string, pt: number): boolean =>
      this.constraints.some(
        (c) =>
          c.type === type &&
          c.refs[0]?.new === nw &&
          (c.refs[0]?.pt ?? 0) === pt
      )
    // a point that already picked up a REAL constraint this commit (from
    // autoCoincident / autoTangent snapping it onto other geometry, real or
    // projected) does not also need pinning to an axis - adding both would
    // over-constrain a point that merely happens to sit on the axis too
    const alreadyConstrained = (pt: number): boolean =>
      this.constraints.some((c) => c.refs.some((r) => r.new === nw && r.pt === pt))
    // a Tangent added THIS commit (autoTangent) already ties the whole
    // line's direction, plus one endpoint's position, to external geometry -
    // its OTHER endpoint's position is a derived quantity, not a free DOF, so
    // pinning it to an axis too can over-constrain even though that specific
    // point was never directly referenced (the DOF removal is transitive
    // through the line's fixed direction + the already-anchored curve)
    const gotFreshTangent = this.constraints.some(
      (c) => c.type === 'Tangent' && c.refs.some((r) => r.new === nw)
    )
    const anchor = (uv: [number, number], pt: 1 | 2 | 3): void => {
      if (alreadyConstrained(pt) || gotFreshTangent) return
      const onX = Math.abs(uv[1]) < tolMm // on the X axis  -> geoId -1
      const onY = Math.abs(uv[0]) < tolMm // on the Y axis  -> geoId -2
      if (onX && onY) {
        if (!has('Coincident', pt))
          this.constraints.push({
            type: 'Coincident',
            refs: [{ new: nw, sub: 0, pt }, { geo: -1, pt: 1 }]
          })
      } else if (onX) {
        if (!has('PointOnObject', pt))
          this.constraints.push({ type: 'PointOnObject', refs: [{ new: nw, sub: 0, pt }, { geo: -1 }] })
      } else if (onY) {
        if (!has('PointOnObject', pt))
          this.constraints.push({ type: 'PointOnObject', refs: [{ new: nw, sub: 0, pt }, { geo: -2 }] })
      }
    }
    if (e.type === 'line') {
      anchor(e.a, 1)
      anchor(e.b, 2)
    } else if (e.type === 'circle' || e.type === 'arc') {
      anchor(e.c, 3)
    }
  }

  // --- local relaxation (keeps drags looking right; sidecar has the real solve) //

  /** entity index a ref points at, or -1 for datum geometry */
  private entIdxOfRef(r: { new?: number; geo?: number }): number {
    if (r.geo != null) return r.geo >= 0 ? r.geo : -1
    return r.new != null ? r.new + this.baseCount : -1
  }

  private keyOfRef(r: { new?: number; geo?: number; pt?: number }): string | null {
    // entIdxOfRef collapses EVERY negative geo (origin -1, axes -2, and
    // projected/external geometry <= -3) down to the same -1 - fine for
    // "is this the same REAL entity" comparisons elsewhere, but fatal here:
    // keyOfRef's string is used as a weldGroups() union-find key, and two
    // DIFFERENT datum/projected refs (e.g. two different projected edges, or
    // the origin vs. a projected edge) would incorrectly union into the same
    // pseudo-point "-1:pt", pulling in whatever OTHER constraint happens to
    // reference that same collapsed key (found via a real cross-entity false
    // positive: a Tangent constraint on an unrelated entity's point, with no
    // connection at all to the line actually being dragged, got treated as
    // anchoring it purely because both aliased to "-1:2"). Preserve the RAW
    // geo value in the key for anything negative, so distinct datums never
    // collide with each other or with a real entity index.
    if (r.geo != null && r.geo < 0) return `g${r.geo}:${r.pt ?? 1}`
    const i = this.entIdxOfRef(r)
    if (i < 0) return null
    return `${i}:${r.pt ?? 1}`
  }

  /** the live world position of a point on PROJECTED (external) geometry,
   *  addressed by its raw negative `geo` id (<= -3; -1/-2 are the origin and
   *  axes, not projected geometry) - or null if `geo` does not match any
   *  projected entity. entIdxOfRef has no entry for projected geometry (it
   *  is not one of `this.entities`), so this looks the raw ref up directly
   *  in `this.projected` instead. */
  private projectedPtByGeo(geo: number, pt: number): [number, number] | null {
    if (geo > -3) return null
    const p = this.projected.find((pp) => pp.geoId === geo)
    if (!p) return null
    if (pt === 3) return p.ent.type === 'circle' || p.ent.type === 'arc' ? [...p.ent.c] : this.endpointOf(p.ent, 1)
    if (p.ent.type === 'arc') {
      const a = pt === 1 ? p.ent.a0 : p.ent.a1
      return [p.ent.c[0] + Math.cos(a) * p.ent.r, p.ent.c[1] + Math.sin(a) * p.ent.r]
    }
    return this.endpointOf(p.ent, pt)
  }

  private ptOf(key: string): [number, number] {
    const [i, p] = key.split(':').map(Number)
    const e = this.entities[i]
    if (!e) return [0, 0]
    if (e.type === 'line') return p === 2 ? [...e.b] : [...e.a]
    if (e.type === 'circle') return [...e.c]
    if (e.type === 'arc') {
      // pt 1/2 are the rim endpoints (a0/a1); pt 3 (or anything else) is the
      // centre - matches ptUV's convention for the same entity/pt pair
      if (p === 1 || p === 2) return this.ptUV({ e: i, pt: p as 1 | 2 })
      return [...e.c]
    }
    if (e.type === 'rect') return p === 2 ? [...e.b] : [...e.a]
    return [0, 0]
  }

  private setPtOf(key: string, uv: [number, number]): void {
    const [i, p] = key.split(':').map(Number)
    const e = this.entities[i]
    if (!e) return
    if (e.type === 'line') {
      if (p === 2) e.b = [uv[0], uv[1]]
      else e.a = [uv[0], uv[1]]
    } else if (e.type === 'circle') {
      e.c = [uv[0], uv[1]]
    } else if (e.type === 'arc') {
      // pt 1/2: re-angle that endpoint about the (unchanged) centre, so a
      // weld to a rim point drags the arc's SWEEP, not the whole arc
      if (p === 1) e.a0 = Math.atan2(uv[1] - e.c[1], uv[0] - e.c[0])
      else if (p === 2) e.a1 = Math.atan2(uv[1] - e.c[1], uv[0] - e.c[0])
      else e.c = [uv[0], uv[1]]
    }
  }

  /** groups of point keys tied together by Coincident constraints */
  private weldGroups(): Array<Set<string>> {
    const parent = new Map<string, string>()
    const find = (a: string): string => {
      let r = a
      while (parent.get(r) && parent.get(r) !== r) r = parent.get(r)!
      return r
    }
    const union = (a: string, b: string): void => {
      if (!parent.has(a)) parent.set(a, a)
      if (!parent.has(b)) parent.set(b, b)
      parent.set(find(a), find(b))
    }
    for (const c of this.constraints) {
      if (c.type !== 'Coincident' || c.refs.length < 2) continue
      const ka = this.keyOfRef(c.refs[0])
      const kb = this.keyOfRef(c.refs[1])
      if (ka && kb) union(ka, kb)
    }
    const groups = new Map<string, Set<string>>()
    for (const k of parent.keys()) {
      const root = find(k)
      ;(groups.get(root) ?? groups.set(root, new Set()).get(root)!).add(k)
    }
    return [...groups.values()].filter((g) => g.size > 1)
  }

  private lineHasHV(i: number, type: 'Horizontal' | 'Vertical'): boolean {
    return this.constraints.some(
      (c) => c.type === type && this.entIdxOfRef(c.refs[0] ?? {}) === i
    )
  }

  /** Gauss-Seidel relaxation so a drag looks rigid: snap axis anchors, weld
   *  coincident points (a directly-dragged point wins), hold H / V lines flat,
   *  keep midpoints centred and length dims exact. `held` points stay where
   *  they are (used to pin the far side of a rectangle so it resizes cleanly
   *  instead of shearing). The headless solver still runs the exact solve. */
  private solveLocal(pinned: Set<string>, held: Set<string> = new Set()): void {
    const groups = this.weldGroups()

    // points hard-anchored to the origin / an axis / projected (external)
    // geometry, plus caller-held points. entIdxOfRef/keyOfRef alias every
    // negative geo (origin -1, axes -2, projected <= -3) to the same -1, so
    // a plain `refs[1]?.geo === -1` check alone would only ever catch a
    // literal origin ref - a Coincident/PointOnObject onto PROJECTED
    // geometry (geo <= -3) needs its own check via projectedPtByGeo (real
    // user file, 2026-09-13: "there should've been coincidents on the
    // projected geometry, allowing the connected lines only to rotate about
    // those" - they were not being held fixed at all).
    const anchored = new Set<string>(held)
    for (const c of this.constraints) {
      const g1 = c.refs[1]?.geo
      if (c.type === 'Coincident' && (g1 === -1 || (g1 != null && g1 <= -3))) {
        const k = this.keyOfRef(c.refs[0])
        if (k) anchored.add(k)
      } else if (
        c.type === 'PointOnObject' &&
        (g1 === -1 || g1 === -2 || (g1 != null && g1 <= -3))
      ) {
        const k = this.keyOfRef(c.refs[0])
        if (k) anchored.add(k)
      }
    }

    // "fixed" = do not move this in the H / V and dim passes
    const fixed = new Set([...pinned, ...anchored])
    for (const g of groups)
      if ([...g].some((k) => pinned.has(k) || anchored.has(k)))
        for (const k of g) fixed.add(k)

    for (let it = 0; it < 30; it++) {
      // 1. origin / axis / projected-geometry anchors first, so welds can
      // lock onto them
      for (const c of this.constraints) {
        const g1 = c.refs[1]?.geo
        if (c.type === 'Coincident' && g1 === -1) {
          const k = this.keyOfRef(c.refs[0])
          if (k) this.setPtOf(k, [0, 0])
        } else if (c.type === 'Coincident' && g1 != null && g1 <= -3) {
          const k = this.keyOfRef(c.refs[0])
          const pp = this.projectedPtByGeo(g1, c.refs[1]?.pt ?? 1)
          if (k && pp) this.setPtOf(k, pp)
        } else if (c.type === 'PointOnObject') {
          const k = this.keyOfRef(c.refs[0])
          if (!k) continue
          const p = this.ptOf(k)
          if (g1 === -1) this.setPtOf(k, [p[0], 0])
          else if (g1 === -2) this.setPtOf(k, [0, p[1]])
          else if (g1 != null && g1 <= -3) {
            // point-on-projected-CURVE: no general projection here (would
            // need the curve's own nearest-point math); leave it to the weld
            // pass / real sidecar solve. Only the Coincident (exact point)
            // case above is fixed-position enough to snap directly.
          }
        }
      }
      // 2. coincident welds - a pinned (directly dragged) key wins, then an
      //    axis-anchored key, otherwise the group average
      for (const g of groups) {
        const keys = [...g]
        const anchor =
          keys.find((k) => pinned.has(k)) ?? keys.find((k) => anchored.has(k))
        let pos: [number, number]
        if (anchor) pos = this.ptOf(anchor)
        else {
          let sx = 0
          let sy = 0
          for (const k of keys) {
            const p = this.ptOf(k)
            sx += p[0]
            sy += p[1]
          }
          pos = [sx / keys.length, sy / keys.length]
        }
        for (const k of keys) if (k !== anchor) this.setPtOf(k, pos)
      }
      // 3. tangent joins (line-arc or arc-arc, sharing a welded endpoint) -
      // pivot the NON-dragged side's arc about the shared point, at its
      // current radius, so its tangent direction there matches the other
      // side's. Without this an arc kept its old centre/radius while its
      // endpoint got welded to wherever the drag moved it, breaking
      // tangency and swinging the arc into a visibly wrong, self-crossing
      // shape (a stadium/slot profile dragged by one side - user report +
      // screenshot, 2026-09-12: "it got all crazy"). The real sidecar solve
      // on release still produces the exact, correct shape - this only
      // fixes what the drag looks like WHILE held down.
      for (const c of this.constraints) {
        if (c.type !== 'Tangent') continue
        const r0 = c.refs[0]
        const r1 = c.refs[1]
        if (!r0 || !r1) continue
        const i0 = this.entIdxOfRef(r0)
        const i1 = this.entIdxOfRef(r1)
        const e0 = this.entities[i0]
        const e1 = this.entities[i1]
        if (!e0 || !e1) continue
        // only the endpoint-tangent form (both refs carry pt 1/2) has a
        // definite shared point to pivot about - a bare edge-tangent (full
        // circle case) has no single point and is left alone here
        if (r0.pt !== 1 && r0.pt !== 2) continue
        if (r1.pt !== 1 && r1.pt !== 2) continue
        const k0 = `${i0}:${r0.pt}`
        const k1 = `${i1}:${r1.pt}`
        const p0 = this.ptOf(k0)
        const p1 = this.ptOf(k1)
        // A tangent-at-endpoint join has NO Coincident constraint of its own
        // enforcing the two points share a position - that coincidence is
        // only ever an emergent RESULT of FreeCAD's real solve, never
        // guaranteed here mid-drag. Previously this pass required the two
        // points to ALREADY be within 1e-6 before doing anything ("only
        // meaningful once welded"), which is backwards: the exact moment a
        // drag perturbs one side without the other is precisely when this
        // join needs to be pulled back together, not skipped. Skipping left
        // the gap only free to grow, iteration after iteration, with
        // nothing ever closing it for the rest of the drag (real user file,
        // 2026-09-14: arc3's rim tore away from line0 by a visibly growing
        // gap while dragging arc3's own centre/radius handles - confirmed
        // via live instrumentation that this exact early-exit fired on
        // EVERY iteration of EVERY frame of the drag, the pass never ran
        // even once). Use whichever point is the more strongly anchored
        // side (pinned > merely fixed > neither) as the point to close the
        // gap TOWARD, so a drag on one side still pulls the other into
        // place instead of leaving both to drift.
        const k0Anchored = pinned.has(k0) ? 2 : fixed.has(k0) ? 1 : 0
        const k1Anchored = pinned.has(k1) ? 2 : fixed.has(k1) ? 1 : 0
        const shared = k1Anchored > k0Anchored ? p1 : p0
        // prefer adjusting an arc whose OTHER endpoint is not itself fixed
        // (so a fully-pinned arc is left alone); if both are arcs, adjust
        // whichever side is not "fixed" (closer to the drag anchor logic
        // used elsewhere in this function)
        const pivotArc = (idx: number, e: SketchEntity, ownPt: 1 | 2, otherDir: [number, number]): void => {
          if (e.type !== 'arc') return
          // current radius vector centre->shared point
          const rx = shared[0] - e.c[0]
          const ry = shared[1] - e.c[1]
          const r = Math.hypot(rx, ry)
          if (r < 1e-9) return
          // tangent direction at the rim point is perpendicular to the
          // radius; align it with otherDir by rotating the centre about the
          // FIXED shared point (radius length preserved), choosing whichever
          // of the two perpendicular candidates keeps the centre on the same
          // side it already was (does not flip the arc's bulge direction
          // every iteration)
          const ux = otherDir[0]
          const uy = otherDir[1]
          const nx = -uy
          const ny = ux
          const same = rx * nx + ry * ny >= 0 ? 1 : -1
          const newCx = shared[0] - nx * r * same
          const newCy = shared[1] - ny * r * same
          e.c = [newCx, newCy]
          // re-angle both rim endpoints about the new centre so the OTHER
          // end (not this shared one) keeps its own world position exactly -
          // only this join's endpoint is meant to move with the drag; the
          // arc's far end is whatever the next weld/tangent pass pins
          const otherPt = ownPt === 1 ? 2 : 1
          const farKey = `${idx}:${otherPt}`
          const farPos = fixed.has(farKey) ? this.ptOf(farKey) : null
          if (ownPt === 1) e.a0 = Math.atan2(shared[1] - e.c[1], shared[0] - e.c[0])
          else e.a1 = Math.atan2(shared[1] - e.c[1], shared[0] - e.c[0])
          if (farPos) {
            if (otherPt === 1) e.a0 = Math.atan2(farPos[1] - e.c[1], farPos[0] - e.c[0])
            else e.a1 = Math.atan2(farPos[1] - e.c[1], farPos[0] - e.c[0])
          }
        }
        const dirOf = (e: SketchEntity): [number, number] | null => {
          if (e.type === 'line') {
            const dx = e.b[0] - e.a[0]
            const dy = e.b[1] - e.a[1]
            const L = Math.hypot(dx, dy) || 1
            return [dx / L, dy / L]
          }
          if (e.type === 'arc') {
            const rx = shared[0] - e.c[0]
            const ry = shared[1] - e.c[1]
            const L = Math.hypot(rx, ry) || 1
            return [-ry / L, rx / L]
          }
          return null
        }
        // rotate a LINE about the shared (fixed) endpoint so it stays
        // tangent to a fixed/pinned ARC there - the mirror of pivotArc, for
        // when the arc side cannot be moved (it is what is actually being
        // dragged: see the pinned-side note below). A line has no
        // radius/centre to preserve - only its direction needs to change,
        // to whatever is perpendicular to the arc's own radius vector at
        // the shared point. The line's OWN far endpoint keeps its distance
        // from the shared point (the line's length is preserved, only its
        // angle changes) - never its far endpoint's absolute position,
        // which would silently change the line's length instead.
        const pivotLine = (e: SketchEntity, ownPt: 1 | 2, arcDir: [number, number]): void => {
          if (e.type !== 'line') return
          const far = ownPt === 1 ? e.b : e.a
          // this join's OWN endpoint is not guaranteed to already sit at
          // `shared` - a Tangent-at-endpoint constraint has no Coincident of
          // its own enforcing that (see the "no Coincident of its own" note
          // above the gap-tolerant `shared` pick); measure the line's length
          // from its CURRENT own-endpoint position before moving it, so a
          // drag that has pulled the two points apart still preserves the
          // line's real length when it snaps back together, rather than
          // silently stretching/shrinking it by whatever the gap happened
          // to be (real user file, 2026-09-14: fixing the gap-skip above
          // alone was not enough - this pass rotated the FAR end around an
          // assumed-already-coincident own end that was, in fact, still
          // sitting wherever the weld pass had separately left it, so the
          // shared vertex never actually closed).
          const own = ownPt === 1 ? e.a : e.b
          const len = Math.hypot(far[0] - own[0], far[1] - own[1])
          if (len < 1e-9) return
          // two perpendicular candidates to the arc's radius vector;
          // keep whichever one the far point already leans toward, so the
          // line does not flip to point the opposite way every iteration
          const same = (far[0] - shared[0]) * arcDir[0] + (far[1] - shared[1]) * arcDir[1] >= 0 ? 1 : -1
          const newFar: [number, number] = [
            shared[0] + arcDir[0] * len * same,
            shared[1] + arcDir[1] * len * same
          ]
          if (ownPt === 1) {
            e.a = [...shared]
            e.b = newFar
          } else {
            e.b = [...shared]
            e.a = newFar
          }
        }
        // PINNED (the entity actually being dragged this frame, e.g. its own
        // radius/centre handle) is a stronger claim than merely "fixed"
        // (which also includes axis/projected anchors and other entities'
        // pinned points reached through a weld chain) - a pinned side must
        // never be pivoted here, or this pass fights the very drag that is
        // pinning it, undoing part of it every relaxation iteration (found
        // via a real user file: dragging arc3's OWN radius handle, with the
        // rim-pin fix correctly pinning arc3's points, still re-pivoted
        // arc3's centre back to match its tangent neighbour's stale
        // direction, because this pass only ever asked "is the OTHER side
        // fixed", never "is THIS side the one being actively dragged").
        const e0Pinned = pinned.has(k0)
        const e1Pinned = pinned.has(k1)
        const e0Fixed = fixed.has(k0)
        const e1Fixed = fixed.has(k1)
        // adjust whichever side is NOT fixed (and never the pinned/dragged
        // side); if neither/both are fixed, prefer adjusting an arc over a
        // line (a dragged line stays put, its tangent arc follows - matches
        // how the weld pass already lets a pinned point win)
        if (e1Fixed && !e0Fixed && !e0Pinned && e0.type === 'arc') {
          const dir = dirOf(e1)
          if (dir) pivotArc(i0, e0, r0.pt as 1 | 2, dir)
        } else if (e0Fixed && !e1Fixed && !e1Pinned && e1.type === 'arc') {
          const dir = dirOf(e0)
          if (dir) pivotArc(i1, e1, r1.pt as 1 | 2, dir)
        } else if (e1.type === 'arc' && !e1Pinned && e0.type !== 'arc') {
          const dir = dirOf(e0)
          if (dir) pivotArc(i1, e1, r1.pt as 1 | 2, dir)
        } else if (e0.type === 'arc' && !e0Pinned) {
          const dir = dirOf(e1)
          if (dir) pivotArc(i0, e0, r0.pt as 1 | 2, dir)
        } else if (e0.type === 'arc' && e0Pinned && e1.type === 'line' && !e1Pinned) {
          // the arc side is the one being dragged (radius/centre handle) and
          // cannot be pivoted - rotate the LINE instead so tangency still
          // holds at the new radius, rather than silently dropping tangency
          // for the rest of the drag (found via code inspection after a
          // real user file's report of a live detached-looking shape: this
          // pass previously only ever asked "is the OTHER side fixed", never
          // "is THIS side the one being actively dragged", so a pinned arc
          // could still get re-pivoted back toward its neighbour's stale
          // direction, fighting the drag).
          const dir = dirOf(e0)
          if (dir) pivotLine(e1, r1.pt as 1 | 2, dir)
        } else if (e1.type === 'arc' && e1Pinned && e0.type === 'line' && !e0Pinned) {
          const dir = dirOf(e1)
          if (dir) pivotLine(e0, r0.pt as 1 | 2, dir)
        }
      }
      // 4. horizontal / vertical
      for (let i = 0; i < this.entities.length; i++) {
        const e = this.entities[i]
        if (e.type !== 'line') continue
        const hasH = this.lineHasHV(i, 'Horizontal')
        const hasV = this.lineHasHV(i, 'Vertical')
        if (!hasH && !hasV) continue
        const fa = fixed.has(`${i}:1`)
        const fb = fixed.has(`${i}:2`)
        if (hasH) {
          const y = fa && !fb ? e.a[1] : fb && !fa ? e.b[1] : (e.a[1] + e.b[1]) / 2
          if (!fa) e.a = [e.a[0], y]
          if (!fb) e.b = [e.b[0], y]
        }
        if (hasV) {
          const x = fa && !fb ? e.a[0] : fb && !fa ? e.b[0] : (e.a[0] + e.b[0]) / 2
          if (!fa) e.a = [x, e.a[1]]
          if (!fb) e.b = [x, e.b[1]]
        }
      }
      // 5. midpoints (Symmetric about a line's two endpoints)
      for (const c of this.constraints) {
        if (c.type !== 'Symmetric' || c.refs.length < 3) continue
        const ka = this.keyOfRef(c.refs[0])
        const kb = this.keyOfRef(c.refs[1])
        const kc = this.keyOfRef(c.refs[2])
        if (!ka || !kb || !kc) continue
        const a = this.ptOf(ka)
        const b = this.ptOf(kb)
        if (!fixed.has(kc)) this.setPtOf(kc, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2])
      }
      // 6. length dimensions - keep the length, pivot on the fixed end
      for (const c of this.constraints) {
        if (c.type !== 'Distance' || c.value == null) continue
        const i = this.entIdxOfRef(c.refs[0] ?? {})
        const e = this.entities[i]
        if (!e || e.type !== 'line') continue
        const dx = e.b[0] - e.a[0]
        const dy = e.b[1] - e.a[1]
        const L = Math.hypot(dx, dy) || 1
        const s = c.value / L
        if (fixed.has(`${i}:1`) || !fixed.has(`${i}:2`))
          e.b = [e.a[0] + dx * s, e.a[1] + dy * s]
        else e.a = [e.b[0] - dx * s, e.b[1] - dy * s]
      }
    }
  }

  // --- headless constraint solve (fully-constrained colouring + reconcile) --- //

  private scheduleSolve(): void {
    if (!this.onSolve) return
    if (this.solveTimer != null) window.clearTimeout(this.solveTimer)
    this.solveTimer = window.setTimeout(() => {
      this.solveTimer = null
      void this.runSolve()
    }, 240)
  }

  private async runSolve(): Promise<void> {
    if (!this.onSolve || this.drag || this.band) return
    const seq = ++this.solveSeq
    // send the whole sketch to the scratch solver (base + new), with every ref
    // resolved to an absolute geo index so the mapping is 1:1
    const allEnts = this.entities.slice()
    const cons = this.constraints.map((c) => ({
      ...c,
      refs: c.refs.map((r) =>
        r.new != null
          ? { geo: r.new + this.baseCount, ...(r.pt != null ? { pt: r.pt } : {}) }
          : r
      )
    }))
    let res: SketchSolveResult | null = null
    try {
      res = await this.onSolve(allEnts, cons)
    } catch {
      return
    }
    if (!res || seq !== this.solveSeq || this.drag || this.band) return

    // over-constraint veto: if the constraint the user just added is what the
    // solver flags as conflicting / redundant, pull it back out and say why
    if (this.lastUserConstraint >= 0 && this.lastUserConstraint < this.constraints.length) {
      const i = this.lastUserConstraint
      const conflict = (res.conflicting ?? []).includes(i) || (res.malformed ?? []).includes(i)
      const redundant =
        (res.redundant ?? []).includes(i) || (res.partiallyRedundant ?? []).includes(i)
      if (conflict || redundant) {
        this.constraints.splice(i, 1)
        this.lastUserConstraint = -1
        this.onNotice?.(
          conflict
            ? 'Cannot add that - it conflicts with a constraint already on this geometry. Remove one first.'
            : 'That would over-dimension this geometry - it is already fully defined here. Delete an existing constraint / dimension first.'
        )
        this.geomV++
        this.redraw()
        this.scheduleSolve()
        this.onChange()
        return
      }
    }
    this.lastUserConstraint = -1

    // reconcile: adopt the solved coordinates (indices are absolute now).
    // Construction geometry is solved and adopted too - it can carry real
    // constraints (H/V, coincident, dimensions) and must move to satisfy them.
    res.geometry.forEach((g, i) => {
      const ent = this.entities[i]
      if (!ent || !g || ent.type !== g.type) return
      if (g.type === 'line' && ent.type === 'line') {
        ent.a = [g.a[0], g.a[1]]
        ent.b = [g.b[0], g.b[1]]
      } else if ((g.type === 'circle' || g.type === 'arc') && (ent.type === 'circle' || ent.type === 'arc')) {
        ent.c = [g.c[0], g.c[1]]
        ;(ent as { r: number }).r = g.r
        // an arc's sweep (a0/a1) was NEVER adopted here - only c/r - so the
        // client kept whatever STALE angles it had going into this solve,
        // mixed with the solver's fresh centre/radius. Reading the arc's rim
        // point back out (c + r*(cos a0, sin a0)) then computes a position
        // that matches neither the pre-solve nor the post-solve shape - a
        // real, confirmed tear: dragging arc3's centre/radius in a real user
        // file left its rim visibly detached from a Coincident-welded line
        // even AFTER the real FreeCAD solve completed and was accepted
        // (verified live: the solver's OWN returned a0/a1 close the gap to
        // ~1e-14, but the reconciliation here silently discarded them,
        // 2026-09-14).
        if (g.type === 'arc' && ent.type === 'arc') {
          ent.a0 = g.a0
          ent.a1 = g.a1
        }
      }
    })
    const free = new Set(res.free)
    this.constrainedSet = new Set()
    for (let i = 0; i < this.entities.length; i++)
      if (!free.has(i)) this.constrainedSet.add(i)
    this.sketchFullyConstrained = !!res.fullyConstrained
    this.geomV++
    this.redraw()
  }

  // --- constraints -------------------------------------------------------- //

  /** Which constraint types are legal for the current selection. */
  availableConstraints(): SketchConstraintType[] {
    // point selection takes priority when the user has picked individual points
    if (this.selectedPts.length) {
      const out: SketchConstraintType[] = []
      if (this.selectedPts.length === 2) out.push('Coincident', 'Horizontal', 'Vertical')
      if (this.selectedPts.length === 1 && this.selected.length === 1) {
        // a point + a whole entity: coincident (to its nearest point / centre),
        // or - if the entity is a curve - point-on-curve
        out.push('Coincident')
        if (isCurve(this.entAt(this.selected[0]))) out.push('PointOnObject')
      }
      return out
    }
    const sel = this.selected.map((i) => this.entAt(i)).filter(Boolean)
    if (!sel.length) return []
    const anyProj = this.selected.some((i) => i >= PROJ_BASE)
    const out: SketchConstraintType[] = []
    // a single projected line has no self-constraints (it is read-only)
    if (sel.length === 1 && isLine(sel[0]) && !anyProj) out.push('Horizontal', 'Vertical')
    if (sel.length === 2) {
      const [a, b] = sel
      if (isLine(a) && isLine(b)) {
        out.push('Parallel', 'Perpendicular', 'Equal', 'Coincident')
        if (!(this.selected[0] >= PROJ_BASE && this.selected[1] >= PROJ_BASE)) out.push('Midpoint')
      }
      if (isCurve(a) && isCurve(b)) out.push('Equal', 'Concentric', 'Tangent')
      if ((isLine(a) && isCurve(b)) || (isCurve(a) && isLine(b)))
        out.push('Tangent', 'Coincident', 'Midpoint')
    }
    return out
  }

  /** Ask the solver whether a NEW dimension on this entity would over-constrain
   *  it, so the UI can warn before even prompting for a number. Returns a
   *  message, or null if it is fine. */
  async dimensionPrecheck(index: number): Promise<string | null> {
    const e = this.entities[index]
    if (!e) return null
    if (e.type === 'rect') return null
    // re-typing an entity's own existing dimension is always allowed
    if (this.entityHasDimension(index)) return null
    if (!this.onSolve) return null
    const cur =
      e.type === 'line'
        ? Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1])
        : (e as { r: number }).r
    if (!(cur > 0)) return null
    // Radius vs Diameter does not change whether the geometry is over-defined,
    // so the precheck can use Radius for either.
    const kind: RecordedConstraint['type'] = e.type === 'line' ? 'Distance' : 'Radius'
    const cons = this.constraints.map((c) => ({
      ...c,
      refs: c.refs.map((r) =>
        r.new != null
          ? { geo: r.new + this.baseCount, ...(r.pt != null ? { pt: r.pt } : {}) }
          : r
      )
    }))
    const trial = [...cons, { type: kind, refs: [{ geo: index }], value: cur }]
    let res: SketchSolveResult | null = null
    try {
      res = await this.onSolve(this.entities.slice(), trial)
    } catch {
      return null
    }
    if (!res) return null
    const last = trial.length - 1
    const bad =
      (res.conflicting ?? []).includes(last) ||
      (res.redundant ?? []).includes(last) ||
      (res.partiallyRedundant ?? []).includes(last)
    return bad
      ? 'This geometry is already fully defined here - remove an existing dimension or constraint first.'
      : null
  }

  /** Set a numeric dimension on an entity (value already resolved from any
   *  expression). Line -> length; circle/arc -> radius or diameter.
   *  `as` forces 'radius' | 'diameter' for a circle/arc; default keeps the
   *  entity's current radius/diameter kind, or 'radius' if it has none yet. */
  setDimension(index: number, value: number, as?: 'radius' | 'diameter'): boolean {
    const e = this.entities[index]
    if (!e || !(value > 0)) return false
    this.snapshot()
    let kind: RecordedConstraint['type']
    if (e.type === 'line') {
      const dx = e.b[0] - e.a[0]
      const dy = e.b[1] - e.a[1]
      const len = Math.hypot(dx, dy) || 1
      e.b = [e.a[0] + (dx / len) * value, e.a[1] + (dy / len) * value]
      kind = 'Distance'
    } else if (e.type === 'circle' || e.type === 'arc') {
      const existing = this.entityDimKind(index)
      const dk = as ?? existing ?? 'radius'
      kind = dk === 'diameter' ? 'Diameter' : 'Radius'
      ;(e as { r: number }).r = dk === 'diameter' ? value / 2 : value
    } else {
      return false
    }
    const ref =
      index < this.baseCount
        ? { geo: index }
        : { new: index - this.baseCount, sub: 0 }
    this.constraints = this.constraints.filter(
      (c) =>
        !(
          (c.type === 'Distance' || c.type === 'Radius' || c.type === 'Diameter') &&
          JSON.stringify(c.refs[0]) === JSON.stringify(ref)
        )
    )
    this.constraints.push({ type: kind, refs: [ref], value })
    this.lastUserConstraint = this.constraints.length - 1
    this.geomV++
    this.redraw()
    // solve now so the geometry snaps to the dimension immediately AND an
    // over-dimension is vetoed right away instead of 240 ms later
    void this.runSolve()
    this.scheduleSolve()
    this.onChange()
    return true
  }

  /** 'radius' | 'diameter' if a circle/arc entity currently has a dimensional
   *  constraint, else null. */
  private entityDimKind(index: number): 'radius' | 'diameter' | null {
    const ref =
      index < this.baseCount ? { geo: index } : { new: index - this.baseCount, sub: 0 }
    const key = JSON.stringify(ref)
    for (const c of this.constraints) {
      if ((c.type === 'Radius' || c.type === 'Diameter') && JSON.stringify(c.refs[0]) === key)
        return c.type === 'Diameter' ? 'diameter' : 'radius'
    }
    return null
  }

  /** Flip the selected circle/arc dimension between radius and diameter,
   *  keeping the geometry the same size. Returns the new kind, or null if the
   *  selected dimension is not a radius/diameter. */
  toggleSelectedDimKind(): 'radius' | 'diameter' | null {
    const ci = this.selectedDim
    if (ci == null || ci < 0 || ci >= this.constraints.length) return null
    const c = this.constraints[ci]
    if (c.type !== 'Radius' && c.type !== 'Diameter') return null
    this.snapshot()
    const i = c.refs[0].geo != null ? c.refs[0].geo : (c.refs[0].new ?? 0) + this.baseCount
    const e = this.entities[i]
    const r = (e as { r?: number })?.r ?? (c.value ?? 0) / (c.type === 'Diameter' ? 2 : 1)
    if (c.type === 'Radius') {
      c.type = 'Diameter'
      c.value = r * 2
    } else {
      c.type = 'Radius'
      c.value = r
    }
    if (ci < this.baseConstraintCount) {
      // a reopened dimension changed kind: the sidecar matches removals on
      // type + geoId, so queue the OLD one for removal and let the changed one
      // re-apply as new
      this.removedBaseConstraints.push({
        type: c.type === 'Radius' ? 'Diameter' : 'Radius',
        refs: [{ ...c.refs[0] }]
      })
      this.baseConstraintCount--
      // move it out of the base range so getNewConstraints picks it up
      this.constraints.splice(ci, 1)
      this.constraints.push(c)
      this.selectedDim = this.constraints.length - 1
    }
    this.geomV++
    this.redraw()
    void this.runSolve()
    this.scheduleSolve()
    this.onChange()
    return c.type === 'Diameter' ? 'diameter' : 'radius'
  }

  /** Coincident / Horizontal / Vertical / Symmetric / PointOnObject on selected
   *  geometry points. Returns false if `type` is not a point constraint. */
  private applyPointConstraint(type: SketchConstraintType): boolean {
    const pts = this.selectedPts.slice()

    // one point + one whole CURVE entity -> PointOnObject (endpoint lies on the
    // circle / arc rim), or Coincident (endpoint welds to the curve's centre)
    if (pts.length === 1 && this.selected.length === 1) {
      const oi = this.selected[0]
      const oe = this.entAt(oi)
      if (type === 'PointOnObject' && oe && isCurve(oe)) {
        const p = pts[0]
        const pa = this.ptUV(p)
        const c = (oe as { c: [number, number]; r: number }).c
        const r = (oe as { r: number }).r
        const d = Math.hypot(pa[0] - c[0], pa[1] - c[1]) || 1
        // pull the point onto the rim now so the solve has a good start
        const on: [number, number] = [
          c[0] + ((pa[0] - c[0]) / d) * r,
          c[1] + ((pa[1] - c[1]) / d) * r
        ]
        const e = this.entities[p.e] // no-ops for a projected (read-only) point
        if (e && e.type === 'line') {
          if (p.pt === 2) e.b = on
          else e.a = on
        }
        const curveRef =
          oi >= PROJ_BASE
            ? { geo: this.projected[oi - PROJ_BASE].geoId }
            : oi < this.baseCount
              ? { geo: oi }
              : { new: oi - this.baseCount, sub: 0 }
        this.snapshot()
        this.constraints.push({
          type: 'PointOnObject',
          refs: [this.ptRecRef(p), curveRef]
        })
        this.lastUserConstraint = this.constraints.length - 1
        this.selectedPts = []
        this.selected = []
        this.geomV++
        this.redraw()
        void this.runSolve()
        this.scheduleSolve()
        this.onChange()
        return true
      }
    }

    // a point + a whole entity -> treat the entity's nearest point as the 2nd pt
    // (for a circle/arc that nearest point is its centre)
    if (pts.length === 1 && this.selected.length === 1 && type === 'Coincident') {
      const oi = this.selected[0]
      const a = this.ptUV(pts[0])
      const cands = this.entityPts(oi)
      if (!cands.length) return false
      cands.sort((x, y) => {
        const px = this.ptUV(x)
        const py = this.ptUV(y)
        return Math.hypot(px[0] - a[0], px[1] - a[1]) - Math.hypot(py[0] - a[0], py[1] - a[1])
      })
      pts.push(cands[0])
    }
    if (pts.length !== 2) return false
    const [p, q] = pts
    const pa = this.ptUV(p)
    const isProjPt = (pr: PtRef): boolean => pr.e >= PROJ_BASE
    const setPt = (pr: PtRef, uv: [number, number]): void => {
      const e = this.entities[pr.e] // no-ops for a projected (read-only) point
      if (!e) return
      if (pr.pt === 3 && (e.type === 'circle' || e.type === 'arc')) e.c = [uv[0], uv[1]]
      else if (e.type === 'line') {
        if (pr.pt === 2) e.b = [uv[0], uv[1]]
        else e.a = [uv[0], uv[1]]
      }
      // NOTE: deliberately no case for an arc's rim endpoint (pt 1/2) here -
      // re-angling a0/a1 to point at an arbitrary uv can flip the two
      // endpoints past each other or collapse the arc's span, silently
      // producing a degenerate shape (an arc's endpoints are linked through
      // its own centre/radius, unlike a line's, which are independent). The
      // caller below prefers moving a LINE's endpoint onto an arc's instead
      // whenever one is available, which is always safe; only a genuine
      // arc-arc weld has no safe point to pre-position, and is left as a
      // no-op here - the live preview just doesn't visually snap until the
      // real server-side solve runs, same as before this fix (see the
      // comment at the call site).
    }
    this.snapshot()
    if (type === 'Coincident') {
      // pre-position whichever point ISN'T read-only projected geometry onto
      // the other, so the jump happens immediately instead of waiting on the
      // next solve; if q is the projected one, move p instead. AND prefer
      // moving a LINE's endpoint over an ARC's whenever the two points
      // belong to different entity kinds - welding a line's end to an arc's
      // end previously left the arc's end (silently) unmoved because setPt
      // has no safe way to reposition an arc's endpoint (see its own
      // comment) - moving the LINE side instead is always safe and actually
      // makes the join visible immediately, instead of only cosmetically at
      // the next full solve (user-adjacent follow-up while fixing the
      // drag-strictness report, 2026-09-13).
      const isLinePt = (pr: PtRef): boolean => this.entities[pr.e]?.type === 'line' || this.entities[pr.e]?.type === 'rect'
      if (isProjPt(q)) setPt(p, this.ptUV(q))
      else if (!isProjPt(p) && isLinePt(p) && !isLinePt(q)) setPt(p, this.ptUV(q))
      else setPt(q, pa)
      this.constraints.push({ type: 'Coincident', refs: [this.ptRecRef(p), this.ptRecRef(q)] })
    } else if (type === 'Horizontal' || type === 'Vertical') {
      const qb = this.ptUV(q)
      // nudge the 2nd point onto the same row / column, unless it is
      // read-only projected geometry - then nudge the first point instead
      if (isProjPt(q)) {
        setPt(p, type === 'Horizontal' ? [pa[0], qb[1]] : [qb[0], pa[1]])
      } else {
        setPt(q, type === 'Horizontal' ? [qb[0], pa[1]] : [pa[0], qb[1]])
      }
      this.constraints.push({ type, refs: [this.ptRecRef(p), this.ptRecRef(q)] })
    } else {
      return false
    }
    this.lastUserConstraint = this.constraints.length - 1
    this.selectedPts = []
    this.geomV++
    this.redraw()
    void this.runSolve()
    this.scheduleSolve()
    this.onChange()
    return true
  }

  applyConstraint(type: SketchConstraintType): boolean {
    // point-selection constraints: Coincident / Horizontal / Vertical between
    // two geometry points (line ends, circle / arc centres), Symmetric of two
    // points about a line
    if (this.selectedPts.length >= 1) {
      const ok = this.applyPointConstraint(type)
      if (ok) return true
      // fall through only if the point path did not handle this type
    }
    const idxs = this.selected.slice()
    const ents = idxs.map((i) => this.entAt(i))
    if (ents.some((e) => !e)) return false
    this.snapshot()
    const ref = (i: number, pt?: number): RecordedConstraint['refs'][number] => {
      if (i >= PROJ_BASE) return { geo: this.projected[i - PROJ_BASE].geoId, pt }
      return i < this.baseCount ? { geo: i, pt } : { new: i - this.baseCount, sub: 0, pt }
    }
    // a projected entity is read-only geometry: don't mutate its coords, only
    // record the constraint. Branches below that write `this.entities[idxs[k]]`
    // are skipped for projected refs by the isProj guard.
    const isProj = (k: number): boolean => idxs[k] >= PROJ_BASE

    if (
      (type === 'Horizontal' || type === 'Vertical') &&
      ents.length === 1 &&
      isLine(ents[0]) &&
      !isProj(0)
    ) {
      const e = this.entities[idxs[0]] as { type: 'line'; a: [number, number]; b: [number, number] }
      if (type === 'Horizontal') e.b = [e.b[0], e.a[1]]
      else e.b = [e.a[0], e.b[1]]
      this.constraints.push({ type, refs: [ref(idxs[0])] })
    } else if (
      (type === 'Parallel' || type === 'Perpendicular') &&
      ents.length === 2 &&
      isLine(ents[0]) &&
      isLine(ents[1])
    ) {
      const a = ents[0] as { a: [number, number]; b: [number, number] }
      // orient the SECOND line to the first; if the second is projected
      // (read-only) orient the first instead, or just record the constraint
      const bIdx = isProj(1) ? (isProj(0) ? -1 : 0) : 1
      if (bIdx >= 0) {
        const src = bIdx === 1 ? a : (ents[1] as { a: [number, number]; b: [number, number] })
        const b = ents[bIdx] as { a: [number, number]; b: [number, number] }
        let ang = Math.atan2(src.b[1] - src.a[1], src.b[0] - src.a[0])
        if (type === 'Perpendicular') ang += Math.PI / 2
        const len = Math.hypot(b.b[0] - b.a[0], b.b[1] - b.a[1])
        b.b = [b.a[0] + Math.cos(ang) * len, b.a[1] + Math.sin(ang) * len]
      }
      this.constraints.push({ type, refs: [ref(idxs[0]), ref(idxs[1])] })
    } else if (type === 'Equal' && ents.length === 2) {
      const a = ents[0]!
      const b = ents[1]!
      if (isLine(a) && isLine(b) && !isProj(1)) {
        const la = a as { a: [number, number]; b: [number, number] }
        const lb = b as { a: [number, number]; b: [number, number] }
        const len = Math.hypot(la.b[0] - la.a[0], la.b[1] - la.a[1])
        const ang = Math.atan2(lb.b[1] - lb.a[1], lb.b[0] - lb.a[0])
        lb.b = [lb.a[0] + Math.cos(ang) * len, lb.a[1] + Math.sin(ang) * len]
      } else if (isCurve(a) && isCurve(b) && !isProj(1)) {
        ;(b as { r: number }).r = (a as { r: number }).r
      }
      this.constraints.push({ type, refs: [ref(idxs[0]), ref(idxs[1])] })
    } else if (type === 'Concentric' && ents.length === 2 && isCurve(ents[0]) && isCurve(ents[1])) {
      ;(this.entities[idxs[1]] as { c: [number, number] }).c = [
        ...(this.entities[idxs[0]] as { c: [number, number] }).c
      ] as [number, number]
      this.constraints.push({
        type,
        refs: [ref(idxs[0], 3), ref(idxs[1], 3)]
      })
    } else if (type === 'Coincident' && ents.length === 2 && isLine(ents[0]) && isLine(ents[1])) {
      // weld the two nearest endpoints; move the non-projected line's endpoint
      const a = ents[0] as { a: [number, number]; b: [number, number] }
      const b = ents[1] as { a: [number, number]; b: [number, number] }
      const pairs: Array<[1 | 2, 1 | 2, number]> = [
        [1, 1, Math.hypot(a.a[0] - b.a[0], a.a[1] - b.a[1])],
        [1, 2, Math.hypot(a.a[0] - b.b[0], a.a[1] - b.b[1])],
        [2, 1, Math.hypot(a.b[0] - b.a[0], a.b[1] - b.a[1])],
        [2, 2, Math.hypot(a.b[0] - b.b[0], a.b[1] - b.b[1])]
      ]
      pairs.sort((x, y) => x[2] - y[2])
      const [pa, pb] = pairs[0]
      if (!isProj(1)) {
        const target = pa === 1 ? a.a : a.b
        if (pb === 1) b.a = [...target] as [number, number]
        else b.b = [...target] as [number, number]
      } else if (!isProj(0)) {
        const target = pb === 1 ? b.a : b.b
        if (pa === 1) a.a = [...target] as [number, number]
        else a.b = [...target] as [number, number]
      }
      this.constraints.push({ type, refs: [ref(idxs[0], pa), ref(idxs[1], pb)] })
    } else if (
      type === 'Coincident' &&
      ents.length === 2 &&
      ((isLine(ents[0]) && isCurve(ents[1])) || (isCurve(ents[0]) && isLine(ents[1])))
    ) {
      // line endpoint welded to a circle / arc CENTRE
      const lk = isLine(ents[0]) ? 0 : 1
      const li = idxs[lk]
      const ci = idxs[1 - lk]
      const ln = ents[lk] as { a: [number, number]; b: [number, number] }
      const cv = ents[1 - lk] as { c: [number, number] }
      const near =
        Math.hypot(ln.a[0] - cv.c[0], ln.a[1] - cv.c[1]) <=
        Math.hypot(ln.b[0] - cv.c[0], ln.b[1] - cv.c[1])
          ? 1
          : 2
      if (!isProj(lk)) {
        if (near === 1) ln.a = [...cv.c] as [number, number]
        else ln.b = [...cv.c] as [number, number]
      }
      this.constraints.push({ type, refs: [ref(li, near), ref(ci, 3)] })
    } else if (type === 'Tangent' && ents.length === 2) {
      // pre-position the geometry so the solver lands on the NEARBY tangent
      // solution, not some far-off one (and so the change is visible before
      // Finish). line + curve: slide the line parallel to itself until its
      // distance to the curve centre equals the radius. curve + curve: move
      // the 2nd centre so the circles are externally tangent.
      const a = ents[0]!
      const b = ents[1]!
      // if the two entities already share (or nearly share) an endpoint, this
      // is a "close the wire smoothly" tangent, not an edge-tangent between
      // two curves that stay apart - weld that shared point with an ENDPOINT
      // Tangent (FreeCAD/this app both treat that as implying Coincident, see
      // autoTangent above) instead of a plain edge Tangent with no point refs.
      // An edge-only Tangent leaves the endpoints free, so the solver can (and
      // did, in a real user file) land them a fraction of a mm apart even
      // though the curves are tangent - the wire never closes and Finish/Pad
      // sees an open profile with no error to point at.
      const WELD_TOL = 0.5 // mm - "the user clicked near the same point"
      const isArc = (e: SketchEntity): boolean => e.type === 'arc'
      let endpointPair: { pa: 1 | 2; pb: 1 | 2 } | null = null
      if (
        (isLine(a) && isArc(b)) ||
        (isArc(a) && isLine(b)) ||
        (isArc(a) && isArc(b))
      ) {
        const aPts: Array<1 | 2> = isArc(a) || isLine(a) ? [1, 2] : []
        const bPts: Array<1 | 2> = isArc(b) || isLine(b) ? [1, 2] : []
        let best: { pa: 1 | 2; pb: 1 | 2; d: number } | null = null
        for (const pa of aPts) {
          for (const pb of bPts) {
            const va = entPoint(a, pa)
            const vb = entPoint(b, pb)
            const d = Math.hypot(va[0] - vb[0], va[1] - vb[1])
            if (!best || d < best.d) best = { pa, pb, d }
          }
        }
        if (best && best.d <= WELD_TOL) endpointPair = { pa: best.pa, pb: best.pb }
      }
      if (endpointPair) {
        // weld the shared point exactly, on whichever entity isn't read-only
        // projected geometry, so the visible geometry snaps shut immediately
        if (!isProj(1)) {
          setEntPoint(ents[1]!, endpointPair.pb, entPoint(a, endpointPair.pa))
        } else if (!isProj(0)) {
          setEntPoint(ents[0]!, endpointPair.pa, entPoint(b, endpointPair.pb))
        }
      } else if ((isLine(a) && isCurve(b)) || (isCurve(a) && isLine(b))) {
        const lk = isLine(a) ? 0 : 1
        const ln = ents[lk] as { a: [number, number]; b: [number, number] }
        const cv = ents[1 - lk] as { c: [number, number]; r: number }
        if (!isProj(lk)) {
          const dx = ln.b[0] - ln.a[0]
          const dy = ln.b[1] - ln.a[1]
          const L = Math.hypot(dx, dy) || 1
          // unit normal to the line
          let nx = -dy / L
          let ny = dx / L
          // signed distance from centre to the line
          const sd = (cv.c[0] - ln.a[0]) * nx + (cv.c[1] - ln.a[1]) * ny
          if (sd < 0) {
            nx = -nx
            ny = -ny
          }
          const move = Math.abs(sd) - cv.r // shift the line by this along +n
          ln.a = [ln.a[0] + nx * move, ln.a[1] + ny * move]
          ln.b = [ln.b[0] + nx * move, ln.b[1] + ny * move]
        }
      } else if (isCurve(a) && isCurve(b) && !isProj(1)) {
        const ca = a as { c: [number, number]; r: number }
        const cb = b as { c: [number, number]; r: number }
        const dx = cb.c[0] - ca.c[0]
        const dy = cb.c[1] - ca.c[1]
        const D = Math.hypot(dx, dy) || 1
        const target = ca.r + cb.r // external tangency
        cb.c = [ca.c[0] + (dx / D) * target, ca.c[1] + (dy / D) * target]
      }
      this.constraints.push({
        type,
        refs: endpointPair
          ? [ref(idxs[0], endpointPair.pa), ref(idxs[1], endpointPair.pb)]
          : [ref(idxs[0]), ref(idxs[1])]
      })
      this.lastUserConstraint = this.constraints.length - 1
      this.selected = []
      this.geomV++
      this.redraw()
      void this.runSolve()
      this.scheduleSolve()
      this.onChange()
      return true
    } else if (type === 'Midpoint' && ents.length === 2) {
      // one line + one other entity: put that entity's nearest endpoint at the
      // line's midpoint (recorded as a Symmetric-about-the-endpoints constraint)
      const lk = isLine(ents[0]) ? 0 : isLine(ents[1]) ? 1 : -1
      if (lk < 0) return false
      const li = idxs[lk]
      const oi = idxs[1 - lk]
      const ln = ents[lk] as { a: [number, number]; b: [number, number] }
      const mid: [number, number] = [(ln.a[0] + ln.b[0]) / 2, (ln.a[1] + ln.b[1]) / 2]
      const oe = ents[1 - lk]!
      let opt: 1 | 2 | 3 = 3
      const canMove = !isProj(1 - lk)
      if (oe.type === 'line') {
        opt =
          Math.hypot(oe.a[0] - mid[0], oe.a[1] - mid[1]) <=
          Math.hypot(oe.b[0] - mid[0], oe.b[1] - mid[1])
            ? 1
            : 2
        if (canMove) {
          if (opt === 1) oe.a = [...mid] as [number, number]
          else oe.b = [...mid] as [number, number]
        }
      } else if ((oe.type === 'circle' || oe.type === 'arc') && canMove) {
        oe.c = [...mid] as [number, number]
      }
      this.constraints.push({
        type: 'Symmetric',
        refs: [ref(li, 1), ref(li, 2), ref(oi, opt)]
      })
    } else {
      return false
    }
    this.lastUserConstraint = this.constraints.length - 1
    this.selected = []
    this.geomV++
    this.redraw()
    this.scheduleSolve()
    this.onChange()
    return true
  }

  // --- rendering ---
  private lineMat = new THREE.LineBasicMaterial({ color: 0x36a8ea })
  private consMat = new THREE.LineDashedMaterial({
    color: 0xc178e6,
    dashSize: 2,
    gapSize: 1.4
  })
  private selMat = new THREE.LineBasicMaterial({ color: 0xffb020, linewidth: 2 })
  // fully-constrained geometry reads as "done" - white, same convention as
  // FreeCAD's own green (was a muted grey before, which read as "disabled"
  // rather than "fully defined" - user feedback, 2026-09-12)
  private constrainedMat = new THREE.LineBasicMaterial({ color: 0xffffff })
  // projected / external reference geometry - amber, dashed
  private projMat = new THREE.LineDashedMaterial({ color: 0xe0a24a, dashSize: 2.4, gapSize: 1.6 })
  private hoverMat = new THREE.LineBasicMaterial({ color: 0x9fe0ff })
  private bandMat = new THREE.LineDashedMaterial({ color: 0x9fb4c8, dashSize: 2, gapSize: 1.5 })
  private conHoverMat = new THREE.LineBasicMaterial({ color: 0x7fe0ff, linewidth: 2 })
  private refMat = new THREE.LineBasicMaterial({ color: 0x6b7784, transparent: true, opacity: 0.6 })
  private refPtMat = new THREE.PointsMaterial({ color: 0x9aa7b4, size: 5, sizeAttenuation: false })
  private ptHandleMat = new THREE.PointsMaterial({ color: 0x8fa8c8, size: 6, sizeAttenuation: false })
  // a point belonging to a fully-constrained entity - same white as
  // constrainedMat, so a fully-defined line's own endpoints read as "done"
  // too, not just the line itself
  private ptHandleConstrainedMat = new THREE.PointsMaterial({ color: 0xffffff, size: 6, sizeAttenuation: false })
  private ptHandleSelMat = new THREE.PointsMaterial({ color: 0xffcc44, size: 11, sizeAttenuation: false })
  private previewMat = new THREE.LineDashedMaterial({
    color: 0x8fd0f4,
    dashSize: 1.5,
    gapSize: 1
  })
  private dimMat = new THREE.LineBasicMaterial({ color: 0x8b98a6, transparent: true, opacity: 0.9 })
  private dimDrivenMat = new THREE.LineBasicMaterial({ color: 0xffcf7a })
  private xAxisMat = new THREE.LineBasicMaterial({ color: 0xcf5f43, transparent: true, opacity: 0.5 })
  private yAxisMat = new THREE.LineBasicMaterial({ color: 0x54a85f, transparent: true, opacity: 0.5 })
  private originMat = new THREE.PointsMaterial({ color: 0xf2f4f7, size: 8, sizeAttenuation: false })
  private snapMats: Record<SnapKind, THREE.PointsMaterial> = {
    grid: new THREE.PointsMaterial({ color: 0xffcc44, size: 8, sizeAttenuation: false }),
    origin: new THREE.PointsMaterial({ color: 0xff5f5f, size: 11, sizeAttenuation: false }),
    point: new THREE.PointsMaterial({ color: 0xffe14d, size: 11, sizeAttenuation: false }),
    edge: new THREE.PointsMaterial({ color: 0x6fe0ff, size: 10, sizeAttenuation: false }),
    axis: new THREE.PointsMaterial({ color: 0x7fd98a, size: 10, sizeAttenuation: false })
  }

  private polyToObj(uvs: [number, number][], mat: THREE.Material, close = false): THREE.Line {
    const pts = uvs.map(([u, v]) => this.toWorld(u, v))
    if (close && pts.length) pts.push(pts[0].clone())
    const g = new THREE.BufferGeometry().setFromPoints(pts)
    const l = new THREE.Line(g, mat)
    l.computeLineDistances()
    l.renderOrder = 20
    return l
  }

  private circleUVs(c: [number, number], r: number, a0 = 0, a1 = Math.PI * 2): [number, number][] {
    const out: [number, number][] = []
    let span = a1 - a0
    if (span <= 0) span += Math.PI * 2
    const n = Math.max(12, Math.round((span / (Math.PI * 2)) * 64))
    for (let i = 0; i <= n; i++) {
      const a = a0 + (span * i) / n
      out.push([c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r])
    }
    return out
  }

  /** Catmull-Rom through the spline points, for a smooth on-screen curve. */
  private splineUVs(pts: [number, number][]): [number, number][] {
    if (pts.length < 3) return pts
    const out: [number, number][] = []
    const seg = 12
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i === 0 ? 0 : i - 1]
      const p1 = pts[i]
      const p2 = pts[i + 1]
      const p3 = pts[i + 2 < pts.length ? i + 2 : pts.length - 1]
      for (let s = 0; s < seg; s++) {
        const t = s / seg
        const t2 = t * t
        const t3 = t2 * t
        const f = (a: number, b: number, c: number, d: number): number =>
          0.5 *
          (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3)
        out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])])
      }
    }
    out.push(pts[pts.length - 1])
    return out
  }

  private entityObj(e: SketchEntity, mat: THREE.Material): THREE.Line {
    if (e.type === 'line') {
      // a projected point comes back as a zero-length line (a model edge / vertex
      // perpendicular to the plane pierced it here) - draw a visible cross marker
      if (Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]) < 1e-6) {
        const r = 6 / Math.max(this.pxPerMm(), 0.001) // ~6px on screen
        const [x, y] = e.a
        const g = new THREE.BufferGeometry().setFromPoints([
          this.toWorld(x - r, y),
          this.toWorld(x + r, y),
          this.toWorld(x, y - r),
          this.toWorld(x, y + r)
        ])
        return new THREE.LineSegments(g, mat) as unknown as THREE.Line
      }
      return this.polyToObj([e.a, e.b], mat)
    }
    if (e.type === 'rect')
      return this.polyToObj([e.a, [e.b[0], e.a[1]], e.b, [e.a[0], e.b[1]]], mat, true)
    if (e.type === 'circle') return this.polyToObj(this.circleUVs(e.c, e.r), mat, true)
    if (e.type === 'spline') return this.polyToObj(this.splineUVs(e.pts), mat)
    return this.polyToObj(this.circleUVs(e.c, e.r, e.a0, e.a1), mat)
  }

  private gridObj: THREE.GridHelper | null = null
  private gridSpacing = 0

  /** pick a "nice" 1/2/5 x 10^n mm grid spacing that stays ~22px on screen */
  private niceSpacing(): number {
    const ppm = this.pxPerMm()
    const raw = 22 / (ppm > 1e-4 ? ppm : 8)
    const pow = Math.pow(10, Math.floor(Math.log10(raw || 1)))
    const n = raw / pow
    const step = n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10
    return step * pow
  }

  /** Rebuild the sketch grid only when the zoom crosses into a new spacing. */
  private updateGrid(): void {
    const s = this.niceSpacing()
    if (s === this.gridSpacing && this.gridObj) return
    this.gridSpacing = s
    if (this.gridObj) {
      this.group.remove(this.gridObj)
      ;(this.gridObj.material as THREE.Material).dispose()
      this.gridObj.geometry.dispose()
    }
    const divisions = Math.max(20, Math.min(400, Math.round(4000 / s)))
    const grid = new THREE.GridHelper(s * divisions, divisions, 0x3a4048, 0x2c313a)
    grid.position.copy(this.O)
    grid.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3().crossVectors(this.X, this.Y).normalize()
    )
    ;(grid.material as THREE.Material).transparent = true
    ;(grid.material as THREE.Material).opacity = 0.32
    grid.renderOrder = 1
    this.gridObj = grid
    this.group.add(grid)
  }

  /** Origin marker + the two in-plane axes (where the perpendicular planes cut
   *  this sketch), so the user always has a visible datum to work from. */
  private addAxes(): void {
    const L = 5000
    const axis = (dir: [number, number], mat: THREE.Material): void => {
      const g = new THREE.BufferGeometry().setFromPoints([
        this.toWorld(-L * dir[0], -L * dir[1]),
        this.toWorld(L * dir[0], L * dir[1])
      ])
      const l = new THREE.Line(g, mat)
      l.renderOrder = 6
      this.group.add(l)
    }
    axis([1, 0], this.xAxisMat)
    axis([0, 1], this.yAxisMat)
    const og = new THREE.BufferGeometry().setFromPoints([this.toWorld(0, 0)])
    const op = new THREE.Points(og, this.originMat)
    op.renderOrder = 22
    this.group.add(op)
  }

  private dimGroup = new THREE.Group()
  private symGroup = new THREE.Group()
  private symV = -1
  private hoverSymKey: string | null = null
  private symEnts = new Map<string, Set<number>>() // symKey -> entity indices it references
  private hoverSymEnts = new Set<number>()

  private fmt(v: number): string {
    return String(Number(v.toFixed(2)))
  }

  // --- constraint symbols ------------------------------------------------- //
  private static readonly SYM_BASE = 0x8fa0b0
  private static readonly SYM_HOT = 0x7fe0ff
  private symTexCache = new Map<string, THREE.CanvasTexture>()

  private symTex(glyph: string): THREE.CanvasTexture {
    let t = this.symTexCache.get(glyph)
    if (t) return t
    const dpr = 2
    const c = document.createElement('canvas')
    c.width = c.height = 30 * dpr
    const g = c.getContext('2d')!
    g.scale(dpr, dpr)
    // just the glyph - no box. A dark outline keeps it readable on any colour.
    g.font = '800 20px ui-sans-serif, system-ui, sans-serif'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.lineJoin = 'round'
    g.strokeStyle = 'rgba(8,10,13,0.92)'
    g.lineWidth = 4
    g.strokeText(glyph, 15, 16)
    g.fillStyle = '#ffffff'
    g.fillText(glyph, 15, 16)
    t = new THREE.CanvasTexture(c)
    t.colorSpace = THREE.SRGBColorSpace
    this.symTexCache.set(glyph, t)
    return t
  }

  private symSprite(glyph: string, at: [number, number], key: string, px = 15): THREE.Sprite {
    const s = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.symTex(glyph),
        color: SketchController.SYM_BASE,
        depthTest: false,
        transparent: true
      })
    )
    s.position.copy(this.toWorld(at[0], at[1]))
    const h = this.mmForPx(px)
    s.scale.set(h, h, 1)
    s.renderOrder = 44
    // targetPx remembered so rescaleScreenSpace() can recompute the correct
    // world-space size from the CURRENT camera every frame - the sprite is
    // built once per geomV change (rebuildSyms bails out when nothing
    // changed), but zooming touches only the camera, never geomV, so without
    // a live rescale every frame these stayed stuck at whatever size they
    // were when last built - shrinking/growing on screen as you zoomed
    // instead of staying a constant, readable pixel size (user report,
    // 2026-09-11: "the constraint symbols don't seem to dynamically change
    // size properly").
    s.userData = { symKey: key, targetPx: px }
    return s
  }

  /** a sketch point of an entity by pos id (1=start, 2=end, 3=centre) */
  private endpointOf(e: SketchEntity, pt: number): [number, number] {
    if (e.type === 'line') return pt === 2 ? e.b : e.a
    if (e.type === 'rect') return pt === 2 ? e.b : e.a
    if (e.type === 'spline') return pt === 2 ? e.pts[e.pts.length - 1] : e.pts[0]
    return e.c
  }

  /** a point a little to one side of an entity, for placing its glyph */
  private symAnchor(e: SketchEntity, k = 0): [number, number] {
    const nudge = this.mmForPx(9)
    if (e.type === 'line') {
      const mx = (e.a[0] + e.b[0]) / 2
      const my = (e.a[1] + e.b[1]) / 2
      const dx = e.b[0] - e.a[0]
      const dy = e.b[1] - e.a[1]
      const L = Math.hypot(dx, dy) || 1
      return [mx - (dy / L) * nudge, my + (dx / L) * nudge]
    }
    if (e.type === 'rect') {
      return [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2]
    }
    if (e.type === 'spline') {
      const m = e.pts[Math.floor(e.pts.length / 2)]
      return [m[0], m[1] + nudge]
    }
    const ang = Math.PI / 4 + k
    return [e.c[0] + Math.cos(ang) * (e.r + nudge), e.c[1] + Math.sin(ang) * (e.r + nudge)]
  }

  // glyphs mirror the SKETCH ribbon's constraint buttons
  private static readonly SYM_GLYPH: Record<string, string> = {
    Horizontal: '—',
    Vertical: '|',
    Parallel: '∥',
    Perpendicular: '⟂',
    Equal: '=',
    Tangent: '◟',
    Coincident: '○',
    Concentric: '◎',
    PointOnObject: '⌐',
    Symmetric: '⋈'
  }

  private rebuildSyms(): void {
    if (this.symV === this.geomV) return
    this.symV = this.geomV
    for (const c of [...this.symGroup.children]) {
      this.symGroup.remove(c)
      ;(c as THREE.Sprite).material.dispose()
    }
    this.symEnts.clear()

    this.constraints.forEach((con, ci) => {
      if (con.type === 'Distance' || con.type === 'Radius' || con.type === 'Diameter') return // shown as dims
      const glyph = SketchController.SYM_GLYPH[con.type]
      if (!glyph) return
      const key = `con${ci}`
      const ents = this.symEnts.get(key) ?? new Set<number>()
      this.symEnts.set(key, ents)

      // Coincident / PointOnObject: one small marker, exactly on the point
      if (con.type === 'Coincident' || con.type === 'PointOnObject') {
        const r0 = con.refs[0]
        const ei = this.entIdxOfRef(r0)
        const e = this.entities[ei]
        if (!e) return
        ents.add(ei)
        const r1 = con.refs[1]
        if (r1 && r1.geo != null && r1.geo >= 0) ents.add(r1.geo)
        else if (r1 && r1.new != null) ents.add(r1.new + this.baseCount)
        this.symGroup.add(this.symSprite(glyph, this.endpointOf(e, r0.pt ?? 1), key, 10))
        return
      }
      // Symmetric (midpoint): one marker at the middle of the symmetry line
      if (con.type === 'Symmetric') {
        const la = this.entIdxOfRef(con.refs[0])
        const le = this.entities[la]
        const pj = this.entIdxOfRef(con.refs[2])
        if (!le || le.type !== 'line') return
        ents.add(la)
        if (pj >= 0) ents.add(pj)
        this.symGroup.add(
          this.symSprite(
            glyph,
            [(le.a[0] + le.b[0]) / 2, (le.a[1] + le.b[1]) / 2],
            key,
            11
          )
        )
        return
      }
      // line-type constraints: a glyph beside each referenced entity
      con.refs.forEach((r, ri) => {
        if (r.geo != null && r.geo < 0) return // axis / origin ref - no glyph
        const ei = this.entIdxOfRef(r)
        const e = this.entities[ei]
        if (!e) return
        ents.add(ei)
        this.symGroup.add(this.symSprite(glyph, this.symAnchor(e, ci + ri), key))
      })
    })

    this.applySymHighlight()
  }

  private applySymHighlight(): void {
    for (const c of this.symGroup.children) {
      const sp = c as THREE.Sprite
      const hot = this.hoverSymKey != null && sp.userData.symKey === this.hoverSymKey
      sp.material.color.setHex(hot ? SketchController.SYM_HOT : SketchController.SYM_BASE)
    }
  }

  /** Re-scale constraint-symbol sprites to their intended on-screen pixel
   *  size for the CURRENT camera. rebuildSyms() only runs on a geometry
   *  change (geomV) and skips otherwise, so a zoom alone (which touches only
   *  the camera, not geomV) left every symbol frozen at whatever world-space
   *  size it was built at - shrinking or growing on screen as you zoomed
   *  instead of staying constant. Call this every frame while a sketch is
   *  active; it is cheap (a scale.set per sprite, no texture/geometry work). */
  rescaleScreenSpace(): void {
    if (!this.symGroup.children.length) return
    for (const c of this.symGroup.children) {
      const px = (c.userData as { targetPx?: number }).targetPx
      if (px == null) continue
      const h = this.mmForPx(px)
      c.scale.set(h, h, 1)
    }
  }

  /** World-space scale.x of the first constraint symbol sprite (test hook,
   *  for verifying rescaleScreenSpace tracks zoom - a fixed pixel size means
   *  this value must change proportionally to pxPerMm as the camera zooms). */
  testSymbolWorldScale(): number | null {
    const c = this.symGroup.children[0]
    return c ? c.scale.x : null
  }

  /** Current "click the constraint, then click the geometry" pick state
   *  (test hook, diagnostics only) - selectedPts/selected are private, and a
   *  point pick abandoned mid-way (e.g. the ribbon button clicked again
   *  before the 2nd geometry pick) can leave a stale entry that silently
   *  corrupts the NEXT attempt - this exists to make that state visible. */
  testPendingConState(): { pendingCon: string | null; selectedPts: number; selected: number } {
    return {
      pendingCon: this.pendingCon,
      selectedPts: this.selectedPts.length,
      selected: this.selected.length
    }
  }

  /** entity indices the app currently considers fully constrained (test hook) */
  testConstrainedIndices(): number[] {
    return [...this.constrainedSet].sort((a, b) => a - b)
  }

  /** DEBUG test hook: the live in-memory geometry of entity `idx` right now,
   *  for investigating a drag's actual solved result rather than only what
   *  is visible on screen. */
  testEntitySnapshot(idx: number): unknown {
    const e = this.entities[idx]
    if (!e) return null
    if (e.type === 'arc') return { type: 'arc', c: [...e.c], r: e.r, a0: e.a0, a1: e.a1 }
    if (e.type === 'line') return { type: 'line', a: [...e.a], b: [...e.b] }
    if (e.type === 'circle') return { type: 'circle', c: [...e.c], r: e.r }
    return { type: e.type }
  }

  /** the actual rendered line color of entity `idx`, as a CSS hex string
   *  (e.g. "#ffffff") - looks up the real THREE.Object3D by the userData tag
   *  set in redraw(), not a re-derivation of the color logic, so this checks
   *  what is ACTUALLY on screen (test hook) */
  testEntityColorHex(idx: number): string | null {
    for (const obj of this.entGroup.children) {
      if (obj.userData?.entIdx !== idx) continue
      const mat = (obj as THREE.Line).material as THREE.LineBasicMaterial | THREE.LineBasicMaterial[]
      const m = Array.isArray(mat) ? mat[0] : mat
      return m?.color ? `#${m.color.getHexString()}` : null
    }
    return null
  }

  /** total count of geometry-point handles ACTUALLY rendered right now
   *  (sums every THREE.Points object's own vertex count under `preview` -
   *  the faint / faintConstrained / hot buffers built in redraw() - not a
   *  re-derivation from this.entities, so it catches a deleted entity's
   *  points staying drawn even though its own line no longer is; test hook) */
  testHandlePointCount(): number {
    let n = 0
    for (const obj of this.preview.children) {
      if (!(obj instanceof THREE.Points)) continue
      n += obj.geometry.getAttribute('position')?.count ?? 0
    }
    return n
  }

  /** DEBUG test hook: current dimension-tool picks, for diagnosing why a
   *  ctrl-click sequence did or didn't land on the geometry intended. */
  testDimPicksState(): unknown {
    return this.dimPicks.map((p) => ('pt' in p ? { pt: p.pt } : { ent: p.ent }))
  }

  private pickSym(ev: { clientX: number; clientY: number }): string | null {
    if (!this.symGroup.children.length) return null
    this.ray.setFromCamera(this.ndcFor(ev.clientX, ev.clientY), this.camera)
    const hits = this.ray.intersectObjects(this.symGroup.children, false)
    return hits.length ? ((hits[0].object.userData.symKey as string) ?? null) : null
  }

  /** world mm that a given on-screen pixel size maps to at the sketch plane */
  private mmForPx(px: number): number {
    const ppm = this.pxPerMm()
    return px / (ppm > 0.05 ? ppm : 8)
  }

  private dimLabel(text: string, at: THREE.Vector3, driven = true, selected = false): THREE.Sprite {
    const dpr = 2
    const c = document.createElement('canvas')
    c.width = 160 * dpr
    c.height = 44 * dpr
    const g = c.getContext('2d')!
    g.scale(dpr, dpr)
    g.fillStyle = selected ? 'rgba(58,42,20,0.95)' : driven ? 'rgba(18,20,24,0.9)' : 'rgba(18,20,24,0.7)'
    const r = 6
    g.beginPath()
    g.roundRect(2, 2, 156, 40, r)
    g.fill()
    if (selected) {
      g.strokeStyle = '#ffb020'
      g.lineWidth = 2.5
      g.stroke()
    }
    g.fillStyle = driven ? '#ffd27a' : '#9fd0f0'
    g.font = '600 24px ui-sans-serif, system-ui, sans-serif'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillText(text, 80, 23)
    const tex = new THREE.CanvasTexture(c)
    tex.colorSpace = THREE.SRGBColorSpace
    const s = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true })
    )
    s.position.copy(at)
    const h = this.mmForPx(18) // ~18px tall on screen
    s.scale.set(h * (160 / 44), h, 1)
    s.renderOrder = 40
    return s
  }

  private clearDims(): void {
    for (const c of [...this.dimGroup.children]) {
      this.dimGroup.remove(c)
      c.traverse((o) => {
        const any = o as THREE.Line & THREE.Sprite
        any.geometry?.dispose?.()
        const m = any.material as THREE.Material | undefined
        if (m && m !== this.dimMat && m !== this.dimDrivenMat) {
          ;(m as THREE.SpriteMaterial).map?.dispose?.()
          m.dispose()
        }
      })
    }
  }

  private seg(g: THREE.Group, p: [number, number], q: [number, number], mat: THREE.Material): void {
    const geo = new THREE.BufferGeometry().setFromPoints([
      this.toWorld(p[0], p[1]),
      this.toWorld(q[0], q[1])
    ])
    g.add(new THREE.Line(geo, mat))
  }

  /** A proper linear dimension: two witness lines, a dimension line with little
   *  arrowheads, and the value label - "from here to here", not just a box. */
  private makeDim(
    a: [number, number],
    b: [number, number],
    side: 1 | -1,
    text: string,
    driven: boolean,
    owner = -1,
    offset: [number, number] = [0, 0],
    selected = false
  ): THREE.Group {
    const g = new THREE.Group()
    g.userData = { dimOwner: owner, dimKind: 'linear' }
    const mat = driven ? this.dimDrivenMat : this.dimMat
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const len = Math.hypot(dx, dy) || 1
    const ux = dx / len
    const uy = dy / len
    const nx = -uy * side
    const ny = ux * side
    // offset[0] nudges the dim line off the geometry, offset[1] slides the label
    const off = this.mmForPx(24) + offset[0]
    const s = off >= 0 ? 1 : -1
    const ext = this.mmForPx(6) * s
    const gap = this.mmForPx(2) * s
    const along = offset[1]
    const a1: [number, number] = [a[0] + nx * off, a[1] + ny * off]
    const b1: [number, number] = [b[0] + nx * off, b[1] + ny * off]
    // witness lines (with a small gap off the geometry, overshooting the dim line)
    this.seg(g, [a[0] + nx * gap, a[1] + ny * gap], [a[0] + nx * (off + ext), a[1] + ny * (off + ext)], mat)
    this.seg(g, [b[0] + nx * gap, b[1] + ny * gap], [b[0] + nx * (off + ext), b[1] + ny * (off + ext)], mat)
    this.seg(g, a1, b1, mat)
    const ah = this.mmForPx(3.5)
    const head = (tip: [number, number], dir: 1 | -1): void => {
      const bx = tip[0] + ux * ah * dir
      const by = tip[1] + uy * ah * dir
      this.seg(g, [bx + nx * ah * 0.45, by + ny * ah * 0.45], tip, mat)
      this.seg(g, [bx - nx * ah * 0.45, by - ny * ah * 0.45], tip, mat)
    }
    head(a1, 1)
    head(b1, -1)
    const lu = (a1[0] + b1[0]) / 2 + ux * along + nx * this.mmForPx(8) * s
    const lv = (a1[1] + b1[1]) / 2 + uy * along + ny * this.mmForPx(8) * s
    if (owner >= 0) this.dimLabelUV.set(owner, { uv: [lu, lv], kind: 'linear' })
    g.add(this.dimLabel(text, this.toWorld(lu, lv), driven, selected))
    g.renderOrder = 32
    return g
  }

  /** Radius dimension: a leader from the centre out past the rim, arrowhead at
   *  the rim, "R value" label. */
  private makeRadial(
    c: [number, number],
    r: number,
    text: string,
    driven: boolean,
    owner = -1,
    offset: [number, number] = [0, 0],
    selected = false
  ): THREE.Group {
    const g = new THREE.Group()
    g.userData = { dimOwner: owner, dimKind: 'radius' }
    const mat = driven ? this.dimDrivenMat : this.dimMat
    // default leader at 45 deg, then the label drag adds a free uv nudge and the
    // leader / arrowhead re-aim at wherever the label ended up
    const base: [number, number] = [
      c[0] + Math.cos(Math.PI / 4) * (r + this.mmForPx(16)) + offset[0],
      c[1] + Math.sin(Math.PI / 4) * (r + this.mmForPx(16)) + offset[1]
    ]
    const ld = Math.hypot(base[0] - c[0], base[1] - c[1]) || 1
    const ux = (base[0] - c[0]) / ld
    const uy = (base[1] - c[1]) / ld
    const rim: [number, number] = [c[0] + ux * r, c[1] + uy * r]
    this.seg(g, c, base, mat)
    const ah = this.mmForPx(3.5)
    const nx = -uy
    const ny = ux
    const bx = rim[0] - ux * ah
    const by = rim[1] - uy * ah
    this.seg(g, [bx + nx * ah * 0.45, by + ny * ah * 0.45], rim, mat)
    this.seg(g, [bx - nx * ah * 0.45, by - ny * ah * 0.45], rim, mat)
    const lu = base[0] + ux * this.mmForPx(2)
    const lv = base[1] + uy * this.mmForPx(2)
    if (owner >= 0) this.dimLabelUV.set(owner, { uv: [lu, lv], kind: 'radius' })
    g.add(this.dimLabel(text, this.toWorld(lu, lv), driven, selected))
    g.renderOrder = 32
    return g
  }

  /** Angle-between-two-lines glyph: a small arc at their (infinite-line)
   *  intersection, spanning the angle actually being dimensioned, with the
   *  value label at its midpoint. `pivot` is the intersection point;
   *  `dir0`/`dir1` the two lines' unit directions (either sign - only the
   *  angle between them, mod 180, is meaningful); `nearUV` (usually the
   *  cursor, for the live preview, or the current label position for a
   *  committed one) picks which of the two supplementary angle wedges to
   *  actually draw, so the glyph reads as "the angle you're pointing at". */
  private makeAngleDim(
    pivot: [number, number],
    dir0: [number, number],
    dir1: [number, number],
    text: string,
    driven: boolean,
    nearUV: [number, number],
    owner = -1,
    selected = false
  ): THREE.Group {
    const g = new THREE.Group()
    g.userData = { dimOwner: owner, dimKind: 'angle' }
    const mat = driven ? this.dimDrivenMat : this.dimMat
    let a0 = Math.atan2(dir0[1], dir0[0])
    let a1 = Math.atan2(dir1[1], dir1[0])
    // pick the wedge (out of the two supplementary pairs a line's undirected
    // angle admits) that actually contains the near point, so the arc draws
    // on the same side as the cursor / existing label
    const near = Math.atan2(nearUV[1] - pivot[1], nearUV[0] - pivot[0])
    const norm = (a: number): number => {
      let x = a
      while (x <= -Math.PI) x += 2 * Math.PI
      while (x > Math.PI) x -= 2 * Math.PI
      return x
    }
    const candidates: Array<[number, number]> = [
      [a0, a1],
      [a0, a1 + Math.PI],
      [a0 + Math.PI, a1],
      [a0 + Math.PI, a1 + Math.PI]
    ]
    let best = candidates[0]
    let bestScore = -Infinity
    for (const [s0, s1] of candidates) {
      const mid = norm(s0 + norm(s1 - s0) / 2)
      const score = Math.cos(mid - near)
      if (score > bestScore) {
        bestScore = score
        best = [s0, s1]
      }
    }
    a0 = best[0]
    a1 = best[1]
    let sweep = norm(a1 - a0)
    const r = this.mmForPx(28)
    const n = 20
    const pts: [number, number][] = []
    for (let i = 0; i <= n; i++) {
      const a = a0 + (sweep * i) / n
      pts.push([pivot[0] + Math.cos(a) * r, pivot[1] + Math.sin(a) * r])
    }
    for (let i = 0; i + 1 < pts.length; i++) this.seg(g, pts[i], pts[i + 1], mat)
    const mid = a0 + sweep / 2
    const lu = pivot[0] + Math.cos(mid) * (r + this.mmForPx(10))
    const lv = pivot[1] + Math.sin(mid) * (r + this.mmForPx(10))
    if (owner >= 0) this.dimLabelUV.set(owner, { uv: [lu, lv], kind: 'radius' })
    g.add(this.dimLabel(text, this.toWorld(lu, lv), driven, selected))
    g.renderOrder = 32
    return g
  }

  private redrawDims(): void {
    const dimPending = this.tool === 'dimension' && this.dimPicks.length > 0
    const live = this.pending.length > 0 || dimPending
    if (this.geomV === this.dimV && !live && !this.dimHadLive) return
    this.dimV = this.geomV
    this.dimHadLive = live
    this.clearDims()
    this.dimLabelUV.clear()

    // Dimensions are only shown once the user assigns them - never by default.
    for (let ci = 0; ci < this.constraints.length; ci++) {
      const con = this.constraints[ci]
      if (con.value == null) continue
      if (con.type === 'Angle') {
        // both refs are whole lines (no pt) - see setAngleDimension
        if (con.refs.length < 2) continue
        const i0 = this.entIdxOfRef(con.refs[0])
        const i1 = this.entIdxOfRef(con.refs[1])
        const e0 = this.entities[i0]
        const e1 = this.entities[i1]
        if (!e0 || !e1 || e0.type !== 'line' || e1.type !== 'line' || e0.construction || e1.construction) continue
        const pivot = this.linesIntersectUV(e0, e1)
        if (!pivot) continue
        const sel = this.selectedDim === ci
        // "near" the existing label position if we have one, else default to
        // between the two lines' midpoints - keeps a committed angle glyph
        // from randomly flipping which wedge it draws on an unrelated redraw
        const prevUV = this.dimLabelUV.get(i0)?.uv
        const nearUV: [number, number] = prevUV ?? [
          (this.entMidUV(i0)[0] + this.entMidUV(i1)[0]) / 2,
          (this.entMidUV(i0)[1] + this.entMidUV(i1)[1]) / 2
        ]
        this.dimGroup.add(
          this.makeAngleDim(
            pivot,
            [e0.b[0] - e0.a[0], e0.b[1] - e0.a[1]],
            [e1.b[0] - e1.a[0], e1.b[1] - e1.a[1]],
            `${this.fmt(con.value)}°`,
            true,
            nearUV,
            i0,
            sel
          )
        )
        continue
      }
      if (con.type !== 'Distance' && con.type !== 'Radius' && con.type !== 'Diameter') continue
      const r0 = con.refs[0]
      // point-to-point / point-to-line distances have no dimension glyph yet -
      // the constraint still drives the solver
      if (con.type === 'Distance' && (con.refs.length >= 2 || r0.pt != null)) continue
      const i = r0.geo != null ? r0.geo : (r0.new ?? 0) + this.baseCount
      const e = this.entities[i]
      if (!e || e.construction) continue
      const nudge = this.dimOffsets.get(i) ?? [0, 0]
      const sel = this.selectedDim === ci
      if (e.type === 'line') {
        this.dimGroup.add(this.makeDim(e.a, e.b, 1, this.fmt(con.value), true, i, nudge, sel))
      } else if (e.type === 'circle' || e.type === 'arc') {
        // Radius glyph is drawn at the stored radius; a Diameter constraint's
        // value IS the diameter, so halve it for the glyph geometry but label
        // it with the diameter number and a Ø prefix.
        const isDia = con.type === 'Diameter'
        const label = `${isDia ? 'Ø' : 'R'} ${this.fmt(con.value)}`
        this.dimGroup.add(this.makeRadial(e.c, e.r, label, true, i, nudge, sel))
      }
    }

    // live readout for whatever is being drawn right now
    if (live) {
      const cur = this.cursorUV
      if (this.tool === 'line') {
        const a = this.pending[this.pending.length - 1]
        if (Math.hypot(cur[0] - a[0], cur[1] - a[1]) > 0.01)
          this.dimGroup.add(this.makeDim(a, cur, 1, this.fmt(Math.hypot(cur[0] - a[0], cur[1] - a[1])), false))
      } else if (this.tool === 'rect') {
        const a = this.pending[0]
        const x0 = Math.min(a[0], cur[0])
        const x1 = Math.max(a[0], cur[0])
        const y0 = Math.min(a[1], cur[1])
        const y1 = Math.max(a[1], cur[1])
        if (x1 - x0 > 0.01) this.dimGroup.add(this.makeDim([x0, y0], [x1, y0], -1, this.fmt(x1 - x0), false))
        if (y1 - y0 > 0.01) this.dimGroup.add(this.makeDim([x0, y0], [x0, y1], 1, this.fmt(y1 - y0), false))
      } else if (this.tool === 'circle' || this.tool === 'arc') {
        const c = this.pending[0]
        const rr = Math.hypot(cur[0] - c[0], cur[1] - c[1])
        if (rr > 0.01) this.dimGroup.add(this.makeRadial(c, rr, `R ${this.fmt(rr)}`, false))
      }
    }

    // Dimension tool: a live preview of whatever is currently armed,
    // following the cursor toward wherever it will be placed - "click a
    // line, it should show a preview... left-click in open space to place
    // it" (per spec). The label position tracks the cursor via a synthetic
    // offset rather than the entity's own default placement, so it visibly
    // "follows" rather than sitting fixed the moment something is armed.
    if (dimPending) {
      const cur = this.cursorUV
      const uv = (p: { pt: PtRef } | { ent: number }): [number, number] =>
        'pt' in p ? this.ptUV(p.pt) : this.entMidUV(p.ent)
      if (this.dimPicks.length === 1) {
        const p = this.dimPicks[0]
        if ('ent' in p) {
          const e = this.entities[p.ent]
          if (e && e.type === 'line') {
            const dx = e.b[0] - e.a[0]
            const dy = e.b[1] - e.a[1]
            const L = Math.hypot(dx, dy) || 1
            const ux = dx / L
            const uy = dy / L
            const mx = (e.a[0] + e.b[0]) / 2
            const my = (e.a[1] + e.b[1]) / 2
            const rx = cur[0] - mx
            const ry = cur[1] - my
            // perpendicular (nudges the dim line off the geometry) and
            // along (slides the label along it), both real mm, matching
            // makeDim's own offset convention exactly
            const perp = -rx * uy + ry * ux
            const along = rx * ux + ry * uy
            const side: 1 | -1 = perp >= 0 ? 1 : -1
            this.dimGroup.add(
              this.makeDim(e.a, e.b, side, this.fmt(L), false, -1, [Math.abs(perp), along])
            )
          } else if (e && (e.type === 'circle' || e.type === 'arc')) {
            const dx = cur[0] - e.c[0]
            const dy = cur[1] - e.c[1]
            this.dimGroup.add(this.makeRadial(e.c, e.r, `R ${this.fmt(e.r)}`, false, -1, [dx, dy]))
          }
        }
      } else if (this.dimPicks.length >= 2 && this.dimPicksAreAngle()) {
        const [p0, p1] = this.dimPicks as [{ ent: number }, { ent: number }]
        const e0 = this.entities[p0.ent]
        const e1 = this.entities[p1.ent]
        if (e0 && e1 && e0.type === 'line' && e1.type === 'line') {
          const pivot = this.linesIntersectUV(e0, e1) ?? [
            (this.entMidUV(p0.ent)[0] + this.entMidUV(p1.ent)[0]) / 2,
            (this.entMidUV(p0.ent)[1] + this.entMidUV(p1.ent)[1]) / 2
          ]
          const ang = this.angleValue()
          if (ang != null) {
            this.dimGroup.add(
              this.makeAngleDim(
                pivot,
                [e0.b[0] - e0.a[0], e0.b[1] - e0.a[1]],
                [e1.b[0] - e1.a[0], e1.b[1] - e1.a[1]],
                `${this.fmt(ang)}°`,
                false,
                cur
              )
            )
          }
        }
      } else if (this.dimPicks.length >= 2) {
        const a = uv(this.dimPicks[0])
        const b = uv(this.dimPicks[1])
        const val = this.distancePickValue()
        if (val != null && Math.hypot(b[0] - a[0], b[1] - a[1]) > 1e-6) {
          const dx = b[0] - a[0]
          const dy = b[1] - a[1]
          const L = Math.hypot(dx, dy) || 1
          const ux = dx / L
          const uy = dy / L
          const mx = (a[0] + b[0]) / 2
          const my = (a[1] + b[1]) / 2
          const perp = -(cur[0] - mx) * uy + (cur[1] - my) * ux
          const side: 1 | -1 = perp >= 0 ? 1 : -1
          this.dimGroup.add(this.makeDim(a, b, side, this.fmt(val), false))
        }
      }
    }
  }

  private drawRefGeom(): void {
    this.group.add(this.dimGroup)
    this.group.add(this.symGroup)
    for (const poly of this.refPolys) {
      if (poly.length >= 2) this.refGroup.add(this.polyToObj(poly, this.refMat))
    }
    if (this.refPoints.length) {
      const g = new THREE.BufferGeometry().setFromPoints(
        this.refPoints.map(([u, v]) => this.toWorld(u, v))
      )
      const pts = new THREE.Points(g, this.refPtMat)
      pts.renderOrder = 19
      this.refGroup.add(pts)
    }
  }

  private static ptKey(p: [number, number]): string {
    return `${Math.round(p[0] * 1e3)},${Math.round(p[1] * 1e3)}`
  }

  /** Closed polygons made of the current line entities (for the fill). */
  private lineLoops(): [number, number][][] {
    const segs = this.entities.filter(
      (e) => !e.construction && e.type === 'line'
    ) as { a: [number, number]; b: [number, number] }[]
    const adj = new Map<string, { to: [number, number]; seg: number }[]>()
    segs.forEach((s, i) => {
      for (const [p, q] of [
        [s.a, s.b],
        [s.b, s.a]
      ] as [[number, number], [number, number]][]) {
        const k = SketchController.ptKey(p)
        ;(adj.get(k) ?? adj.set(k, []).get(k)!).push({ to: q, seg: i })
      }
    })
    const used = new Set<number>()
    const loops: [number, number][][] = []
    for (let start = 0; start < segs.length; start++) {
      if (used.has(start)) continue
      const loop: [number, number][] = [segs[start].a]
      let cur = segs[start].b
      used.add(start)
      loop.push(cur)
      let ok = true
      for (let guard = 0; guard <= segs.length; guard++) {
        if (SketchController.ptKey(cur) === SketchController.ptKey(loop[0])) break
        const cand = (adj.get(SketchController.ptKey(cur)) ?? []).find((c) => !used.has(c.seg))
        if (!cand) {
          ok = false
          break
        }
        used.add(cand.seg)
        cur = cand.to
        loop.push(cur)
      }
      if (ok && loop.length >= 4 && SketchController.ptKey(cur) === SketchController.ptKey(loop[0])) {
        loops.push(loop.slice(0, -1))
      }
    }
    return loops
  }

  private fillV = -1
  private rebuildFills(): void {
    if (this.fillV === this.geomV) return
    this.fillV = this.geomV
    for (const c of [...this.fillGroup.children]) {
      this.fillGroup.remove(c)
      ;(c as THREE.Mesh).geometry.dispose()
    }
    // closed line loops
    for (const loop of this.lineLoops()) {
      const uv = loop.map(([u, v]) => new THREE.Vector2(u, v))
      let tris: number[][] = []
      try {
        tris = THREE.ShapeUtils.triangulateShape(uv, [])
      } catch {
        tris = []
      }
      if (!tris.length) continue
      const pos: number[] = []
      for (const t of tris)
        for (const idx of t) {
          const w = this.toWorld(loop[idx][0], loop[idx][1])
          pos.push(w.x, w.y, w.z)
        }
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
      const m = new THREE.Mesh(g, this.fillMat)
      m.renderOrder = 3
      this.fillGroup.add(m)
    }
    // circles are closed on their own
    for (const e of this.entities) {
      if (e.construction || e.type !== 'circle') continue
      const pts = this.circleUVs(e.c, e.r)
      const pos: number[] = []
      for (let i = 0; i + 1 < pts.length; i++) {
        const c = this.toWorld(e.c[0], e.c[1])
        const p = this.toWorld(pts[i][0], pts[i][1])
        const q = this.toWorld(pts[i + 1][0], pts[i + 1][1])
        pos.push(c.x, c.y, c.z, p.x, p.y, p.z, q.x, q.y, q.z)
      }
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
      const m = new THREE.Mesh(g, this.fillMat)
      m.renderOrder = 3
      this.fillGroup.add(m)
    }
  }

  private redraw(): void {
    this.updateGrid()
    for (const c of [...this.preview.children]) {
      this.preview.remove(c)
      ;(c as THREE.Line).geometry.dispose()
    }
    for (const c of [...this.entGroup.children]) {
      this.entGroup.remove(c)
      ;(c as THREE.Line).geometry.dispose()
    }
    this.rebuildFills()

    for (let i = 0; i < this.entities.length; i++) {
      if (this.deletedBaseSet.has(i)) continue
      const mat = this.selected.includes(i)
        ? this.selMat
        : this.hoverSymEnts.has(i)
          ? this.conHoverMat
          : i === this.hoverIdx
            ? this.hoverMat
            : this.entities[i].construction
              ? this.consMat
              : this.constrainedSet.has(i)
                ? this.constrainedMat
                : this.lineMat
      const obj = this.entityObj(this.entities[i], mat)
      obj.userData.entIdx = i // test hook: testEntityColorHex looks objects up by this
      this.entGroup.add(obj)
    }
    // projected (external) geometry - drawn as a distinct amber reference line
    for (let k = 0; k < this.projected.length; k++) {
      const pIdx = PROJ_BASE + k
      const mat = this.selected.includes(pIdx)
        ? this.selMat
        : pIdx === this.hoverIdx
          ? this.hoverMat
          : this.projMat
      this.entGroup.add(this.entityObj(this.projected[k].ent, mat))
    }
    this.redrawDims()
    this.rebuildSyms()

    const drawTool = this.tool !== 'select' && this.tool !== 'dimension'

    if (this.pending.length || this.tool === 'spline') {
      const p = [...this.pending, this.cursorUV]
      if (this.tool === 'line') {
        this.preview.add(this.entityObj({ type: 'line', a: p[0], b: p[1] }, this.previewMat))
      } else if (this.tool === 'rect') {
        this.preview.add(this.entityObj({ type: 'rect', a: p[0], b: p[1] }, this.previewMat))
      } else if (this.tool === 'rect-center') {
        const hw = p[1][0] - p[0][0]
        const hh = p[1][1] - p[0][1]
        this.preview.add(
          this.entityObj(
            { type: 'rect', a: [p[0][0] - hw, p[0][1] - hh], b: [p[0][0] + hw, p[0][1] + hh] },
            this.previewMat
          )
        )
      } else if (this.tool === 'circle') {
        const r = Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1])
        this.preview.add(this.entityObj({ type: 'circle', c: p[0], r }, this.previewMat))
      } else if (this.tool === 'circle-3p' || this.tool === 'arc-3p') {
        if (p.length >= 3) {
          const cc = SketchController.circumcircle(p[0], p[1], p[2])
          if (cc) this.preview.add(this.entityObj({ type: 'circle', c: cc.c, r: cc.r }, this.previewMat))
        }
        this.preview.add(this.polyToObj(p, this.previewMat))
      } else if (this.tool === 'arc' && this.pending.length === 1) {
        // 2nd click pending: only the centre is placed yet, radius/start not
        // chosen - a full circle at the live radius is the right preview
        const c = this.pending[0]
        const r = Math.hypot(this.cursorUV[0] - c[0], this.cursorUV[1] - c[1])
        this.preview.add(this.entityObj({ type: 'circle', c, r }, this.previewMat))
      } else if (this.tool === 'arc' && this.pending.length >= 2) {
        // 3rd click pending: centre + start are placed, now sweeping to the
        // end angle - show the actual arc, not a full circle, so the user
        // can see where it will end before clicking
        const c = this.pending[0]
        const startPt = this.pending[1]
        const r = Math.hypot(startPt[0] - c[0], startPt[1] - c[1])
        const a0 = Math.atan2(startPt[1] - c[1], startPt[0] - c[0])
        const a1 = Math.atan2(this.cursorUV[1] - c[1], this.cursorUV[0] - c[0])
        this.preview.add(this.entityObj({ type: 'arc', c, r, a0, a1 }, this.previewMat))
      } else if (this.tool === 'spline' && p.length >= 2) {
        this.preview.add(this.entityObj({ type: 'spline', pts: p }, this.previewMat))
      }
    }

    // rubber-band window select box
    if (this.band) {
      const [ax, ay] = this.band.a
      const [bx, by] = this.band.b
      const box = this.polyToObj(
        [
          [ax, ay],
          [bx, ay],
          [bx, by],
          [ax, by]
        ],
        this.bandMat,
        true
      )
      box.renderOrder = 41
      this.preview.add(box)
    }

    // snap indicator so the user sees exactly where a click will land
    if (drawTool) {
      const g = new THREE.BufferGeometry().setFromPoints([
        this.toWorld(this.cursorUV[0], this.cursorUV[1])
      ])
      const m = new THREE.Points(g, this.snapMats[this.snapKind])
      m.renderOrder = 42
      this.preview.add(m)
    }

    // geometry-point handles (select tool / dimension tool): every line end and
    // circle / arc centre, brighter when selected / hovered / a dim pick
    if (this.tool === 'select' || this.tool === 'dimension') {
      const bright: PtRef[] = [
        ...this.selectedPts,
        ...(this.hoverPt ? [this.hoverPt] : []),
        ...this.dimPicks.flatMap((p) => ('pt' in p ? [p.pt] : []))
      ]
      const isBright = (pr: PtRef): boolean => bright.some((b) => this.samePt(b, pr))
      const faint: THREE.Vector3[] = []
      const faintConstrained: THREE.Vector3[] = []
      const hot: THREE.Vector3[] = []
      for (let i = 0; i < this.entities.length; i++) {
        // a deleted BASE entity is never spliced out of this.entities (its
        // index is the reopen contract - see deleteSelected) so its line is
        // skipped by the same check above, but this point loop had no such
        // guard: its endpoint/centre handles kept being drawn forever after
        // "deleting" it (user report, 2026-09-13: "when I delete a line or
        // any sketch object, it's points don't seem to go [a]way")
        if (this.deletedBaseSet.has(i)) continue
        for (const pr of this.entityPts(i)) {
          const uv = this.ptUV(pr)
          if (isBright(pr)) hot.push(this.toWorld(uv[0], uv[1]))
          else (this.constrainedSet.has(i) ? faintConstrained : faint).push(this.toWorld(uv[0], uv[1]))
        }
      }
      if (faint.length) {
        const o = new THREE.Points(new THREE.BufferGeometry().setFromPoints(faint), this.ptHandleMat)
        o.renderOrder = 43
        this.preview.add(o)
      }
      if (faintConstrained.length) {
        const o = new THREE.Points(
          new THREE.BufferGeometry().setFromPoints(faintConstrained),
          this.ptHandleConstrainedMat
        )
        o.renderOrder = 43
        this.preview.add(o)
      }
      if (hot.length) {
        const o = new THREE.Points(new THREE.BufferGeometry().setFromPoints(hot), this.ptHandleSelMat)
        o.renderOrder = 44
        this.preview.add(o)
      }
    }
  }

  dispose(): void {
    this.dom.style.cursor = ''
    if (this.solveTimer != null) window.clearTimeout(this.solveTimer)
    this.dom.removeEventListener('pointerdown', this.onDown)
    this.dom.removeEventListener('pointermove', this.onMove)
    this.dom.removeEventListener('dblclick', this.onDblClick)
    window.removeEventListener('pointerup', this.onUp)
    window.removeEventListener('keydown', this.onKey)
    for (const c of this.symGroup.children) (c as THREE.Sprite).material.dispose()
    for (const t of this.symTexCache.values()) t.dispose()
    this.symTexCache.clear()
    for (const c of this.fillGroup.children) (c as THREE.Mesh).geometry.dispose()
    this.fillMat.dispose()
    this.group.removeFromParent()
    this.preview.removeFromParent()
    this.refGroup.removeFromParent()
  }
}
