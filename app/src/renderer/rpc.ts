/** Thin typed wrappers over the preload bridge. */

export type FeatureKind = 'sketch' | 'datum' | 'solid' | 'other'

export interface Feature {
  id: string
  label: string
  opType: string
  kind: FeatureKind
  isTip: boolean
  error: boolean
}

export interface BodyTree {
  id: string
  label: string
  features: Feature[]
}

export interface FaceGroup {
  face: number
  start: number
  count: number
}

export interface EdgePoly {
  edge: number
  points: number[]
}

export interface RenderMesh {
  id: string
  label: string
  positions: number[]
  normals: number[]
  indices: number[]
  faceGroups: FaceGroup[]
  edges: EdgePoly[]
  bbox: { min: [number, number, number]; max: [number, number, number] }
}

const rpc = <T,>(m: string, p: Record<string, unknown> = {}) => window.cad.rpc<T>(m, p)

export const api = {
  ping: () => rpc<{ pong: boolean; freecad: string; build: string }>('ping'),
  demoPad: (width: number, depth: number, height: number) =>
    rpc<{ bodies: BodyTree[] }>('demo.pad', { width, depth, height }),
  sceneGet: () => rpc<{ meshes: RenderMesh[] }>('scene.get'),
  treeGet: () => rpc<{ bodies: BodyTree[] }>('tree.get'),
  exportStep: (path: string) => rpc<{ path: string; bodies: number }>('io.exportStep', { path })
}
