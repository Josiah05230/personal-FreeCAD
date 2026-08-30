import type { SketchTool, SketchConstraintType } from '../viewport/SketchController'

const TOOLS: { id: SketchTool; label: string; glyph: string; key: string }[] = [
  { id: 'select', label: 'Select', glyph: '⤢', key: 'Esc' },
  { id: 'line', label: 'Line', glyph: '╱', key: 'L' },
  { id: 'rect', label: 'Rectangle', glyph: '▭', key: 'R' },
  { id: 'circle', label: 'Circle', glyph: '◯', key: 'C' },
  { id: 'arc', label: 'Arc', glyph: '⌒', key: 'A' },
  { id: 'dimension', label: 'Dimension', glyph: '⇤⇥', key: 'D' }
]

const CONSTRAINTS: { id: SketchConstraintType; label: string; glyph: string }[] = [
  { id: 'Horizontal', label: 'Horizontal', glyph: '—' },
  { id: 'Vertical', label: 'Vertical', glyph: '|' },
  { id: 'Parallel', label: 'Parallel', glyph: '∥' },
  { id: 'Perpendicular', label: 'Perpendicular', glyph: '⟂' },
  { id: 'Equal', label: 'Equal', glyph: '=' },
  { id: 'Tangent', label: 'Tangent', glyph: '◡' },
  { id: 'Coincident', label: 'Coincident', glyph: '•' },
  { id: 'Concentric', label: 'Concentric', glyph: '◎' },
  { id: 'Midpoint', label: 'Midpoint', glyph: '½' }
]

/**
 * Contextual SKETCH tab body - only mounted while a sketch is open. Replaces the
 * old floating sketch palette; lives inside the ribbon like Fusion.
 */
export function SketchRibbon({
  tool,
  onTool,
  construction,
  onToggleConstruction,
  available,
  pendingConstraint = null,
  onConstraint,
  onUndo,
  onFinish,
  onCancel,
  count,
  constraintCount
}: {
  tool: SketchTool
  onTool: (t: SketchTool) => void
  construction: boolean
  onToggleConstruction: () => void
  available: SketchConstraintType[]
  pendingConstraint?: SketchConstraintType | null
  onConstraint: (t: SketchConstraintType) => void
  onUndo: () => void
  onFinish: () => void
  onCancel: () => void
  count: number
  constraintCount: number
}): JSX.Element {
  return (
    <div className="ribbon-body sketch-ribbon">
      <div className="ribbon-group">
        <div className="ribbon-group-cmds">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              className={t.id === tool ? 'ribbon-cmd active' : 'ribbon-cmd'}
              title={`${t.label} (${t.key})`}
              onClick={() => onTool(t.id)}
            >
              <span className="ribbon-cmd-icon">{t.glyph}</span>
              <span className="ribbon-cmd-label">{t.label}</span>
            </button>
          ))}
        </div>
        <div className="ribbon-group-name">Draw</div>
      </div>

      <div className="ribbon-group">
        <div className="ribbon-group-cmds">
          <button
            className={construction ? 'ribbon-cmd active' : 'ribbon-cmd'}
            title="Construction geometry (X)"
            onClick={onToggleConstruction}
          >
            <span className="ribbon-cmd-icon">┈</span>
            <span className="ribbon-cmd-label">Construction</span>
          </button>
        </div>
        <div className="ribbon-group-name">Mode</div>
      </div>

      <div className="ribbon-group">
        <div className="ribbon-group-cmds">
          {CONSTRAINTS.map((c) => (
            <button
              key={c.id}
              className={pendingConstraint === c.id ? 'ribbon-cmd active' : 'ribbon-cmd'}
              title={
                available.includes(c.id)
                  ? c.label
                  : `${c.label} - click, then pick the geometry`
              }
              onClick={() => onConstraint(c.id)}
            >
              <span className="ribbon-cmd-icon">{c.glyph}</span>
              <span className="ribbon-cmd-label">{c.label}</span>
            </button>
          ))}
        </div>
        <div className="ribbon-group-name">
          Constraints{constraintCount ? ` (${constraintCount})` : ''}
        </div>
      </div>

      <div className="ribbon-group">
        <div className="ribbon-group-cmds">
          <button className="ribbon-cmd" title="Undo (Ctrl+Z)" onClick={onUndo}>
            <span className="ribbon-cmd-icon">↺</span>
            <span className="ribbon-cmd-label">Undo</span>
          </button>
        </div>
        <div className="ribbon-group-name">Edit</div>
      </div>

      <span className="ribbon-tabs-spacer" />

      <div className="sketch-ribbon-finish">
        <span className="sketch-ribbon-count">{count} entities</span>
        <button className="sk-btn ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className="sk-btn primary" onClick={onFinish}>
          Finish Sketch
        </button>
      </div>
    </div>
  )
}
