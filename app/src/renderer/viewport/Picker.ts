/**
 * Picking + highlight for the viewport. Raycasts the built scene group, resolves
 * hits to FreeCAD sub-names (Face3 / Edge7), and paints hover/selection overlays.
 */
import * as THREE from 'three'
import type { Selection } from '../rpc'
import { faceSubFromTriangle } from './sceneBuilder'

const HILITE = 0x2f9fe0
const SELECT = 0xffb020

export class Picker {
  private ray = new THREE.Raycaster()
  private pointer = new THREE.Vector2()
  private hoverOverlay: THREE.Object3D | null = null
  private selOverlays: THREE.Object3D[] = []

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly dom: HTMLElement,
    private readonly overlayRoot: THREE.Object3D
  ) {
    this.ray.params.Line = { threshold: 1.2 }
  }

  private setPointer(ev: PointerEvent | MouseEvent): void {
    const r = this.dom.getBoundingClientRect()
    this.pointer.set(
      ((ev.clientX - r.left) / r.width) * 2 - 1,
      -((ev.clientY - r.top) / r.height) * 2 + 1
    )
  }

  /** Resolve what is under the cursor within `content`. */
  pick(ev: PointerEvent | MouseEvent, content: THREE.Object3D): Selection | null {
    this.setPointer(ev)
    this.ray.setFromCamera(this.pointer, this.camera)
    const hits = this.ray.intersectObjects(content.children, false)
    for (const h of hits) {
      const ud = h.object.userData
      if (ud.pick === 'edge') {
        return {
          kind: 'edge',
          bodyId: ud.bodyId,
          index: 0,
          sub: ud.sub,
          point: [h.point.x, h.point.y, h.point.z]
        }
      }
      if (ud.pick === 'face' && h.faceIndex != null) {
        const sub = faceSubFromTriangle(ud.faceGroups, h.faceIndex)
        if (sub)
          return {
            kind: 'face',
            bodyId: ud.bodyId,
            index: 0,
            sub,
            point: [h.point.x, h.point.y, h.point.z]
          }
      }
    }
    return null
  }

  private overlayFor(sel: Selection, content: THREE.Object3D, color: number): THREE.Object3D | null {
    if (sel.kind === 'edge') {
      const src = content.children.find(
        (c) => c.userData.pick === 'edge' && c.userData.sub === sel.sub && c.userData.bodyId === sel.bodyId
      ) as THREE.Line | undefined
      if (!src) return null
      const line = new THREE.Line(
        src.geometry,
        new THREE.LineBasicMaterial({ color, depthTest: false })
      )
      line.renderOrder = 10
      return line
    }
    if (sel.kind !== 'face') return null
    // face overlay: slice the body geometry to that face group's triangles
    const mesh = content.children.find(
      (c) => c.userData.pick === 'face' && c.userData.bodyId === sel.bodyId
    ) as THREE.Mesh | undefined
    if (!mesh) return null
    const groups = mesh.userData.faceGroups as { face: number; start: number; count: number }[]
    const g = groups.find((x) => `Face${x.face + 1}` === sel.sub)
    if (!g) return null
    const srcGeom = mesh.geometry as THREE.BufferGeometry
    const idx = srcGeom.getIndex()!
    const pos = srcGeom.getAttribute('position')
    const sub = new THREE.BufferGeometry()
    const slice: number[] = []
    for (let i = g.start; i < g.start + g.count; i++) {
      const vi = idx.getX(i)
      slice.push(pos.getX(vi), pos.getY(vi), pos.getZ(vi))
    }
    sub.setAttribute('position', new THREE.Float32BufferAttribute(slice, 3))
    sub.computeVertexNormals()
    const ov = new THREE.Mesh(
      sub,
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.32,
        side: THREE.DoubleSide,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1
      })
    )
    ov.renderOrder = 9
    return ov
  }

  setHover(sel: Selection | null, content: THREE.Object3D): void {
    if (this.hoverOverlay) {
      this.overlayRoot.remove(this.hoverOverlay)
      this.disposeObj(this.hoverOverlay)
      this.hoverOverlay = null
    }
    if (sel) {
      const ov = this.overlayFor(sel, content, HILITE)
      if (ov) {
        this.hoverOverlay = ov
        this.overlayRoot.add(ov)
      }
    }
  }

  setSelection(sels: Selection[], content: THREE.Object3D): void {
    for (const o of this.selOverlays) {
      this.overlayRoot.remove(o)
      this.disposeObj(o)
    }
    this.selOverlays = []
    for (const s of sels) {
      const ov = this.overlayFor(s, content, SELECT)
      if (ov) {
        this.selOverlays.push(ov)
        this.overlayRoot.add(ov)
      }
    }
  }

  private disposeObj(o: THREE.Object3D): void {
    const any = o as THREE.Mesh
    if (any.geometry && any.geometry !== (any.userData.shared as unknown)) {
      // edge overlays reuse source geometry; only dispose our own slices
    }
    const mat = (any as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose())
    else mat?.dispose()
  }

  clear(): void {
    this.setHover(null, this.overlayRoot)
    this.setSelection([], this.overlayRoot)
  }
}
