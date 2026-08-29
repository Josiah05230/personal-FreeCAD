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
  visible: boolean
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
  resetDocument: () => rpc<{ document: string }>('session.reset'),
  demoPad: (width: number, depth: number, height: number) =>
    rpc<{ bodies: BodyTree[] }>('demo.pad', { width, depth, height }),
  sceneGet: () => rpc<{ meshes: RenderMesh[] }>('scene.get'),
  treeGet: () => rpc<{ bodies: BodyTree[]; path: string | null }>('tree.get'),

  setVisibility: (id: string, visible: boolean) =>
    rpc<{ id: string; visible: boolean }>('object.setVisibility', { id, visible }),
  rollTo: (bodyId: string, featureId: string | null) =>
    rpc<{ tip: string | null }>('history.rollTo', { bodyId, featureId }),
  renameFeature: (id: string, label: string) =>
    rpc<{ id: string; label: string }>('feature.rename', { id, label }),
  deleteFeature: (id: string) => rpc<{ deleted: string }>('feature.delete', { id }),

  save: () => rpc<{ path: string }>('document.save'),
  saveAs: (path: string) => rpc<{ path: string }>('document.saveAs', { path }),
  open: (path: string) => rpc<{ path: string; name: string }>('document.open', { path }),

  exportStep: (path: string) => rpc<{ path: string; bodies: number }>('io.exportStep', { path }),
  exportStl: (path: string) => rpc<{ path: string; bodies: number }>('io.exportStl', { path }),
  importStep: (path: string) => rpc<{ path: string }>('io.importStep', { path })
}
