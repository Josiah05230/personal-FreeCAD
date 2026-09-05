/** Thin typed wrappers over the preload bridge. */

import { trace } from './trace'

export type FeatureKind = 'sketch' | 'datum' | 'solid' | 'other'

export interface Feature {
  id: string
  label: string
  opType: string
  kind: FeatureKind
  isTip: boolean
  afterTip?: boolean
  suppressed?: boolean
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
  ptype?: 'origin' | 'construction'
  visible?: boolean
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

export interface MeshVertex {
  vertex: number
  p: [number, number, number]
}

export interface RenderMesh {
  id: string
  label: string
  positions: number[]
  normals: number[]
  indices: number[]
  faceGroups: FaceGroup[]
  edges: EdgePoly[]
  vertices?: MeshVertex[]
  bbox: { min: [number, number, number]; max: [number, number, number] }
  color?: [number, number, number]
  needsNormals?: boolean
  component?: boolean
  visible?: boolean
  /** cheap shape signature from the sidecar; unchanged => skip client rebuild */
  sig?: string | null
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

/** everything the operation dialog needs to reopen a committed feature */
export interface FeatureEdit {
  id: string
  label: string
  kind: string | null // an OpKind, or null when the feature has no edit dialog
  values?: Record<string, number | string | boolean>
  refs?: {
    profile?: { kind: 'sketch'; id: string } | { kind: 'face'; bodyId: string; sub: string }
    edges?: string[]
    faces?: string[]
    axis?: GeomRef
    /** mirror / pattern: the mirror plane / pattern axis / linear direction */
    planeOrAxis?: GeomRef
    /** mirror / pattern Type=Features: the feature ids to transform */
    features?: string[]
    /** mirror / pattern Type dropdown value ('Body' | 'Features' | 'Faces') */
    scope?: string
  }
  exprs?: Record<string, string>
}

export interface SketchRender {
  id: string
  label: string
  polys: number[][]
  visible?: boolean
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
    | 'Distance'
    | 'Radius'
    | 'PointOnObject'
    | 'Symmetric'
    | 'Midpoint'
  refs: Array<{ new?: number; geo?: number; sub?: number; pt?: number }>
  value?: number
}

export interface SketchSolveDTO {
  geometry: Array<
    | { type: 'line'; a: [number, number]; b: [number, number] }
    | { type: 'circle'; c: [number, number]; r: number }
    | { type: 'arc'; c: [number, number]; r: number; a0: number; a1: number }
    | null
  >
  free: number[]
  fullyConstrained: boolean
}

export type Selection =
  | {
      kind: 'face'
      bodyId: string
      index: number
      sub: string
      point: [number, number, number]
      normal?: [number, number, number]
    }
  | { kind: 'edge'; bodyId: string; index: number; sub: string; point: [number, number, number] }
  | { kind: 'vertex'; bodyId: string; index: number; sub: string; point: [number, number, number] }
  | { kind: 'body'; bodyId: string }
  | { kind: 'sketch'; sketchId: string }
  | { kind: 'plane'; planeId: string; role?: string; label?: string }

/** A geometry reference the sidecar understands (mirror plane, pattern axis...). */
export type GeomRef =
  | { kind: 'origin'; role: string }
  | { kind: 'plane'; id: string }
  | { kind: 'face'; bodyId: string; sub: string }
  | { kind: 'edge'; bodyId: string; sub: string }
  | { kind: 'vertex'; bodyId: string; sub: string }
  | { kind: 'sketch'; id: string; sub?: string }

export interface Param {
  name: string
  expr: string
  value: number | null
}

export function selectionToRef(s: Selection): GeomRef | null {
  if (s.kind === 'plane') {
    return s.role ? { kind: 'origin', role: s.role } : { kind: 'plane', id: s.planeId }
  }
  if (s.kind === 'face') return { kind: 'face', bodyId: s.bodyId, sub: s.sub }
  if (s.kind === 'edge') return { kind: 'edge', bodyId: s.bodyId, sub: s.sub }
  if (s.kind === 'vertex') return { kind: 'vertex', bodyId: s.bodyId, sub: s.sub }
  if (s.kind === 'sketch') return { kind: 'sketch', id: s.sketchId }
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

let _rpcSeq = 0
const _pickParams = (p: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const k of [
    'sketchId',
    'featureId',
    'id',
    'bodyId',
    'length',
    'angle',
    'operation',
    'cut',
    'props',
    'faceRef'
  ]) {
    if (k in p) out[k] = p[k]
  }
  return out
}

const rpc = async <T,>(m: string, p: Record<string, unknown> = {}): Promise<T> => {
  const n = ++_rpcSeq
  bumpBusy(1)
  trace(`rpc #${n} ${m}`, { busy: _busy, p: _pickParams(p) })
  const t = Date.now()
  try {
    const r = await window.cad.rpc<T>(m, p)
    trace(`rpc #${n} ${m} ok`, { ms: Date.now() - t })
    return r
  } catch (e) {
    trace(`rpc #${n} ${m} ERR`, { ms: Date.now() - t, msg: (e as Error)?.message ?? String(e) })
    throw e
  } finally {
    bumpBusy(-1)
  }
}

/** Background calls that must not light the busy indicator (timeline prefetch). */
const rpcQuiet = async <T,>(m: string, p: Record<string, unknown> = {}): Promise<T> => {
  const n = ++_rpcSeq
  trace(`rpcQ #${n} ${m}`, { busy: _busy, p: _pickParams(p) })
  const t = Date.now()
  try {
    const r = await window.cad.rpc<T>(m, p)
    trace(`rpcQ #${n} ${m} ok`, { ms: Date.now() - t })
    return r
  } catch (e) {
    trace(`rpcQ #${n} ${m} ERR`, { ms: Date.now() - t, msg: (e as Error)?.message ?? String(e) })
    throw e
  }
}

export const apiQuiet = {
  rollTo: (bodyId: string, featureId: string | null) =>
    rpcQuiet<{ tip: string | null }>('history.rollTo', { bodyId, featureId }),
  sketchFinish: (
    sketchId: string,
    elements?: unknown[],
    constraints?: unknown[],
    removedConstraints?: unknown[]
  ) =>
    rpcQuiet<{ sketchId: string; count: number; constrained: boolean; closed: boolean }>(
      'sketch.finish',
      { sketchId, elements, constraints, removedConstraints }
    ),
  sketchSolve: (elements: unknown[], constraints: unknown[]) =>
    rpcQuiet<SketchSolveDTO>('sketch.solve', { elements, constraints }),
  /**
   * Fast live-edit path: change an existing feature's params in place and get
   * back only the affected body's mesh. Creates no undo step (see the sidecar's
   * registry._NO_TXN), so one undo still removes the whole preview feature.
   */
  previewUpdate: (featureId: string, props: Record<string, number | boolean>) =>
    rpcQuiet<{ mesh: RenderMesh }>('feature.previewUpdate', { featureId, props }),
  /** live preview when a dress-up's edge / face set changed: re-point its Base
   * in place (no drain + rebuild), returns the body's fresh mesh */
  previewSetBase: (id: string, subs: string[]) =>
    rpcQuiet<{ mesh: RenderMesh }>('feature.previewSetBase', { id, subs }),
  /** delete one feature by id, no spinner - used to discard a live-preview feature */
  deleteFeature: (id: string) => rpcQuiet<{ deleted: string }>('feature.delete', { id }),
  /** read a committed feature's params + refs so its dialog can reopen */
  featureGet: (id: string) => rpcQuiet<FeatureEdit>('feature.get', { id }),
  /** live preview while editing: recompute ONLY this feature, get its body mesh */
  editPreview: (
    id: string,
    values: Record<string, number | string | boolean>,
    refs: FeatureEdit['refs']
  ) => rpcQuiet<{ mesh: RenderMesh }>('feature.editPreview', { id, values, refs }),
  sceneGet: () =>
    rpcQuiet<{
      meshes: RenderMesh[]
      sketches: SketchRender[]
      datums: DatumDTO[]
      pickPlanes: PickPlane[]
      canvases: CanvasDTO[]
    }>('scene.get'),
  treeGet: () => rpcQuiet<{ bodies: BodyTree[]; path: string | null }>('tree.get')
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
  treeGet: () =>
    rpc<{ bodies: BodyTree[]; path: string | null; canUndo?: boolean; canRedo?: boolean }>(
      'tree.get'
    ),
  undo: () =>
    rpc<{ bodies: BodyTree[]; path: string | null; undone: boolean; canUndo: boolean; canRedo: boolean }>(
      'history.undo'
    ),
  redo: () =>
    rpc<{ bodies: BodyTree[]; path: string | null; redone: boolean; canUndo: boolean; canRedo: boolean }>(
      'history.redo'
    ),

  sketchOn: (ref: SketchRef) =>
    rpc<{
      sketchId: string
      bodyId: string
      frame: SketchFrameDTO
      refGeom: SketchRefGeom | null
    }>('sketch.on', { ref }),
  importModel: (path: string) =>
    rpc<{ path: string; imported: string[]; count: number }>('io.importModel', { path }),
  kicadImport: (path: string) =>
    rpc<{
      bodies: BodyTree[]
      kicad: { path: string; thickness: number; components: number; size: [number, number, number] }
    }>('kicad.import', { path }),
  kicadReimport: () =>
    rpc<{ kicad: { path: string; components: number } }>('kicad.reimport', {}),
  kicadStatus: () =>
    rpc<{ path?: string; placements?: Record<string, unknown> }>('kicad.status', {}),
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

  extrude: (
    sketchId: string | null,
    length: number,
    cut = false,
    midplane = false,
    reversed = false,
    upToFaceRef: GeomRef | null = null,
    operation: 'join' | 'cut' | 'intersect' | 'newBody' = 'join',
    offset = 0,
    faceRef: { bodyId: string; sub: string } | null = null,
    taper = 0,
    length2 = 0,
    throughAll = false
  ) =>
    rpc<{ bodies: BodyTree[] }>('feature.extrude', {
      sketchId,
      length,
      cut,
      midplane,
      reversed,
      upToFaceRef,
      operation,
      offset,
      faceRef,
      taper,
      length2,
      throughAll
    }),
  fillet: (edges: string[], radius: number) =>
    rpc<{ bodies: BodyTree[] }>('feature.fillet', { edges, radius }),
  /** commit an edit to an existing feature (params + references) in place */
  featureUpdate: (
    id: string,
    values: Record<string, number | string | boolean>,
    refs: FeatureEdit['refs'],
    exprs: Record<string, string> = {}
  ) => rpc<{ bodies: BodyTree[] }>('feature.update', { id, values, refs, exprs }),
  chamfer: (
    edges: string[],
    size: number,
    mode: 'Equal' | 'Two distances' | 'Distance and angle' = 'Equal',
    size2 = 0,
    angle = 45
  ) => rpc<{ bodies: BodyTree[] }>('feature.chamfer', { edges, size, mode, size2, angle }),
  shell: (faces: string[], thickness: number, direction: 'Inside' | 'Outside' | 'Both' = 'Inside') =>
    rpc<{ bodies: BodyTree[] }>('feature.shell', { faces, thickness, direction }),
  hole: (
    face: string,
    point: number[],
    diameter: number,
    depth: number,
    throughAll: boolean,
    cutType: 'None' | 'Counterbore' | 'Countersink' = 'None',
    cutDiameter = 0,
    cutDepth = 0,
    csAngle = 90
  ) =>
    rpc<{ bodies: BodyTree[] }>('feature.hole', {
      face,
      point,
      diameter,
      depth,
      throughAll,
      cutType,
      cutDiameter,
      cutDepth,
      csAngle
    }),
  bodyTransform: (id: string, translate: number[], rotate: number[], relative = true) =>
    rpc<{ bodies: BodyTree[] }>('body.transform', { id, translate, rotate, relative }),
  patternLinear: (
    direction: number[],
    count: number,
    spacing: number,
    directionRef: GeomRef | null = null,
    scope: 'body' | 'features' | 'faces' = 'body',
    refs: string[] = [],
    operation: 'join' | 'cut' | 'intersect' | 'newbody' = 'join'
  ) =>
    rpc<{ bodies: BodyTree[] }>('pattern.linear', {
      direction,
      count,
      spacing,
      directionRef,
      scope,
      refs,
      operation
    }),
  mirror: (
    planeRef: GeomRef | null,
    plane = 'YZ',
    scope: 'body' | 'features' | 'faces' = 'body',
    refs: string[] = [],
    operation: 'join' | 'cut' | 'intersect' | 'newbody' = 'join'
  ) =>
    rpc<{ bodies: BodyTree[] }>('feature.mirror', {
      planeRef,
      plane,
      scope,
      refs,
      operation
    }),
  datumPlane: (
    baseRef: GeomRef | null,
    offset: number,
    basePlane = 'XY',
    targetRef: GeomRef | null = null,
    refs: GeomRef[] = [],
    angle = 0,
    flip = false
  ) =>
    rpc<{ bodies: BodyTree[] }>('datum.plane', {
      baseRef,
      offset,
      basePlane,
      targetRef,
      refs,
      angle,
      flip
    }),
  datumPlanePreview: (
    baseRef: GeomRef | null,
    offset: number,
    targetRef: GeomRef | null = null,
    refs: GeomRef[] = [],
    angle = 0,
    flip = false
  ) =>
    rpc<{
      origin: [number, number, number]
      x: [number, number, number]
      y: [number, number, number]
      z: [number, number, number]
      size: number
      distance: number
    }>('datum.planePreview', { baseRef, offset, basePlane: 'XY', targetRef, refs, angle, flip }),
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
      constraints: SketchConstraint[]
      refGeom: SketchRefGeom | null
    }>('sketch.reopen', { sketchId }),
  sketchFinish: (
    sketchId: string,
    elements?: unknown[],
    constraints?: SketchConstraint[],
    removedConstraints?: SketchConstraint[]
  ) =>
    rpc<{ sketchId: string; count: number; constrained: boolean; closed: boolean }>(
      'sketch.finish',
      { sketchId, elements, constraints, removedConstraints }
    ),
  sketchSolve: (elements: unknown[], constraints: SketchConstraint[]) =>
    rpc<SketchSolveDTO>('sketch.solve', { elements, constraints }),
  revolve: (
    sketchId: string | null,
    angle: number,
    axis = 'V',
    cut = false,
    axisRef: GeomRef | null = null,
    faceRef: { bodyId: string; sub: string } | null = null,
    operation: 'join' | 'cut' | 'intersect' | 'newbody' = 'join'
  ) =>
    rpc<{ bodies: BodyTree[] }>('feature.revolve', {
      sketchId,
      angle,
      axis,
      cut,
      axisRef,
      faceRef,
      operation
    }),
  sweep: (
    profileId: string,
    pathId: string | null,
    cut = false,
    pathRef: GeomRef | null = null,
    operation: 'join' | 'cut' | 'intersect' | 'newbody' = 'join',
    orientation: 'Path' | 'Parallel' = 'Path',
    transition: 'Transformed' | 'Right corner' | 'Round corner' = 'Transformed'
  ) =>
    rpc<{ bodies: BodyTree[] }>('feature.sweep', {
      profileId,
      pathId,
      cut,
      pathRef,
      operation,
      orientation,
      transition
    }),
  loft: (
    sketchIds: string[],
    cut = false,
    operation: 'join' | 'cut' | 'intersect' | 'newbody' = 'join',
    ruled = false,
    closed = false
  ) => rpc<{ bodies: BodyTree[] }>('feature.loft', { sketchIds, cut, operation, ruled, closed }),
  draft: (
    faces: string[],
    angle: number,
    neutral: string | null,
    neutralRef: GeomRef | null = null
  ) => rpc<{ bodies: BodyTree[] }>('feature.draft', { faces, angle, neutral, neutralRef }),
  datumAxis: (refs: GeomRef[], offset = 0, flip = false) =>
    rpc<{ bodies: BodyTree[] }>('datum.axis', { refs, offset, flip }),
  datumPoint: (refs: GeomRef[]) => rpc<{ bodies: BodyTree[] }>('datum.point', { refs }),
  featureSuppress: (id: string, suppressed: boolean) =>
    rpc<{ bodies: BodyTree[] }>('feature.suppress', { id, suppressed }),
  combine: (
    op: string,
    baseBodyId: string | null,
    toolBodyIds: string[],
    keepTools = false
  ) => rpc<{ bodies: BodyTree[] }>('feature.combine', { op, baseBodyId, toolBodyIds, keepTools }),
  rib: (sketchId: string, thickness: number, reversed = false) =>
    rpc<{ bodies: BodyTree[] }>('feature.rib', { sketchId, thickness, reversed }),
  bodyCopy: (id: string) => rpc<{ bodies: BodyTree[] }>('body.copy', { id }),
  splitBody: (bodyId: string, planeRef: GeomRef) =>
    rpc<{ bodies: BodyTree[] }>('body.split', { bodyId, planeRef }),

