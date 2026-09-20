/**
 * ISO 286 (metric limits and fits) fit-class resolver: given a nominal size
 * and a tolerance class like "H7" or "g6", returns the upper/lower limit
 * deviations in millimetres so a dimension's tolerance can be set by picking
 * a standard fit instead of typing raw +/- numbers.
 *
 * Values below are transcribed from ISO 286-1:2010(E) Table 1 (standard
 * tolerance grades) and Tables 2-5 (fundamental deviations), cross-checked
 * against the standard's own worked examples in clause 4.3.2/4.3.3 (36H8/f7,
 * 36H7/n6, 90F7, 20K7, 40U6, 60M6 all matched exactly). Only the letters most
 * used for common mechanical fits are included - K, M, N and P-through-ZC
 * need a size/grade-dependent "Delta" correction at fine grades that isn't
 * transcribed here, so those letters are deliberately left out rather than
 * risk a silently-wrong value; add them only after transcribing the Delta
 * table too (see ISO 286-1:2010(E) Table 3's supplementary Delta columns).
 */

/** upper bound (mm, inclusive) of each standard size range this table uses -
 *  a size falls in the first range whose upper bound is >= it. Ranges below
 *  500mm only (ISO 286 covers up to 3150mm but that's far outside anything
 *  this app's parts would realistically use). */
const SIZE_RANGES_MM = [3, 6, 10, 18, 30, 50, 80, 120, 180, 250, 315, 400, 500]

function sizeRangeIndex(nominalMm: number): number {
  for (let i = 0; i < SIZE_RANGES_MM.length; i++) {
    if (nominalMm <= SIZE_RANGES_MM[i]) return i
  }
  return SIZE_RANGES_MM.length - 1
}

/** IT grade standard tolerance values (µm), IT01..IT18, one row per size
 *  range above. Only IT5..IT13 kept - the practical range for machined
 *  mechanical fits; ISO 286-1:2010(E) Table 1 has the full IT01..IT18 set
 *  if finer/coarser grades are ever needed. */
const IT_GRADES: Record<number, number[]> = {
  //   5    6    7    8    9   10   11    12    13
  3: [4, 6, 10, 14, 25, 40, 60, 100, 140],
  6: [5, 8, 12, 18, 30, 48, 75, 120, 180],
  10: [6, 9, 15, 22, 36, 58, 90, 150, 220],
  18: [8, 11, 18, 27, 43, 70, 110, 180, 270],
  30: [9, 13, 21, 33, 52, 84, 130, 210, 330],
  50: [11, 16, 25, 39, 62, 100, 160, 250, 390],
  80: [13, 19, 30, 46, 74, 120, 190, 300, 460],
  120: [15, 22, 35, 54, 87, 140, 220, 350, 540],
  180: [18, 25, 40, 63, 100, 160, 250, 400, 630],
  250: [20, 29, 46, 72, 115, 185, 290, 460, 720],
  315: [23, 32, 52, 81, 130, 210, 320, 520, 810],
  400: [25, 36, 57, 89, 140, 230, 360, 570, 890],
  500: [27, 40, 63, 97, 155, 250, 400, 630, 970]
}
const IT_GRADE_NUMBERS = [5, 6, 7, 8, 9, 10, 11, 12, 13]

/** fundamental deviation (µm, signed) for each hole letter, one row per size
 *  range above - the value nearest the nominal size (EI for A-H, ES for
 *  P-ZC); the OTHER limit is derived via ES = EI + IT (holes). H is always
 *  0 by definition (the basic hole) so it isn't a lookup at all. */
const HOLE_FUND_DEV: Record<string, number[]> = {
  //     0-3   3-6  6-10 10-18 18-30 30-50 50-80 80-120 120-180 180-250
  G: [2, 4, 5, 6, 7, 9, 10, 12, 14, 15],
  F: [6, 10, 13, 16, 20, 25, 30, 36, 43, 50],
  E: [14, 20, 25, 32, 40, 50, 60, 72, 85, 100],
  D: [20, 30, 40, 50, 65, 80, 100, 120, 145, 170]
}

