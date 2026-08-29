import { useEffect, useRef, useState } from 'react'
import type { BodyTree } from '../rpc'
import { Icon, type IconName } from './icons'
import { ContextMenu, type MenuItem } from './ContextMenu'

const KIND_ICON: Record<string, IconName> = {
  sketch: 'sketch',
  datum: 'plane',
  solid: 'extrude',
  other: 'point'
}

export interface TimelineHandlers {
  onRollTo: (featureId: string | null) => void
  onEdit: (featureId: string) => void
  onRename: (featureId: string) => void
  onDelete: (featureId: string) => void
}

/**
 * History timeline - full-width, bottom-pinned, left-aligned. Play/stop marches
 * the rollback marker; the scrubber drags it; chips are double-clickable and
 * right-clickable.
 */
export function Timeline({
  bodies,
  handlers
}: {
  bodies: BodyTree[]
  handlers: TimelineHandlers
}): JSX.Element {
  const body = bodies[0]
  const feats = body?.features ?? []
  const tipIndex = Math.max(0, feats.findIndex((f) => f.isTip))
  const pos = feats.length ? (feats.some((f) => f.isTip) ? tipIndex : feats.length - 1) : 0

  const [playing, setPlaying] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null)
  const playRef = useRef<number | null>(null)

  useEffect(() => {
    if (!playing) return
    let i = pos
    const step = (): void => {
      i += 1
      if (i >= feats.length) {
        setPlaying(false)
        handlers.onRollTo(null)
        return
      }
      handlers.onRollTo(feats[i].id)
      playRef.current = window.setTimeout(step, 550)
    }
    playRef.current = window.setTimeout(step, 550)
    return () => {
      if (playRef.current) window.clearTimeout(playRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing])

  const jump = (idx: number): void => {
    const clamped = Math.max(0, Math.min(idx, feats.length - 1))
    handlers.onRollTo(clamped >= feats.length - 1 ? null : feats[clamped].id)
  }

  const menuItems = (id: string): MenuItem[] => [
    { label: 'Edit Feature', onClick: () => handlers.onEdit(id) },
    { label: 'Rename…', onClick: () => handlers.onRename(id) },
    { label: 'Roll History Here', onClick: () => handlers.onRollTo(id) },
    { separator: true, label: '' },
    { label: 'Delete', danger: true, onClick: () => handlers.onDelete(id) }
  ]

  return (
    <div className="timeline">
      <div className="tl-controls">
        <button className="tl-btn" title="Beginning" onClick={() => jump(0)} disabled={!feats.length}>
          ⏮
        </button>
        <button
          className="tl-btn"
          title="Step back"
          onClick={() => jump(pos - 1)}
          disabled={!feats.length}
        >
          ◀
        </button>
        <button
          className="tl-btn play"
          title={playing ? 'Stop' : 'Play history'}
          onClick={() => setPlaying((p) => !p)}
          disabled={feats.length < 2}
        >
          {playing ? '■' : '▶'}
        </button>
        <button
          className="tl-btn"
          title="Step forward"
          onClick={() => jump(pos + 1)}
          disabled={!feats.length}
        >
          ▶
        </button>
        <button
          className="tl-btn"
          title="End"
          onClick={() => handlers.onRollTo(null)}
          disabled={!feats.length}
        >
          ⏭
        </button>
      </div>

      <div className="tl-main">
        <div className="tl-track">
          {feats.length === 0 && <span className="tl-empty">No features yet</span>}
          {feats.map((f, i) => {
            const Glyph = Icon[KIND_ICON[f.kind] ?? 'point']
            return (
              <div
                key={f.id}
                className={
                  'tl-chip' +
                  (f.isTip ? ' tip' : '') +
                  (f.error ? ' error' : '') +
                  (i > pos ? ' rolled' : '')
                }
                title={`${f.label}  ·  ${f.opType}`}
                onDoubleClick={() => handlers.onEdit(f.id)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setMenu({ x: e.clientX, y: e.clientY, id: f.id })
                }}
                onClick={() => jump(i)}
              >
                <span className="tl-chip-ic">
                  <Glyph />
                </span>
                <span className="tl-chip-label">{f.label}</span>
              </div>
            )
          })}
        </div>
        {feats.length > 1 && (
          <input
            className="tl-scrub"
            type="range"
            min={0}
            max={feats.length - 1}
            value={pos}
            onChange={(e) => jump(Number(e.target.value))}
          />
        )}
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.id)} onClose={() => setMenu(null)} />
      )}
    </div>
  )
}
