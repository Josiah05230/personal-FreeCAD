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
 *   - Right drag ............. orbit (no modifier needed)
 *   - Wheel .................. dolly, zoomed toward the cursor
 *
 * Orbit is a constrained turntable, like Fusion's default: horizontal drags spin
 * about world +Z, vertical drags change elevation and stop just short of the
 * poles so the view never rolls or flips. The camera up stays world +Z, which
 * keeps the motion rock-steady (the old free-tumble version drifted roll and
 * spazzed near the poles). A short exponential momentum continues on release.
 */
import * as THREE from 'three'

const UP = new THREE.Vector3(0, 0, 1)

type Mode = 'none' | 'pan' | 'orbit'

export interface CadControlsOptions {
  orbitSpeed?: number
  panSpeed?: number
  zoomStep?: number
  inertiaDamping?: number // per-frame multiplier for leftover velocity (0..1)
}

export type Projection = 'perspective' | 'orthographic'

export class CadControls {
  pivot = new THREE.Vector3()

  /** the perspective camera - the pose source of truth even in ortho mode */
  readonly persp: THREE.PerspectiveCamera
  /** the orthographic camera, kept synced to persp's pose every frame */
  readonly ortho: THREE.OrthographicCamera
  private projection: Projection = 'orthographic'

  private mode: Mode = 'none'
  private lastX = 0
  private lastY = 0
  private orbitVel = new THREE.Vector2() // yaw, pitch radians/frame
  private panVel = new THREE.Vector3()
  private rollAngle = 0 // persistent screen-roll (the view-cube 90 arrows)
  private readonly opts: Required<CadControlsOptions>
  private disposed = false

  constructor(
    persp: THREE.PerspectiveCamera,
    private readonly dom: HTMLElement,
    options: CadControlsOptions = {}
  ) {
    this.persp = persp
    const aspect = persp.aspect || 1
    // a matching ortho: half-height chosen in syncOrtho() from the pivot distance
    this.ortho = new THREE.OrthographicCamera(-aspect, aspect, 1, -1, persp.near, persp.far)
    this.ortho.up.copy(UP)
    this.opts = {
      orbitSpeed: options.orbitSpeed ?? 0.006,
      panSpeed: options.panSpeed ?? 1,
      zoomStep: options.zoomStep ?? 0.0015,
      inertiaDamping: options.inertiaDamping ?? 0.74
    }
    this.persp.up.copy(UP)
    this.syncOrtho()
    this.dom.addEventListener('pointerdown', this.onPointerDown)
    this.dom.addEventListener('pointermove', this.onPointerMove)
    window.addEventListener('pointerup', this.onPointerUp)
    this.dom.addEventListener('wheel', this.onWheel, { passive: false })
    this.dom.addEventListener('contextmenu', this.onContextMenu)
  }

  /** the camera to render / pick / slave the view-cube with */
  get camera(): THREE.PerspectiveCamera | THREE.OrthographicCamera {
    return this.projection === 'orthographic' ? this.ortho : this.persp
  }

  getProjection(): Projection {
    return this.projection
  }

  setProjection(p: Projection): void {
    if (p === this.projection) return
    this.projection = p
    this.syncOrtho()
  }

  toggleProjection(): Projection {
    this.setProjection(this.projection === 'orthographic' ? 'perspective' : 'orthographic')
    return this.projection
  }

  /** Copy the perspective camera's pose onto the ortho camera and size its
   *  frustum so, at the pivot's depth, it shows the same extent the
   *  perspective camera does. Called whenever the pose or viewport changes. */
  syncOrtho(): void {
    const o = this.ortho
    o.position.copy(this.persp.position)
    o.quaternion.copy(this.persp.quaternion)
    o.up.copy(this.persp.up)
    const dist = this.persp.position.distanceTo(this.pivot) || 1
    const halfH = Math.tan(THREE.MathUtils.degToRad(this.persp.fov) / 2) * dist
    const halfW = halfH * (this.persp.aspect || 1)
    o.left = -halfW
    o.right = halfW
    o.top = halfH
    o.bottom = -halfH
    o.near = -this.persp.far
    o.far = this.persp.far
    o.updateProjectionMatrix()
  }

  /** react to a canvas resize */
  setAspect(aspect: number): void {
    this.persp.aspect = aspect
    this.persp.updateProjectionMatrix()
    this.syncOrtho()
  }

  /** Frame the camera on a bounding sphere. */
  frame(centerIn: THREE.Vector3, radiusIn: number): void {
    // never let a NaN / degenerate frame strand the camera (blank viewport)
    const bad =
      !Number.isFinite(centerIn.x) ||
      !Number.isFinite(centerIn.y) ||
      !Number.isFinite(centerIn.z) ||
      !Number.isFinite(radiusIn) ||
      radiusIn <= 0
    const center = bad ? new THREE.Vector3() : centerIn
    const radius = bad ? 60 : radiusIn
    this.pivot.copy(center)
    this.rollAngle = 0
    const dir = new THREE.Vector3(1, -1, 0.7).normalize()
    const dist = radius / Math.sin(THREE.MathUtils.degToRad(this.persp.fov * 0.5))
    this.persp.position.copy(center).addScaledVector(dir, dist * 1.15)
    this.persp.up.copy(UP)
    this.persp.lookAt(center)
    this.persp.near = Math.max(radius / 500, 0.01)
    this.persp.far = radius * 200
    this.persp.updateProjectionMatrix()
    // do not wait for the next animation frame to pick this up - in
    // orthographic mode (the default) that is the camera actually rendered,
    // so a caller reading it back (or a frame that never ticks, e.g. an
    // unfocused/throttled window) must not see a stale pose
    this.syncOrtho()
  }

