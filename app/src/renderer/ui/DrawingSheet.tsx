import type { DrawingView } from '../rpc'

function polylinePoints(poly: number[][]): string {
  return poly.map((p) => `${p[0]},${-p[1]}`).join(' ') // flip Y for screen space
}

function ViewSvg({ view }: { view: DrawingView }): JSX.Element {
  const [minX, minY, maxX, maxY] = view.bbox
  const pad = Math.max((maxX - minX) * 0.12, 6)
  const vb = `${minX - pad} ${-(maxY + pad)} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}`
  return (
    <div className="dw-view">
      <div className="dw-view-head">
        {view.label} · {view.direction} · 1:{Math.round(1 / view.scale)}
      </div>
      <svg className="dw-view-svg" viewBox={vb} preserveAspectRatio="xMidYMid meet">
        {view.hidden.map((poly, i) => (
          <polyline
            key={`h${i}`}
            points={polylinePoints(poly)}
            fill="none"
            stroke="#7f8792"
            strokeWidth={0.35}
            strokeDasharray="1.6 1.2"
          />
        ))}
        {view.visible.map((poly, i) => (
          <polyline
            key={`v${i}`}
            points={polylinePoints(poly)}
            fill="none"
            stroke="#e9e9ec"
            strokeWidth={0.6}
          />
        ))}
      </svg>
    </div>
  )
}

/** A drawing sheet: the projected views of the current design. */
export function DrawingSheet({
  views,
  onBack,
  onAddView
}: {
  views: DrawingView[]
  onBack: () => void
  onAddView: (dir: string) => void
}): JSX.Element {
  return (
    <div className="drawing">
      <div className="drawing-bar">
        <button className="drawing-back" onClick={onBack}>
          ← Model
        </button>
        <span className="drawing-title">Drawing</span>
        <span className="drawing-spacer" />
        {['front', 'top', 'right', 'left', 'back', 'bottom', 'iso'].map((d) => (
          <button key={d} className="drawing-adddir" onClick={() => onAddView(d)}>
            + {d}
          </button>
        ))}
      </div>
      <div className="drawing-sheet">
        {views.length === 0 && <div className="drawing-empty">Add a view.</div>}
        <div className="drawing-grid">
          {views.map((v) => (
            <ViewSvg key={v.id} view={v} />
          ))}
        </div>
      </div>
    </div>
  )
}
