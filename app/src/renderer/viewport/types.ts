import type { SketchEntity, SketchConstraintType } from './SketchController'

export interface RecordedSketchConstraint {
  type: SketchConstraintType | 'Distance' | 'Radius' | 'PointOnObject'
  refs: Array<{ new?: number; geo?: number; sub?: number; pt?: number }>
  value?: number
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
  setSketchDimension: (entityIndex: number, value: number) => boolean
  sketchSelectedCount: () => number
  /** construction-geometry mode for newly drawn entities */
  setSketchConstruction: (on: boolean) => void
  toggleSketchConstruction: () => boolean
}