  private onContextMenu = (e: Event) => e.preventDefault()

  private onPointerDown = (e: PointerEvent) => {
    if (e.button === 1) this.mode = e.shiftKey ? 'orbit' : 'pan'
    else if (e.button === 2) this.mode = 'orbit' // right drag orbits, no modifier
    else return
    e.preventDefault()
    this.lastX = e.clientX
    this.lastY = e.clientY
    this.orbitVel.set(0, 0)
    this.panVel.set(0, 0, 0)
    try {
      this.dom.setPointerCapture(e.pointerId)
    } catch {
      /* ignore - e.g. a synthetic PointerEvent with no real active pointer */
    }
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
      this.persp.position.add(delta)
      this.pivot.add(delta)
      this.panVel.copy(delta)
      this.syncOrtho() // see frame()'s comment - do not wait on the next rAF tick
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
    ray.setFromCamera(ndc, this.persp)
    const planeN = this.persp.getWorldDirection(new THREE.Vector3())
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(planeN, this.pivot)
    const hit = new THREE.Vector3()
    if (!ray.ray.intersectPlane(plane, hit)) return

    const factor = Math.exp(e.deltaY * this.opts.zoomStep)
    this.persp.position.sub(hit).multiplyScalar(factor).add(hit)
    this.pivot.sub(hit).multiplyScalar(factor).add(hit)
    // ortho's frustum size is derived from persp's distance to the pivot
    // (see syncOrtho) - without this, zooming while in ortho mode (the
    // default) would visibly do nothing until the next animation frame
    this.syncOrtho()
  }

  /**
   * Constrained turntable orbit. Yaw spins the camera about world +Z (horizon
   * stays level); pitch changes elevation and is clamped just shy of both poles
   * so the view can never roll or snap over. Camera up is pinned to world +Z,
   * which is what makes this steady. Public so the ViewCube drives the same path.
   */
  private static readonly POLE = 0.03 // rad kept clear of each pole (~1.7 deg)

  applyOrbit(yaw: number, pitch: number): void {
    const offset = this.persp.position.clone().sub(this.pivot)
    const radius = offset.length()
    if (radius < 1e-6) return

    let azim = Math.atan2(offset.y, offset.x)
    let polar = Math.acos(THREE.MathUtils.clamp(offset.z / radius, -1, 1))
    azim += yaw
    polar = THREE.MathUtils.clamp(
      polar + pitch,
      CadControls.POLE,
      Math.PI - CadControls.POLE
    )
    const sp = Math.sin(polar)
    offset.set(radius * sp * Math.cos(azim), radius * sp * Math.sin(azim), radius * Math.cos(polar))

    this.persp.position.copy(this.pivot).add(offset)
    this.applyUp()
    this.syncOrtho() // see frame()'s comment - do not wait on the next rAF tick
  }

  /** Set camera.up to world +Z rolled by rollAngle about the view axis, then aim. */
  private applyUp(): void {
    const view = new THREE.Vector3().subVectors(this.pivot, this.persp.position).normalize()
    const up = UP.clone()
    if (Math.abs(up.dot(view)) > 0.999) up.set(0, 1, 0) // looking straight up/down
    if (this.rollAngle) up.applyAxisAngle(view, this.rollAngle)
    this.persp.up.copy(up).normalize()
    this.persp.lookAt(this.pivot)
  }

  /** View-cube 90-degree roll arrows: same view direction, rotated on screen. */
  roll(quarterTurns: 1 | -1): void {
    this.rollAngle += (quarterTurns * Math.PI) / 2
    const twoPi = Math.PI * 2
    this.rollAngle = ((this.rollAngle % twoPi) + twoPi) % twoPi
    this.applyUp()
  }

  resetRoll(): void {
    this.rollAngle = 0
  }

  private panDelta(dx: number, dy: number): THREE.Vector3 {
    const dist = this.persp.position.distanceTo(this.pivot)
    const vFov = THREE.MathUtils.degToRad(this.persp.fov)
    const worldPerPx = (2 * Math.tan(vFov / 2) * dist) / this.dom.clientHeight
    const right = new THREE.Vector3()
      .setFromMatrixColumn(this.persp.matrix, 0)
      .normalize()
    const up = new THREE.Vector3().setFromMatrixColumn(this.persp.matrix, 1).normalize()
    return right
      .multiplyScalar(-dx * worldPerPx * this.opts.panSpeed)
      .addScaledVector(up, dy * worldPerPx * this.opts.panSpeed)
  }

  /** Call once per animation frame. Applies leftover momentum. */
  update(): void {
    if (this.disposed) return
    if (this.mode === 'none') {
      const d = this.opts.inertiaDamping
      if (this.orbitVel.lengthSq() > 4e-6) {
        this.applyOrbit(this.orbitVel.x, this.orbitVel.y)
        this.orbitVel.multiplyScalar(d)
      } else {
        this.orbitVel.set(0, 0)
      }
      if (this.panVel.lengthSq() > 1e-9) {
        this.persp.position.add(this.panVel)
        this.pivot.add(this.panVel)
        this.panVel.multiplyScalar(d)
      }
    }
    // keep the ortho camera glued to the perspective pose + framing every frame
    // (cheap; a few vector copies + one matrix update) so a projection switch is
    // instant and orbit / pan / zoom feel identical in both modes
    this.syncOrtho()
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
