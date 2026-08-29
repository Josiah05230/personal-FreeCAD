import { useState } from 'react'
import type { BodyTree, Selection } from '../rpc'
import { ContextMenu, type MenuItem } from './ContextMenu'

export interface BrowserHandlers {
  onToggleVisibility: (id: string, visible: boolean) => void
  onToggleGroup: (group: 'bodies' | 'sketches' | 'origin', visible: boolean) => void
  onRename: (id: string) => void
  onDelete: (id: string) => void
  onEdit: (id: string) => void
  onSelect: (sel: Selection, additive: boolean) => void
}

const Eye = ({ on }: { on: boolean }): JSX.Element =>
  on ? (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M1 6.5 C3 3, 10 3, 12 6.5 C10 10, 3 10, 1 6.5 Z" />
      <circle cx="6.5" cy="6.5" r="1.8" />
    </svg>
  ) : (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M1 6.5 C3 3, 10 3, 12 6.5 C11 8, 9 9.3, 6.5 9.3" />
      <line x1="2" y1="11" x2="11" y2="2" />
    </svg>
  )

interface RowProps {
  depth: number
  label: string
  glyph: string
  id?: string
  visible?: boolean
  onToggle?: (v: boolean) => void
  onPick?: (additive: boolean) => void
  selected?: boolean
  menu?: MenuItem[]
  onEditDbl?: () => void
  defaultOpen?: boolean
  children?: React.ReactNode
}

function Row({
  depth,
  label,
  glyph,
  visible,
  onToggle,
  onPick,
  selected,
  menu,
  onEditDbl,
  defaultOpen = true,
  children
}: RowProps): JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  const [ctx, setCtx] = useState<{ x: number; y: number } | null>(null)
  const hasKids = Array.isArray(children) ? children.length > 0 : !!children

  return (
    <div className="br-node">
      <div
        className={selected ? 'br-row selected' : 'br-row'}
        style={{ paddingLeft: 6 + depth * 13 }}
        onContextMenu={
          menu
            ? (e) => {
                e.preventDefault()
                setCtx({ x: e.clientX, y: e.clientY })
              }
            : undefined
        }
      >
        <span
          className={hasKids ? (open ? 'br-tw open' : 'br-tw') : 'br-tw none'}
          onClick={() => hasKids && setOpen(!open)}
        />
        <span className="br-glyph">{glyph}</span>
        <span
          className="br-label"
          onClick={(e) => onPick?.(e.shiftKey || e.ctrlKey)}
          onDoubleClick={onEditDbl}
        >
          {label}
        </span>
        {typeof visible === 'boolean' && onToggle && (
          <span
            className={visible ? 'br-eye on' : 'br-eye'}
            title={visible ? 'Hide' : 'Show'}
            onClick={(e) => {
              e.stopPropagation()
              onToggle(!visible)
            }}
          >
            <Eye on={visible} />
          </span>
        )}
      </div>
      {open && children}
      {ctx && menu && (
        <ContextMenu x={ctx.x} y={ctx.y} items={menu} onClose={() => setCtx(null)} />
      )}
    </div>
  )
}

