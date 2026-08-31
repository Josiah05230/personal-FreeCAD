/**
 * ViewCube - the orientation gizmo in the top-right corner.
 *
 * Own small canvas/scene/camera; rotation slaved to the main camera each frame.
 * 26 pick zones (6 faces, 12 edges, 8 corners) like Fusion's cube: hover
 * highlights the zone under the cursor, click snaps to that direction,
 * right-click a face offers Set as Front/Top/Right. Drag orbits the main view.
 */
import * as THREE from 'three'
import type { CadControls } from './CadControls'

const FACE_KEYS = ['1,0,0', '-1,0,0', '0,1,0', '0,-1,0', '0,0,1', '0,0,-1'] as const
const LABELS: Record<string, string> = {
  '0,0,1': 'TOP',
  '0,0,-1': 'BOT',
  '0,-1,0': 'FRONT',
  '0,1,0': 'BACK',
  '1,0,0': 'RIGHT',
  '-1,0,0': 'LEFT'
}
const S = 1.6 // cube half-extent * 2 (side length)
const H = S / 2

function faceFillTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')!
  g.fillStyle = '#e9ebee'
  g.fillRect(0, 0, 128, 128)
  g.strokeStyle = '#b7bcc3'
  g.lineWidth = 4
  g.strokeRect(4, 4, 120, 120)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

/** Just the label text on transparent, upright. Orientation is handled by the
 *  quad's own quaternion, not the box UVs - so every face reads relative to the
 *  FRONT face. */
function labelTexture(text: string): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')!
  g.fillStyle = '#333941'
  g.font = '600 19px "Segoe UI", system-ui, sans-serif'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(text, 64, 66)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 4
  return t
}

export class ViewCube {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private cam: THREE.OrthographicCamera
  private cube: THREE.Group
  private zones: THREE.Mesh[] = []
  private ray = new THREE.Raycaster()
  private dragging = false
  private lastX = 0
  private lastY = 0
  private moved = 0
  private hot: THREE.Mesh | null = null
  private menuEl: HTMLDivElement | null = null
  private tween: { from: THREE.Vector3; to: THREE.Vector3; up: THREE.Vector3; t: number } | null =
    null
  private disposed = false
  /** maps cube-label space -> world space; "Set as Front/Top/Right" rewrites it */
  private frameQuat = new THREE.Quaternion()

  constructor(
    private readonly mount: HTMLElement,
    private readonly mainCam: THREE.PerspectiveCamera,
    private readonly controls: CadControls
  ) {
    const size = Math.max(mount.clientWidth || 150, 96)
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(size, size)
    mount.appendChild(this.renderer.domElement)

    this.cam = new THREE.OrthographicCamera(-1.9, 1.9, 1.9, -1.9, 0.1, 20)
    this.cam.position.set(0, 0, 6)
    this.cam.up.set(0, 1, 0)
    this.cam.lookAt(0, 0, 0)

    this.cube = new THREE.Group()
    this.scene.add(this.cube)

    // plain shaded box + border
    const fill = faceFillTexture()
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(S, S, S),
      new THREE.MeshBasicMaterial({ map: fill })
    )
    this.cube.add(box)
    this.cube.add(
      new THREE.LineSegments(
        new THREE.EdgesGeometry(box.geometry),
        new THREE.LineBasicMaterial({ color: 0x8a9099 })
      )
    )

    // label quads: one per face, oriented so its "up" is world +Z for the side
    // faces (and toward BACK / FRONT for top / bottom), i.e. relative to FRONT
    const labelGeo = new THREE.PlaneGeometry(S * 0.94, S * 0.94)
    for (const k of FACE_KEYS) {
      const d = k.split(',').map(Number) as [number, number, number]
      const normal = new THREE.Vector3(...d)
      const up =
        d[2] === 0
          ? new THREE.Vector3(0, 0, 1)
          : d[2] > 0
            ? new THREE.Vector3(0, 1, 0)
            : new THREE.Vector3(0, -1, 0)
      const xAxis = new THREE.Vector3().crossVectors(up, normal).normalize()
      const yAxis = new THREE.Vector3().crossVectors(normal, xAxis).normalize()
      const label = new THREE.Mesh(
        labelGeo,
        new THREE.MeshBasicMaterial({
          map: labelTexture(LABELS[k]),
          transparent: true,
          depthWrite: false
        })
      )
      label.quaternion.setFromRotationMatrix(
        new THREE.Matrix4().makeBasis(xAxis, yAxis, normal)
      )
      label.position.copy(normal).multiplyScalar(H + 0.007)
      label.renderOrder = 2
      this.cube.add(label)
    }

