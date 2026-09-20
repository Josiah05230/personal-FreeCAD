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

  const radialPrefix = RADIAL_PREFIX[type] ?? ''
  const unitSuffix = f.unitSuffix ? (type === 'Angle' || type === 'Angle3Pt' ? '°' : 'mm') : ''
  // user-typed callout text (e.g. "2X ", "4X ", " TYP") wraps AROUND the
  // automatic radial prefix/unit suffix, not instead of them - "2X R4.00"
  // keeps both the count and the fact that it's a radius, not "2X4.00"
  // silently dropping the R.
  return `${fmt.textPrefix ?? ''}${radialPrefix}${s}${unitSuffix}${fmt.textSuffix ?? ''}`
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
  // deviation: tolerancePlus/toleranceMinus are the upper/lower LIMIT
  // DEVIATIONS themselves, genuinely signed (not magnitudes with a forced
  // +/- glyph) - a real ISO fit's two limits are very often the same sign
  // (e.g. f7 is -0.025/-0.050, a clearance shaft with both limits below
  // nominal), which a hardcoded "+ this / - that" display can't represent
  // at all. Each line still gets an explicit leading sign for readability
  // (a bare "0.025" reads ambiguously on a drawing), but that sign now
  // reflects the value's own sign rather than which field it came from.
  const plus = fmt.tolerancePlus
  const minus = fmt.toleranceMinus
  if ((plus === undefined || plus === null) && (minus === undefined || minus === null)) return null
  const signed = (n: number): string => (n < 0 ? `-${fixed(n)}` : `+${fixed(n)}`)
  const lines: string[] = [signed(plus ?? 0), signed(minus ?? 0)]
  return { lines }
}
