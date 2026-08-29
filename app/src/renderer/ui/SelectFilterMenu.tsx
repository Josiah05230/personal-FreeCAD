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
 * Fusion-style Select group - always-visible entity-kind toggles plus a
 * paint / window mode switch. Inline in the ribbon, no dropdown.
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
  const toggle = (k: SelKind): void =>
    onActive(active.includes(k) ? active.filter((x) => x !== k) : [...active, k])
  const allOn = KINDS.every((k) => active.includes(k.id))

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
      <div className="selfilter-kinds">
        <button
          className="selfilter-all"
          title={allOn ? 'Only faces' : 'All types'}
          onClick={() =>
            onActive(allOn ? ['face', 'plane'] : [...KINDS.map((k) => k.id), 'plane'])
          }
        >
          {allOn ? 'None' : 'All'}
        </button>
        {KINDS.map((k) => (
          <button
            key={k.id}
            className={active.includes(k.id) ? 'selfilter-btn on' : 'selfilter-btn'}
            title={k.label}
            onClick={() => toggle(k.id)}
          >
            <span className="selfilter-glyph">{k.glyph}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
