import type { SketchEntity, SketchConstraintType } from './SketchController'
import type { RenderSettings } from '../rpc'

export interface RenderImageOptions {
  width: number
  height: number
  /** null => transparent background */
  background: string | null
  /** supersample factor (1-4); the buffer is rendered at width*ss then downscaled */
  supersample?: number
  format: 'png' | 'jpeg'
  quality?: number
}

export interface RecordedSketchConstraint {
  type: SketchConstraintType | 'Distance' | 'Radius' | 'Diameter' | 'Angle' | 'Symmetric'
  refs: Array<{ new?: number; geo?: number; sub?: number; pt?: number }>
  value?: number
}

export interface ViewportApi {
  fit: () => void
  setView: (dir: [number, number, number]) => void
  getProjection: () => import('./CadControls').Projection
  setProjection: (p: import('./CadControls').Projection) => void
  toggleProjection: () => import('./CadControls').Projection
  getSketchEntities: () => SketchEntity[]
  getNewSketchEntities: () => SketchEntity[]
  loadSketchEntities: (ents: SketchEntity[], cons?: RecordedSketchConstraint[]) => void
  sketchUndo: () => void
  /** manual sketch constraints recorded in the 2D editor */
  getSketchConstraints: () => RecordedSketchConstraint[]
  /** constraints added this session (reopen keeps the originals server-side) */
  getNewSketchConstraints: () => RecordedSketchConstraint[]
  /** reopen-era constraints the user deleted this session (removed on finish) */
  getRemovedSketchConstraints: () => RecordedSketchConstraint[]
  /** reopen-era geometry the user deleted this session, as entity indices */
  getRemovedSketchEntities: () => number[]
  /** reopen-era geometry whose raw SHAPE changed this session (a drag with no
   *  dimension recording it) - finishSketch removes the old copy and adds
   *  the new one via the same removedElements + elements channels a real
   *  delete already uses, since sketch.finish's `elements` is additive-only */
  getEditedBaseSketchEntities: () => Array<{ index: number; entity: SketchEntity }>
  /** reopen-era geometry whose construction flag was flipped this session */
  getConvertedSketchEntities: () => Array<[number, boolean]>
  applySketchConstraint: (type: SketchConstraintType) => boolean
  /** enter "pick the geometry" mode for a constraint (no live selection) */
  startSketchConstraint: (type: SketchConstraintType) => void
  pendingSketchConstraint: () => SketchConstraintType | null
  availableSketchConstraints: () => SketchConstraintType[]
  setSketchDimension: (
    entityIndex: number,
    value: number,
    as?: 'radius' | 'diameter'
  ) => boolean
  /** flip the selected circle/arc dimension radius<->diameter; new kind or null */
  toggleSketchDimKind: () => 'radius' | 'diameter' | null
  /** would a new dimension on this entity over-constrain it? message or null */
  checkSketchDimension: (entityIndex: number) => Promise<string | null>
  /** commit the pending point-to-point / point-to-line distance dimension */
  setSketchDistanceDimension: (value: number) => boolean
  /** current distance between the two dimension-tool picks (for the prompt default) */
  sketchDistancePickValue: () => number | null
  /** world xyz to anchor a floating inline dimension editor at, for this
   *  request (null if nothing sane to anchor to, should not happen live) */
  sketchDimRequestWorldPos: (
    entityIndex: number | null,
    kind: 'linear' | 'radius' | 'distance' | 'angle'
  ) => [number, number, number] | null
  /** current angle (degrees) between the two dim-pick lines, for the
   *  floating editor's pre-fill */
  sketchAnglePickValue: () => number | null
  /** commit the pending angle-between-two-lines dimension (degrees) */
  setSketchAngleDimension: (valueDeg: number) => boolean
  /** project a world xyz to client screen coordinates (null if behind the camera) */
  projectToScreen: (world: [number, number, number]) => { x: number; y: number } | null
  sketchSelectedCount: () => number
  /** construction-geometry mode for newly drawn entities */
  setSketchConstruction: (on: boolean) => void
  toggleSketchConstruction: () => boolean
  /** apply document render settings (shading mode, lighting rig, background) live */
  setRenderSettings: (r: RenderSettings) => void
  /** render the current view to a PNG/JPEG data URL at an arbitrary size + background */
  renderImage: (opts: RenderImageOptions) => Promise<string>

