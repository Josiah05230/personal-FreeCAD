export type SelKind = 'face' | 'edge' | 'sketch' | 'body' | 'datum'

const FILTERS: { id: SelKind; label: string; glyph: string }[] = [
  { id: 'face', label: 'Faces', glyph: '◱' },
  { id: 'edge', label: 'Edges', glyph: '╱' },
  { id: 'sketch', label: 'Sketches', glyph: '✎' },
  { id: 'datum', label: 'Datums', glyph: '▱' },
  { id: 'body', label: 'Bodies', glyph: '▬' }
]

/** Fusion-style selection filter - toggle which entity kinds are pickable. */
export function SelectionFilterBar({
  active,
  onChange
}: {
  active: SelKind[]
  onChange: (next: SelKind[]) => void
}): JSX.Element {
  const toggle = (k: SelKind): void =>
    onChange(active.includes(k) ? active.filter((x) => x !== k) : [...active, k])
  const allOn = active.length === FILTERS.length

  return (
    <div className="selfilter">
      <button
        className="selfilter-all"
        title={allOn ? 'Select all types' : 'Enable all'}
        onClick={() => onChange(allOn ? ['face'] : FILTERS.map((f) => f.id))}
      >
        Filter
      </button>
      {FILTERS.map((f) => (
        <button
          key={f.id}
          className={active.includes(f.id) ? 'selfilter-btn on' : 'selfilter-btn'}
          title={f.label}
          onClick={() => toggle(f.id)}
        >
          <span className="selfilter-glyph">{f.glyph}</span>
        </button>
      ))}
    </div>
  )
}
