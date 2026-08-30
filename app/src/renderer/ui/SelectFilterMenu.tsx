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

/** Ribbon face for the Select group: just the paint / window mode switch. */
export function SelectModeToggle({
  mode,
  onMode
}: {
  mode: SelectMode
  onMode: (m: SelectMode) => void
}): JSX.Element {
  return (
    <div className="selfilter">
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
    </div>
  )
}

/** Contents of the Select group's fold-out: the entity-kind checkboxes. */
export function SelectKindList({
  active,
  onActive
}: {
  active: SelKind[]
  onActive: (next: SelKind[]) => void
}): JSX.Element {
  const toggle = (k: SelKind): void =>
    onActive(active.includes(k) ? active.filter((x) => x !== k) : [...active, k])
  const allOn = KINDS.every((k) => active.includes(k.id))
  return (
    <div className="selfilter-list">
      <div className="selfilter-list-title">Selectable</div>
      <button
        className="selfilter-list-all"
        onClick={() =>
          onActive(allOn ? ['face', 'plane'] : [...KINDS.map((k) => k.id), 'plane'])
        }
      >
        {allOn ? 'Faces only' : 'Select all types'}
      </button>
      {KINDS.map((k) => (
        <label key={k.id} className="selfilter-list-row">
          <input type="checkbox" checked={active.includes(k.id)} onChange={() => toggle(k.id)} />
          <span className="selfilter-glyph">{k.glyph}</span>
          <span>{k.label}</span>
        </label>
      ))}
    </div>
  )
}
