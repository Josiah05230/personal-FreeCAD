/** Per-user ribbon customisation: which commands sit on the ribbon face, and
 *  their hotkeys. Backed by localStorage; safe if storage is unavailable. */

const PIN_KEY = 'gwtcad.ribbon.pinned'
const HK_KEY = 'gwtcad.ribbon.hotkeys'

/** Commands shown on the ribbon face out of the box. Everything else is still
 *  reachable through its group's fold-out. */
export const DEFAULT_PINNED = new Set<string>([
  'sketch.create',
  'solid.extrude',
  'solid.revolve',
  'mod.fillet',
  'mod.chamfer',
  'mod.hole',
  'pat.mirror',
  'con.plane',
  'sel.filter',
  // Inspect has only two tools - keep them both on the ribbon by default
  'insp.measure',
  'insp.section',
  // the whole TOOLS tab is pinned out of the box
  'draw.fromDesign',
  'file.new',
  'file.open',
  'file.save',
  'file.saveAs',
  'file.export',
  'file.import',
  'view.fit',
  'panel.data',
  'panel.git'
])

function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? { ...(fallback as object), ...JSON.parse(raw) } : fallback
  } catch {
    return fallback
  }
}
function writeJSON(key: string, val: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(val))
  } catch {
    /* private mode / disabled storage - customisation just won't persist */
  }
}

export type PinMap = Record<string, boolean>
export type HotkeyMap = Record<string, string>

export const loadPinned = (): PinMap => readJSON<PinMap>(PIN_KEY, {})
export const savePinned = (p: PinMap): void => writeJSON(PIN_KEY, p)
export const loadHotkeys = (): HotkeyMap => readJSON<HotkeyMap>(HK_KEY, {})
export const saveHotkeys = (h: HotkeyMap): void => writeJSON(HK_KEY, h)

export function isPinned(id: string, pins: PinMap): boolean {
  return id in pins ? pins[id] : DEFAULT_PINNED.has(id)
}

/** Normalise a KeyboardEvent to a comparable combo string, e.g. "shift+e". */
export function comboFromEvent(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('ctrl')
  if (e.altKey) parts.push('alt')
  if (e.shiftKey) parts.push('shift')
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase()
  parts.push(k)
  return parts.join('+')
}

/** Normalise a user-typed hotkey string ("Shift+E", "ctrl s") the same way. */
export function normaliseCombo(s: string): string {
  const toks = s
    .toLowerCase()
    .split(/[\s+]+/)
    .filter(Boolean)
  const mods = toks.filter((t) => ['ctrl', 'cmd', 'meta', 'alt', 'shift'].includes(t))
  const key = toks.find((t) => !mods.includes(t)) ?? ''
  const order = ['ctrl', 'alt', 'shift'].filter(
    (m) => mods.includes(m) || (m === 'ctrl' && (mods.includes('cmd') || mods.includes('meta')))
  )
  return [...order, key].filter(Boolean).join('+')
}
