/** Thin typed wrappers over the preload bridge. */

export type FeatureKind = 'sketch' | 'datum' | 'solid' | 'other'

export interface Feature {
  id: string
  label: string
  opType: string
  kind: FeatureKind
  isTip: boolean
  afterTip?: boolean
  visible: boolean
  error: boolean
}

export interface OriginItem {
  id: string
  label: string
  role: string
  kind: 'plane' | 'axis' | 'point'
  visible: boolean
}

export interface BodyTree {
  id: string
  label: string
  visible: boolean
  features: Feature[]
  origin: OriginItem[]
  /** Feature the rollback marker sits AFTER; null/undefined => at the tip. */
  marker?: string | null
}

export interface DatumDTO {
  id: string
  label: string
  kind: 'plane' | 'axis' | 'point'
  origin: [number, number, number]
  x?: [number, number, number]
  y?: [number, number, number]
  size?: number
  dir?: [number, number, number]
  length?: number
  role?: string
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
  color?: [number, number, number]
  needsNormals?: boolean
  component?: boolean
}

export interface PickPlane {
  id: string
  label: string
  ptype: 'origin' | 'construction'
  role?: string
  origin: [number, number, number]
  x: [number, number, number]
  y: [number, number, number]
  size?: number
}

export interface CanvasDTO {
  id: string
  plane: string
  w: number
  h: number
  offset: [number, number]
  rot: number
  image?: string | null
  frame: { origin: number[]; x: number[]; y: number[] }
}

export type SketchRef =
  | { kind: 'origin'; role: string }
  | { kind: 'plane'; id: string }
  | { kind: 'face'; bodyId: string; sub: string }

export interface SketchRender {
  id: string
  label: string
  polys: number[][]
}

export interface SketchFrameDTO {
  origin: [number, number, number]
  x: [number, number, number]
  y: [number, number, number]
  z: [number, number, number]
}

/** Model geometry under a sketch plane, in plane (u,v) mm, for reference + snap. */
export interface SketchRefGeom {
  polys: number[][][] // [poly][point][u,v]
  points: number[][] // [point][u,v]
}

/** Manual constraint recorded in the 2D editor, resolved on sketch.finish.
 *  refs address geometry drawn this session by `new` (index) or pre-existing
 *  geometry by raw `geo` id; `pt` is 1=start 2=end 3=centre for point constraints. */
export interface SketchConstraint {
  type:
    | 'Horizontal'
    | 'Vertical'
    | 'Parallel'
    | 'Perpendicular'
    | 'Equal'
    | 'Tangent'
    | 'Coincident'
    | 'Concentric'
  refs: Array<{ new?: number; geo?: number; sub?: number; pt?: number }>
}

export type Selection =
  | { kind: 'face'; bodyId: string; index: number; sub: string; point: [number, number, number] }
  | { kind: 'edge'; bodyId: string; index: number; sub: string; point: [number, number, number] }
  | { kind: 'body'; bodyId: string }
  | { kind: 'sketch'; sketchId: string }
  | { kind: 'plane'; planeId: string; role?: string; label?: string }

/** A geometry reference the sidecar understands (mirror plane, pattern axis...). */
export type GeomRef =
  | { kind: 'origin'; role: string }
  | { kind: 'plane'; id: string }
  | { kind: 'face'; bodyId: string; sub: string }
  | { kind: 'edge'; bodyId: string; sub: string }

export function selectionToRef(s: Selection): GeomRef | null {
  if (s.kind === 'plane') {
    return s.role ? { kind: 'origin', role: s.role } : { kind: 'plane', id: s.planeId }
  }
  if (s.kind === 'face') return { kind: 'face', bodyId: s.bodyId, sub: s.sub }
  if (s.kind === 'edge') return { kind: 'edge', bodyId: s.bodyId, sub: s.sub }
  return null
}

export interface MeasureResult {
  refs: string[]
  kind?: 'length' | 'area' | 'point' | 'distance'
  length?: number
  area?: number
  perimeter?: number
  point?: [number, number, number]
  distance?: number
  from?: [number, number, number]
  to?: [number, number, number]
  angle?: number
}

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

/** Global in-flight counter so the shell can show a busy indicator. */
let _busy = 0
const _busyListeners = new Set<(n: number) => void>()
export function onBusyChange(fn: (n: number) => void): () => void {
  _busyListeners.add(fn)
  return () => _busyListeners.delete(fn)
}
function bumpBusy(delta: number): void {
  _busy = Math.max(0, _busy + delta)
  for (const l of _busyListeners) l(_busy)
}

const rpc = async <T,>(m: string, p: Record<string, unknown> = {}): Promise<T> => {
  bumpBusy(1)
  try {
    return await window.cad.rpc<T>(m, p)
  } finally {
    bumpBusy(-1)
  }
}

