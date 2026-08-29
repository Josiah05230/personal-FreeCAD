import type { BodyTree } from '../rpc'
import { Icon } from './icons'
import type { IconName } from './icons'

const KIND_ICON: Record<string, IconName> = {
  sketch: 'sketch',
  datum: 'plane',
  solid: 'extrude',
  other: 'point'
}

/**
 * History timeline - a full-width strip pinned to the bottom edge, content
 * left-aligned (Fusion layout). Display only for Milestone 0; drag-reorder,
 * rollback scrubbing and grouping come with Milestone 1.
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
        {feats.map((f) => {
          const Glyph = Icon[KIND_ICON[f.kind] ?? 'point']
          return (
            <div
              key={f.id}
              className={'tl-chip' + (f.isTip ? ' tip' : '') + (f.error ? ' error' : '')}
              title={`${f.label}  ·  ${f.opType}`}
            >
              <span className="tl-chip-ic">
                <Glyph />
              </span>
              <span className="tl-chip-label">{f.label}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
