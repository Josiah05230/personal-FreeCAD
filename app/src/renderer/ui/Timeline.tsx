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
  onEditDim: (featureId: string) => void
  onRename: (featureId: string) => void
  onDelete: (featureId: string) => void
  onSuppress: (featureId: string, suppressed: boolean) => void
}

const CHIP_W = 54 // keep in sync with .tl-chip min-width + gap

/**
 * History timeline - full-width, bottom-pinned, left-aligned. A draggable
 * rollback marker sits between feature chips; the model rebuilds to that point.
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
  const tipIdx = feats.findIndex((f) => f.isTip)
  const markerAt = tipIdx >= 0 ? tipIdx : feats.length - 1

  const [playing, setPlaying] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const playTimer = useRef<number | null>(null)

  const rollToIndex = (idx: number): void => {
    const clamped = Math.max(0, Math.min(idx, feats.length - 1))
    handlers.onRollTo(clamped >= feats.length - 1 ? null : feats[clamped].id)
  }

  useEffect(() => {
    if (!playing) return
    let i = markerAt
    const tick = (): void => {
      i += 1
      if (i >= feats.length) {
        setPlaying(false)
        handlers.onRollTo(null)
        return
      }
      handlers.onRollTo(feats[i].id)
      playTimer.current = window.setTimeout(tick, 550)
    }
    playTimer.current = window.setTimeout(tick, 550)
    return () => {
      if (playTimer.current) window.clearTimeout(playTimer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing])

  // drag the marker (throttled + de-duped so scrubbing does not flood the engine)
  useEffect(() => {
    if (!dragging) return
    let last = -1
    let raf = 0
    const onMove = (e: PointerEvent): void => {
      const el = trackRef.current
      if (!el) return
      const x = e.clientX - el.getBoundingClientRect().left + el.scrollLeft
      const idx = Math.max(0, Math.min(Math.round(x / CHIP_W) - 1, feats.length - 1))
      if (idx === last) return
      if (raf) return
      raf = window.requestAnimationFrame(() => {
        raf = 0
        if (idx === last) return
        last = idx
        rollToIndex(idx)
      })
    }
    const onUp = (): void => {
      if (raf) window.cancelAnimationFrame(raf)
      setDragging(false)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging, feats.length])

  const menuItems = (id: string): MenuItem[] => {
    const f = feats.find((x) => x.id === id)
    return [
      f?.kind === 'sketch'
        ? { label: 'Edit Sketch', onClick: () => handlers.onEdit(id) }
        : { label: 'Edit Value…', onClick: () => handlers.onEditDim(id) },
      { label: 'Rename…', onClick: () => handlers.onRename(id) },
      { label: 'Move timeline here', onClick: () => handlers.onRollTo(id) },
      {
        label: f?.suppressed ? 'Unsuppress' : 'Suppress',
        onClick: () => handlers.onSuppress(id, !f?.suppressed)
      },
      { separator: true, label: '' },
      { label: 'Delete', danger: true, onClick: () => handlers.onDelete(id) }
    ]
  }

  const markerLeft = (markerAt + 1) * CHIP_W

  return (
    <div className="timeline">
      <div className="tl-controls">
        <button className="tl-btn" title="Beginning" onClick={() => rollToIndex(0)} disabled={!feats.length}>
          ⏮
        </button>
        <button className="tl-btn" title="Step back" onClick={() => rollToIndex(markerAt - 1)} disabled={!feats.length}>
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
        <button className="tl-btn" title="Step forward" onClick={() => rollToIndex(markerAt + 1)} disabled={!feats.length}>
          ▶
        </button>
        <button className="tl-btn" title="End" onClick={() => handlers.onRollTo(null)} disabled={!feats.length}>
          ⏭
        </button>
      </div>

      <div className="tl-track" ref={trackRef}>
        {feats.length === 0 && <span className="tl-empty">No features yet</span>}
        {feats.map((f, i) => {
          const Glyph = Icon[KIND_ICON[f.kind] ?? 'point']
          return (
            <div
              key={f.id}
              className={
                'tl-chip' +
                (f.error ? ' error' : '') +
                (i > markerAt ? ' rolled' : '') +
                (f.suppressed ? ' suppressed' : '')
              }
              title={`${f.label}  ·  ${f.opType}`}
              onDoubleClick={() =>
                f.kind === 'sketch' ? handlers.onEdit(f.id) : handlers.onEditDim(f.id)
              }
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu({ x: e.clientX, y: e.clientY, id: f.id })
              }}
              onClick={() => rollToIndex(i)}
            >
              <span className="tl-chip-ic">
                <Glyph />
              </span>
              <span className="tl-chip-label">{f.label}</span>
            </div>
          )
        })}
        {feats.length > 0 && (
          <div
            className={dragging ? 'tl-marker dragging' : 'tl-marker'}
            style={{ left: markerLeft }}
            onPointerDown={(e) => {
              e.preventDefault()
              setDragging(true)
            }}
            title="Drag to roll history"
          >
            <span className="tl-marker-grip" />
          </div>
        )}
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.id)} onClose={() => setMenu(null)} />
      )}
    </div>
  )
}
