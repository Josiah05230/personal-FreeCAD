import type { SketchEntity } from './SketchController'

export interface ViewportApi {
  fit: () => void
  setView: (dir: [number, number, number]) => void
  getSketchEntities: () => SketchEntity[]
  getNewSketchEntities: () => SketchEntity[]
  loadSketchEntities: (ents: SketchEntity[]) => void
  sketchUndo: () => void
}
