/**
 * Interactive 2D sketching on a plane inside the 3D viewport.
 *
 * Owns pointer input while a sketch is active: projects the cursor onto the
 * sketch plane, applies grid / endpoint / origin snapping, runs a small state
 * machine per tool, and renders committed + rubber-band geometry in world space.
 * Emits plane-local (u,v mm) entities the sidecar can feed straight to Sketcher.
 */
import * as THREE from 'three'

export type SketchTool = 'select' | 'line' | 'rect' | 'circle' | 'arc'

export interface SketchFrame {
  origin: [number, number, number]
  x: [number, number, number]
  y: [number, number, number]
  z: [number, number, number]
}

export type SketchEntity =
  | { type: 'line'; a: [number, number]; b: [number, number] }
  | { type: 'rect'; a: [number, number]; b: [number, number] }
  | { type: 'circle'; c: [number, number]; r: number }
  | { type: 'arc'; c: [number, number]; r: number; a0: number; a1: number }

const GRID = 1 // mm snap
const SNAP_PX = 12

export class SketchController {
  private group = new THREE.Group()
  private preview = new THREE.Group()
  private plane: THREE.Plane
  private O: THREE.Vector3
  private X: THREE.Vector3
  private Y: THREE.Vector3
  private ray = new THREE.Raycaster()
  private tool: SketchTool = 'line'
  private pending: [number, number][] = []
  private entities: SketchEntity[] = []
  private cursorUV: [number, number] = [0, 0]
  private onChange: () => void

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly dom: HTMLElement,
    frame: SketchFrame,
    root: THREE.Object3D,
    onChange: () => void
  ) {
    this.O = new THREE.Vector3(...frame.origin)
    this.X = new THREE.Vector3(...frame.x).normalize()
    this.Y = new THREE.Vector3(...frame.y).normalize()
    const N = new THREE.Vector3(...frame.z).normalize()
    this.plane = new THREE.Plane().setFromNormalAndCoplanarPoint(N, this.O)
    this.onChange = onChange

    root.add(this.group)
    root.add(this.preview)
    this.addGrid()
    this.redraw()

    this.dom.addEventListener('pointerdown', this.onDown)
    this.dom.addEventListener('pointermove', this.onMove)
    window.addEventListener('keydown', this.onKey)
  }

  setTool(t: SketchTool): void {
    this.tool = t
    this.pending = []
    this.redraw()
  }

  getEntities(): SketchEntity[] {
    return this.entities
  }

  undo(): void {
    if (this.pending.length) this.pending.pop()
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

  private snap(uv: [number, number]): [number, number] {
    const tolMm = SNAP_PX / Math.max(this.pxPerMm(), 0.001)
    // endpoints of existing entities + origin
    const targets: [number, number][] = [[0, 0]]
    for (const e of this.entities) {
      if (e.type === 'line') targets.push(e.a, e.b)
      if (e.type === 'rect') targets.push(e.a, e.b, [e.a[0], e.b[1]], [e.b[0], e.a[1]])
      if (e.type === 'circle') targets.push(e.c)
    }
    for (const p of [...this.pending]) targets.push(p)
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
    return [Math.round(uv[0] / GRID) * GRID, Math.round(uv[1] / GRID) * GRID]
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

  // --- input ---
  private onDown = (ev: PointerEvent): void => {
    if (ev.button !== 0 || this.tool === 'select') return
    ev.stopPropagation()
    const uv = this.pointerUV(ev)
    this.pending.push(uv)
    const need = this.tool === 'arc' ? 3 : 2
    if (this.pending.length >= need) {
      this.commit()
    }
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
    if (this.tool === 'line') {
      this.entities.push({ type: 'line', a: p[0], b: p[1] })
      this.pending = [p[1]] // chain
    } else if (this.tool === 'rect') {
      this.entities.push({ type: 'rect', a: p[0], b: p[1] })
      this.pending = []
    } else if (this.tool === 'circle') {
      const r = Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1])
      this.entities.push({ type: 'circle', c: p[0], r })
      this.pending = []
    } else if (this.tool === 'arc') {
      const c = p[0]
      const r = Math.hypot(p[1][0] - c[0], p[1][1] - c[1])
      const a0 = Math.atan2(p[1][1] - c[1], p[1][0] - c[0])
      const a1 = Math.atan2(p[2][1] - c[1], p[2][0] - c[0])
      this.entities.push({ type: 'arc', c, r, a0, a1 })
      this.pending = []
    }
    this.onChange()
  }

  // --- rendering ---
  private lineMat = new THREE.LineBasicMaterial({ color: 0x36a8ea })
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
      return this.polyToObj(
        [e.a, [e.b[0], e.a[1]], e.b, [e.a[0], e.b[1]]],
        mat,
        true
      )
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

  private redraw(): void {
    for (const c of [...this.preview.children]) {
      this.preview.remove(c)
      ;(c as THREE.Line).geometry.dispose()
    }
    // committed
    for (const c of [...this.group.children]) {
      if ((c as THREE.Line).isLine) {
        this.group.remove(c)
        ;(c as THREE.Line).geometry.dispose()
      }
    }
    for (const e of this.entities) this.group.add(this.entityObj(e, this.lineMat))

    // rubber band from pending + cursor
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
        this.preview.add(
          this.entityObj({ type: 'circle', c, r }, this.previewMat)
        )
      }
    }
  }

  dispose(): void {
    this.dom.removeEventListener('pointerdown', this.onDown)
    this.dom.removeEventListener('pointermove', this.onMove)
    window.removeEventListener('keydown', this.onKey)
    this.group.removeFromParent()
    this.preview.removeFromParent()
  }
}
