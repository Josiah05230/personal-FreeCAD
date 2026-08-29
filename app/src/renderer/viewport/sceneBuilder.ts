import * as THREE from 'three'
import type { RenderMesh, SketchRender, DatumDTO } from '../rpc'

export interface BuiltScene {
  group: THREE.Group
  center: THREE.Vector3
  radius: number
}

const AXIS_COLOR: Record<string, number> = {
  X_Axis: 0xe0533a,
  Y_Axis: 0x5cb85c,
  Z_Axis: 0x4a90d9
}

function buildDatum(d: DatumDTO): THREE.Object3D {
  const g = new THREE.Group()
  g.userData = { pick: 'datum', datumId: d.id, kind: d.kind }
  const O = new THREE.Vector3(...d.origin)
  if (d.kind === 'plane' && d.x && d.y) {
    const X = new THREE.Vector3(...d.x)
    const Y = new THREE.Vector3(...d.y)
    const s = d.size ?? 40
    const c = [
      O.clone().addScaledVector(X, -s).addScaledVector(Y, -s),
      O.clone().addScaledVector(X, s).addScaledVector(Y, -s),
      O.clone().addScaledVector(X, s).addScaledVector(Y, s),
      O.clone().addScaledVector(X, -s).addScaledVector(Y, s)
    ]
    const geom = new THREE.BufferGeometry().setFromPoints([c[0], c[1], c[2], c[0], c[2], c[3]])
    const fill = new THREE.Mesh(
      geom,
      new THREE.MeshBasicMaterial({
        color: 0x4a90d9,
        transparent: true,
        opacity: 0.12,
        side: THREE.DoubleSide,
        depthWrite: false
      })
    )
    const border = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(c),
      new THREE.LineBasicMaterial({ color: 0x6aa9dd, transparent: true, opacity: 0.6 })
    )
    g.add(fill, border)
  } else if (d.kind === 'axis' && d.dir) {
    const D = new THREE.Vector3(...d.dir).normalize()
    const L = d.length ?? 60
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        O.clone().addScaledVector(D, -L),
        O.clone().addScaledVector(D, L)
      ]),
      new THREE.LineBasicMaterial({ color: AXIS_COLOR[d.role ?? ''] ?? 0x9aa0a6 })
    )
    g.add(line)
  } else if (d.kind === 'point') {
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(1.2, 12, 12),
      new THREE.MeshBasicMaterial({ color: 0xf0c419 })
    )
    dot.position.copy(O)
    g.add(dot)
  }
  return g
}

// Dark theme: graphite body with a satin sheen; edges near-black; sketches blue.
const SOLID_COLOR = 0x8a8f96
const EDGE_COLOR = 0x1c1f24
const SKETCH_COLOR = 0x2f9fe0

export function buildScene(
  meshes: RenderMesh[],
  sketches: SketchRender[] = [],
  datums: DatumDTO[] = []
): BuiltScene {
  const group = new THREE.Group()
  const box = new THREE.Box3()

  for (const d of datums) group.add(buildDatum(d))

  for (const m of meshes) {
    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.Float32BufferAttribute(m.positions, 3))
    geom.setAttribute('normal', new THREE.Float32BufferAttribute(m.normals, 3))
    geom.setIndex(m.indices)
    geom.userData = { bodyId: m.id, faceGroups: m.faceGroups }

    const mesh = new THREE.Mesh(
      geom,
      new THREE.MeshStandardMaterial({
        color: SOLID_COLOR,
        metalness: 0.15,
        roughness: 0.5,
        side: THREE.DoubleSide
      })
    )
    mesh.name = `body:${m.id}`
    mesh.userData = { pick: 'face', bodyId: m.id, faceGroups: m.faceGroups }
    group.add(mesh)
    box.expandByObject(mesh)

    // one line object per model edge, individually pickable
    for (const e of m.edges) {
      const p = e.points
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3))
      const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: EDGE_COLOR }))
      line.name = `edge:${m.id}:${e.edge}`
      line.userData = { pick: 'edge', bodyId: m.id, sub: `Edge${e.edge + 1}` }
      line.renderOrder = 1
      group.add(line)
    }
  }

  for (const s of sketches) {
    for (const poly of s.polys) {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute(poly, 3))
      const line = new THREE.Line(
        g,
        new THREE.LineBasicMaterial({ color: SKETCH_COLOR, linewidth: 2 })
      )
      line.name = `sketch:${s.id}`
      line.userData = { pick: 'sketch', sketchId: s.id }
      line.renderOrder = 2
      group.add(line)
    }
  }

  const center = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3())
  const radius = box.isEmpty() ? 60 : Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1)
  return { group, center, radius }
}

/** Map a raytraced triangle index to the FreeCAD face sub-name. */
export function faceSubFromTriangle(
  faceGroups: { face: number; start: number; count: number }[],
  triangleIndex: number
): string | null {
  const i = triangleIndex * 3
  for (const g of faceGroups) {
    if (i >= g.start && i < g.start + g.count) return `Face${g.face + 1}`
  }
  return null
}
