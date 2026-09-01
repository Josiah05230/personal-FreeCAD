import { useEffect, useMemo, useRef, useState } from 'react'
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
  onDeleteMany: (featureIds: string[]) => void
  onSuppress: (featureId: string, suppressed: boolean) => void
  onSuppressMany: (featureIds: string[], suppressed: boolean) => void
}

const CHIP_W = 54 // keep in sync with .tl-chip min-width + gap

/**
 * History timeline - full-width, bottom-pinned, left-aligned. A draggable
 * rollback marker sits between feature chips; the model rebuilds to that point.
 *
 * Clicking a chip SELECTS it (shift = range, ctrl/cmd = toggle) so a group of
 * features can be reworked or deleted at once - it does NOT roll history.
 * History rolls only via the marker, the transport buttons, or the right-click
 * "Move timeline here" item, matching how Fusion / SolidWorks behave.
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
  // the scrubber follows the rollback marker (the feature it sits AFTER), not
  // body.Tip - Tip stays at the last feature even while history is rolled back
  const markerId = body?.marker ?? null
  const markerIdx = markerId ? feats.findIndex((f) => f.id === markerId) : -1
  const tipIdx = feats.findIndex((f) => f.isTip)
  const markerAt =
    markerIdx >= 0 ? markerIdx : tipIdx >= 0 ? tipIdx : feats.length - 1

  const [playing, setPlaying] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const anchorRef = useRef<number | null>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const playTimer = useRef<number | null>(null)

  const featIds = feats.map((f) => f.id).join('|')
  // drop selection entries for features that no longer exist (deleted / rolled)
  useEffect(() => {
    setSelected((cur) => {
      if (cur.size === 0) return cur
      const live = new Set(feats.map((f) => f.id))
      let changed = false
      const next = new Set<string>()
      cur.forEach((id) => (live.has(id) ? next.add(id) : (changed = true)))
      return changed ? next : cur
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [featIds])

  const selectedList = useMemo(
    () => feats.filter((f) => selected.has(f.id)).map((f) => f.id),
    [feats, selected]
  )

  const rollToIndex = (idx: number): void => {
    const clamped = Math.max(0, Math.min(idx, feats.length - 1))
    handlers.onRollTo(clamped >= feats.length - 1 ? null : feats[clamped].id)
  }

  const clickChip = (i: number, ev: React.MouseEvent): void => {
    const id = feats[i].id
    if (ev.shiftKey && anchorRef.current != null) {
      const lo = Math.min(anchorRef.current, i)
      const hi = Math.max(anchorRef.current, i)
      const next = new Set(selected)
      for (let k = lo; k <= hi; k++) next.add(feats[k].id)
      setSelected(next)
      return
    }
    if (ev.ctrlKey || ev.metaKey) {
      const next = new Set(selected)
      next.has(id) ? next.delete(id) : next.add(id)
      setSelected(next)
      anchorRef.current = i
      return
    }
    setSelected(new Set([id]))
    anchorRef.current = i
  }

  const clearSelection = (): void => {
    setSelected(new Set())
    anchorRef.current = null
  }

  // Delete / Backspace removes the selected chips; Escape clears the selection
  useEffect(() => {
    if (selected.size === 0) return
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return
      if (e.key === 'Escape') {
        clearSelection()
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        const ids = feats.filter((f) => selected.has(f.id)).map((f) => f.id)
        if (ids.length === 1) handlers.onDelete(ids[0])
        else if (ids.length > 1) handlers.onDeleteMany(ids)
        clearSelection()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, featIds])

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
    // a right-click on a chip that is part of a multi-selection acts on the
    // whole group; otherwise it acts on (and selects) just that chip
    const group = selected.has(id) && selectedList.length > 1 ? selectedList : null
    if (group) {
      const anySuppressed = feats.some((f) => group.includes(f.id) && f.suppressed)
      return [
        {
          label: anySuppressed ? `Unsuppress ${group.length} features` : `Suppress ${group.length} features`,
          onClick: () => handlers.onSuppressMany(group, !anySuppressed)
        },
        { separator: true, label: '' },
        {
          label: `Delete ${group.length} features`,
          danger: true,
          onClick: () => {
            handlers.onDeleteMany(group)
            clearSelection()
          }
        }
      ]
    }
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

      <div
        className="tl-track"
        ref={trackRef}
        onClick={(e) => {
          // a click on empty track space (not a chip) clears the selection
          if (e.target === e.currentTarget) clearSelection()
        }}
      >
        {feats.length === 0 && <span className="tl-empty">No features yet</span>}
        {feats.map((f, i) => {
          const Glyph = Icon[KIND_ICON[f.kind] ?? 'point']
          return (
            <div
              key={f.id}
              className={
                'tl-chip' +
                (f.error ? ' error' : '') +
                (f.afterTip || i > markerAt ? ' rolled' : '') +
                (f.suppressed ? ' suppressed' : '') +
                (selected.has(f.id) ? ' selected' : '')
              }
              title={`${f.label}  ·  ${f.opType}\nClick to select · Shift/Ctrl click to multi-select · double-click to edit`}
              onDoubleClick={() =>
                f.kind === 'sketch' ? handlers.onEdit(f.id) : handlers.onEditDim(f.id)
              }
              onContextMenu={(e) => {
                e.preventDefault()
                if (!selected.has(f.id)) {
                  setSelected(new Set([f.id]))
                  anchorRef.current = i
                }
                setMenu({ x: e.clientX, y: e.clientY, id: f.id })
              }}
              onClick={(e) => clickChip(i, e)}
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
