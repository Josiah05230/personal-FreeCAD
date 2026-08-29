import type { SketchTool } from '../viewport/SketchController'

const TOOLS: { id: SketchTool; label: string; glyph: string; key: string }[] = [
  { id: 'select', label: 'Select', glyph: '⤢', key: 'Esc' },
  { id: 'line', label: 'Line', glyph: '╱', key: 'L' },
  { id: 'rect', label: 'Rectangle', glyph: '▭', key: 'R' },
  { id: 'circle', label: 'Circle', glyph: '◯', key: 'C' },
  { id: 'arc', label: 'Arc', glyph: '⌒', key: 'A' }
]

/** Toolbar shown while a sketch is being edited (Fusion's sketch palette). */
export function SketchBar({
  tool,
  onTool,
  onUndo,
  onFinish,
  onCancel,
  count
}: {
  tool: SketchTool
  onTool: (t: SketchTool) => void
  onUndo: () => void
  onFinish: () => void
  onCancel: () => void
  count: number
}): JSX.Element {
  return (
    <div className="sketchbar">
      <span className="sketchbar-label">SKETCH</span>
      <div className="sketchbar-tools">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            className={t.id === tool ? 'sk-tool active' : 'sk-tool'}
            title={`${t.label} (${t.key})`}
            onClick={() => onTool(t.id)}
          >
            <span className="sk-tool-glyph">{t.glyph}</span>
            <span className="sk-tool-label">{t.label}</span>
          </button>
        ))}
      </div>
      <button className="sk-btn" onClick={onUndo} title="Undo (Ctrl+Z)">
        Undo
      </button>
      <span className="sketchbar-spacer" />
      <span className="sketchbar-count">{count} entities</span>
      <button className="sk-btn ghost" onClick={onCancel}>
        Cancel
      </button>
      <button className="sk-btn primary" onClick={onFinish}>
        Finish Sketch
      </button>
    </div>
  )
}
