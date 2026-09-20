import type { DimensionFormat, DimensionType } from './rpc'

export const DEFAULT_DIM_FORMAT: Required<
  Pick<DimensionFormat, 'precision' | 'leadingZero' | 'trailingZeros' | 'unitSuffix'>
> = {
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

/** A tolerance rendered as one or two lines of text, stacked to the right of
 *  the main dimension value the way a real drawing shows it - a single
 *  "±0.05" line for symmetric, or two lines "+0.10"/"-0.05" for deviation
 *  (an asymmetric band, the common case for a real fit). null when
 *  toleranceMode is 'off'/unset or the needed numbers are missing - the
 *  caller draws nothing in that case, same as before tolerances existed. */
export function formatDimensionTolerance(
  fmt: DimensionFormat = {}
): { lines: string[] } | null {
  const mode = fmt.toleranceMode ?? 'off'
  if (mode === 'off') return null
  const precision = Math.max(0, fmt.precision ?? DEFAULT_DIM_FORMAT.precision)
  const fixed = (n: number): string => Math.abs(n).toFixed(precision)
  if (mode === 'symmetric') {
    const t = fmt.tolerancePlus
    if (t === undefined || t === null || !(t >= 0)) return null
    return { lines: [`±${fixed(t)}`] }
  }
  // deviation: plus and minus are independent magnitudes (minus is stored
  // positive - a hole/shaft tolerance band is almost never symmetric, so
  // forcing a sign convention on the input would just invite mistakes;
  // the renderer always shows plus as "+" and minus as "-").
  const plus = fmt.tolerancePlus
  const minus = fmt.toleranceMinus
  if ((plus === undefined || plus === null) && (minus === undefined || minus === null)) return null
  const lines: string[] = []
  lines.push(`+${fixed(plus ?? 0)}`)
  lines.push(`-${fixed(minus ?? 0)}`)
  return { lines }
}
