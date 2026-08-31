import { useState } from 'react'
import type { SketchTool, SketchConstraintType } from '../viewport/SketchController'
import { isPinned, type PinMap } from '../ribbonPrefs'

type DrawItem = { id: SketchTool; label: string; glyph: string; key?: string; pin: string }

const DRAW: DrawItem[] = [
  { id: 'select', label: 'Select', glyph: '⤢', key: 'Esc', pin: 'sk.select' },
  { id: 'line', label: 'Line', glyph: '╱', key: 'L', pin: 'sk.line' },
  { id: 'rect', label: 'Rectangle', glyph: '▭', key: 'R', pin: 'sk.rect' },
  { id: 'rect-center', label: 'Center Rectangle', glyph: '⊡', pin: 'sk.rectC' },
  { id: 'circle', label: 'Circle', glyph: '◯', key: 'C', pin: 'sk.circle' },
  { id: 'circle-3p', label: '3-Point Circle', glyph: '◔', pin: 'sk.circle3' },
  { id: 'arc', label: 'Center Arc', glyph: '⌒', key: 'A', pin: 'sk.arc' },
  { id: 'arc-3p', label: '3-Point Arc', glyph: '⌓', pin: 'sk.arc3' },
  { id: 'spline', label: 'Spline', glyph: '∿', pin: 'sk.spline' },
  { id: 'dimension', label: 'Dimension', glyph: '⇤⇥', key: 'D', pin: 'sk.dim' }
]
// shown on the group face by default; the rest live in the fold-out until pinned
const DRAW_DEFAULT = new Set(['sk.select', 'sk.line', 'sk.rect', 'sk.circle', 'sk.arc', 'sk.dim'])

const CONSTRAINTS: { id: SketchConstraintType; label: string; glyph: string; pin: string }[] = [
  { id: 'Horizontal', label: 'Horizontal', glyph: '—', pin: 'skc.h' },
  { id: 'Vertical', label: 'Vertical', glyph: '|', pin: 'skc.v' },
  { id: 'Parallel', label: 'Parallel', glyph: '∥', pin: 'skc.par' },
  { id: 'Perpendicular', label: 'Perpendicular', glyph: '⟂', pin: 'skc.perp' },
  { id: 'Equal', label: 'Equal', glyph: '=', pin: 'skc.eq' },
  { id: 'Tangent', label: 'Tangent', glyph: '◡', pin: 'skc.tan' },
  { id: 'Coincident', label: 'Coincident', glyph: '•', pin: 'skc.coin' },
  { id: 'Concentric', label: 'Concentric', glyph: '◎', pin: 'skc.conc' },
  { id: 'Midpoint', label: 'Midpoint', glyph: '½', pin: 'skc.mid' }
]
const CON_DEFAULT = new Set(['skc.h', 'skc.v', 'skc.par', 'skc.perp', 'skc.eq', 'skc.coin'])

type Row = { pin: string; glyph: string; label: string; onClick: () => void; active?: boolean }

/**
 * Contextual SKETCH tab body - only mounted while a sketch is open. Groups behave
 * like the rest of the ribbon: a fold-out lists every tool with a pin toggle. The
 * fold-out is position:fixed (anchored to the group button) so it is not clipped
 * by the ribbon body's overflow.
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
  constraintCount,
  pins,
  onSetPin
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
  pins: PinMap
  onSetPin: (id: string, pinned: boolean) => void
}): JSX.Element {
  const [menu, setMenu] = useState<{ group: string; x: number; y: number } | null>(null)
  const shown = (pin: string, dflt: Set<string>): boolean =>
    pin in pins ? isPinned(pin, pins) : dflt.has(pin)

  const openAt = (group: string, e: React.MouseEvent): void => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setMenu(menu?.group === group ? null : { group, x: r.left, y: r.bottom + 2 })
  }

  const drawRows: Row[] = DRAW.map((t) => ({
    pin: t.pin,
    glyph: t.glyph,
    label: t.label,
    active: t.id === tool,
    onClick: () => onTool(t.id)
  }))
  const conRows: Row[] = CONSTRAINTS.map((c) => ({
    pin: c.pin,
    glyph: c.glyph,
    label: c.label,
    active: pendingConstraint === c.id,
    onClick: () => onConstraint(c.id)
  }))
  const rows = menu?.group === 'draw' ? drawRows : menu?.group === 'con' ? conRows : []

  return (
    <div className="ribbon-body sketch-ribbon">
      <div className="ribbon-group">
        <div className="ribbon-group-cmds">
          {DRAW.filter((t) => shown(t.pin, DRAW_DEFAULT)).map((t) => (
            <button
              key={t.id}
              className={t.id === tool ? 'ribbon-cmd active' : 'ribbon-cmd'}
              title={t.key ? `${t.label} (${t.key})` : t.label}
              onClick={() => onTool(t.id)}
            >
              <span className="ribbon-cmd-icon">{t.glyph}</span>
              <span className="ribbon-cmd-label">{t.label}</span>
            </button>
          ))}
        </div>
        <button className="ribbon-group-name" onClick={(e) => openAt('draw', e)}>
          Draw <span className="ribbon-group-caret">▾</span>
        </button>
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
          {CONSTRAINTS.filter((c) => shown(c.pin, CON_DEFAULT)).map((c) => (
            <button
              key={c.id}
              className={pendingConstraint === c.id ? 'ribbon-cmd active' : 'ribbon-cmd'}
              title={
                available.includes(c.id) ? c.label : `${c.label} - click, then pick the geometry`
              }
              onClick={() => onConstraint(c.id)}
            >
              <span className="ribbon-cmd-icon">{c.glyph}</span>
              <span className="ribbon-cmd-label">{c.label}</span>
            </button>
          ))}
        </div>
        <button className="ribbon-group-name" onClick={(e) => openAt('con', e)}>
          Constraints{constraintCount ? ` (${constraintCount})` : ''}{' '}
          <span className="ribbon-group-caret">▾</span>
        </button>
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

      {menu && (
        <>
          <div className="ribbon-dd-scrim" onClick={() => setMenu(null)} />
          <div className="ribbon-dd" style={{ left: menu.x, top: menu.y }}>
            {rows.map((r) => {
              const p = isPinned(r.pin, pins)
              return (
                <div
                  key={r.pin}
                  className={r.active ? 'ribbon-dd-item active' : 'ribbon-dd-item'}
                >
                  <span
                    className="ribbon-dd-body"
                    onClick={() => {
                      r.onClick()
                      setMenu(null)
                    }}
                  >
                    <span className="ribbon-dd-ic">{r.glyph}</span>
                    <span>{r.label}</span>
                  </span>
                  <span
                    className={p ? 'ribbon-dd-pin on' : 'ribbon-dd-pin'}
                    title={p ? 'Pinned - click to unpin' : 'Pin to ribbon'}
                    onClick={() => onSetPin(r.pin, !p)}
                  >
                    📌
                  </span>
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
