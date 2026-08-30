import { useEffect, useRef, useState } from 'react'

export type SelKind = 'face' | 'edge' | 'vertex' | 'sketch' | 'datum' | 'body' | 'plane'
export type SelectMode = 'paint' | 'window'

const KINDS: { id: SelKind; label: string; glyph: string }[] = [
  { id: 'face', label: 'Faces', glyph: '◧' },
  { id: 'edge', label: 'Edges', glyph: '╱' },
  { id: 'vertex', label: 'Vertices', glyph: '•' },
  { id: 'body', label: 'Bodies', glyph: '▦' },
  { id: 'sketch', label: 'Sketch geometry', glyph: '✎' },
  { id: 'datum', label: 'Datums / planes', glyph: '▱' }
]

/**
 * Fusion-style Select group: the ribbon face carries only the paint / window
 * mode switch; the entity-kind checkboxes live in a fold-out you open by
 * clicking "Select".
 */
export function SelectFilterMenu({
  mode,
  onMode,
  active,
  onActive
}: {
  mode: SelectMode
  onMode: (m: SelectMode) => void
  active: SelKind[]
  onActive: (next: SelKind[]) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const toggle = (k: SelKind): void =>
    onActive(active.includes(k) ? active.filter((x) => x !== k) : [...active, k])
  const allOn = KINDS.every((k) => active.includes(k.id))

  return (
    <div className="selfilter" ref={wrapRef}>
      <div className="selfilter-modes">
        <button
          className={mode === 'paint' ? 'selfilter-mode on' : 'selfilter-mode'}
          title="Paint select (click)"
          onClick={() => onMode('paint')}
        >
          Paint
        </button>
        <button
          className={mode === 'window' ? 'selfilter-mode on' : 'selfilter-mode'}
          title="Window select (drag a box)"
          onClick={() => onMode('window')}
        >
          Window
        </button>
      </div>
      <button
        className={open ? 'selfilter-toggle on' : 'selfilter-toggle'}
        title="Choose which kinds of geometry are selectable"
        onClick={() => setOpen((v) => !v)}
      >
        Select <span className="selfilter-caret">▾</span>
      </button>

      {open && (
        <div className="selfilter-pop">
          <button
            className="selfilter-pop-all"
            onClick={() =>
              onActive(allOn ? ['face', 'plane'] : [...KINDS.map((k) => k.id), 'plane'])
            }
          >
            {allOn ? 'Faces only' : 'Select all types'}
          </button>
          {KINDS.map((k) => (
            <label key={k.id} className="selfilter-pop-row">
              <input
                type="checkbox"
                checked={active.includes(k.id)}
                onChange={() => toggle(k.id)}
              />
              <span className="selfilter-glyph">{k.glyph}</span>
              <span>{k.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}
