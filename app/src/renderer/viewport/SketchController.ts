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
  type: SketchConstraintType | 'Distance' | 'Radius'
  refs: Array<{ new?: number; geo?: number; sub?: number; pt?: number }>
  value?: number
}

const GRID = 1 // mm snap
const SNAP_PX = 12

const isCurve = (e: SketchEntity): boolean => e.type === 'circle' || e.type === 'arc'
const isLine = (e: SketchEntity): boolean => e.type === 'line'

export class SketchController {
  private group = new THREE.Group()
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
  private constraints: RecordedConstraint[] = []
  private construction = false

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
    this.addGrid()
    this.drawRefGeom()
    this.redraw()

    this.dom.addEventListener('pointerdown', this.onDown)
    this.dom.addEventListener('pointermove', this.onMove)
    window.addEventListener('keydown', this.onKey)
  }

  setTool(t: SketchTool): void {
    this.tool = t
    this.pending = []
    if (t !== 'select') this.selected = []
    this.redraw()
  }

  setConstruction(on: boolean): void {
    this.construction = on
  }

  toggleConstruction(): boolean {
    this.construction = !this.construction
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
    this.redraw()
  }

  undo(): void {
    if (this.pending.length) this.pending.pop()
    else if (this.constraints.length && !this.entities.length) this.constraints.pop()
    else this.entities.pop()
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
    const targets: [number, number][] = [[0, 0], ...this.refPoints]
    for (const e of this.entities) targets.push(...this.entityPoints(e))
    for (const poly of this.refPolys) targets.push(...poly)
    for (const p of this.pending) targets.push(p)
    let best: [number, number] | null = null
    let bestD = tolMm
    for (const t of targets) {
      const d = Math.hypot(t[0] - uv[0], t[1] - uv[1])
      if (d < bestD) {
        bestD = d
        best = t
      }
    }
    if (best) return [best[0], best[1]]
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
    if (onEdge) return onEdge
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

  private rawPointerUV(ev: PointerEvent): [number, number] {
    const r = this.dom.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((ev.clientX - r.left) / r.width) * 2 - 1,
      -((ev.clientY - r.top) / r.height) * 2 + 1
    )
    this.ray.setFromCamera(ndc, this.camera)
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

  private onMove = (ev: PointerEvent): void => {
    if (this.tool === 'select') return
    this.cursorUV = this.pointerUV(ev)
    if (this.pending.length) this.redraw()
  }

  private onKey = (ev: KeyboardEvent): void => {
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
    const k = this.construction ? { construction: true } : {}
    if (this.tool === 'line') {
      this.entities.push({ type: 'line', a: p[0], b: p[1], ...k })
      this.pending = [p[1]] // chain
    } else if (this.tool === 'rect') {
      this.entities.push({ type: 'rect', a: p[0], b: p[1], ...k })
      this.pending = []
    } else if (this.tool === 'circle') {
      const r = Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1])
      this.entities.push({ type: 'circle', c: p[0], r, ...k })
      this.pending = []
    } else if (this.tool === 'arc') {
      const c = p[0]
      const r = Math.hypot(p[1][0] - c[0], p[1][1] - c[1])
      const a0 = Math.atan2(p[1][1] - c[1], p[1][0] - c[0])
      const a1 = Math.atan2(p[2][1] - c[1], p[2][0] - c[0])
      this.entities.push({ type: 'arc', c, r, a0, a1, ...k })
      this.pending = []
    }
    this.onChange()
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
  private refMat = new THREE.LineBasicMaterial({ color: 0x6b7784, transparent: true, opacity: 0.6 })
  private refPtMat = new THREE.PointsMaterial({ color: 0x9aa7b4, size: 5, sizeAttenuation: false })
  private previewMat = new THREE.LineDashedMaterial({
    color: 0x8fd0f4,
    dashSize: 1.5,
    gapSize: 1
  })

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

  private addGrid(): void {
    const grid = new THREE.GridHelper(400, 80, 0x3a4048, 0x2c313a)
    grid.rotateX(Math.PI / 2)
    grid.position.copy(this.O)
    grid.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3().crossVectors(this.X, this.Y).normalize()
    )
    ;(grid.material as THREE.Material).transparent = true
    ;(grid.material as THREE.Material).opacity = 0.4
    this.group.add(grid)
  }

  private dimGroup = new THREE.Group()

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
      const sp = c as THREE.Sprite
      sp.material.map?.dispose()
      sp.material.dispose()
    }
  }

  private redrawDims(): void {
    this.clearDims()
    // committed driven dimensions
    for (const con of this.constraints) {
      if (con.value == null) continue
      const r0 = con.refs[0]
      const idx = r0.geo != null ? r0.geo : (r0.new ?? 0) + this.baseCount
      const e = this.entities[idx]
      if (!e) continue
      let at: [number, number]
      if (e.type === 'line') {
        const dx = e.b[0] - e.a[0]
        const dy = e.b[1] - e.a[1]
        const len = Math.hypot(dx, dy) || 1
        at = [(e.a[0] + e.b[0]) / 2 - (dy / len) * this.mmForPx(16), (e.a[1] + e.b[1]) / 2 + (dx / len) * this.mmForPx(16)]
      } else if (e.type === 'circle' || e.type === 'arc') at = [e.c[0], e.c[1] + e.r]
      else continue
      const txt =
        con.type === 'Radius' ? `R ${Number(con.value.toFixed(3))}` : `${Number(con.value.toFixed(3))}`
      this.dimGroup.add(this.dimLabel(txt, this.toWorld(at[0], at[1]), true))
    }
    // live readout for whatever is being drawn right now
    if (this.pending.length) {
      const cur = this.cursorUV
      if (this.tool === 'line') {
        const a = this.pending[this.pending.length - 1]
        const len = Math.hypot(cur[0] - a[0], cur[1] - a[1])
        if (len > 0.01)
          this.dimGroup.add(
            this.dimLabel(
              len.toFixed(2),
              this.toWorld((a[0] + cur[0]) / 2, (a[1] + cur[1]) / 2 + this.mmForPx(14)),
              false
            )
          )
      } else if (this.tool === 'rect') {
        const a = this.pending[0]
        this.dimGroup.add(
          this.dimLabel(
            `${Math.abs(cur[0] - a[0]).toFixed(1)} x ${Math.abs(cur[1] - a[1]).toFixed(1)}`,
            this.toWorld((a[0] + cur[0]) / 2, Math.max(a[1], cur[1]) + this.mmForPx(14)),
            false
          )
        )
      } else if (this.tool === 'circle' || this.tool === 'arc') {
        const c = this.pending[0]
        const rr = Math.hypot(cur[0] - c[0], cur[1] - c[1])
        if (rr > 0.01)
          this.dimGroup.add(
            this.dimLabel(`R ${rr.toFixed(2)}`, this.toWorld(c[0], c[1] + rr + this.mmForPx(10)), false)
          )
      }
    }
  }

  private drawRefGeom(): void {
    this.group.add(this.dimGroup)
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
    for (const c of [...this.preview.children]) {
      this.preview.remove(c)
      ;(c as THREE.Line).geometry.dispose()
    }
    for (const c of [...this.group.children]) {
      if ((c as THREE.Line).isLine) {
        this.group.remove(c)
        ;(c as THREE.Line).geometry.dispose()
      }
    }
    for (let i = 0; i < this.entities.length; i++) {
      const mat = this.selected.includes(i)
        ? this.selMat
        : this.entities[i].construction
          ? this.consMat
          : this.lineMat
      this.group.add(this.entityObj(this.entities[i], mat))
    }
    this.redrawDims()

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
  }

  dispose(): void {
    this.dom.removeEventListener('pointerdown', this.onDown)
    this.dom.removeEventListener('pointermove', this.onMove)
    window.removeEventListener('keydown', this.onKey)
    this.group.removeFromParent()
    this.preview.removeFromParent()
    this.refGroup.removeFromParent()
  }
}