  // --- Move/Copy, Scale, Align (Fusion Modify panel) ---
  moveCopy: (args: {
    ids: string[]
    mode: 'translate' | 'rotate' | 'pointToPoint' | 'pointToPosition'
    dx?: number
    dy?: number
    dz?: number
    axisBase?: number[]
    axisDir?: number[]
    angle?: number
    fromPoint?: number[]
    toPoint?: number[]
    createCopy?: boolean
    copies?: number
  }) => rpc<{ bodies: BodyTree[] }>('body.moveCopy', args),
  scaleBody: (args: {
    id: string | null
    uniform: boolean
    factor?: number
    fx?: number
    fy?: number
    fz?: number
    center?: number[]
  }) => rpc<{ bodies: BodyTree[] }>('body.scaleBody', args),
  alignBody: (moveId: string | null, fromRef: GeomRef | null, toRef: GeomRef | null) =>
    rpc<{ bodies: BodyTree[] }>('body.align', { moveId, fromRef, toRef }),
  interference: (ids: string[] = []) =>
    rpc<{ pairs: { a: string; b: string; volume: number; hasInterference: boolean }[]; totalVolume: number }>(
      'inspect.interference',
      { ids }
    ),
  centerOfMass: (ids: string[] = []) =>
    rpc<{
      bodies: { id: string; com: number[]; volume: number; area: number }[]
      combined: { com: number[]; volume: number }
    }>('inspect.centerOfMass', { ids }),

