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
    this.ray.params.Points = { threshold: 1 }
  }

  private setPointer(ev: PointerEvent | MouseEvent): void {
    const r = this.dom.getBoundingClientRect()
    this.pointer.set(
      ((ev.clientX - r.left) / r.width) * 2 - 1,
      -((ev.clientY - r.top) / r.height) * 2 + 1
    )
  }

  /** true if `world` projects to within `px` pixels of the current cursor */
  private nearOnScreen(world: THREE.Vector3, px: number): boolean {
    const r = this.dom.getBoundingClientRect()
    const p = world.clone().project(this.camera)
    const dx = ((p.x - this.pointer.x) * r.width) / 2
    const dy = ((p.y - this.pointer.y) * r.height) / 2
    return Math.hypot(dx, dy) <= px
  }

  /** Resolve what is under the cursor within `content`. */
  pick(ev: PointerEvent | MouseEvent, content: THREE.Object3D): Selection | null {
    this.setPointer(ev)
    this.ray.setFromCamera(this.pointer, this.camera)
    const hits = this.ray.intersectObjects(content.children, true)
    for (const h of hits) {
      // three's raycaster ignores .visible, so skip anything hidden up the chain
      let vis: THREE.Object3D | null = h.object
      let hidden = false
      while (vis && vis !== content) {
        if (vis.visible === false) {
          hidden = true
          break
        }
        vis = vis.parent
      }
      if (hidden) continue
      // walk up to the object that carries the pick tag (datums nest a group)
      let owner: THREE.Object3D | null = h.object
      while (owner && owner.userData?.pick == null && owner !== content) owner = owner.parent
      const ud = owner?.userData ?? h.object.userData
      if (ud.pick === 'datum') {
        return { kind: 'plane', planeId: ud.datumId, role: ud.role || undefined, label: ud.label }
      }
      if (ud.pick === 'sketch') {
        return { kind: 'sketch', sketchId: ud.sketchId }
      }
      if (ud.pick === 'vertex' && h.index != null) {
        const sub = (ud.vsub as string[] | undefined)?.[h.index]
        // only snap to a corner when the cursor is genuinely near it on screen,
        // so corners are not a huge invisible grab target over the whole model
        if (sub && this.nearOnScreen(h.point, 8))
          return {
            kind: 'vertex',
            bodyId: ud.bodyId,
            index: 0,
            sub,
            point: [h.point.x, h.point.y, h.point.z]
          }
      }
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
        if (sub) {
          let normal: [number, number, number] | undefined
          if (h.face) {
            const n = h.face.normal
              .clone()
              .transformDirection((h.object as THREE.Mesh).matrixWorld)
              .normalize()
            normal = [n.x, n.y, n.z]
          }
          return {
            kind: 'face',
            bodyId: ud.bodyId,
            index: 0,
            sub,
            point: [h.point.x, h.point.y, h.point.z],
            normal
          }
        }
      }
    }
    return null
  }

  private overlayFor(sel: Selection, content: THREE.Object3D, color: number): THREE.Object3D | null {
    if (sel.kind === 'vertex') {
      // a small dot ON the corner (blue on hover, orange when selected), kept to
      // roughly a constant ~5 px on screen at any zoom, and clamped small
      const c = new THREE.Vector3(...sel.point)
      const fov = (this.camera.fov * Math.PI) / 180
      const perPx = (2 * Math.tan(fov / 2) * c.distanceTo(this.camera.position)) / this.dom.clientHeight
      const rad = Math.min(Math.max(perPx * 5, 1e-4), c.distanceTo(this.camera.position) * 0.02)
      const s = new THREE.Mesh(
        new THREE.SphereGeometry(rad, 16, 12),
        new THREE.MeshBasicMaterial({ color, depthTest: false })
      )
      s.position.copy(c)
      s.renderOrder = 12
      s.userData.ownGeom = true
      return s
    }
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
    if (sel.kind === 'plane') {
      const grp = content.children.find(
        (c) => c.userData.pick === 'datum' && c.userData.datumId === sel.planeId
      )
      if (!grp) return null
      const out = new THREE.Group()
      grp.traverse((o) => {
        const any = o as THREE.Line & THREE.Mesh & { isLineLoop?: boolean; isLineSegments?: boolean }
        if (!any.geometry) return
        if (any.isLineLoop || any.isLineSegments || any.isLine) {
          // keep the loop closed - cloning a LineLoop as a plain Line drew a "C"
          const Ctor = any.isLineLoop
            ? THREE.LineLoop
            : any.isLineSegments
              ? THREE.LineSegments
              : THREE.Line
          const cl = new Ctor(any.geometry, new THREE.LineBasicMaterial({ color, depthTest: false }))
          cl.renderOrder = 11
          out.add(cl)
        } else if ((any as THREE.Mesh).isMesh) {
          const m = new THREE.Mesh(
            any.geometry,
            new THREE.MeshBasicMaterial({
              color,
              transparent: true,
              opacity: 0.14,
              side: THREE.DoubleSide,
              depthWrite: false
            })
          )
          m.renderOrder = 10
          out.add(m)
        }
      })
      return out.children.length ? out : null
    }
    if (sel.kind === 'sketch') {
      // highlight the finished sketch's fill + outline so it is obvious it is
      // selected (and therefore ready to Extrude / Revolve)
      const out = new THREE.Group()
      for (const c of content.children) {
        const any = c as THREE.Line & THREE.Mesh
        if (any.userData.pick !== 'sketch' || any.userData.sketchId !== sel.sketchId) continue
        if (!any.geometry) continue
        if ((any as THREE.Mesh).isMesh) {
          out.add(
            new THREE.Mesh(
              any.geometry,
              new THREE.MeshBasicMaterial({
                color,
                transparent: true,
                opacity: 0.25,
                side: THREE.DoubleSide,
                depthWrite: false
              })
            )
          )
        } else {
          const cl = new THREE.Line(any.geometry, new THREE.LineBasicMaterial({ color, depthTest: false }))
          cl.renderOrder = 11
          out.add(cl)
        }
      }
      return out.children.length ? out : null
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
    ov.userData.ownGeom = true
    return ov
  }

  setHover(sel: Selection | null, content: THREE.Object3D): void {
    if (this.hoverOverlay) {
      this.overlayRoot.remove(this.hoverOverlay)
      this.disposeObj(this.hoverOverlay)
      this.hoverOverlay = null
    }
    if (sel) {
      let ov: THREE.Object3D | null = null
      try {
        ov = this.overlayFor(sel, content, HILITE)
      } catch {
        ov = null
      }
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
      let ov: THREE.Object3D | null = null
      try {
        ov = this.overlayFor(s, content, SELECT)
      } catch {
        ov = null
      }
      if (ov) {
        this.selOverlays.push(ov)
        this.overlayRoot.add(ov)
      }
    }
  }

  private disposeObj(o: THREE.Object3D): void {
    // some overlays reuse source geometry (edge / datum lines) - those are not
    // ours to dispose; ones we build tag userData.ownGeom. Recurse for groups.
    o.traverse((n) => {
      const m = n as THREE.Mesh
      if (m.userData?.ownGeom) m.geometry?.dispose?.()
      const mat = m.material as THREE.Material | THREE.Material[] | undefined
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose())
      else mat?.dispose()
    })
  }

  /** Faces whose centroid projects inside the screen rect (window select). */
  windowSelect(
    content: THREE.Object3D,
    rect: { x0: number; y0: number; x1: number; y1: number },
    domW: number,
    domH: number
  ): Selection[] {
    const minX = Math.min(rect.x0, rect.x1)
    const maxX = Math.max(rect.x0, rect.x1)
    const minY = Math.min(rect.y0, rect.y1)
    const maxY = Math.max(rect.y0, rect.y1)
    const out: Selection[] = []
    const v = new THREE.Vector3()
    for (const c of content.children) {
      if (c.userData.pick !== 'face' || c.visible === false) continue
      const mesh = c as THREE.Mesh
      const geom = mesh.geometry as THREE.BufferGeometry
      const idx = geom.getIndex()
      const pos = geom.getAttribute('position')
      if (!idx) continue
      const groups = mesh.userData.faceGroups as { face: number; start: number; count: number }[]
      for (const g of groups) {
        let cx = 0
        let cy = 0
        let cz = 0
        let n = 0
        for (let i = g.start; i < g.start + g.count; i++) {
          const vi = idx.getX(i)
          cx += pos.getX(vi)
          cy += pos.getY(vi)
          cz += pos.getZ(vi)
          n++
        }
        if (!n) continue
        v.set(cx / n, cy / n, cz / n).applyMatrix4(mesh.matrixWorld).project(this.camera)
        const sx = ((v.x + 1) / 2) * domW
        const sy = ((1 - v.y) / 2) * domH
        if (v.z < 1 && sx >= minX && sx <= maxX && sy >= minY && sy <= maxY) {
          out.push({
            kind: 'face',
            bodyId: mesh.userData.bodyId,
            index: 0,
            sub: `Face${g.face + 1}`,
            point: [cx / n, cy / n, cz / n]
          })
        }
      }
    }
    return out
  }

  clear(): void {
    this.setHover(null, this.overlayRoot)
    this.setSelection([], this.overlayRoot)
  }
}
