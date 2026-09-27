/**
 * MoveGizmo - the Move/Copy on-canvas manipulator (Fusion 360's triad):
 * X / Y / Z translate arrows + XY / YZ / XZ plane squares in Translate mode,
 * rotation rings in Rotate mode. Drawn on top of the model at a constant
 * on-screen size.
 *
 * Hand-rolled rather than three's TransformControls so it rides the Viewport's
 * own pointer pipeline (left-button drag never reaches CadControls, which only
 * orbits / pans on middle + right) and works with whichever camera
 * `controls.camera` currently returns (ortho by default). It never moves the
 * bodies itself - a drag reports a world translation or an angle, and the
 * Viewport applies that on top of the dialog's current delta.
 */
import * as THREE from 'three'
import type { MoveGizmoSpec } from '../moveXform'

const AXIS_COLOR: Record<string, number> = { X: 0xe0453a, Y: 0x3cb44b, Z: 0x3a78e0 }
const OTHER_COLOR = 0xffa31a
const HOVER_COLOR = 0xffe14d
/** arrow length on screen, px */
const SIZE_PX = 110

export interface GizmoHandle {
  id: string
  kind: 'arrow' | 'plane' | 'ring'
  /** arrow: its direction; plane: its normal; ring: its rotation axis */
  dir: THREE.Vector3
}

export interface GizmoDragResult {
  handle: GizmoHandle
  /** arrow / plane: world translation since the drag started */
  translate?: THREE.Vector3
  /** ring: degrees since the drag started (right-handed about dir) */
  angle?: number
}

interface Built {
  handle: GizmoHandle
  visuals: THREE.Mesh[]
  pick: THREE.Mesh
  color: number
}

const onTop = (color: number, opacity = 1): THREE.MeshBasicMaterial =>
  new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide
  })

/** invisible but still raycastable (Mesh.raycast ignores material.visible) */
const pickMat = (): THREE.MeshBasicMaterial => {
  const m = new THREE.MeshBasicMaterial()
  m.visible = false
  return m
}

const Z = new THREE.Vector3(0, 0, 1)
const Yup = new THREE.Vector3(0, 1, 0)

export class MoveGizmo {
  readonly root = new THREE.Group()
  private built: Built[] = []
  private sig = ''
  private hovered: string | null = null
  private drag: {
    h: GizmoHandle
    origin: THREE.Vector3
    t0: number
    p0: THREE.Vector3
    lastVec: THREE.Vector3 | null
    angle: number
  } | null = null

  constructor() {
    this.root.visible = false
    this.root.renderOrder = 50
  }

  get active(): boolean {
    return this.root.visible && this.built.length > 0
  }

  /** show / move / hide the triad. Rebuilds geometry only when the handle set
   *  changes - a plain origin change (typing a number) just moves it. */
  set(spec: MoveGizmoSpec | null): void {
    if (!spec) {
      this.root.visible = false
      return
    }
    const sig =
      spec.mode + '|' + (spec.rings ?? []).map((r) => r.id + ':' + r.axis.map((x) => x.toFixed(4)).join(',')).join(';')
    if (sig !== this.sig) {
      this.clear()
      this.sig = sig
      if (spec.mode === 'translate') this.buildTranslate()
      else this.buildRings(spec.rings ?? [])
      this.hovered = null
    }
    this.root.position.set(spec.origin[0], spec.origin[1], spec.origin[2])
    this.root.visible = true
    this.root.updateMatrixWorld(true)
  }

  private clear(): void {
    for (const b of this.built) {
      for (const m of [...b.visuals, b.pick]) {
        m.geometry.dispose()
        ;(m.material as THREE.Material).dispose()
      }
    }
    this.root.clear()
    this.built = []
  }

  private add(handle: GizmoHandle, color: number, visuals: THREE.Mesh[], pick: THREE.Mesh): void {
    const g = new THREE.Group()
    for (const v of visuals) {
      v.renderOrder = 50
      g.add(v)
    }
    pick.userData.gizmoHandle = handle.id
    g.add(pick)
    this.root.add(g)
    this.built.push({ handle, visuals, pick, color })
  }