  // --- Modify panel additions ---
  offsetFace: (faces: string[], distance: number) =>
    rpc<{ bodies: BodyTree[] }>('feature.offsetFace', { faces, distance }),
  splitFace: (faces: string[], planeRef: GeomRef | null) =>
    rpc<{ bodies: BodyTree[] }>('feature.splitFace', { faces, planeRef }),
  pressPull: (subs: string[], distance: number) =>
    rpc<{ bodies: BodyTree[] }>('feature.pressPull', { subs, distance }),

  // --- CREATE: primitives ---
  primBox: (a: { length: number; width: number; height: number; operation: string; planeRef: GeomRef | null }) =>
    rpc<{ bodies: BodyTree[] }>('primitive.box', a),
  primCylinder: (a: { diameter: number; height: number; operation: string; planeRef: GeomRef | null }) =>
    rpc<{ bodies: BodyTree[] }>('primitive.cylinder', a),
  primSphere: (a: { diameter: number; operation: string; planeRef: GeomRef | null }) =>
    rpc<{ bodies: BodyTree[] }>('primitive.sphere', a),
  primTorus: (a: {
    meanDiameter: number
    sectionDiameter: number
    operation: string
    planeRef: GeomRef | null
  }) => rpc<{ bodies: BodyTree[] }>('primitive.torus', a),
  primCoil: (a: {
    diameter: number
    pitch: number
    height: number
    sectionDiameter: number
    turns: number
    operation: string
    planeRef: GeomRef | null
  }) => rpc<{ bodies: BodyTree[] }>('primitive.coil', a),
  primPipe: (a: {
    pathRefs: { bodyId: string; sub: string }[]
    sectionDiameter: number
    wallThickness: number
    operation: string
  }) => rpc<{ bodies: BodyTree[] }>('primitive.pipe', a),

