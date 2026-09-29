/**
 * Draws face decals (see ../decals.ts): one textured PlaneGeometry per decal,
 * widthMm x heightMm, placed on its face by the sidecar's frame (centre,
 * outward normal, in-plane u). A hair off the surface plus polygonOffset so it
 * never z-fights the face; transparent where the PNG is. Each body's decals
 * are one scene node keyed `decals:<bodyId>` whose group carries
 * userData.bodyId, so it hides, isolates and Move/Copy-previews with its body
 * like the body's own objects. Decals are never pickable - a click goes
 * through to the face underneath.
 */
import * as THREE from 'three'
import type { RenderMesh } from '../rpc'
import type { DecalRender } from '../decals'

/** lift off the face, mm - polygonOffset does the real work */
const LIFT_MM = 0.02

// one texture per image file version, shared by every decal that uses it
// (material.dispose() leaves .map alone, so rebuilding a node keeps these)
const textures = new Map<string, Promise<THREE.Texture | null>>()

function textureFor(d: DecalRender): Promise<THREE.Texture | null> {
  const key = `${d.image}|${d.imageMtime ?? ''}`
  let p = textures.get(key)
  if (!p) {
    p = window.cad
      .readImage(d.image)
      .then(
        (url) =>
          new Promise<THREE.Texture | null>((resolve) => {
            new THREE.TextureLoader().load(
              url,
              (tex) => {
                tex.colorSpace = THREE.SRGBColorSpace
                tex.anisotropy = 4
                resolve(tex)
              },
              undefined,
              () => resolve(null)
            )
          })
      )
      .catch(() => null)
    textures.set(key, p)
    // a missing file must not stay cached as missing forever
    void p.then((t) => {
      if (!t) textures.delete(key)
    })
  }
  return p
}

function buildOne(bodyId: string, d: DecalRender): THREE.Mesh | null {
  if (!(d.width > 0 && d.height > 0)) return null
  const n = new THREE.Vector3(...d.normal)
  const u = new THREE.Vector3(...d.u)
  if (n.lengthSq() < 1e-12 || u.lengthSq() < 1e-12) return null
  n.normalize()
  u.sub(n.clone().multiplyScalar(u.dot(n))).normalize() // keep u in the plane
  const v = new THREE.Vector3().crossVectors(n, u).normalize()

  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.6,
    metalness: 0,
    transparent: true,
    alphaTest: 0.01,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
    side: THREE.FrontSide
  })
  mat.visible = false // until the image is in
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(d.width, d.height), mat)
  mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(u, v, n))
  mesh.position.set(...d.center).addScaledVector(n, LIFT_MM)
  mesh.name = `decal:${bodyId}:${d.id}`
  mesh.renderOrder = 2
  mesh.raycast = () => undefined
  void textureFor(d).then((tex) => {
    if (!tex) return
    mat.map = tex
    mat.visible = true
    mat.needsUpdate = true
  })
  return mesh
}

export function buildDecals(m: RenderMesh): THREE.Object3D[] {
  const g = new THREE.Group()
  g.name = `decals:${m.id}`
  g.userData = { pick: 'decal', bodyId: m.id }
  for (const d of m.decals ?? []) {
    const mesh = buildOne(m.id, d)
    if (mesh) g.add(mesh)
  }
  return [g]
}

const r = (a: number[]): string => a.map((x) => x.toFixed(4)).join('/')
export function decalSig(m: RenderMesh): string {
  return (m.decals ?? [])
    .map((d) => [d.id, r(d.center), r(d.normal), r(d.u), d.width, d.height, d.image, d.imageMtime ?? ''].join('~'))
    .join('|')
}

/** syncScene entries for every body that has decals. No decals in the
 *  wireframe / hidden-line modes, which draw no filled faces either. */
export function decalNodes(
  meshes: RenderMesh[],
  shading: string
): { key: string; sig: string; build: () => THREE.Object3D[]; frame: boolean }[] {
  if (shading === 'wireframe' || shading === 'hidden-line') return []
  return meshes
    .filter((m) => m.decals?.length)
    .map((m) => ({ key: `decals:${m.id}`, sig: decalSig(m), build: () => buildDecals(m), frame: false }))
}