  // --- test hooks: drive the real SketchController without pointer events ---
  testAddSketchEntity: (
    ent: SketchEntity,
    snapTo?: Array<{ idx: number; pt: 1 | 2 | 3 } | null>
  ) => number
  /** draw a multi-click tool (rect-center / circle / arc / ...) through the real
   *  commit() path; returns the index of the first entity it produced */
  testCommitSketchTool: (
    tool: import('./SketchController').SketchTool,
    points: [number, number][],
    snapTo?: Array<{ idx: number; pt: 1 | 2 | 3 } | null>
  ) => number
  testSelectSketch: (indices: number[]) => void
  testSelectSketchPoints: (pts: Array<{ e: number; pt: 1 | 2 | 3 }>) => void
  testSelectSketchDim: (owner: number) => boolean
  testDeleteSketchSelection: () => void
  testToggleSketchConstruction: () => boolean
  /** replace the projected-geometry set (after a sketch.project / unproject) */
  setSketchProjected: (
    projected: Array<{ geoId: number } & SketchEntity>
  ) => void
  getSketchProjected: () => Array<{ geoId: number; ent: SketchEntity }>

  // --- test hook: real synthetic pointer/keyboard events (not the semantic
  // `pick`/`select` bridge shortcuts) need a client X/Y to dispatch at, so an
  // E2E can exercise the ACTUAL Picker raycast / hover / keydown handlers
  // instead of calling onSelect directly - the class of bug that only shows
  // up in the real interactive path (see docs/status.md "Sketcher fixes")
  /** project a world point through the live camera to viewport client
   *  coordinates (clientX/Y, ready for a synthetic PointerEvent), or null if
   *  it is behind the camera / the viewport is not mounted */
  testProjectToScreen: (world: [number, number, number]) => { x: number; y: number } | null
  /** sketch-plane uv -> world xyz, while a sketch is open (test hook) */
  testSketchUVToWorld: (u: number, v: number) => [number, number, number] | null
  /** world-space scale.x of the first constraint-symbol sprite, while a
   *  sketch is open (test hook - verifies rescaleScreenSpace tracks zoom) */
  testSymbolWorldScale: () => number | null
  /** current "click the constraint, then click the geometry" pick state
   *  (test hook, diagnostics only - see SketchController.testPendingConState) */
  testPendingConState: () => { pendingCon: string | null; selectedPts: number; selected: number } | null
  /** entity indices the app currently considers fully constrained (test hook) */
  testConstrainedIndices: () => number[]
  /** the actual rendered line color of entity `idx`, as a CSS hex string
   *  (test hook - what is ACTUALLY on screen, not a re-derivation) */
  testEntityColorHex: (idx: number) => string | null
  /** DEBUG test hook: live in-memory geometry of entity `idx` right now */
  testEntitySnapshot: (idx: number) => unknown
  /** total geometry-point handles ACTUALLY rendered right now (test hook -
   *  what is ACTUALLY on screen, catches a deleted entity's points staying
   *  drawn even after its own line is gone) */
  testHandlePointCount: () => number
  /** DEBUG test hook: current dimension-tool picks */
  testDimPicksState: () => unknown
  /** offset the camera + pivot by a world-space delta (test hook only - a
   *  reliable way to perturb the camera for a "does Fit/Home recover?" test
   *  without depending on synthetic drag-event edge cases) */
  testNudgeCamera: (delta: [number, number, number]) => void
  /** raw camera/controls debug snapshot (test hook, diagnostics only) */
  testCameraDebug: () => {
    pos: [number, number, number]
    pivot: [number, number, number]
    lastCenter: [number, number, number]
    lastRadius: number
  } | null
}