  // --- MESH tab ---
  meshFromBRep: (a: { bodyId: string | null; deflection: number; angularDeflection: number }) =>
    rpc<{ bodies: BodyTree[] }>('mesh.fromBRep', a),
  meshReduce: (a: { id: string | null; targetFactor: number; targetCount: number }) =>
    rpc<{ bodies: BodyTree[] }>('mesh.reduce', a),
  meshSmooth: (a: { id: string | null; iterations: number }) =>
    rpc<{ bodies: BodyTree[] }>('mesh.smooth', a),
  meshPlaneCut: (a: {
    id: string | null
    planeRef: GeomRef | null
    base: number[]
    normal: number[]
    keep: string
    fill: boolean
  }) => rpc<{ bodies: BodyTree[] }>('mesh.planeCut', a),
  meshFlipNormals: (id: string | null) => rpc<{ bodies: BodyTree[] }>('mesh.flipNormals', { id }),
  meshRepair: (a: {
    id: string | null
    fixNormals: boolean
    fillHoles: boolean
    removeNonManifold: boolean
    removeDuplicates: boolean
  }) => rpc<{ bodies: BodyTree[] }>('mesh.repair', a),
  meshSeparate: (id: string | null) => rpc<{ bodies: BodyTree[] }>('mesh.separate', { id }),
  meshToSolid: (a: { id: string | null; mode: string; sewTolerance: number }) =>
    rpc<{ bodies: BodyTree[] }>('mesh.toSolid', a),
  surfaceRuled: (refs: GeomRef[]) => rpc<{ bodies: BodyTree[] }>('surface.ruled', { refs }),
  surfaceFill: (refs: GeomRef[]) => rpc<{ bodies: BodyTree[] }>('surface.fill', { refs }),
  surfaceStitch: (refs: GeomRef[]) => rpc<{ bodies: BodyTree[] }>('surface.stitch', { refs }),
  surfaceOffset: (refs: GeomRef[], distance: number) =>
    rpc<{ bodies: BodyTree[] }>('surface.offset', { refs, distance }),
  sheetBaseFlange: (sketchId: string, thickness: number) =>
    rpc<{ bodies: BodyTree[] }>('sheet.baseFlange', { sketchId, thickness }),
  patternCircular: (
    count: number,
    angle: number,
    axisRef: GeomRef | null,
    axisPlane = 'XY',
    scope: 'body' | 'features' | 'faces' = 'body',
    refs: string[] = [],
    operation: 'join' | 'cut' | 'intersect' | 'newbody' = 'join'
  ) =>
    rpc<{ bodies: BodyTree[] }>('pattern.circular', {
      count,
      angle,
      axisRef,
      axisPlane,
      scope,
      refs,
      operation
    }),

