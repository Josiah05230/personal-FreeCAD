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

type SnapKind = 'grid' | 'origin' | 'point' | 'edge' | 'axis'
type DragHandle = 'a' | 'b' | 'ab' | 'ba' | 'c' | 'r' | 'whole'

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
) & { construction?: boolean }

export interface RecordedConstraint {
  type: SketchConstraintType | 'Distance' | 'Radius' | 'PointOnObject' | 'Symmetric'
  refs: Array<{ new?: number; geo?: number; sub?: number; pt?: number }>
  value?: number
}

const GRID = 1 // mm snap
const SNAP_PX = 12

const isCurve = (e: SketchEntity): boolean => e.type === 'circle' || e.type === 'arc'
const isLine = (e: SketchEntity): boolean => e.type === 'line'

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
  private selected: number[] = []
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
  /** where each dim label currently sits (uv) + its kind, for hit-testing */
  private dimLabelUV = new Map<number, { uv: [number, number]; kind: 'linear' | 'radius' }>()
  private dimDrag: {
    owner: number
    kind: 'linear' | 'radius'
    startUV: [number, number]
    base: [number, number]
  } | null = null
  /** constraint index of the dimension whose label is selected (Delete removes it) */
  private selectedDim: number | null = null

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly dom: HTMLElement,
    frame: SketchFrame,
    root: THREE.Object3D,
    onChange: () => void,
    refGeom?: SketchRefGeom | null,
    private readonly onDimensionRequest?: (entityIndex: number, kind: 'linear' | 'radius') => void,
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
    this.tool = t
    this.pending = []
    this.pendingSnaps = []
    this.pendingMids = []
    this.hoverIdx = -1
    this.drag = null
    this.band = null
    this.dom.style.cursor = ''
    if (t !== 'select') this.selected = []
    if (t !== 'select') this.pendingCon = null
    this.redraw()
  }

  /** Enter "pick geometry for this constraint" mode (ribbon button, no live
   *  selection). Clears once enough entities are picked. */
  beginConstraint(t: SketchConstraintType): void {
    this.pendingCon = t
    this.tool = 'select'
    this.selected = []
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

  get constraintCount(): number {
    return this.constraints.length
  }

  get selectedCount(): number {
    return this.selected.length
  }

  loadExisting(ents: SketchEntity[], cons: RecordedConstraint[] = []): void {
    this.entities = ents.slice()
    this.baseCount = this.entities.length
    this.constraints = cons.map((c) => ({ ...c, refs: c.refs.map((r) => ({ ...r })) }))
    this.baseConstraintCount = this.constraints.length
    this.removedBaseConstraints = []
    this.undoStack = []
    this.geomV++
    this.redraw()
    this.scheduleSolve()
  }

  /** Full pre-action snapshot, so one Ctrl+Z reverts one user action (a
   *  rectangle is 4 lines + its constraints, but still one undo step). */
  private undoStack: Array<{ ents: SketchEntity[]; cons: RecordedConstraint[] }> = []

  private dragMoved = false
  private preDragSnap: { ents: SketchEntity[]; cons: RecordedConstraint[] } | null = null
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

    // whole-entity / body moves: only blocked when the entity is fully solved
    if (handle === 'whole' || handle === 'ab' || handle === 'ba') {
      if (this.constrainedSet.has(idx)) {
        this.noticeOnce(
          'This geometry is fully constrained - remove a dimension or constraint to move it.'
        )
        return null
      }
      return target
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
        if (c.type === 'Coincident' && c.refs[1]?.geo === -1) {
          lockX = true
          lockY = true
        } else if (c.type === 'PointOnObject' && c.refs[1]?.geo === -1) lockY = true
        else if (c.type === 'PointOnObject' && c.refs[1]?.geo === -2) lockX = true
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

  private static cloneEnt(e: SketchEntity): SketchEntity {
    return e.type === 'spline' ? { ...e, pts: e.pts.map((p) => [p[0], p[1]] as [number, number]) } : { ...e }
  }

  private cloneEnts(): SketchEntity[] {
    return this.entities.map((e) => SketchController.cloneEnt(e))
  }

  private cloneCons(): RecordedConstraint[] {
    return this.constraints.map((c) => ({ ...c, refs: c.refs.map((r) => ({ ...r })) }))
  }

  private snapshot(): void {
    this.undoStack.push({ ents: this.cloneEnts(), cons: this.cloneCons() })
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
    this.snapKind = 'grid'
    return [Math.round(uv[0] / GRID) * GRID, Math.round(uv[1] / GRID) * GRID]
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
      const d = this.distToEntity(uv, this.entities[i])
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    return best
  }

  /** Nearest dimension value-label to a uv, within a screen-sized tolerance. */
  /** constraint index of the Distance / Radius dimension driving entity `owner` */
  private dimConstraintIndex(owner: number): number {
    return this.constraints.findIndex((c) => {
      if (c.type !== 'Distance' && c.type !== 'Radius') return false
      const r0 = c.refs[0]
      if (!r0) return false
      const ei = r0.geo != null ? r0.geo : (r0.new ?? -999) + this.baseCount
      return ei === owner
    })
  }

  private pickDimLabel(uv: [number, number]): { owner: number; kind: 'linear' | 'radius' } | null {
    const tol = this.mmForPx(30)
    let best: { owner: number; kind: 'linear' | 'radius' } | null = null
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
    if (this.tool === 'dimension') {
      ev.stopPropagation()
      const idx = this.pickEntity(this.rawPointerUV(ev))
      if (idx < 0) return
      const e = this.entities[idx]
      this.onDimensionRequest?.(idx, e.type === 'circle' || e.type === 'arc' ? 'radius' : 'linear')
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
          // select the dimension (Delete removes it) and arm a label drag
          this.selectedDim = this.dimConstraintIndex(dl.owner)
          this.selected = []
          this.dimDrag = {
            owner: dl.owner,
            kind: dl.kind,
            startUV: uv,
            base: this.dimOffsets.get(dl.owner) ?? [0, 0]
          }
          this.dom.style.cursor = 'move'
          this.forceDimRedraw()
          this.onChange()
          return
        }
      }
      if (this.selectedDim != null) {
        this.selectedDim = null
        this.dimV = -1
      }

      const idx = this.pickEntity(uv)

      // "click the constraint, then click the geometry" mode
      if (this.pendingCon) {
        if (idx >= 0 && !this.selected.includes(idx)) this.selected.push(idx)
        if (this.selected.length >= this.conArity(this.pendingCon)) {
          const t = this.pendingCon
          this.pendingCon = null
          this.dom.style.cursor = ''
          this.applyConstraint(t)
        }
        this.redraw()
        this.onChange()
        return
      }

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
          this.preDragSnap = { ents: this.cloneEnts(), cons: this.cloneCons() }
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
      if (c.type !== 'Distance' && c.type !== 'Radius') return false
      const r0 = c.refs[0]
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
    }
    // keep coincident corners welded and honour H / V while dragging - a
    // rectangle side stays a rectangle side (the sidecar still re-solves later)
    this.solveLocal(this.draggedKeys(), this.rectHoldKeys())
    this.dragMoved = true
    this.drag.last = uv
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
        out.add(`${i}:3`)
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
    const hits: number[] = []
    this.entities.forEach((e, i) => {
      let pts: [number, number][]
      if (e.type === 'line') {
        pts = [e.a, e.b, [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2]]
      } else if (e.type === 'circle' || e.type === 'arc') {
        pts = [
          e.c,
          [e.c[0] + e.r, e.c[1]],
          [e.c[0] - e.r, e.c[1]],
          [e.c[0], e.c[1] + e.r],
          [e.c[0], e.c[1] - e.r]
        ]
      } else if (e.type === 'spline') {
        pts = e.pts
      } else {
        pts = [e.a, e.b]
      }
      const n = pts.filter(inside).length
      if (crossing ? n > 0 : n === pts.length) hits.push(i)
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
      const idx = symKey || onLabel ? -1 : this.pickEntity(raw)
      if (idx !== this.hoverIdx) {
        this.hoverIdx = idx
        this.redraw()
      }
      this.dom.style.cursor = onLabel ? 'move' : idx >= 0 || symKey ? 'pointer' : ''
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
      this.selected.length
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

  /** Delete the selected entities (only ones added this session) and drop /
   *  reindex any constraints that referenced them. */
  private deleteSelected(): void {
    const rel = this.selected
      .filter((i) => i >= this.baseCount)
      .map((i) => i - this.baseCount)
      .sort((a, b) => b - a)
    if (!rel.length) {
      this.selected = []
      this.redraw()
      return
    }
    this.snapshot()
    for (const r of rel) {
      this.entities.splice(this.baseCount + r, 1)
      this.constraints = this.constraints.filter((c) => !c.refs.some((rf) => rf.new === r))
      for (const c of this.constraints)
        for (const rf of c.refs) if (rf.new != null && rf.new > r) rf.new--
    }
    this.selected = []
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
    this.geomV++
    const k = this.construction ? { construction: true } : {}
    if (this.tool === 'line') {
      this.entities.push({ type: 'line', a: p[0], b: p[1], ...k })
      const li = this.entities.length - 1
      this.anchorToAxes(li)
      this.autoCoincident(li, [snaps[0] ?? null, snaps[1] ?? null])
      this.autoMidpoint(li, [mids[0] ?? null, mids[1] ?? null])
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
      this.anchorToAxes(this.entities.length - 1)
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
    snaps: Array<{ idx: number; pt: number } | null>
  ): void {
    const e = this.entities[entIdx]
    if (e.construction) return
    if (e.type !== 'line' && e.type !== 'circle' && e.type !== 'arc') return
    const nw = entIdx - this.baseCount
    if (nw < 0) return
    // line: snaps[0] -> start (pt 1), snaps[1] -> end (pt 2); circle/arc: centre (pt 3)
    const myPts = e.type === 'line' ? [1, 2] : [3]
    snaps.forEach((s, k) => {
      if (!s || s.idx === entIdx) return
      const target = this.entities[s.idx]
      if (!target || target.construction) return
      const myPt = myPts[k]
      if (myPt == null) return
      const tref = s.idx < this.baseCount ? { geo: s.idx, pt: s.pt } : { new: s.idx - this.baseCount, sub: 0, pt: s.pt }
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
      const line = this.entities[m.idx]
      if (!line || line.type !== 'line' || line.construction) return
      const myPt = k === 0 ? 1 : 2
      const lref = (pt: number): RecordedConstraint['refs'][number] =>
        m.idx < this.baseCount
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
    const anchor = (uv: [number, number], pt: 1 | 2 | 3): void => {
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
    const i = this.entIdxOfRef(r)
    if (i < 0) return null
    return `${i}:${r.pt ?? 1}`
  }

  private ptOf(key: string): [number, number] {
    const [i, p] = key.split(':').map(Number)
    const e = this.entities[i]
    if (!e) return [0, 0]
    if (e.type === 'line') return p === 2 ? [...e.b] : [...e.a]
    if (e.type === 'circle' || e.type === 'arc') return [...e.c]
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
    } else if (e.type === 'circle' || e.type === 'arc') {
      e.c = [uv[0], uv[1]]
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

    // points hard-anchored to the origin / an axis, plus caller-held points
    const anchored = new Set<string>(held)
    for (const c of this.constraints) {
      if (c.type === 'Coincident' && c.refs[1]?.geo === -1) {
        const k = this.keyOfRef(c.refs[0])
        if (k) anchored.add(k)
      } else if (
        c.type === 'PointOnObject' &&
        (c.refs[1]?.geo === -1 || c.refs[1]?.geo === -2)
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
      // 1. origin / axis anchors first, so welds can lock onto them
      for (const c of this.constraints) {
        if (c.type === 'Coincident' && c.refs[1]?.geo === -1) {
          const k = this.keyOfRef(c.refs[0])
          if (k) this.setPtOf(k, [0, 0])
        } else if (c.type === 'PointOnObject') {
          const k = this.keyOfRef(c.refs[0])
          if (!k) continue
          const p = this.ptOf(k)
          if (c.refs[1]?.geo === -1) this.setPtOf(k, [p[0], 0])
          else if (c.refs[1]?.geo === -2) this.setPtOf(k, [0, p[1]])
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
      // 3. horizontal / vertical
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
      // 4. midpoints (Symmetric about a line's two endpoints)
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
      // 5. length dimensions - keep the length, pivot on the fixed end
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

    // reconcile: adopt the solved coordinates (indices are absolute now)
    res.geometry.forEach((g, i) => {
      const ent = this.entities[i]
      if (!ent || !g || ent.type !== g.type || ent.construction) return
      if (g.type === 'line' && ent.type === 'line') {
        ent.a = [g.a[0], g.a[1]]
        ent.b = [g.b[0], g.b[1]]
      } else if ((g.type === 'circle' || g.type === 'arc') && (ent.type === 'circle' || ent.type === 'arc')) {
        ent.c = [g.c[0], g.c[1]]
        ;(ent as { r: number }).r = g.r
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
    const sel = this.selected.map((i) => this.entities[i]).filter(Boolean)
    if (!sel.length) return []
    const out: SketchConstraintType[] = []
    if (sel.length === 1 && isLine(sel[0])) out.push('Horizontal', 'Vertical')
    if (sel.length === 2) {
      const [a, b] = sel
      if (isLine(a) && isLine(b)) out.push('Parallel', 'Perpendicular', 'Equal', 'Coincident', 'Midpoint')
      if (isCurve(a) && isCurve(b)) out.push('Equal', 'Concentric')
      if ((isLine(a) && isCurve(b)) || (isCurve(a) && isLine(b))) out.push('Tangent', 'Midpoint')
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
   *  expression). Line -> length; circle/arc -> radius. */
  setDimension(index: number, value: number): boolean {
    const e = this.entities[index]
    if (!e || !(value > 0)) return false
    this.snapshot()
    if (e.type === 'line') {
      const dx = e.b[0] - e.a[0]
      const dy = e.b[1] - e.a[1]
      const len = Math.hypot(dx, dy) || 1
      e.b = [e.a[0] + (dx / len) * value, e.a[1] + (dy / len) * value]
    } else if (e.type === 'circle' || e.type === 'arc') {
      ;(e as { r: number }).r = value
    } else {
      return false
    }
    const ref =
      index < this.baseCount
        ? { geo: index }
        : { new: index - this.baseCount, sub: 0 }
    const kind: RecordedConstraint['type'] = e.type === 'line' ? 'Distance' : 'Radius'
    this.constraints = this.constraints.filter(
      (c) => !((c.type === 'Distance' || c.type === 'Radius') && JSON.stringify(c.refs[0]) === JSON.stringify(ref))
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

  applyConstraint(type: SketchConstraintType): boolean {
    const idxs = this.selected.slice()
    const ents = idxs.map((i) => this.entities[i])
    if (ents.some((e) => !e)) return false
    this.snapshot()
    const ref = (i: number, pt?: number): RecordedConstraint['refs'][number] =>
      i < this.baseCount ? { geo: i, pt } : { new: i - this.baseCount, sub: 0, pt }

    if ((type === 'Horizontal' || type === 'Vertical') && ents.length === 1 && isLine(ents[0])) {
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
      const a = this.entities[idxs[0]] as { a: [number, number]; b: [number, number] }
      const b = this.entities[idxs[1]] as { a: [number, number]; b: [number, number] }
      let ang = Math.atan2(a.b[1] - a.a[1], a.b[0] - a.a[0])
      if (type === 'Perpendicular') ang += Math.PI / 2
      const len = Math.hypot(b.b[0] - b.a[0], b.b[1] - b.a[1])
      b.b = [b.a[0] + Math.cos(ang) * len, b.a[1] + Math.sin(ang) * len]
      this.constraints.push({ type, refs: [ref(idxs[0]), ref(idxs[1])] })
    } else if (type === 'Equal' && ents.length === 2) {
      const a = this.entities[idxs[0]]
      const b = this.entities[idxs[1]]
      if (isLine(a) && isLine(b)) {
        const la = a as { a: [number, number]; b: [number, number] }
        const lb = b as { a: [number, number]; b: [number, number] }
        const len = Math.hypot(la.b[0] - la.a[0], la.b[1] - la.a[1])
        const ang = Math.atan2(lb.b[1] - lb.a[1], lb.b[0] - lb.a[0])
        lb.b = [lb.a[0] + Math.cos(ang) * len, lb.a[1] + Math.sin(ang) * len]
      } else if (isCurve(a) && isCurve(b)) {
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
      // weld the two nearest endpoints
      const a = this.entities[idxs[0]] as { a: [number, number]; b: [number, number] }
      const b = this.entities[idxs[1]] as { a: [number, number]; b: [number, number] }
      const pairs: Array<[1 | 2, 1 | 2, number]> = [
        [1, 1, Math.hypot(a.a[0] - b.a[0], a.a[1] - b.a[1])],
        [1, 2, Math.hypot(a.a[0] - b.b[0], a.a[1] - b.b[1])],
        [2, 1, Math.hypot(a.b[0] - b.a[0], a.b[1] - b.a[1])],
        [2, 2, Math.hypot(a.b[0] - b.b[0], a.b[1] - b.b[1])]
      ]
      pairs.sort((x, y) => x[2] - y[2])
      const [pa, pb] = pairs[0]
      const target = pa === 1 ? a.a : a.b
      if (pb === 1) b.a = [...target] as [number, number]
      else b.b = [...target] as [number, number]
      this.constraints.push({ type, refs: [ref(idxs[0], pa), ref(idxs[1], pb)] })
    } else if (type === 'Tangent' && ents.length === 2) {
      this.constraints.push({ type, refs: [ref(idxs[0]), ref(idxs[1])] })
    } else if (type === 'Midpoint' && ents.length === 2) {
      // one line + one other entity: put that entity's nearest endpoint at the
      // line's midpoint (recorded as a Symmetric-about-the-endpoints constraint)
      const li = isLine(ents[0]) ? idxs[0] : isLine(ents[1]) ? idxs[1] : -1
      const oi = li === idxs[0] ? idxs[1] : idxs[0]
      if (li < 0) return false
      const ln = this.entities[li] as { a: [number, number]; b: [number, number] }
      const mid: [number, number] = [(ln.a[0] + ln.b[0]) / 2, (ln.a[1] + ln.b[1]) / 2]
      const oe = this.entities[oi]
      let opt: 1 | 2 | 3 = 3
      if (oe.type === 'line') {
        opt =
          Math.hypot(oe.a[0] - mid[0], oe.a[1] - mid[1]) <=
          Math.hypot(oe.b[0] - mid[0], oe.b[1] - mid[1])
            ? 1
            : 2
        if (opt === 1) oe.a = [...mid] as [number, number]
        else oe.b = [...mid] as [number, number]
      } else if (oe.type === 'circle' || oe.type === 'arc') {
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
  // fully-constrained geometry reads as "done" - drawn grey like FreeCAD's green
  private constrainedMat = new THREE.LineBasicMaterial({ color: 0x8b93a0 })
  private hoverMat = new THREE.LineBasicMaterial({ color: 0x9fe0ff })
  private bandMat = new THREE.LineDashedMaterial({ color: 0x9fb4c8, dashSize: 2, gapSize: 1.5 })
  private conHoverMat = new THREE.LineBasicMaterial({ color: 0x7fe0ff, linewidth: 2 })
  private refMat = new THREE.LineBasicMaterial({ color: 0x6b7784, transparent: true, opacity: 0.6 })
  private refPtMat = new THREE.PointsMaterial({ color: 0x9aa7b4, size: 5, sizeAttenuation: false })
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
    if (e.type === 'line') return this.polyToObj([e.a, e.b], mat)
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
    s.userData = { symKey: key }
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
      if (con.type === 'Distance' || con.type === 'Radius') return // shown as dims
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

  private redrawDims(): void {
    const live = this.pending.length > 0
    if (this.geomV === this.dimV && !live && !this.dimHadLive) return
    this.dimV = this.geomV
    this.dimHadLive = live
    this.clearDims()
    this.dimLabelUV.clear()

    // Dimensions are only shown once the user assigns them - never by default.
    for (let ci = 0; ci < this.constraints.length; ci++) {
      const con = this.constraints[ci]
      if (con.value == null) continue
      if (con.type !== 'Distance' && con.type !== 'Radius') continue
      const r0 = con.refs[0]
      const i = r0.geo != null ? r0.geo : (r0.new ?? 0) + this.baseCount
      const e = this.entities[i]
      if (!e || e.construction) continue
      const nudge = this.dimOffsets.get(i) ?? [0, 0]
      const sel = this.selectedDim === ci
      if (e.type === 'line') {
        this.dimGroup.add(this.makeDim(e.a, e.b, 1, this.fmt(con.value), true, i, nudge, sel))
      } else if (e.type === 'circle' || e.type === 'arc') {
        this.dimGroup.add(this.makeRadial(e.c, e.r, `R ${this.fmt(con.value)}`, true, i, nudge, sel))
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
      this.entGroup.add(this.entityObj(this.entities[i], mat))
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
      } else if (this.tool === 'arc' && this.pending.length >= 1) {
        const c = this.pending[0]
        const r = Math.hypot(this.cursorUV[0] - c[0], this.cursorUV[1] - c[1])
        this.preview.add(this.entityObj({ type: 'circle', c, r }, this.previewMat))
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
