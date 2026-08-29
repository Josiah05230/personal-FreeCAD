import type { SketchEntity } from './SketchController'

export interface ViewportApi {
  fit: () => void
  setView: (dir: [number, number, number]) => void
  getSketchEntities: () => SketchEntity[]
  sketchUndo: () => void
}
