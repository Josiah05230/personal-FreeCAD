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

export interface SketchRender {
  id: string
  label: string
  polys: number[][]
}

export type Selection =
  | { kind: 'face'; bodyId: string; index: number; sub: string; point: [number, number, number] }
  | { kind: 'edge'; bodyId: string; index: number; sub: string; point: [number, number, number] }
  | { kind: 'body'; bodyId: string }

export interface DrawingView {
  id: string
  label: string
  direction: string
  scale: number
  visible: number[][][] // [poly][point][x,y]
  hidden: number[][][]
  bbox: [number, number, number, number]
}

export interface AssemblyComponent {
  id: string
  label: string
  grounded: boolean
  placement: { base: number[]; axis: number[]; angle: number }
}
export interface AssemblyJoint {
  id: string
  label: string
  type: string
}
export interface AssemblyTree {
  assembly: string | null
  components: AssemblyComponent[]
  joints: AssemblyJoint[]
}

const rpc = <T,>(m: string, p: Record<string, unknown> = {}) => window.cad.rpc<T>(m, p)

export const api = {
  ping: () => rpc<{ pong: boolean; freecad: string; build: string }>('ping'),
  resetDocument: () => rpc<{ document: string }>('session.reset'),
  demoPad: (width: number, depth: number, height: number) =>
    rpc<{ bodies: BodyTree[] }>('demo.pad', { width, depth, height }),
  sceneGet: () => rpc<{ meshes: RenderMesh[]; sketches: SketchRender[] }>('scene.get'),
  treeGet: () => rpc<{ bodies: BodyTree[]; path: string | null }>('tree.get'),

  box: (width: number, depth: number, height: number) =>
    rpc<{ bodies: BodyTree[] }>('primitive.box', { width, depth, height }),
  cylinder: (diameter: number, height: number) =>
    rpc<{ bodies: BodyTree[] }>('primitive.cylinder', { diameter, height }),
  extrude: (sketchId: string, length: number, cut = false, midplane = false, reversed = false) =>
    rpc<{ bodies: BodyTree[] }>('feature.extrude', { sketchId, length, cut, midplane, reversed }),
  fillet: (edges: string[], radius: number) =>
    rpc<{ bodies: BodyTree[] }>('feature.fillet', { edges, radius }),
  chamfer: (edges: string[], size: number) =>
    rpc<{ bodies: BodyTree[] }>('feature.chamfer', { edges, size }),
  shell: (faces: string[], thickness: number) =>
    rpc<{ bodies: BodyTree[] }>('feature.shell', { faces, thickness }),
  hole: (face: string, point: number[], diameter: number, depth: number, throughAll: boolean) =>
    rpc<{ bodies: BodyTree[] }>('feature.hole', { face, point, diameter, depth, throughAll }),
  patternLinear: (direction: number[], count: number, spacing: number) =>
    rpc<{ bodies: BodyTree[] }>('pattern.linear', { direction, count, spacing }),
  mirror: (plane: string) => rpc<{ bodies: BodyTree[] }>('feature.mirror', { plane }),
  datumPlane: (basePlane: string, offset: number) =>
    rpc<{ bodies: BodyTree[] }>('datum.plane', { basePlane, offset }),
  sketchOnPlane: (plane: string) =>
    rpc<{ sketchId: string; bodyId: string }>('sketch.onPlane', { plane }),
  sketchAddGeometry: (sketchId: string, elements: unknown[]) =>
    rpc<{ sketchId: string; count: number }>('sketch.addGeometry', { sketchId, elements }),

  drawingAddView: (bodyId: string | null, direction: string, scale = 1) =>
    rpc<DrawingView>('drawing.addView', { bodyId, direction, scale }),

  assemblyCreate: () => rpc<{ assembly: string }>('assembly.create'),
  assemblyAddComponent: (path: string, name?: string) =>
    rpc<AssemblyTree>('assembly.addComponent', { path, name }),
  assemblySetPlacement: (
    componentId: string,
    base: number[],
    axis: number[],
    angle: number
  ) => rpc<AssemblyTree>('assembly.setPlacement', { componentId, base, axis, angle }),
  assemblyGround: (componentId: string) =>
    rpc<AssemblyTree & { via: string }>('assembly.ground', { componentId }),
  assemblyAddJoint: (
    jointType: string,
    comp1: string,
    sub1: string,
    comp2: string,
    sub2: string
  ) =>
    rpc<AssemblyTree & { solved: boolean; engine: string }>('assembly.addJoint', {
      jointType,
      comp1,
      sub1,
      comp2,
      sub2
    }),
  assemblyTree: () => rpc<AssemblyTree>('assembly.tree'),

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
