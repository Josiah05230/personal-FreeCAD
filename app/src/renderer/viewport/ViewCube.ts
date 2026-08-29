/**
 * ViewCube - the orientation gizmo in the top-right corner.
 *
 * Renders in its own small canvas with its own scene/camera, but its rotation is
 * slaved to the main camera every frame. Clicking a face (or edge/corner) tweens
 * the main camera to that standard view. Dragging it orbits the main view.
 */
import * as THREE from 'three'
import type { CadControls } from './CadControls'

const LABELS: Record<string, string> = {
  '0,0,1': 'TOP',
  '0,0,-1': 'BOTTOM',
  '0,-1,0': 'FRONT',
  '0,1,0': 'BACK',
  '1,0,0': 'RIGHT',
  '-1,0,0': 'LEFT'
}

function faceTexture(text: string): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')!
  g.fillStyle = '#e9ebee'
  g.fillRect(0, 0, 128, 128)
  g.strokeStyle = '#b7bcc3'
  g.lineWidth = 4
  g.strokeRect(2, 2, 124, 124)
  g.fillStyle = '#3a3f47'
  g.font = '600 20px "Segoe UI", system-ui, sans-serif'
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
  private ray = new THREE.Raycaster()
  private dragging = false
  private lastX = 0
  private lastY = 0
  private moved = 0
  private tween: { from: THREE.Vector3; to: THREE.Vector3; up: THREE.Vector3; t: number } | null =
    null
  private disposed = false

  constructor(
    mount: HTMLElement,
    private readonly mainCam: THREE.PerspectiveCamera,
    private readonly controls: CadControls
  ) {
    const size = 96
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(size, size)
    mount.appendChild(this.renderer.domElement)

    this.cam = new THREE.OrthographicCamera(-1.7, 1.7, 1.7, -1.7, 0.1, 20)
    this.cam.position.set(0, 0, 6)
    this.cam.up.set(0, 1, 0)
    this.cam.lookAt(0, 0, 0)

    // order matches BoxGeometry material slots: +x -x +y -y +z -z
    const order = ['1,0,0', '-1,0,0', '0,1,0', '0,-1,0', '0,0,1', '0,0,-1']
    const mats = order.map(
      (k) =>
        new THREE.MeshBasicMaterial({ map: faceTexture(LABELS[k]) })
    )
    this.cube = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.6, 1.6), mats)
    this.scene.add(this.cube)
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(this.cube.geometry),
      new THREE.LineBasicMaterial({ color: 0x8a9099 })
    )
    this.cube.add(edges)

    this.renderer.domElement.style.cursor = 'pointer'
    this.renderer.domElement.addEventListener('pointerdown', this.onDown)
    this.renderer.domElement.addEventListener('pointermove', this.onMove)
    window.addEventListener('pointerup', this.onUp)
  }

  private onDown = (e: PointerEvent) => {
    this.dragging = true
    this.moved = 0
    this.lastX = e.clientX
    this.lastY = e.clientY
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }

  private onMove = (e: PointerEvent) => {
    if (!this.dragging) return
    const dx = e.clientX - this.lastX
    const dy = e.clientY - this.lastY
    this.lastX = e.clientX
    this.lastY = e.clientY
    this.moved += Math.abs(dx) + Math.abs(dy)
    // reuse the main orbit so feel is identical
    this.controls.applyOrbit(-dx * 0.01, -dy * 0.01)
  }

  private onUp = (e: PointerEvent) => {
    if (!this.dragging) return
    this.dragging = false
    try {
      ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      /* not captured */
    }
    if (this.moved < 4) this.pick(e)
  }

  private pick(e: PointerEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    )
    this.ray.setFromCamera(ndc, this.cam)
    const hit = this.ray.intersectObject(this.cube, false)[0]
    if (!hit || hit.face == null) return
    const n = hit.face.normal.clone().applyMatrix3(
      new THREE.Matrix3().getNormalMatrix(this.cube.matrixWorld)
    )
    // snap to dominant axis
    const ax = Math.abs(n.x) > Math.abs(n.y) && Math.abs(n.x) > Math.abs(n.z)
    const ay = !ax && Math.abs(n.y) > Math.abs(n.z)
    const dir = new THREE.Vector3(
      ax ? Math.sign(n.x) : 0,
      ay ? Math.sign(n.y) : 0,
      !ax && !ay ? Math.sign(n.z) : 0
    )
    this.goToView(dir)
  }

  goToView(dir: THREE.Vector3): void {
    const pivot = this.controls.pivot
    const dist = this.mainCam.position.distanceTo(pivot)
    const to = pivot.clone().addScaledVector(dir, dist)
    const up =
      Math.abs(dir.z) > 0.5 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1)
    this.tween = { from: this.mainCam.position.clone(), to, up, t: 0 }
  }

  update(dt: number): void {
    if (this.disposed) return
    if (this.tween) {
      this.tween.t = Math.min(1, this.tween.t + dt / 0.25)
      const k = this.tween.t < 0.5
        ? 2 * this.tween.t * this.tween.t
        : 1 - Math.pow(-2 * this.tween.t + 2, 2) / 2 // easeInOutQuad
      this.mainCam.position.lerpVectors(this.tween.from, this.tween.to, k)
      this.mainCam.up.copy(this.tween.up)
      this.mainCam.lookAt(this.controls.pivot)
      if (this.tween.t >= 1) this.tween = null
    }
    // slave cube orientation to the main camera
    const q = this.mainCam.quaternion.clone().invert()
    this.cube.quaternion.copy(q)
    this.renderer.render(this.scene, this.cam)
  }

  dispose(): void {
    this.disposed = true
    this.renderer.domElement.removeEventListener('pointerdown', this.onDown)
    this.renderer.domElement.removeEventListener('pointermove', this.onMove)
    window.removeEventListener('pointerup', this.onUp)
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