/** Floating browser panel over the top-left of the canvas. Not a docked sidebar. */
export function Browser({
  bodies,
  handlers,
  visibility,
  selection
}: {
  bodies: BodyTree[]
  handlers: BrowserHandlers
  visibility: Record<string, boolean>
  selection: Selection[]
}): JSX.Element {
  const vis = (id: string, fallback: boolean): boolean =>
    id in visibility ? visibility[id] : fallback
  const isSel = (pred: (s: Selection) => boolean): boolean => selection.some(pred)

  const b0 = bodies[0]
  const origin = b0?.origin ?? []
  const sketches = bodies.flatMap((b) => b.features.filter((f) => f.kind === 'sketch'))
  const datums = bodies.flatMap((b) => b.features.filter((f) => f.kind === 'datum'))

  const anyOn = (ids: string[], fb: (id: string) => boolean): boolean =>
    ids.some((id) => vis(id, fb(id)))

  const featMenu = (id: string, kind?: 'sketch'): MenuItem[] => [
    { label: kind === 'sketch' ? 'Edit Sketch' : 'Edit', onClick: () => handlers.onEdit(id) },
    { label: 'Rename…', onClick: () => handlers.onRename(id) },
    { separator: true, label: '' },
    { label: 'Delete', danger: true, onClick: () => handlers.onDelete(id) }
  ]

  return (
    <div className="browser">
      <Row depth={0} label="Untitled" glyph="◈">
        <Row
          depth={1}
          label="Origin"
          glyph="✛"
          defaultOpen={false}
          visible={anyOn(
            origin.map((o) => o.id),
            (id) => origin.find((o) => o.id === id)?.visible ?? false
          )}
          onToggle={(v) => handlers.onToggleGroup('origin', v)}
        >
          {origin.map((o) => (
            <Row
              key={o.id}
              depth={2}
              label={o.label}
              glyph={o.kind === 'plane' ? '▱' : o.kind === 'axis' ? '╱' : '•'}
              visible={vis(o.id, o.visible)}
              onToggle={(v) => handlers.onToggleVisibility(o.id, v)}
              onPick={(add) =>
                handlers.onSelect(
                  { kind: 'plane', planeId: o.id, role: o.role, label: o.label },
                  add
                )
              }
              selected={isSel((s) => s.kind === 'plane' && s.planeId === o.id)}
            />
          ))}
        </Row>

        <Row
          depth={1}
          label="Bodies"
          glyph="▨"
          visible={anyOn(
            bodies.map((b) => b.id),
            (id) => bodies.find((b) => b.id === id)?.visible ?? true
          )}
          onToggle={(v) => handlers.onToggleGroup('bodies', v)}
        >
          {bodies.map((b) => (
            <Row
              key={b.id}
              depth={2}
              label={b.label}
              glyph="▬"
              visible={vis(b.id, b.visible)}
              onToggle={(v) => handlers.onToggleVisibility(b.id, v)}
              onPick={(add) => handlers.onSelect({ kind: 'body', bodyId: b.id }, add)}
              selected={isSel((s) => s.kind === 'body' && s.bodyId === b.id)}
              menu={featMenu(b.id)}
              onEditDbl={() => handlers.onEdit(b.id)}
            />
          ))}
        </Row>

        {sketches.length > 0 && (
          <Row
            depth={1}
            label="Sketches"
            glyph="✎"
            visible={anyOn(
              sketches.filter((s) => !s.afterTip).map((s) => s.id),
              (id) => sketches.find((s) => s.id === id)?.visible ?? false
            )}
            onToggle={(v) => handlers.onToggleGroup('sketches', v)}
          >
            {sketches.map((f) =>
              f.afterTip ? (
                <div key={f.id} className="br-row rolled" style={{ paddingLeft: 32 }}>
                  <span className="br-glyph">✎</span>
                  <span className="br-label">{f.label}</span>
                </div>
              ) : (
                <Row
                  key={f.id}
                  depth={2}
                  label={f.label}
                  glyph="✎"
                  visible={vis(f.id, f.visible)}
                  onToggle={(v) => handlers.onToggleVisibility(f.id, v)}
                  menu={featMenu(f.id, 'sketch')}
                />
              )
            )}
          </Row>
        )}

        {datums.length > 0 && (
          <Row depth={1} label="Construction" glyph="▱" defaultOpen={false}>
            {datums.map((f) =>
              f.afterTip ? (
                <div key={f.id} className="br-row rolled" style={{ paddingLeft: 32 }}>
                  <span className="br-glyph">▱</span>
                  <span className="br-label">{f.label}</span>
                </div>
              ) : (
                <Row
                  key={f.id}
                  depth={2}
                  label={f.label}
                  glyph="▱"
                  visible={vis(f.id, f.visible)}
                  onToggle={(v) => handlers.onToggleVisibility(f.id, v)}
                  onPick={(add) =>
                    handlers.onSelect({ kind: 'plane', planeId: f.id, label: f.label }, add)
                  }
                  selected={isSel((s) => s.kind === 'plane' && s.planeId === f.id)}
                  menu={featMenu(f.id)}
                />
              )
            )}
          </Row>
        )}
      </Row>
    </div>
  )
}