  measure: (refs: { bodyId: string; sub: string }[]) =>
    rpc<MeasureResult>('measure.compute', { refs }),

  exprEval: (text: string, kind: 'length' | 'angle' = 'length') =>
    rpc<{ value: number; expr: string; kind: string }>('expr.eval', { text, kind }),
  paramsList: () => rpc<{ params: Param[] }>('params.list'),
  paramsSet: (name: string, expr: string) =>
    rpc<{ params: Param[]; rebuilt?: boolean }>('params.set', { name, expr }),
  paramsDelete: (name: string) =>
    rpc<{ params: Param[]; rebuilt?: boolean }>('params.delete', { name }),
  featurePrimaryDim: (id: string) =>
    rpc<{
      id: string
      prop: string | null
      value?: number
      expr?: string | null
      kind?: 'length' | 'angle'
    }>('feature.primaryDim', { id }),
  featureExprs: (id: string) =>
    rpc<{ id: string; exprs: Record<string, string> }>('feature.exprs', { id }),
  featureSetExpr: (id: string, prop: string, expr: string) =>
    rpc<{ bodies: BodyTree[] }>('feature.setExpr', { id, prop, expr }),

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
  importStep: (path: string) => rpc<{ path: string }>('io.importStep', { path }),

  // --- Materials ---
  materialPresets: () => rpc<{ families: MaterialFamily[]; total: number }>('material.presets'),
  materialPresetDetail: (uuid: string) => rpc<MaterialDTO>('material.presetDetail', { uuid }),
  materialGet: (targetId?: string | null) =>
    rpc<{ assigned: MaterialDTO | null }>('material.get', { targetId }),
  materialAssign: (targetId: string | null, uuid: string, extra?: Record<string, unknown>) =>
    rpc<{ bodies: BodyTree[] }>('material.assign', { targetId, uuid, extra }),
  materialClear: (targetId?: string | null) =>
    rpc<{ bodies: BodyTree[] }>('material.clear', { targetId }),
  materialCustomList: () => rpc<{ presets: CustomMaterialPreset[] }>('material.customList'),
  materialCustomSave: (
    name: string,
    baseUuid: string,
    appearance?: Record<string, unknown>,
    physical?: Record<string, unknown>,
    extra?: Record<string, unknown>,
    id?: string
  ) =>
    rpc<CustomMaterialPreset>('material.customSave', {
      name,
      baseUuid,
      appearance,
      physical,
      extra,
      id
    }),
  materialCustomDelete: (id: string) => rpc<{ deleted: string }>('material.customDelete', { id }),
  materialCustomAssign: (targetId: string | null, customId: string) =>
    rpc<{ bodies: BodyTree[] }>('material.customAssign', { targetId, customId })
}

export interface MaterialFamily {
  family: string
  materials: { uuid: string; name: string }[]
}

export interface MaterialDTO {
  uuid: string
  name: string
  family?: string
  physical: Record<string, number | string>
  appearance: Record<string, number | string>
  extra?: Record<string, unknown>
}

export interface CustomMaterialPreset {
  id: string
  name: string
  baseUuid: string
  baseName: string
  appearance: Record<string, unknown>
  physical: Record<string, unknown>
  extra: Record<string, unknown>
}
