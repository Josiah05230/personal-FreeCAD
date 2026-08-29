import { useState } from 'react'
import type { BodyTree } from '../rpc'
import { ContextMenu, type MenuItem } from './ContextMenu'

export interface BrowserHandlers {
  onToggleVisibility: (id: string, visible: boolean) => void
  onRename: (id: string) => void
  onDelete: (id: string) => void
  onEdit: (id: string) => void
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
  handlers?: BrowserHandlers
  defaultOpen?: boolean
  children?: React.ReactNode
}

function Row({
  depth,
  label,
  glyph,
  id,
  visible,
  handlers,
  defaultOpen = true,
  children
}: RowProps): JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const hasKids = Array.isArray(children) ? children.length > 0 : !!children

  const items: MenuItem[] = id
    ? [
        { label: 'Edit', onClick: () => handlers?.onEdit(id) },
        { label: 'Rename…', onClick: () => handlers?.onRename(id) },
        {
          label: visible ? 'Hide' : 'Show',
          onClick: () => handlers?.onToggleVisibility(id, !visible)
        },
        { separator: true, label: '' },
        { label: 'Delete', danger: true, onClick: () => handlers?.onDelete(id) }
      ]
    : []

  return (
    <div className="br-node">
      <div
        className="br-row"
        style={{ paddingLeft: 6 + depth * 13 }}
        onContextMenu={
          id
            ? (e) => {
                e.preventDefault()
                setMenu({ x: e.clientX, y: e.clientY })
              }
            : undefined
        }
      >
        <span
          className={hasKids ? (open ? 'br-tw open' : 'br-tw') : 'br-tw none'}
          onClick={() => hasKids && setOpen(!open)}
        />
        <span className="br-glyph">{glyph}</span>
        <span className="br-label" onDoubleClick={() => id && handlers?.onEdit(id)}>
          {label}
        </span>
        {id && typeof visible === 'boolean' && (
          <span
            className={visible ? 'br-eye on' : 'br-eye'}
            title={visible ? 'Hide' : 'Show'}
            onClick={(e) => {
              e.stopPropagation()
              handlers?.onToggleVisibility(id, !visible)
            }}
          >
            <Eye on={visible} />
          </span>
        )}
      </div>
      {open && children}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />
      )}
    </div>
  )
}

/** Floating browser panel over the top-left of the canvas. Not a docked sidebar. */
export function Browser({
  bodies,
  handlers,
  visibility
}: {
  bodies: BodyTree[]
  handlers: BrowserHandlers
  visibility: Record<string, boolean>
}): JSX.Element {
  const sketches = bodies.flatMap((b) => b.features.filter((f) => f.kind === 'sketch'))
  const vis = (id: string, fallback: boolean): boolean =>
    id in visibility ? visibility[id] : fallback

  return (
    <div className="browser">
      <Row depth={0} label="Untitled" glyph="◈">
        <Row depth={1} label="Named Views" glyph="◱" defaultOpen={false} />
        <Row depth={1} label="Origin" glyph="✛" defaultOpen={false}>
          <Row depth={2} label="Front" glyph="▱" />
          <Row depth={2} label="Top" glyph="▱" />
          <Row depth={2} label="Right" glyph="▱" />
        </Row>
        <Row depth={1} label="Bodies" glyph="▨">
          {bodies.map((b) => (
            <Row
              key={b.id}
              depth={2}
              label={b.label}
              glyph="▬"
              id={b.id}
              visible={vis(b.id, b.visible)}
              handlers={handlers}
            />
          ))}
        </Row>
        {sketches.length > 0 && (
          <Row depth={1} label="Sketches" glyph="✎">
            {sketches.map((f) => (
              <Row
                key={f.id}
                depth={2}
                label={f.label}
                glyph="✎"
                id={f.id}
                visible={vis(f.id, false)}
                handlers={handlers}
              />
            ))}
          </Row>
        )}
      </Row>
    </div>
  )
}
