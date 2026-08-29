import type { BodyTree } from '../rpc'

const GLYPH: Record<string, string> = {
  sketch: '✎',
  datum: '▱',
  solid: '⬛',
  other: '•'
}

/**
 * Floating history timeline, docked visually to the bottom edge of the viewport
 * (not a window dock - Fusion has none). Milestone 0: display only. Drag-reorder,
 * rollback scrubbing and grouping arrive with Milestone 1.
 */
export function Timeline({ bodies }: { bodies: BodyTree[] }): JSX.Element {
  const feats = bodies[0]?.features ?? []
  return (
    <div className="timeline">
      <div className="tl-controls">
        <button className="tl-btn" title="Go to start" disabled>
          ⏮
        </button>
        <button className="tl-btn" title="Step back" disabled>
          ◀
        </button>
        <button className="tl-btn" title="Step forward" disabled>
          ▶
        </button>
        <button className="tl-btn" title="Go to end" disabled>
          ⏭
        </button>
      </div>
      <div className="tl-track">
        {feats.length === 0 && <span className="tl-empty">No features yet</span>}
        {feats.map((f) => (
          <div
            key={f.id}
            className={
              'tl-chip' + (f.isTip ? ' tip' : '') + (f.error ? ' error' : '')
            }
            title={`${f.label} (${f.type})`}
          >
            <span className="tl-chip-glyph">{GLYPH[f.kind] ?? '•'}</span>
            <span className="tl-chip-label">{f.label}</span>
          </div>
        ))}
        {feats.length > 0 && <div className="tl-marker" title="Rollback marker" />}
      </div>
    </div>
  )
}