  private buildTranslate(): void {
    for (const id of ['X', 'Y', 'Z']) {
      const dir = new THREE.Vector3(id === 'X' ? 1 : 0, id === 'Y' ? 1 : 0, id === 'Z' ? 1 : 0)
      const q = new THREE.Quaternion().setFromUnitVectors(Yup, dir)
      const color = AXIS_COLOR[id]
      // cylinder / cone are built along +Y; rotate onto the axis
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.72, 10), onTop(color))
      shaft.position.copy(dir).multiplyScalar(0.18 + 0.36)
      shaft.quaternion.copy(q)
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.2, 16), onTop(color))
      cone.position.copy(dir).multiplyScalar(1.0)
      cone.quaternion.copy(q)
      const pick = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.98, 8), pickMat())
      pick.position.copy(dir).multiplyScalar(0.16 + 0.49)
      pick.quaternion.copy(q)
      this.add({ id, kind: 'arrow', dir }, color, [shaft, cone], pick)
    }
    // plane squares: drag freely within XY / YZ / XZ (coloured by their normal)
    const planes: Array<[string, THREE.Vector3, THREE.Vector3, THREE.Vector3]> = [
      ['XY', new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)],
      ['YZ', new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)],
      ['XZ', new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1)]
    ]
    for (const [id, n, u, w] of planes) {
      const color = AXIS_COLOR[id === 'XY' ? 'Z' : id === 'YZ' ? 'X' : 'Y']
      const centre = u.clone().add(w).multiplyScalar(0.3)
      const basis = new THREE.Matrix4().makeBasis(u, w, n)
      const sq = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.2), onTop(color, 0.45))
      sq.quaternion.setFromRotationMatrix(basis)
      sq.position.copy(centre)
      const pick = new THREE.Mesh(new THREE.PlaneGeometry(0.24, 0.24), pickMat())
      pick.quaternion.copy(sq.quaternion)
      pick.position.copy(centre)
      this.add({ id, kind: 'plane', dir: n.clone() }, color, [sq], pick)
    }
  }

  private buildRings(rings: NonNullable<MoveGizmoSpec['rings']>): void {
    for (const r of rings) {
      const axis = new THREE.Vector3(...r.axis).normalize()
      const q = new THREE.Quaternion().setFromUnitVectors(Z, axis) // torus lies in XY
      const color = AXIS_COLOR[r.id] ?? OTHER_COLOR
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.8, 0.014, 8, 96), onTop(color))
      ring.quaternion.copy(q)
      const pick = new THREE.Mesh(new THREE.TorusGeometry(0.8, 0.07, 6, 48), pickMat())
      pick.quaternion.copy(q)
      this.add({ id: r.id, kind: 'ring', dir: axis }, color, [ring], pick)
    }
  }

  /** keep a constant on-screen size - call every frame */
  updateScale(camera: THREE.Camera, domHeight: number): void {
    if (!this.root.visible || domHeight <= 0) return
    let perPx: number
    if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
      const c = camera as THREE.OrthographicCamera
      perPx = (c.top - c.bottom) / (c.zoom || 1) / domHeight
    } else {
      const c = camera as THREE.PerspectiveCamera
      const dist = c.position.distanceTo(this.root.position) || 1
      perPx = (2 * Math.tan(THREE.MathUtils.degToRad(c.fov) / 2) * dist) / domHeight
    }
    const s = perPx * SIZE_PX
    if (Number.isFinite(s) && s > 0) {
      this.root.scale.setScalar(s)
      this.root.updateMatrixWorld(true)
    }
  }

  /** the handle under a ray, if any */
  pickHandle(ray: THREE.Raycaster): GizmoHandle | null {
    if (!this.active) return null
    this.root.updateMatrixWorld(true)
    const hits = ray.intersectObjects(
      this.built.map((b) => b.pick),
      false
    )
    if (!hits.length) return null
    const id = hits[0].object.userData.gizmoHandle as string
    return this.built.find((b) => b.handle.id === id)?.handle ?? null
  }

  setHover(id: string | null): void {
    if (id === this.hovered) return
    this.hovered = id
    for (const b of this.built) {
      const c = b.handle.id === id ? HOVER_COLOR : b.color
      for (const v of b.visuals) (v.material as THREE.MeshBasicMaterial).color.setHex(c)
    }
  }

  /** world point to grab a handle at (test hook - aim a synthetic pointer) */
  grabPoint(id: string): THREE.Vector3 | null {
    const b = this.built.find((x) => x.handle.id === id)
    if (!b || !this.root.visible) return null
    this.root.updateMatrixWorld(true)
    const s = this.root.scale.x
    const o = this.root.position.clone()
    if (b.handle.kind === 'arrow') return o.addScaledVector(b.handle.dir, 0.8 * s)
    if (b.handle.kind === 'plane') return b.pick.getWorldPosition(new THREE.Vector3())
    // a point on the ring: any direction perpendicular to the axis
    const a = b.handle.dir
    const perp = Math.abs(a.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)
    perp.sub(a.clone().multiplyScalar(perp.dot(a))).normalize()
    return o.addScaledVector(perp, 0.8 * s)
  }

  // ---- drag ----

  /** closest-point parameter along the line (o, d) to a ray */
  private lineParam(o: THREE.Vector3, d: THREE.Vector3, ray: THREE.Ray): number | null {
    const w0 = o.clone().sub(ray.origin)
    const a = d.dot(d)
    const b = d.dot(ray.direction)
    const c = ray.direction.dot(ray.direction)
    const dd = d.dot(w0)
    const e = ray.direction.dot(w0)
    const denom = a * c - b * b
    // axis (nearly) along the view ray - it cannot be dragged meaningfully
    if (Math.abs(denom) < 1e-6) return null
    return (b * e - c * dd) / denom
  }

  private planeHit(o: THREE.Vector3, n: THREE.Vector3, ray: THREE.Ray): THREE.Vector3 | null {
    const pl = new THREE.Plane().setFromNormalAndCoplanarPoint(n, o)
    const out = new THREE.Vector3()
    return ray.intersectPlane(pl, out) ? out : null
  }

  beginDrag(h: GizmoHandle, ray: THREE.Ray): void {
    const origin = this.root.position.clone()
    this.drag = { h, origin, t0: 0, p0: origin.clone(), lastVec: null, angle: 0 }
    if (h.kind === 'arrow') this.drag.t0 = this.lineParam(origin, h.dir, ray) ?? 0
    else if (h.kind === 'plane') this.drag.p0 = this.planeHit(origin, h.dir, ray) ?? origin.clone()
    else {
      const p = this.planeHit(origin, h.dir, ray)
      this.drag.lastVec = p ? p.sub(origin) : null
    }
    this.setHover(h.id)
  }

  get dragging(): boolean {
    return this.drag != null
  }

  /** the drag's total effect so far, or null if this ray gives nothing usable */
  dragTo(ray: THREE.Ray): GizmoDragResult | null {
    const d = this.drag
    if (!d) return null
    if (d.h.kind === 'arrow') {
      const t = this.lineParam(d.origin, d.h.dir, ray)
      if (t == null) return null
      return { handle: d.h, translate: d.h.dir.clone().multiplyScalar(t - d.t0) }
    }
    if (d.h.kind === 'plane') {
      const p = this.planeHit(d.origin, d.h.dir, ray)
      if (!p) return null
      const t = p.sub(d.p0)
      t.sub(d.h.dir.clone().multiplyScalar(t.dot(d.h.dir))) // stay in the plane
      return { handle: d.h, translate: t }
    }
    // ring: accumulate the signed angle swept about the axis, frame by frame,
    // so a drag past 180 degrees keeps counting instead of wrapping
    const p = this.planeHit(d.origin, d.h.dir, ray)
    if (!p) return { handle: d.h, angle: d.angle }
    const v = p.sub(d.origin)
    if (v.lengthSq() < 1e-12) return { handle: d.h, angle: d.angle }
    if (d.lastVec && d.lastVec.lengthSq() > 1e-12) {
      const cross = d.lastVec.clone().cross(v)
      const step = Math.atan2(cross.dot(d.h.dir), d.lastVec.dot(v))
      d.angle += THREE.MathUtils.radToDeg(step)
    }
    d.lastVec = v
    return { handle: d.h, angle: d.angle }
  }

  /** move the triad along with a translate drag (rotate: it stays put) */
  followTranslate(t: THREE.Vector3): void {
    if (!this.drag) return
    this.root.position.copy(this.drag.origin).add(t)
    this.root.updateMatrixWorld(true)
  }

  endDrag(): void {
    this.drag = null
  }

  dispose(): void {
    this.clear()
  }
}
