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
  type: SketchConstraintType | 'Distance' | 'Radius' | 'Diameter' | 'Symmetric'
  refs: Array<{ new?: number; geo?: number; sub?: number; pt?: number }>
  value?: number
}

export interface ViewportApi {
  fit: () => void
  setView: (dir: [number, number, number]) => void
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
}
