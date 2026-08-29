/**
 * CadControls - a Fusion-360-style camera controller.
 *
 * This is deliberately hand-written rather than three's OrbitControls: matching
 * Fusion's feel is the whole point of the project, so every curve here (inertia
 * decay, zoom-to-cursor, constrained orbit) is a knob we own.
 *
 * Default mouse map (Fusion "Fusion" preset):
 *   - Middle drag ............ pan
 *   - Shift + middle drag .... orbit
 *   - Wheel .................. dolly, zoomed toward the cursor
 *
 * Orbit is "constrained": world up (+Z) stays vertical, pitch clamped just shy
 * of the poles, so the horizon never rolls. Momentum continues briefly on
 * release and decays exponentially.
 */
import * as THREE from 'three'

const UP = new THREE.Vector3(0, 0, 1)
const PITCH_LIMIT = THREE.MathUtils.degToRad(89.5)

type Mode = 'none' | 'pan' | 'orbit'

export interface CadControlsOptions {
  orbitSpeed?: number
  panSpeed?: number
  zoomStep?: number
  inertiaDamping?: number // per-frame multiplier for leftover velocity (0..1)
}

export class CadControls {
  pivot = new THREE.Vector3()

  private mode: Mode = 'none'
  private lastX = 0
  private lastY = 0
  private orbitVel = new THREE.Vector2() // yaw, pitch radians/frame
  private panVel = new THREE.Vector3()
  private readonly opts: Required<CadControlsOptions>
  private disposed = false

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly dom: HTMLElement,
    options: CadControlsOptions = {}
  ) {
    this.opts = {
      orbitSpeed: options.orbitSpeed ?? 0.0075,
      panSpeed: options.panSpeed ?? 1,
      zoomStep: options.zoomStep ?? 0.0015,
      inertiaDamping: options.inertiaDamping ?? 0.82
    }
    this.camera.up.copy(UP)
    this.dom.addEventListener('pointerdown', this.onPointerDown)
    this.dom.addEventListener('pointermove', this.onPointerMove)
    window.addEventListener('pointerup', this.onPointerUp)
    this.dom.addEventListener('wheel', this.onWheel, { passive: false })
    this.dom.addEventListener('contextmenu', this.onContextMenu)
  }

  /** Frame the camera on a bounding sphere. */
  frame(center: THREE.Vector3, radius: number): void {
    this.pivot.copy(center)
    const dir = new THREE.Vector3(1, -1, 0.7).normalize()
    const dist = radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov * 0.5))
    this.camera.position.copy(center).addScaledVector(dir, dist * 1.15)
    this.camera.lookAt(center)
    this.camera.near = Math.max(radius / 500, 0.01)
    this.camera.far = radius * 200
    this.camera.updateProjectionMatrix()
  }

  private onContextMenu = (e: Event) => e.preventDefault()

  private onPointerDown = (e: PointerEvent) => {
    if (e.button !== 1) return // middle only for now
    e.preventDefault()
    this.mode = e.shiftKey ? 'orbit' : 'pan'
    this.lastX = e.clientX
    this.lastY = e.clientY
    this.orbitVel.set(0, 0)
    this.panVel.set(0, 0, 0)
    this.dom.setPointerCapture(e.pointerId)
  }

  private onPointerMove = (e: PointerEvent) => {
    if (this.mode === 'none') return
    const dx = e.clientX - this.lastX
    const dy = e.clientY - this.lastY
    this.lastX = e.clientX
    this.lastY = e.clientY
    if (this.mode === 'orbit') {
      const yaw = -dx * this.opts.orbitSpeed
      const pitch = -dy * this.opts.orbitSpeed
      this.applyOrbit(yaw, pitch)
      this.orbitVel.set(yaw, pitch)
    } else {
      const delta = this.panDelta(dx, dy)
      this.camera.position.add(delta)
      this.pivot.add(delta)
      this.panVel.copy(delta)
    }
  }

  private onPointerUp = (e: PointerEvent) => {
    if (this.mode === 'none') return
    this.mode = 'none'
    try {
      this.dom.releasePointerCapture(e.pointerId)
    } catch {
      /* capture may not be held */
    }
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault()
    const rect = this.dom.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    )
    // point under the cursor, at the pivot's depth
    const ray = new THREE.Raycaster()
    ray.setFromCamera(ndc, this.camera)
    const planeN = this.camera.getWorldDirection(new THREE.Vector3())
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(planeN, this.pivot)
    const hit = new THREE.Vector3()
    if (!ray.ray.intersectPlane(plane, hit)) return

    const factor = Math.exp(e.deltaY * this.opts.zoomStep)
    this.camera.position.sub(hit).multiplyScalar(factor).add(hit)
    this.pivot.sub(hit).multiplyScalar(factor).add(hit)
  }

  /** Public so the ViewCube can drive the exact same orbit path. */
  applyOrbit(yaw: number, pitch: number): void {
    const offset = this.camera.position.clone().sub(this.pivot)
    const radius = offset.length()
    const cur = new THREE.Spherical().setFromVector3(
      new THREE.Vector3(offset.x, offset.z, -offset.y) // convert Z-up -> spherical's Y-up
    )
    cur.theta += yaw
    cur.phi = THREE.MathUtils.clamp(
      cur.phi + pitch,
      Math.PI / 2 - PITCH_LIMIT,
      Math.PI / 2 + PITCH_LIMIT
    )
    cur.radius = radius
    const v = new THREE.Vector3().setFromSpherical(cur)
    const back = new THREE.Vector3(v.x, -v.z, v.y) // spherical Y-up -> Z-up
    this.camera.position.copy(this.pivot).add(back)
    this.camera.up.copy(UP)
    this.camera.lookAt(this.pivot)
  }

  private panDelta(dx: number, dy: number): THREE.Vector3 {
    const dist = this.camera.position.distanceTo(this.pivot)
    const vFov = THREE.MathUtils.degToRad(this.camera.fov)
    const worldPerPx = (2 * Math.tan(vFov / 2) * dist) / this.dom.clientHeight
    const right = new THREE.Vector3()
      .setFromMatrixColumn(this.camera.matrix, 0)
      .normalize()
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1).normalize()
    return right
      .multiplyScalar(-dx * worldPerPx * this.opts.panSpeed)
      .addScaledVector(up, dy * worldPerPx * this.opts.panSpeed)
  }

  /** Call once per animation frame. Applies leftover momentum. */
  update(): void {
    if (this.disposed || this.mode !== 'none') return
    const d = this.opts.inertiaDamping
    if (this.orbitVel.lengthSq() > 1e-9) {
      this.applyOrbit(this.orbitVel.x, this.orbitVel.y)
      this.orbitVel.multiplyScalar(d)
    }
    if (this.panVel.lengthSq() > 1e-9) {
      this.camera.position.add(this.panVel)
      this.pivot.add(this.panVel)
      this.panVel.multiplyScalar(d)
    }
  }

  dispose(): void {
    this.disposed = true
    this.dom.removeEventListener('pointerdown', this.onPointerDown)
    this.dom.removeEventListener('pointermove', this.onPointerMove)
    window.removeEventListener('pointerup', this.onPointerUp)
    this.dom.removeEventListener('wheel', this.onWheel)
    this.dom.removeEventListener('contextmenu', this.onContextMenu)
  }
}
