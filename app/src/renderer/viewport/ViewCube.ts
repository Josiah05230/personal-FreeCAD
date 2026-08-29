/**
 * ViewCube - the orientation gizmo in the top-right corner.
 *
 * Own small canvas, own scene/camera; its rotation is slaved to the main camera
 * every frame. Hover highlights the face under the cursor. Click snaps to that
 * view; right-click offers "set as Front / Top / Right". Drag orbits the main
 * view with the identical feel.
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

function faceTexture(text: string, hot = false): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')!
  g.fillStyle = hot ? '#cfe6fa' : '#e9ebee'
  g.fillRect(0, 0, 128, 128)
  g.strokeStyle = hot ? '#2f9fe0' : '#b7bcc3'
  g.lineWidth = hot ? 8 : 4
  g.strokeRect(4, 4, 120, 120)
  g.fillStyle = '#333941'
  g.font = '600 19px "Segoe UI", system-ui, sans-serif'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(text, 64, 68)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 4
  return t
}

export class ViewCube {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private cam: THREE.OrthographicCamera
  private cube: THREE.Mesh
  private mats: THREE.MeshBasicMaterial[]
  private texNormal: THREE.CanvasTexture[]
  private texHot: THREE.CanvasTexture[]
  private ray = new THREE.Raycaster()
  private dragging = false
  private lastX = 0
  private lastY = 0
  private moved = 0
  private hotFace = -1
  private menuEl: HTMLDivElement | null = null
  private tween: { from: THREE.Vector3; to: THREE.Vector3; up: THREE.Vector3; t: number } | null =
    null
  private disposed = false

  constructor(
    private readonly mount: HTMLElement,
    private readonly mainCam: THREE.PerspectiveCamera,
    private readonly controls: CadControls
  ) {
    const size = Math.max(mount.clientWidth || 132, 96)
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(size, size)
    mount.appendChild(this.renderer.domElement)

    this.cam = new THREE.OrthographicCamera(-1.75, 1.75, 1.75, -1.75, 0.1, 20)
    this.cam.position.set(0, 0, 6)
    this.cam.up.set(0, 1, 0)
    this.cam.lookAt(0, 0, 0)

    this.texNormal = FACE_KEYS.map((k) => faceTexture(LABELS[k], false))
    this.texHot = FACE_KEYS.map((k) => faceTexture(LABELS[k], true))
    this.mats = this.texNormal.map((t) => new THREE.MeshBasicMaterial({ map: t }))
    this.cube = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.6, 1.6), this.mats)
    this.scene.add(this.cube)
    this.cube.add(
      new THREE.LineSegments(
        new THREE.EdgesGeometry(this.cube.geometry),
        new THREE.LineBasicMaterial({ color: 0x8a9099 })
      )
    )

    const el = this.renderer.domElement
    el.style.cursor = 'pointer'
    el.addEventListener('pointerdown', this.onDown)
    el.addEventListener('pointermove', this.onMove)
    el.addEventListener('pointerleave', this.onLeave)
    el.addEventListener('contextmenu', this.onContext)
    window.addEventListener('pointerup', this.onUp)
  }

  private ndc(e: PointerEvent | MouseEvent): THREE.Vector2 {
    const r = this.renderer.domElement.getBoundingClientRect()
    return new THREE.Vector2(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1
    )
  }

  private faceUnder(e: PointerEvent | MouseEvent): number {
    this.ray.setFromCamera(this.ndc(e), this.cam)
    const hit = this.ray.intersectObject(this.cube, false)[0]
    return hit && hit.face ? Math.floor(hit.faceIndex! / 2) : -1
  }

  private dirForFace(fi: number): THREE.Vector3 {
    const [x, y, z] = FACE_KEYS[fi].split(',').map(Number)
    return new THREE.Vector3(x, y, z)
  }

  private setHot(fi: number): void {
    if (fi === this.hotFace) return
    if (this.hotFace >= 0) this.mats[this.hotFace].map = this.texNormal[this.hotFace]
    if (fi >= 0) this.mats[fi].map = this.texHot[fi]
    for (const m of this.mats) m.needsUpdate = true
    this.hotFace = fi
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
      this.setHot(this.faceUnder(e))
    }
  }

  private onLeave = (): void => this.setHot(-1)

  private onUp = (e: PointerEvent): void => {
    if (!this.dragging) return
    this.dragging = false
    try {
      ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      /* not captured */
    }
    if (this.moved < 4) {
      const fi = this.faceUnder(e)
      if (fi >= 0) this.goToView(this.dirForFace(fi))
    }
  }

  private onContext = (e: MouseEvent): void => {
    e.preventDefault()
    const fi = this.faceUnder(e)
    if (fi < 0) return
    this.openMenu(e.clientX, e.clientY, fi)
  }

  private openMenu(x: number, y: number, fi: number): void {
    this.closeMenu()
    const host = this.mount.offsetParent instanceof HTMLElement ? this.mount.offsetParent : document.body
    const div = document.createElement('div')
    div.className = 'viewcube-menu'
    const hostRect = host.getBoundingClientRect()
    div.style.left = `${x - hostRect.left}px`
    div.style.top = `${y - hostRect.top}px`
    for (const [label, dir] of [
      ['Set as Front', new THREE.Vector3(0, -1, 0)],
      ['Set as Top', new THREE.Vector3(0, 0, 1)],
      ['Set as Right', new THREE.Vector3(1, 0, 0)],
      ['Go to this face', this.dirForFace(fi)]
    ] as [string, THREE.Vector3][]) {
      const item = document.createElement('div')
      item.className = 'viewcube-menu-item'
      item.textContent = label
      item.onclick = () => {
        this.goToView(dir)
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

  /** Default 3/4 iso view. */
  home(): void {
    this.goToView(new THREE.Vector3(1, -1, 0.8))
  }

  goToView(dir: THREE.Vector3): void {
    const d = dir.clone().normalize()
    const pivot = this.controls.pivot
    const dist = this.mainCam.position.distanceTo(pivot)
    const to = pivot.clone().addScaledVector(d, dist)
    const up =
      Math.abs(d.z) > 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1)
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
    this.cube.quaternion.copy(this.mainCam.quaternion).invert()
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