    this.buildZones()

    const el = this.renderer.domElement
    el.style.cursor = 'pointer'
    el.addEventListener('pointerdown', this.onDown)
    el.addEventListener('pointermove', this.onMove)
    el.addEventListener('pointerleave', this.onLeave)
    el.addEventListener('contextmenu', this.onContext)
    window.addEventListener('pointerup', this.onUp)
  }

  /** 6 faces + 12 edges + 8 corners, each a thin pick zone tagged with a dir. */
  private buildZones(): void {
    const T = 0.34 // zone thickness at edges/corners
    const add = (
      geo: THREE.BoxGeometry,
      pos: [number, number, number],
      dir: [number, number, number],
      kind: string
    ): void => {
      const m = new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({ color: 0x2f9fe0, transparent: true, opacity: 0 })
      )
      m.position.set(...pos)
      m.userData = { dir: new THREE.Vector3(...dir).normalize(), kind }
      this.cube.add(m)
      this.zones.push(m)
    }
    const faceGeo = new THREE.BoxGeometry(S - 2 * T, S - 2 * T, 0.02)
    for (const ax of [0, 1, 2]) {
      for (const s of [1, -1]) {
        const d: [number, number, number] = [0, 0, 0]
        d[ax] = s
        const g = faceGeo.clone()
        if (ax === 0) g.rotateY(Math.PI / 2)
        if (ax === 1) g.rotateX(Math.PI / 2)
        add(g, [d[0] * H, d[1] * H, d[2] * H], d, 'face')
      }
    }
    // edges: for each pair of axes, 4 combinations of signs
    for (let a = 0; a < 3; a++) {
      for (let b = a + 1; b < 3; b++) {
        const c = 3 - a - b
        for (const sa of [1, -1]) {
          for (const sb of [1, -1]) {
            const d: [number, number, number] = [0, 0, 0]
            d[a] = sa
            d[b] = sb
            const dims: [number, number, number] = [T, T, T]
            dims[c] = S - 2 * T
            add(
              new THREE.BoxGeometry(...dims),
              [d[0] * H, d[1] * H, d[2] * H],
              d,
              'edge'
            )
          }
        }
      }
    }
    // corners
    for (const sx of [1, -1])
      for (const sy of [1, -1])
        for (const sz of [1, -1])
          add(
            new THREE.BoxGeometry(T, T, T),
            [sx * H, sy * H, sz * H],
            [sx, sy, sz],
            'corner'
          )
  }

  private ndc(e: PointerEvent | MouseEvent): THREE.Vector2 {
    const r = this.renderer.domElement.getBoundingClientRect()
    return new THREE.Vector2(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1
    )
  }

  private zoneUnder(e: PointerEvent | MouseEvent): THREE.Mesh | null {
    this.ray.setFromCamera(this.ndc(e), this.cam)
    const hits = this.ray.intersectObjects(this.zones, false)
    return hits.length ? (hits[0].object as THREE.Mesh) : null
  }

  private setHot(z: THREE.Mesh | null): void {
    if (z === this.hot) return
    if (this.hot) (this.hot.material as THREE.MeshBasicMaterial).opacity = 0
    if (z) (z.material as THREE.MeshBasicMaterial).opacity = 0.38
    this.hot = z
  }

  private onDown = (e: PointerEvent): void => {
    if (e.button !== 0) return
    this.dragging = true
    this.moved = 0
    this.lastX = e.clientX
    this.lastY = e.clientY
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    this.closeMenu()
  }

  private onMove = (e: PointerEvent): void => {
    if (this.dragging) {
      const dx = e.clientX - this.lastX
      const dy = e.clientY - this.lastY
      this.lastX = e.clientX
      this.lastY = e.clientY
      this.moved += Math.abs(dx) + Math.abs(dy)
      this.controls.applyOrbit(-dx * 0.01, -dy * 0.01)
    } else {
      this.setHot(this.zoneUnder(e))
    }
  }

  private onLeave = (): void => this.setHot(null)

  private onUp = (e: PointerEvent): void => {
    if (!this.dragging) return
    this.dragging = false
    try {
      ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      /* not captured */
    }
    if (this.moved < 4) {
      const z = this.zoneUnder(e)
      if (z) this.goToView((z.userData.dir as THREE.Vector3).clone())
    }
  }

  private onContext = (e: MouseEvent): void => {
    e.preventDefault()
    const z = this.zoneUnder(e)
    if (!z || z.userData.kind !== 'face') return
    this.openMenu(e.clientX, e.clientY, (z.userData.dir as THREE.Vector3).clone())
  }

  /** Rotate the frame so the picked face ends up pointing `target` (label space). */
  private reorient(faceLocalDir: THREE.Vector3, target: THREE.Vector3): void {
    const cur = faceLocalDir.clone().applyQuaternion(this.frameQuat).normalize()
    const delta = new THREE.Quaternion().setFromUnitVectors(cur, target.clone().normalize())
    this.frameQuat.premultiply(delta)
    // fly to look straight at that face in its new place
    this.goToView(target.clone())
  }

  private openMenu(x: number, y: number, faceDir: THREE.Vector3): void {
    this.closeMenu()
    const host = this.mount.offsetParent instanceof HTMLElement ? this.mount.offsetParent : document.body
    const div = document.createElement('div')
    div.className = 'viewcube-menu'
    const hostRect = host.getBoundingClientRect()
    div.style.left = `${x - hostRect.left}px`
    div.style.top = `${y - hostRect.top}px`
    const actions: [string, () => void][] = [
      ['Set as Front', () => this.reorient(faceDir, new THREE.Vector3(0, -1, 0))],
      ['Set as Top', () => this.reorient(faceDir, new THREE.Vector3(0, 0, 1))],
      ['Set as Right', () => this.reorient(faceDir, new THREE.Vector3(1, 0, 0))],
      ['Reset orientation', () => {
        this.frameQuat.identity()
        this.home()
      }],
      ['Home', () => this.home()]
    ]
    for (const [label, run] of actions) {
      const item = document.createElement('div')
      item.className = 'viewcube-menu-item'
      item.textContent = label
      item.onclick = () => {
        run()
        this.closeMenu()
      }
      div.appendChild(item)
    }
    host.appendChild(div)
    this.menuEl = div
    setTimeout(() => window.addEventListener('pointerdown', this.closeMenuOnce), 0)
  }

  private closeMenuOnce = (): void => this.closeMenu()
  private closeMenu(): void {
    window.removeEventListener('pointerdown', this.closeMenuOnce)
    this.menuEl?.remove()
    this.menuEl = null
  }

  home(): void {
    this.goToView(new THREE.Vector3(1, -1, 0.8))
  }

  goToView(dir: THREE.Vector3): void {
    // a named view resets any 90-degree screen roll
    this.controls.resetRoll()
    // dir is in cube-label space; map it through the (possibly reoriented) frame
    const d = dir.clone().normalize().applyQuaternion(this.frameQuat).normalize()
    const pivot = this.controls.pivot
    const dist = this.mainCam.position.distanceTo(pivot)
    const to = pivot.clone().addScaledVector(d, dist)
    const upLabel = Math.abs(dir.z) > 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1)
    const up = upLabel.applyQuaternion(this.frameQuat).normalize()
    this.tween = { from: this.mainCam.position.clone(), to, up, t: 0 }
  }

  update(dt: number): void {
    if (this.disposed) return
    if (this.tween) {
      this.tween.t = Math.min(1, this.tween.t + dt / 0.25)
      const t = this.tween.t
      const k = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
      this.mainCam.position.lerpVectors(this.tween.from, this.tween.to, k)
      this.mainCam.up.lerp(this.tween.up, k).normalize()
      this.mainCam.lookAt(this.controls.pivot)
      if (this.tween.t >= 1) this.tween = null
    }
    // cube shows the model frame: camera orientation, then the reorientation
    this.cube.quaternion.copy(this.mainCam.quaternion).invert().multiply(this.frameQuat)
    this.renderer.render(this.scene, this.cam)
  }

  dispose(): void {
    this.disposed = true
    this.closeMenu()
    const el = this.renderer.domElement
    el.removeEventListener('pointerdown', this.onDown)
    el.removeEventListener('pointermove', this.onMove)
    el.removeEventListener('pointerleave', this.onLeave)
    el.removeEventListener('contextmenu', this.onContext)
    window.removeEventListener('pointerup', this.onUp)
    this.renderer.dispose()
    el.remove()
  }
}
