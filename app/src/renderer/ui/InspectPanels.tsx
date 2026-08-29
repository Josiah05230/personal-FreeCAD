import type { MeasureResult } from '../rpc'

export function MeasurePanel({
  result,
  onClose
}: {
  result: MeasureResult | null
  onClose: () => void
}): JSX.Element {
  return (
    <div className="inspect-panel">
      <div className="inspect-head">
        MEASURE
        <button className="inspect-x" onClick={onClose}>
          ×
        </button>
      </div>
      {!result && <div className="inspect-hint">Pick one or two faces / edges / vertices.</div>}
      {result && (
        <div className="inspect-body">
          {result.kind === 'length' && <Row k="Length" v={`${result.length} mm`} />}
          {result.kind === 'area' && (
            <>
              <Row k="Area" v={`${result.area} mm²`} />
              <Row k="Perimeter" v={`${result.perimeter} mm`} />
            </>
          )}
          {result.kind === 'point' && result.point && (
            <Row k="Point" v={result.point.map((n) => n.toFixed(2)).join(', ')} />
          )}
          {result.kind === 'distance' && (
            <>
              <Row k="Distance" v={`${result.distance} mm`} />
              {result.angle != null && <Row k="Angle" v={`${result.angle}°`} />}
            </>
          )}
        </div>
      )}
    </div>
  )
}

function Row({ k, v }: { k: string; v: string }): JSX.Element {
  return (
    <div className="inspect-row">
      <span className="inspect-k">{k}</span>
      <span className="inspect-v">{v}</span>
    </div>
  )
}

export interface SectionState {
  plane: 'XY' | 'XZ' | 'YZ'
  offset: number
  flip: boolean
}

export function SectionPanel({
  state,
  onChange,
  onClose
}: {
  state: SectionState
  onChange: (s: SectionState) => void
  onClose: () => void
}): JSX.Element {
  return (
    <div className="inspect-panel">
      <div className="inspect-head">
        SECTION
        <button className="inspect-x" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="inspect-body">
        <label className="inspect-field">
          <span>Plane</span>
          <select
            value={state.plane}
            onChange={(e) => onChange({ ...state, plane: e.target.value as SectionState['plane'] })}
          >
            <option>XY</option>
            <option>XZ</option>
            <option>YZ</option>
          </select>
        </label>
        <label className="inspect-field">
          <span>Offset</span>
          <input
            type="range"
            min={-200}
            max={200}
            value={state.offset}
            onChange={(e) => onChange({ ...state, offset: Number(e.target.value) })}
          />
        </label>
        <label className="inspect-field">
          <span>Flip</span>
          <input
            type="checkbox"
            checked={state.flip}
            onChange={(e) => onChange({ ...state, flip: e.target.checked })}
          />
        </label>
        <div className="inspect-hint">{state.offset} mm</div>
      </div>
    </div>
  )
}
