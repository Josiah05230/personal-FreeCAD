import * as THREE from 'three'
import type { RenderMesh, SketchRender, DatumDTO, CanvasDTO } from '../rpc'

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
  g.userData = { pick: 'datum', datumId: d.id, kind: d.kind, role: d.role, label: d.label }
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
  datums: DatumDTO[] = [],
  canvases: CanvasDTO[] = []
): BuiltScene {
  const group = new THREE.Group()
  const box = new THREE.Box3()

  for (const d of datums) group.add(buildDatum(d))

  for (const c of canvases) {
    const O = new THREE.Vector3(...(c.frame.origin as [number, number, number]))
    const X = new THREE.Vector3(...(c.frame.x as [number, number, number])).normalize()
    const Y = new THREE.Vector3(...(c.frame.y as [number, number, number])).normalize()
    const pos = O.clone()
      .addScaledVector(X, c.offset[0])
      .addScaledVector(Y, c.offset[1])
    const geo = new THREE.PlaneGeometry(c.w, c.h)
    const url = c.image ?? undefined
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: url ? 0.9 : 0.2,
      side: THREE.DoubleSide,
      depthWrite: false
    })
    if (url) {
      new THREE.TextureLoader().load(url, (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace
        mat.map = tex
        mat.needsUpdate = true
      })
    }
    const quad = new THREE.Mesh(geo, mat)
    quad.position.copy(pos.addScaledVector(X, c.w / 2).addScaledVector(Y, c.h / 2))
    // orient the plane's local XY onto the frame's X/Y
    const m = new THREE.Matrix4().makeBasis(X, Y, new THREE.Vector3().crossVectors(X, Y))
    quad.quaternion.setFromRotationMatrix(m)
    quad.userData = { pick: 'canvas', canvasId: c.id }
    quad.renderOrder = -1
    group.add(quad)
  }

  for (const m of meshes) {
    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.Float32BufferAttribute(m.positions, 3))
    if (m.needsNormals || m.normals.length !== m.positions.length) {
      geom.setIndex(m.indices)
      geom.computeVertexNormals()
    } else {
      geom.setAttribute('normal', new THREE.Float32BufferAttribute(m.normals, 3))
      geom.setIndex(m.indices)
    }
    geom.userData = { bodyId: m.id, faceGroups: m.faceGroups }

    const color = m.color
      ? new THREE.Color(m.color[0], m.color[1], m.color[2])
      : new THREE.Color(SOLID_COLOR)
    const mesh = new THREE.Mesh(
      geom,
      new THREE.MeshStandardMaterial({
        color,
        metalness: 0.15,
        roughness: 0.5,
        side: THREE.DoubleSide
      })
    )
    mesh.name = `body:${m.id}`
    mesh.userData = { pick: 'face', bodyId: m.id, faceGroups: m.faceGroups }
    group.add(mesh)
    box.expandByObject(mesh)

    // one pickable point per model vertex
    if (m.vertices && m.vertices.length) {
      const vpos: number[] = []
      const vsub: string[] = []
      for (const v of m.vertices) {
        vpos.push(v.p[0], v.p[1], v.p[2])
        vsub.push(`Vertex${v.vertex + 1}`)
      }
      const vg = new THREE.BufferGeometry()
      vg.setAttribute('position', new THREE.Float32BufferAttribute(vpos, 3))
      const pts = new THREE.Points(
        vg,
        new THREE.PointsMaterial({ color: 0xcdd3da, size: 6, sizeAttenuation: false })
      )
      pts.name = `verts:${m.id}`
      pts.userData = { pick: 'vertex', bodyId: m.id, vsub }
      pts.renderOrder = 3
      group.add(pts)
    }

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
      // a sketch-only scene still needs a real bounding box so Fit-to-view and
      // the first-content framing land on the sketch instead of the origin
      box.expandByObject(line)
    }

    // fill every closed region the sketch's edges enclose (a rectangle drawn as
    // four separate lines still gets one filled, pickable face). Never let a bad
    // profile take down the whole scene build.
    let regions: THREE.BufferGeometry[] = []
    try {
      regions = fillSketchRegions(s.polys)
    } catch {
      regions = []
    }
    for (const fill of regions) {
      const face = new THREE.Mesh(
        fill,
        new THREE.MeshBasicMaterial({
          color: 0x5b8fd6,
          transparent: true,
          opacity: 0.15,
          side: THREE.DoubleSide,
          depthWrite: false
        })
      )
      face.userData = { pick: 'sketch', sketchId: s.id }
      face.renderOrder = 1
      group.add(face)
    }
  }

  const center = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3())
  const radius = box.isEmpty() ? 60 : Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1)
  return { group, center, radius }
}

