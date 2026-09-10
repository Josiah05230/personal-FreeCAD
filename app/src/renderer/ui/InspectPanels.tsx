import type { MeasureResult, MassProperties } from '../rpc'

export function MeasurePanel({
  result,
  picks,
  onReset,
  onClose
}: {
  result: MeasureResult | null
  picks: number
  onReset: () => void
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
      {!result && (
        <div className="inspect-hint">
          Click one or two faces / edges / vertices. Two = distance (+ angle).
        </div>
      )}
      <div className="inspect-row" style={{ padding: '6px 12px', alignItems: 'center' }}>
        <span className="inspect-k">{picks} selected</span>
        <button className="inspect-btn" disabled={!picks} onClick={onReset}>
          Reset
        </button>
      </div>
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

const g = (n: number): string => n.toLocaleString(undefined, { maximumSignificantDigits: 5 })
const xyz = (a: number[]): string => a.map((n) => n.toFixed(3)).join(', ')

/** Volume / area / centre of mass, and - when a material with a density is
 *  assigned - real mass and the moment-of-inertia tensor. */
export function MassPropsPanel({
  data,
  onClose
}: {
  data: MassProperties | null
  onClose: () => void
}): JSX.Element {
  return (
    <div className="inspect-panel">
      <div className="inspect-head">
        MASS PROPERTIES
        <button className="inspect-x" onClick={onClose}>
          ×
        </button>
      </div>
      {!data && <div className="inspect-hint">Select one or more bodies.</div>}
      {data && (
        <div className="inspect-body">
          {data.bodies.map((b) => (
            <div key={b.id} className="mass-body">
              <div className="mass-body-name">{b.label}</div>
              <Row k="Volume" v={`${g(b.volume)} mm³`} />
              <Row k="Surface area" v={`${g(b.area)} mm²`} />
              <Row k="Center of mass" v={xyz(b.com)} />
              {b.density != null ? (
                <>
                  <Row k="Density" v={`${(b.density * 1e6).toFixed(3)} g/cm³`} />
                  <Row k="Mass" v={`${g((b.mass ?? 0) * 1000)} g`} />
                  {b.principal && (
                    <Row
                      k="Principal moments"
                      v={b.principal.moments.map((m) => g(m)).join(', ') + ' g·cm²'}
                    />
                  )}
                  {b.inertia && (
                    <div className="mass-tensor">
                      <span className="inspect-k">Inertia tensor (about CoG)</span>
                      <table>
                        <tbody>
                          {b.inertia.map((row, i) => (
                            <tr key={i}>
                              {row.map((c, j) => (
                                <td key={j}>{g(c * 1e6)}</td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <span className="inspect-hint">g·mm² · 10³</span>
                    </div>
                  )}
                </>
              ) : (
                <div className="inspect-hint">
                  Assign a material with a density (Modify → Material) for mass and
                  inertia.
                </div>
              )}
            </div>
          ))}
          {data.bodies.length > 1 && (
            <div className="mass-body">
              <div className="mass-body-name">Combined</div>
              <Row k="Volume" v={`${g(data.combined.volume)} mm³`} />
              <Row
                k="Center of mass (by volume)"
                v={xyz(data.combined.com)}
              />
              {data.combined.mass != null && (
                <>
                  <Row k="Total mass" v={`${g(data.combined.mass * 1000)} g`} />
                  {data.combined.comMass && (
                    <Row k="Center of mass (by mass)" v={xyz(data.combined.comMass)} />
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export interface SectionState {
  /** set once the cut is committed to the model tree; absent while it is a
   *  brand-new, uncommitted cut */
  id?: string
  label?: string
  visible?: boolean
  plane: 'XY' | 'XZ' | 'YZ'
  offset: number
  flip: boolean
}

export function SectionPanel({
  state,
  onChange,
  onOk,
  onCancel
}: {
  state: SectionState
  onChange: (s: SectionState) => void
  /** commit: keep the cut, add / update it in the model tree, close the panel */
  onOk: () => void
  /** discard an uncommitted cut, or just close the panel when editing one */
  onCancel: () => void
}): JSX.Element {
  const committed = !!state.id
  return (
    <div className="inspect-panel">
      <div className="inspect-head">
        {committed ? (state.label ?? 'SECTION') : 'SECTION'}
        <button className="inspect-x" onClick={onCancel}>
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
        <div className="inspect-actions">
          <button className="btn primary" onClick={onOk}>
            {committed ? 'Update' : 'OK'}
          </button>
          <button className="btn" onClick={onCancel}>
            {committed ? 'Close' : 'Cancel'}
          </button>
        </div>
      </div>
    </div>
  )
}
