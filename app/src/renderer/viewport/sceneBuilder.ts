import * as THREE from 'three'
import type { RenderMesh } from '../rpc'

export interface BuiltScene {
  group: THREE.Group
  center: THREE.Vector3
  radius: number
}

const SOLID_COLOR = 0xd6d8db
const EDGE_COLOR = 0x2b2f36

/** Build a display group from sidecar render buffers (mm, Z-up). */
export function buildScene(meshes: RenderMesh[]): BuiltScene {
  const group = new THREE.Group()
  const box = new THREE.Box3()

  for (const m of meshes) {
    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.Float32BufferAttribute(m.positions, 3))
    geom.setAttribute('normal', new THREE.Float32BufferAttribute(m.normals, 3))
    geom.setIndex(m.indices)
    geom.userData = { bodyId: m.id, faceGroups: m.faceGroups }

    const mat = new THREE.MeshStandardMaterial({
      color: SOLID_COLOR,
      metalness: 0.05,
      roughness: 0.55,
      flatShading: false
    })
    const mesh = new THREE.Mesh(geom, mat)
    mesh.name = `body:${m.id}`
    mesh.renderOrder = 0
    group.add(mesh)

    // model edges as one LineSegments per body
    const segPts: number[] = []
    for (const e of m.edges) {
      const p = e.points
      for (let i = 0; i + 5 < p.length; i += 3) {
        segPts.push(p[i], p[i + 1], p[i + 2], p[i + 3], p[i + 4], p[i + 5])
      }
    }
    if (segPts.length) {
      const eg = new THREE.BufferGeometry()
      eg.setAttribute('position', new THREE.Float32BufferAttribute(segPts, 3))
      const el = new THREE.LineSegments(
        eg,
        new THREE.LineBasicMaterial({ color: EDGE_COLOR })
      )
      el.name = `edges:${m.id}`
      el.renderOrder = 1
      group.add(el)
    }

    box.expandByObject(mesh)
  }

  const center = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3())
  const radius = box.isEmpty() ? 50 : Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1)
  return { group, center, radius }
}