/** Chain a sketch's edge polylines into closed loops and triangulate each, so a
 *  profile made of separate line segments still fills. */
function fillSketchRegions(polys: number[][]): THREE.BufferGeometry[] {
  // already-closed polylines fill directly
  const out: THREE.BufferGeometry[] = []
  const open: THREE.Vector3[][] = []
  for (const poly of polys) {
    const n = Math.floor(poly.length / 3)
    if (n < 2) continue
    const pts: THREE.Vector3[] = []
    for (let i = 0; i < n; i++)
      pts.push(new THREE.Vector3(poly[i * 3], poly[i * 3 + 1], poly[i * 3 + 2]))
    if (pts[0].distanceTo(pts[n - 1]) < 1e-4) {
      const g = fillLoop(pts.slice(0, -1))
      if (g) out.push(g)
    } else {
      open.push(pts)
    }
  }
  // greedily stitch open polylines end-to-end into closed loops
  const key = (v: THREE.Vector3): string =>
    `${Math.round(v.x * 1e3)},${Math.round(v.y * 1e3)},${Math.round(v.z * 1e3)}`
  const used = new Set<number>()
  for (let start = 0; start < open.length; start++) {
    if (used.has(start)) continue
    const chain = [...open[start]]
    used.add(start)
    for (let guard = 0; guard < open.length + 1; guard++) {
      if (key(chain[0]) === key(chain[chain.length - 1]) && chain.length > 3) break
      const tail = chain[chain.length - 1]
      let hit = -1
      let rev = false
      for (let j = 0; j < open.length; j++) {
        if (used.has(j)) continue
        if (key(open[j][0]) === key(tail)) {
          hit = j
          rev = false
          break
        }
        if (key(open[j][open[j].length - 1]) === key(tail)) {
          hit = j
          rev = true
          break
        }
      }
      if (hit < 0) break
      used.add(hit)
      const seg = rev ? [...open[hit]].reverse() : open[hit]
      chain.push(...seg.slice(1))
    }
    if (key(chain[0]) === key(chain[chain.length - 1]) && chain.length > 3) {
      const g = fillLoop(chain.slice(0, -1))
      if (g) out.push(g)
    }
  }
  return out
}

/** Triangulate an ordered ring of coplanar points. */
function fillLoop(pts: THREE.Vector3[]): THREE.BufferGeometry | null {
  if (pts.length < 3) return null
  const o = pts[0]
  let nrm = new THREE.Vector3()
  for (let i = 1; i + 1 < pts.length; i++) {
    nrm = new THREE.Vector3()
      .subVectors(pts[i], o)
      .cross(new THREE.Vector3().subVectors(pts[i + 1], o))
    if (nrm.lengthSq() > 1e-9) break
  }
  if (nrm.lengthSq() < 1e-12) return null
  nrm.normalize()
  const ref = Math.abs(nrm.x) > 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)
  const xa = new THREE.Vector3().crossVectors(nrm, ref).normalize()
  const ya = new THREE.Vector3().crossVectors(nrm, xa).normalize()
  const uv = pts.map(
    (p) => new THREE.Vector2(p.clone().sub(o).dot(xa), p.clone().sub(o).dot(ya))
  )
  let tris: number[][]
  try {
    tris = THREE.ShapeUtils.triangulateShape(uv, [])
  } catch {
    return null
  }
  if (!tris.length) return null
  const pos: number[] = []
  for (const t of tris)
    for (const idx of t) {
      const p = pts[idx]
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return null
      pos.push(p.x, p.y, p.z)
    }
  if (!pos.length) return null
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  // MeshBasicMaterial is unlit - no normals needed, and computing them on a
  // degenerate triangle can inject NaN that blanks the whole frame
  return g
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
