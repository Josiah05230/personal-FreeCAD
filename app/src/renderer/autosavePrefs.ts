/** Autosave preferences - persisted to localStorage, same pattern as
 *  meshPrefs.ts. Autosave writes the REAL file (in-work company parts and
 *  non-company files only - see autosave.ts), so it has an off switch. */

const KEY = 'gwtcad.autosave.prefs'

export interface AutosavePrefs {
  enabled: boolean
  /** minutes an unsaved change may sit before it is saved in the background */
  intervalMin: number
}

export const DEFAULT_AUTOSAVE_PREFS: AutosavePrefs = {
  enabled: true,
  intervalMin: 5
}

export const AUTOSAVE_MIN_INTERVAL = 1
export const AUTOSAVE_MAX_INTERVAL = 120

export function loadAutosavePrefs(): AutosavePrefs {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULT_AUTOSAVE_PREFS }
    const p = { ...DEFAULT_AUTOSAVE_PREFS, ...JSON.parse(raw) } as AutosavePrefs
    const n = Number(p.intervalMin)
    p.intervalMin = Number.isFinite(n)
      ? Math.min(AUTOSAVE_MAX_INTERVAL, Math.max(AUTOSAVE_MIN_INTERVAL, n))
      : DEFAULT_AUTOSAVE_PREFS.intervalMin
    p.enabled = p.enabled !== false
    return p
  } catch {
    return { ...DEFAULT_AUTOSAVE_PREFS }
  }
}

export function saveAutosavePrefs(p: AutosavePrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p))
  } catch {
    /* private mode / disabled storage - just won't persist */
  }
}