export const api = {
  ping: () => rpc<{ pong: boolean; freecad: string; build: string }>('ping'),
  resetDocument: () => rpc<{ document: string }>('session.reset'),
  demoPad: (width: number, depth: number, height: number) =>
    rpc<{ bodies: BodyTree[] }>('demo.pad', { width, depth, height }),
  sceneGet: () =>
    rpc<{
      meshes: RenderMesh[]
      sketches: SketchRender[]
      datums: DatumDTO[]
      pickPlanes: PickPlane[]
      canvases: CanvasDTO[]
    }>('scene.get'),
  treeGet: () => rpc<{ bodies: BodyTree[]; path: string | null }>('tree.get'),

  sketchOn: (ref: SketchRef) =>
    rpc<{
      sketchId: string
      bodyId: string
      frame: SketchFrameDTO
      refGeom: SketchRefGeom | null
    }>('sketch.on', { ref }),
  importModel: (path: string) =>
    rpc<{ path: string; imported: string[]; count: number }>('io.importModel', { path }),
  exportModel2: (path: string) => rpc<{ path: string; objects: number }>('io.export', { path }),
  bodyScale: (id: string, factor: number) =>
    rpc<{ id: string; factor: number }>('body.scale', { id, factor }),
  bodyConvertUnits: (id: string, fromUnit: string, toUnit: string) =>
    rpc<{ id: string; factor: number }>('body.convertUnits', { id, fromUnit, toUnit }),
  canvasInsert: (plane: string, widthMm: number, heightMm: number, image: string) =>
    rpc<CanvasDTO>('canvas.insert', { plane, widthMm, heightMm, image }),
  canvasCalibrate: (id: string, realMm: number, measuredMm: number) =>
    rpc<CanvasDTO>('canvas.calibrate', { id, realMm, measuredMm }),
  canvasDelete: (id: string) => rpc<{ deleted: string }>('canvas.delete', { id }),

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
  mirror: (planeRef: GeomRef | null, plane = 'YZ') =>
    rpc<{ bodies: BodyTree[] }>('feature.mirror', { planeRef, plane }),
  datumPlane: (baseRef: GeomRef | null, offset: number, basePlane = 'XY') =>
    rpc<{ bodies: BodyTree[] }>('datum.plane', { baseRef, offset, basePlane }),
  sketchOnPlane: (plane: string) =>
    rpc<{ sketchId: string; bodyId: string; frame: SketchFrameDTO }>('sketch.onPlane', { plane }),
  sketchOnFace: (bodyId: string, face: string) =>
    rpc<{ sketchId: string; bodyId: string; frame: SketchFrameDTO }>('sketch.onFace', {
      bodyId,
      face
    }),
  sketchAddGeometry: (sketchId: string, elements: unknown[]) =>
    rpc<{ sketchId: string; count: number }>('sketch.addGeometry', { sketchId, elements }),
  sketchClear: (sketchId: string) =>
    rpc<{ sketchId: string; count: number }>('sketch.clear', { sketchId }),
  sketchReopen: (sketchId: string) =>
    rpc<{
      sketchId: string
      bodyId: string | null
      frame: SketchFrameDTO
      entities: unknown[]
      refGeom: SketchRefGeom | null
    }>('sketch.reopen', { sketchId }),
  sketchFinish: (sketchId: string, elements?: unknown[], constraints?: SketchConstraint[]) =>
    rpc<{ sketchId: string; count: number; constrained: boolean; closed: boolean }>(
      'sketch.finish',
      { sketchId, elements, constraints }
    ),
  revolve: (sketchId: string, angle: number, axis = 'V', cut = false) =>
    rpc<{ bodies: BodyTree[] }>('feature.revolve', { sketchId, angle, axis, cut }),
  sweep: (profileId: string, pathId: string, cut = false) =>
    rpc<{ bodies: BodyTree[] }>('feature.sweep', { profileId, pathId, cut }),
  loft: (sketchIds: string[], cut = false) =>
    rpc<{ bodies: BodyTree[] }>('feature.loft', { sketchIds, cut }),
  draft: (faces: string[], angle: number, neutral: string | null) =>
    rpc<{ bodies: BodyTree[] }>('feature.draft', { faces, angle, neutral }),
  combine: (op: string, baseBodyId: string | null, toolBodyIds: string[]) =>
    rpc<{ bodies: BodyTree[] }>('feature.combine', { op, baseBodyId, toolBodyIds }),
  splitBody: (bodyId: string, planeRef: GeomRef) =>
    rpc<{ bodies: BodyTree[] }>('body.split', { bodyId, planeRef }),
  sheetBaseFlange: (sketchId: string, thickness: number) =>
    rpc<{ bodies: BodyTree[] }>('sheet.baseFlange', { sketchId, thickness }),
  patternCircular: (count: number, angle: number, axisRef: GeomRef | null, axisPlane = 'XY') =>
    rpc<{ bodies: BodyTree[] }>('pattern.circular', { count, angle, axisRef, axisPlane }),

  measure: (refs: { bodyId: string; sub: string }[]) =>
    rpc<MeasureResult>('measure.compute', { refs }),

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
  setVisibilityGroup: (group: string, visible: boolean) =>
    rpc<{ group: string; visible: boolean }>('visibility.setGroup', { group, visible }),
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
