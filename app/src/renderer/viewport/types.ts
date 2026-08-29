import type { SketchEntity, SketchConstraintType } from './SketchController'

export interface RecordedSketchConstraint {
  type: SketchConstraintType
  refs: Array<{ new?: number; geo?: number; sub?: number; pt?: number }>
}

export interface ViewportApi {
  fit: () => void
  setView: (dir: [number, number, number]) => void
  getSketchEntities: () => SketchEntity[]
  getNewSketchEntities: () => SketchEntity[]
  loadSketchEntities: (ents: SketchEntity[]) => void
  sketchUndo: () => void
  /** manual sketch constraints recorded in the 2D editor */
  getSketchConstraints: () => RecordedSketchConstraint[]
  applySketchConstraint: (type: SketchConstraintType) => boolean
  availableSketchConstraints: () => SketchConstraintType[]
  sketchSelectedCount: () => number
  /** construction-geometry mode for newly drawn entities */
  setSketchConstruction: (on: boolean) => void
  toggleSketchConstruction: () => boolean
}
