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

export type SketchTool = 'select' | 'line' | 'rect' | 'circle' | 'arc' | 'dimension'

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
) & { construction?: boolean }

interface RecordedConstraint {
  type: SketchConstraintType | 'Distance' | 'Radius' | 'PointOnObject'
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
  private preview = new THREE.Group()
  private refGroup = new THREE.Group()
  private plane: THREE.Plane
  private O: THREE.Vector3
  private X: THREE.Vector3
  private Y: THREE.Vector3
  private ray = new THREE.Raycaster()
  private tool: SketchTool = 'line'
  private pending: [number, number][] = []
  private entities: SketchEntity[] = []
  private baseCount = 0
  private cursorUV: [number, number] = [0, 0]
  private onChange: () => void

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
  private construction = false
  private geomV = 0 // bumped whenever committed geometry / constraints change
  private dimV = -1 // last geomV the static dimensions were built for
  private dimHadLive = false

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly dom: HTMLElement,
    frame: SketchFrame,
    root: THREE.Object3D,
    onChange: () => void,
    refGeom?: SketchRefGeom | null,
    private readonly onDimensionRequest?: (entityIndex: number, kind: 'linear' | 'radius') => void
  ) {
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
    this.hoverIdx = -1
    this.drag = null
    this.dom.style.cursor = ''
    if (t !== 'select') this.selected = []
    this.redraw()
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

  get constraintCount(): number {
    return this.constraints.length
  }

  get selectedCount(): number {
    return this.selected.length
  }

  loadExisting(ents: SketchEntity[]): void {
    this.entities = ents.slice()
    this.baseCount = this.entities.length
    this.geomV++
    this.redraw()
  }

  undo(): void {
    if (this.pending.length) this.pending.pop()
    else if (this.constraints.length && !this.entities.length) this.constraints.pop()
    else this.entities.pop()
    this.geomV++
    this.redraw()
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

  private entityPoints(e: SketchEntity): [number, number][] {
    if (e.type === 'line') return [e.a, e.b]
    if (e.type === 'rect') return [e.a, e.b, [e.a[0], e.b[1]], [e.b[0], e.a[1]]]
    return [e.c] // circle / arc centre
  }

  private snap(uv: [number, number]): [number, number] {
    const tolMm = SNAP_PX / Math.max(this.pxPerMm(), 0.001)
    const origin: [number, number] = [0, 0]
    const pts: [number, number][] = [...this.refPoints]
    for (const e of this.entities) pts.push(...this.entityPoints(e))
    for (const poly of this.refPolys) pts.push(...poly)
    for (const p of this.pending) pts.push(p)

    // origin wins ties so it is easy to land on 0,0
    let best: [number, number] | null = null
    let bestD = tolMm
    let kind: SnapKind = 'grid'
    const dO = Math.hypot(uv[0], uv[1])
    if (dO < bestD) {
      bestD = dO
      best = origin
      kind = 'origin'
    }
    for (const t of pts) {
      const d = Math.hypot(t[0] - uv[0], t[1] - uv[1])
      if (d < bestD) {
        bestD = d
        best = t
        kind = 'point'
      }
    }
    if (best) {
      this.snapKind = kind
      return [best[0], best[1]]
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
      const idx = this.pickEntity(uv)
      ev.stopPropagation()
      if (idx < 0) {
        if (!ev.shiftKey) this.selected = []
      } else if (ev.shiftKey) {
        this.selected = this.selected.includes(idx)
          ? this.selected.filter((i) => i !== idx)
          : [...this.selected, idx]
      } else {
        this.selected = [idx]
        if (idx >= 0) this.drag = { idx, handle: this.grabHandle(idx, uv), last: uv }
      }
      this.redraw()
      this.onChange()
      return
    }
    ev.stopPropagation()
    const uv = this.pointerUV(ev)
    this.pending.push(uv)
    const need = this.tool === 'arc' ? 3 : 2
    if (this.pending.length >= need) this.commit()
    this.redraw()
  }

  /** Which part of an entity the cursor grabbed, for free-dragging. */
  private grabHandle(idx: number, uv: [number, number]): DragHandle {
    const e = this.entities[idx]
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
    if (near(e.c)) return 'c'
    if (Math.abs(Math.hypot(uv[0] - e.c[0], uv[1] - e.c[1]) - e.r) < tol) return 'r'
    return 'whole'
  }

  /** Move the dragged entity to follow the cursor. No solver - this is the
   *  "drag whatever is still free" behaviour; the sidecar re-solves on finish. */
  private applyDrag(uv: [number, number]): void {
    if (!this.drag) return
    const e = this.entities[this.drag.idx]
    const dx = uv[0] - this.drag.last[0]
    const dy = uv[1] - this.drag.last[1]
    const move = (p: [number, number]): [number, number] => [p[0] + dx, p[1] + dy]
    switch (this.drag.handle) {
      case 'whole':
        if (e.type === 'line' || e.type === 'rect') {
          e.a = move(e.a)
          e.b = move(e.b)
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
    this.drag.last = uv
    this.geomV++
    this.redraw()
  }

  private onUp = (ev: PointerEvent): void => {
    if (!this.drag) return
    this.drag = null
    ev.stopPropagation()
    this.onChange()
  }

  private onMove = (ev: PointerEvent): void => {
    if (this.drag && (ev.buttons & 1) === 1) {
      this.applyDrag(this.pointerUV(ev))
      return
    }
    // constraint-symbol hover works in any tool mode
    const symKey = this.pickSym(ev)
    if (symKey !== this.hoverSymKey) {
      this.hoverSymKey = symKey
      this.applySymHighlight()
    }
    if (this.tool === 'select' || this.tool === 'dimension') {
      const idx = symKey ? -1 : this.pickEntity(this.rawPointerUV(ev))
      if (idx !== this.hoverIdx) {
        this.hoverIdx = idx
        this.dom.style.cursor = idx >= 0 || symKey ? 'pointer' : ''
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
      this.selected = []
      this.redraw()
    } else if (ev.key === 'Enter' && this.tool === 'line') {
      this.pending = []
      this.redraw()
    } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') {
      this.undo()
    }
  }

  private commit(): void {
    const p = this.pending
    this.geomV++
    const k = this.construction ? { construction: true } : {}
    if (this.tool === 'line') {
      this.entities.push({ type: 'line', a: p[0], b: p[1], ...k })
      this.anchorToAxes(this.entities.length - 1)
      this.pending = [p[1]] // chain
    } else if (this.tool === 'rect') {
      this.entities.push({ type: 'rect', a: p[0], b: p[1], ...k })
      this.pending = []
    } else if (this.tool === 'circle') {
      const r = Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1])
      this.entities.push({ type: 'circle', c: p[0], r, ...k })
      this.anchorToAxes(this.entities.length - 1)
      this.pending = []
    } else if (this.tool === 'arc') {
      const c = p[0]
      const r = Math.hypot(p[1][0] - c[0], p[1][1] - c[1])
      const a0 = Math.atan2(p[1][1] - c[1], p[1][0] - c[0])
      const a1 = Math.atan2(p[2][1] - c[1], p[2][0] - c[0])
      this.entities.push({ type: 'arc', c, r, a0, a1, ...k })
      this.anchorToAxes(this.entities.length - 1)
      this.pending = []
    }
    this.onChange()
  }

  /** If a just-drawn entity landed a point exactly on the origin or an axis
   *  (because snapping put it there), record the matching constraint so the
   *  point stays anchored through the solve. */
  private anchorToAxes(entIdx: number): void {
    const e = this.entities[entIdx]
    if (e.construction) return
    const nw = entIdx - this.baseCount
    if (nw < 0) return
    const eps = 1e-6
    const anchor = (uv: [number, number], pt: 1 | 2 | 3): void => {
      const onX = Math.abs(uv[1]) < eps // on the X axis  -> geoId -1
      const onY = Math.abs(uv[0]) < eps // on the Y axis  -> geoId -2
      if (onX && onY) {
        this.constraints.push({
          type: 'Coincident',
          refs: [{ new: nw, sub: 0, pt }, { geo: -1, pt: 1 }]
        })
      } else if (onX) {
        this.constraints.push({ type: 'PointOnObject', refs: [{ new: nw, sub: 0, pt }, { geo: -1 }] })
      } else if (onY) {
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

  // --- constraints -------------------------------------------------------- //

  /** Which constraint types are legal for the current selection. */
  availableConstraints(): SketchConstraintType[] {
    const sel = this.selected.map((i) => this.entities[i]).filter(Boolean)
    if (!sel.length) return []
    const out: SketchConstraintType[] = []
    if (sel.length === 1 && isLine(sel[0])) out.push('Horizontal', 'Vertical')
    if (sel.length === 2) {
      const [a, b] = sel
      if (isLine(a) && isLine(b)) out.push('Parallel', 'Perpendicular', 'Equal', 'Coincident')
      if (isCurve(a) && isCurve(b)) out.push('Equal', 'Concentric')
      if ((isLine(a) && isCurve(b)) || (isCurve(a) && isLine(b))) out.push('Tangent')
    }
    return out
  }

  /** Set a numeric dimension on an entity (value already resolved from any
   *  expression). Line -> length; circle/arc -> radius. */
  setDimension(index: number, value: number): boolean {
    const e = this.entities[index]
    if (!e || !(value > 0)) return false
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
    this.geomV++
    this.redraw()
    this.onChange()
    return true
  }

  applyConstraint(type: SketchConstraintType): boolean {
    const idxs = this.selected.slice()
    const ents = idxs.map((i) => this.entities[i])
    if (ents.some((e) => !e)) return false
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
    } else {
      return false
    }
    this.selected = []
    this.geomV++
    this.redraw()
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
  private hoverMat = new THREE.LineBasicMaterial({ color: 0x9fe0ff })
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

  private entityObj(e: SketchEntity, mat: THREE.Material): THREE.Line {
    if (e.type === 'line') return this.polyToObj([e.a, e.b], mat)
    if (e.type === 'rect')
      return this.polyToObj([e.a, [e.b[0], e.a[1]], e.b, [e.a[0], e.b[1]]], mat, true)
    if (e.type === 'circle') return this.polyToObj(this.circleUVs(e.c, e.r), mat, true)
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
    g.fillStyle = 'rgba(16,18,22,0.82)'
    g.beginPath()
    g.roundRect(3, 3, 24, 24, 5)
    g.fill()
    g.strokeStyle = 'rgba(255,255,255,0.28)'
    g.lineWidth = 1
    g.stroke()
    g.fillStyle = '#ffffff'
    g.font = '700 15px ui-sans-serif, system-ui, sans-serif'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillText(glyph, 15, 16)
    t = new THREE.CanvasTexture(c)
    t.colorSpace = THREE.SRGBColorSpace
    this.symTexCache.set(glyph, t)
    return t
  }

  private symSprite(glyph: string, at: [number, number], key: string): THREE.Sprite {
    const s = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.symTex(glyph),
        color: SketchController.SYM_BASE,
        depthTest: false,
        transparent: true
      })
    )
    s.position.copy(this.toWorld(at[0], at[1]))
    const h = this.mmForPx(15)
    s.scale.set(h, h, 1)
    s.renderOrder = 44
    s.userData = { symKey: key }
    return s
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
    const ang = Math.PI / 4 + k
    return [e.c[0] + Math.cos(ang) * (e.r + nudge), e.c[1] + Math.sin(ang) * (e.r + nudge)]
  }

  private static readonly SYM_GLYPH: Record<string, string> = {
    Horizontal: 'H',
    Vertical: 'V',
    Parallel: '∥',
    Perpendicular: '⟂',
    Equal: '=',
    Tangent: 'T',
    Coincident: '•',
    Concentric: '◎',
    PointOnObject: '+'
  }

  private rebuildSyms(): void {
    if (this.symV === this.geomV) return
    this.symV = this.geomV
    for (const c of [...this.symGroup.children]) {
      this.symGroup.remove(c)
      ;(c as THREE.Sprite).material.dispose()
    }

    // implied rectangle constraints (the editor stores a rect as one entity but
    // the sidecar builds it as 4 constrained lines - show what will be there)
    for (let i = 0; i < this.entities.length; i++) {
      const e = this.entities[i]
      if (e.construction) continue
      if (e.type === 'rect') {
        const x0 = Math.min(e.a[0], e.b[0])
        const x1 = Math.max(e.a[0], e.b[0])
        const y0 = Math.min(e.a[1], e.b[1])
        const y1 = Math.max(e.a[1], e.b[1])
        const corners: [number, number][] = [
          [x0, y0],
          [x1, y0],
          [x1, y1],
          [x0, y1]
        ]
        corners.forEach((p, ci) =>
          this.symGroup.add(this.symSprite('•', p, `rect${i}-corner${ci}`))
        )
        this.symGroup.add(this.symSprite('H', [(x0 + x1) / 2, y0 - this.mmForPx(7)], `rect${i}-h`))
        this.symGroup.add(this.symSprite('H', [(x0 + x1) / 2, y1 + this.mmForPx(7)], `rect${i}-h`))
        this.symGroup.add(this.symSprite('V', [x0 - this.mmForPx(7), (y0 + y1) / 2], `rect${i}-v`))
        this.symGroup.add(this.symSprite('V', [x1 + this.mmForPx(7), (y0 + y1) / 2], `rect${i}-v`))
      }
    }

    // recorded constraints
    this.constraints.forEach((con, ci) => {
      if (con.type === 'Distance' || con.type === 'Radius') return // shown as dims
      const glyph = SketchController.SYM_GLYPH[con.type]
      if (!glyph) return
      const key = `con${ci}`
      for (const r of con.refs) {
        if (r.geo != null && r.geo < 0) {
          // anchored to origin / an axis - mark it at the origin
          this.symGroup.add(this.symSprite(glyph, [0, 0], key))
          continue
        }
        const ei = r.geo != null ? r.geo : (r.new ?? 0) + this.baseCount
        const e = this.entities[ei]
        if (e) this.symGroup.add(this.symSprite(glyph, this.symAnchor(e, ci), key))
      }
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

  private dimLabel(text: string, at: THREE.Vector3, driven = true): THREE.Sprite {
    const dpr = 2
    const c = document.createElement('canvas')
    c.width = 160 * dpr
    c.height = 44 * dpr
    const g = c.getContext('2d')!
    g.scale(dpr, dpr)
    g.fillStyle = driven ? 'rgba(18,20,24,0.9)' : 'rgba(18,20,24,0.7)'
    const r = 6
    g.beginPath()
    g.roundRect(2, 2, 156, 40, r)
    g.fill()
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
    owner = -1
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
    const off = this.mmForPx(24)
    const ext = this.mmForPx(6)
    const gap = this.mmForPx(2)
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
    g.add(
      this.dimLabel(
        text,
        this.toWorld((a1[0] + b1[0]) / 2 + nx * this.mmForPx(8), (a1[1] + b1[1]) / 2 + ny * this.mmForPx(8)),
        driven
      )
    )
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
    owner = -1
  ): THREE.Group {
    const g = new THREE.Group()
    g.userData = { dimOwner: owner, dimKind: 'radius' }
    const mat = driven ? this.dimDrivenMat : this.dimMat
    const ang = Math.PI / 4
    const ux = Math.cos(ang)
    const uy = Math.sin(ang)
    const rim: [number, number] = [c[0] + ux * r, c[1] + uy * r]
    const out: [number, number] = [c[0] + ux * (r + this.mmForPx(16)), c[1] + uy * (r + this.mmForPx(16))]
    this.seg(g, c, out, mat)
    const ah = this.mmForPx(3.5)
    const nx = -uy
    const ny = ux
    const bx = rim[0] - ux * ah
    const by = rim[1] - uy * ah
    this.seg(g, [bx + nx * ah * 0.45, by + ny * ah * 0.45], rim, mat)
    this.seg(g, [bx - nx * ah * 0.45, by - ny * ah * 0.45], rim, mat)
    g.add(this.dimLabel(text, this.toWorld(out[0] + ux * this.mmForPx(2), out[1] + uy * this.mmForPx(2)), driven))
    g.renderOrder = 32
    return g
  }

  private redrawDims(): void {
    const live = this.pending.length > 0
    if (this.geomV === this.dimV && !live && !this.dimHadLive) return
    this.dimV = this.geomV
    this.dimHadLive = live
    this.clearDims()

    // which entities carry a user-set (driven) dimension
    const driven = new Map<number, number>()
    for (const con of this.constraints) {
      if (con.value == null) continue
      if (con.type !== 'Distance' && con.type !== 'Radius') continue
      const r0 = con.refs[0]
      const idx = r0.geo != null ? r0.geo : (r0.new ?? 0) + this.baseCount
      driven.set(idx, con.value)
    }

    // a reference (or driven) dimension on every real entity
    for (let i = 0; i < this.entities.length; i++) {
      const e = this.entities[i]
      if (e.construction) continue
      const dv = driven.get(i)
      if (e.type === 'line') {
        const v = dv ?? Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1])
        if (v > 0.01) this.dimGroup.add(this.makeDim(e.a, e.b, 1, this.fmt(v), dv != null, i))
      } else if (e.type === 'rect') {
        const x0 = Math.min(e.a[0], e.b[0])
        const x1 = Math.max(e.a[0], e.b[0])
        const y0 = Math.min(e.a[1], e.b[1])
        const y1 = Math.max(e.a[1], e.b[1])
        if (x1 - x0 > 0.01) this.dimGroup.add(this.makeDim([x0, y0], [x1, y0], -1, this.fmt(x1 - x0), false))
        if (y1 - y0 > 0.01) this.dimGroup.add(this.makeDim([x0, y0], [x0, y1], 1, this.fmt(y1 - y0), false))
      } else if (e.type === 'circle' || e.type === 'arc') {
        const v = dv ?? e.r
        this.dimGroup.add(this.makeRadial(e.c, e.r, `R ${this.fmt(v)}`, dv != null, i))
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

    for (let i = 0; i < this.entities.length; i++) {
      const mat = this.selected.includes(i)
        ? this.selMat
        : i === this.hoverIdx
          ? this.hoverMat
          : this.entities[i].construction
            ? this.consMat
            : this.lineMat
      this.entGroup.add(this.entityObj(this.entities[i], mat))
    }
    this.redrawDims()
    this.rebuildSyms()

    const drawTool =
      this.tool === 'line' || this.tool === 'rect' || this.tool === 'circle' || this.tool === 'arc'

    if (this.pending.length) {
      const p = [...this.pending, this.cursorUV]
      if (this.tool === 'line' || this.tool === 'rect') {
        const e: SketchEntity =
          this.tool === 'line'
            ? { type: 'line', a: p[0], b: p[1] }
            : { type: 'rect', a: p[0], b: p[1] }
        this.preview.add(this.entityObj(e, this.previewMat))
      } else if (this.tool === 'circle') {
        const r = Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1])
        this.preview.add(this.entityObj({ type: 'circle', c: p[0], r }, this.previewMat))
      } else if (this.tool === 'arc' && this.pending.length >= 1) {
        const c = this.pending[0]
        const r = Math.hypot(this.cursorUV[0] - c[0], this.cursorUV[1] - c[1])
        this.preview.add(this.entityObj({ type: 'circle', c, r }, this.previewMat))
      }
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
    this.dom.removeEventListener('pointerdown', this.onDown)
    this.dom.removeEventListener('pointermove', this.onMove)
    this.dom.removeEventListener('dblclick', this.onDblClick)
    window.removeEventListener('pointerup', this.onUp)
    window.removeEventListener('keydown', this.onKey)
    for (const c of this.symGroup.children) (c as THREE.Sprite).material.dispose()
    for (const t of this.symTexCache.values()) t.dispose()
    this.symTexCache.clear()
    this.group.removeFromParent()
    this.preview.removeFromParent()
    this.refGroup.removeFromParent()
  }
}
