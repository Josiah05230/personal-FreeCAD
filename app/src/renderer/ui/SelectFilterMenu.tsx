import { useState } from 'react'

export type SelKind = 'face' | 'edge' | 'sketch' | 'datum' | 'body'
export type SelectMode = 'paint' | 'window'

const KINDS: { id: SelKind; label: string }[] = [
  { id: 'face', label: 'Faces' },
  { id: 'edge', label: 'Edges' },
  { id: 'sketch', label: 'Sketch geometry' },
  { id: 'datum', label: 'Datums / planes' },
  { id: 'body', label: 'Bodies' }
]

/** Ribbon "Select" dropdown: mode (paint/window, exclusive) + entity checkboxes. */
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
  const toggle = (k: SelKind): void =>
    onActive(active.includes(k) ? active.filter((x) => x !== k) : [...active, k])

  return (
    <div className="selmenu">
      <button className="selmenu-btn" onClick={() => setOpen((v) => !v)}>
        <span className="selmenu-ic">◱</span> Select <span className="selmenu-caret">▾</span>
      </button>
      {open && (
        <>
          <div className="selmenu-scrim" onClick={() => setOpen(false)} />
          <div className="selmenu-pop">
            <div className="selmenu-section">Mode</div>
            <label className="selmenu-radio">
              <input
                type="radio"
                name="selmode"
                checked={mode === 'paint'}
                onChange={() => onMode('paint')}
              />
              Paint select (click)
            </label>
            <label className="selmenu-radio">
              <input
                type="radio"
                name="selmode"
                checked={mode === 'window'}
                onChange={() => onMode('window')}
              />
              Window select (drag box)
            </label>
            <div className="selmenu-sep" />
            <div className="selmenu-section">Selectable</div>
            {KINDS.map((k) => (
              <label key={k.id} className="selmenu-check">
                <input
                  type="checkbox"
                  checked={active.includes(k.id)}
                  onChange={() => toggle(k.id)}
                />
                {k.label}
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
