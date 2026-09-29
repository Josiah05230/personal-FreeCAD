/* Unit tests for the face-decal quad placement (app/src/renderer/viewport/
 * decalLayer.ts). Pure node: run with `bash test/unit/run.sh`. The image
 * loader is stubbed - only the geometry is checked here. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
// (three lives in app/node_modules, not above test/)
import * as THREE from '../../app/node_modules/three'

;(globalThis as unknown as { window: unknown }).window = {
  cad: { readImage: () => new Promise<string>(() => undefined) }
}

const { buildDecals, decalNodes } = await import('../../app/src/renderer/viewport/decalLayer')

const mesh = (decals: unknown[]) =>
  ({ id: 'Body', label: 'Body', positions: [], normals: [], indices: [], faceGroups: [], edges: [], bbox: { min: [0, 0, 0], max: [0, 0, 0] }, decals }) as never

const near = (a: THREE.Vector3, b: [number, number, number], tol = 1e-6): void => {
  assert.ok(a.distanceTo(new THREE.Vector3(...b)) < tol, `${a.toArray()} != ${b}`)
}

test('a decal quad sits on its face frame at true size', () => {
  // a side wall facing -Y, image +X along world +X, so image up = n x u = +Z
  const [g] = buildDecals(mesh([{ id: 'D1', center: [10, -5, 3], normal: [0, -1, 0], u: [1, 0, 0], width: 30, height: 15, image: '/x.png' }]))
  assert.equal(g.userData.bodyId, 'Body')
  const q = g.children[0] as THREE.Mesh
  q.updateMatrixWorld(true)
  const at = (x: number, y: number): THREE.Vector3 => new THREE.Vector3(x, y, 0).applyMatrix4(q.matrixWorld)
  // centre is lifted a hair along the outward normal
  near(at(0, 0), [10, -5.02, 3])
  // right edge along u, top edge along n x u
  near(at(15, 0), [25, -5.02, 3])
  near(at(0, 7.5), [10, -5.02, 10.5])
  const p = (q.geometry as THREE.BufferGeometry).getAttribute('position')
  const box = new THREE.Box3().setFromBufferAttribute(p as THREE.BufferAttribute)
  near(box.getSize(new THREE.Vector3()), [30, 15, 0])
  // never pickable - clicks go through to the face
  const hits: THREE.Intersection[] = []
  q.raycast(new THREE.Raycaster(new THREE.Vector3(10, -50, 3), new THREE.Vector3(0, 1, 0)), hits)
  assert.equal(hits.length, 0)
})

test('decal nodes: only bodies with decals, none in wireframe', () => {
  const withD = mesh([{ id: 'D1', center: [0, 0, 0], normal: [0, 0, 1], u: [1, 0, 0], width: 1, height: 1, image: '/x.png' }])
  const without = { ...(mesh([]) as object), id: 'Other' } as never
  assert.deepEqual(decalNodes([withD, without], 'shaded').map((n) => n.key), ['decals:Body'])
  assert.equal(decalNodes([withD], 'wireframe').length, 0)
})
