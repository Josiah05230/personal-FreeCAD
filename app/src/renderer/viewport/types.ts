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
  type: SketchConstraintType | 'Distance' | 'Radius' | 'PointOnObject' | 'Symmetric'
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
  applySketchConstraint: (type: SketchConstraintType) => boolean
  /** enter "pick the geometry" mode for a constraint (no live selection) */
  startSketchConstraint: (type: SketchConstraintType) => void
  pendingSketchConstraint: () => SketchConstraintType | null
  availableSketchConstraints: () => SketchConstraintType[]
  setSketchDimension: (entityIndex: number, value: number) => boolean
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
}
