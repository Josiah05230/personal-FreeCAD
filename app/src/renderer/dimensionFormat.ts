import type { DimensionFormat, DimensionType } from './rpc'

export const DEFAULT_DIM_FORMAT: Required<DimensionFormat> = {
  precision: 2,
  leadingZero: true,
  trailingZeros: true,
  unitSuffix: false
}

const RADIAL_PREFIX: Partial<Record<DimensionType, string>> = {
  Radius: 'R',
  Diameter: '⌀'
}

/**
 * Render a dimension's raw measured value (mm for length types, degrees for
 * angle types) as display text, honouring lead/trailing-zero and precision
 * overrides. FreeCAD's own FormatSpec/FormattedValue needs a GUI
 * ViewProvider and is unreadable headlessly (confirmed live), so GWT-CAD
 * always formats client-side from the raw number the sidecar returns.
 */
export function formatDimension(
  value: number,
  type: DimensionType,
  fmt: DimensionFormat = {}
): string {
  const f = { ...DEFAULT_DIM_FORMAT, ...fmt }
  let s = value.toFixed(Math.max(0, f.precision))

  if (!f.trailingZeros && s.includes('.')) {
    s = s.replace(/0+$/, '').replace(/\.$/, '')
  }
  if (!f.leadingZero) {
    s = s.replace(/^(-?)0(\.\d)/, '$1$2')
  }

  const prefix = RADIAL_PREFIX[type] ?? ''
  const suffix = f.unitSuffix ? (type === 'Angle' || type === 'Angle3Pt' ? '°' : 'mm') : ''
  return `${prefix}${s}${suffix}`
}