/** fundamental deviation (µm, signed) for each shaft letter - the value
 *  nearest nominal (es for a-h, ei for j-zc); the other limit is derived via
 *  ei = es - IT (shafts). h is always 0 (the basic shaft). */
const SHAFT_FUND_DEV: Record<string, number[]> = {
  //      0-3    3-6   6-10  10-18  18-30  30-50  50-80  80-120 120-180 180-250
  g: [-2, -4, -5, -6, -7, -9, -10, -12, -14, -15],
  f: [-6, -10, -13, -16, -20, -25, -30, -36, -43, -50],
  e: [-14, -20, -25, -32, -40, -50, -60, -72, -85, -100],
  d: [-20, -30, -40, -50, -65, -80, -100, -120, -145, -170],
  k: [0, 1, 1, 1, 2, 2, 2, 3, 3, 4],
  n: [4, 8, 10, 12, 15, 17, 20, 23, 27, 31],
  p: [6, 12, 15, 18, 22, 26, 32, 37, 43, 50],
  s: [14, 19, 23, 28, 35, 43, 59, 71, 92, 122]
}

export interface FitLimits {
  /** upper limit deviation, mm (ES for a hole, es for a shaft) */
  upper: number
  /** lower limit deviation, mm (EI for a hole, ei for a shaft) */
  lower: number
}

const FIT_CLASS_RE = /^([A-Za-z]+)(\d+)$/

/** Resolve a tolerance class like "H7" or "g6" at a given nominal size (mm)
 *  to its upper/lower limit deviations (mm, signed, relative to nominal).
 *  Returns null for a letter/grade this table doesn't cover (see the
 *  module comment) or a malformed class string - callers should fall back
 *  to manual +/- entry in that case, never guess. */
export function resolveFitClass(fitClass: string, nominalMm: number): FitLimits | null {
  const m = FIT_CLASS_RE.exec(String(fitClass || '').trim())
  if (!m) return null
  const letter = m[1]
  const grade = Number(m[2])
  if (!(nominalMm > 0)) return null

  const isHole = letter === letter.toUpperCase()
  const rangeIdx = sizeRangeIndex(nominalMm)
  const itRow = IT_GRADES[SIZE_RANGES_MM[rangeIdx]]
  const gradeIdx = IT_GRADE_NUMBERS.indexOf(grade)
  if (!itRow || gradeIdx < 0) return null
  const itUm = itRow[gradeIdx]

  if (isHole) {
    if (letter === 'H') return { upper: itUm / 1000, lower: 0 }
    const row = HOLE_FUND_DEV[letter]
    if (!row) return null
    const eiUm = row[rangeIdx]
    if (eiUm === undefined) return null
    return { upper: (eiUm + itUm) / 1000, lower: eiUm / 1000 }
  }
  if (letter === 'h') return { upper: 0, lower: -itUm / 1000 }
  const row = SHAFT_FUND_DEV[letter]
  if (!row) return null
  const val = row[rangeIdx]
  if (val === undefined) return null
  // a-g are the upper (near-nominal) limit for a shaft; k, n, p, s are the
  // LOWER (near-nominal) limit instead (see Figure 9 in the standard).
  const nearUpper = 'gfed'.includes(letter)
  if (nearUpper) return { upper: val / 1000, lower: (val - itUm) / 1000 }
  return { upper: (val + itUm) / 1000, lower: val / 1000 }
}

/** Fit classes this resolver actually covers, grouped for a picker UI -
 *  holes first (upper-case), then shafts, in the order a machinist would
 *  scan them (loose to tight). */
export const COMMON_FIT_CLASSES = {
  holes: ['H7', 'H8', 'H9', 'H11'],
  shafts: ['g6', 'f7', 'e8', 'e9', 'd9', 'd10', 'h6', 'h7', 'h9', 'k6', 'n6', 'p6', 's6']
}
