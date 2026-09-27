/**
 * Background autosave: the rules, kept out of App.tsx so they read in one
 * place. App owns the timer and the actual save; this decides WHETHER a
 * save may run now (deferReason) and whether the file may be written in
 * place at all (inPlaceBlocker).
 *
 * What gets written in place:
 *  - an in-work company part (registry lifecycle "in_work", and this file
 *    is still the current revision)
 *  - any file that is not a company part (scratch / personal designs)
 * Never in place: a released revision (active / discontinued - saving one
 * makes the next revision, which needs the user), a superseded revision,
 * a PN the local registry doesn't know, or a file someone else holds the
 * lock on. Those keep only the crash-recovery copy (recovery.py).
 *
 * "In the background": the sidecar runs every FreeCAD call on one engine
 * thread, so a save stalls whatever the user does next for its duration
 * (measured ~0.1-0.35s). It only starts when nothing is queued or in
 * flight, no dialog / sketch / preview / prompt is open, no mouse button
 * is held, and the user has not touched mouse or keyboard for a few
 * seconds - otherwise it is deferred and retried shortly after.
 */

// ---- user input activity (window-level, capture phase, passive) ----

let _lastInput = 0
let _pointersDown = 0
let _installed = false

/** Start watching mouse / keyboard / wheel activity. Idempotent. */
export function installInputTracker(): void {
  if (_installed || typeof window === 'undefined') return
  _installed = true
  const bump = (): void => {
    _lastInput = Date.now()
  }
  const opts = { capture: true, passive: true } as const
  window.addEventListener(
    'pointerdown',
    () => {
      _pointersDown++
      bump()
    },
    opts
  )
  const up = (): void => {
    _pointersDown = Math.max(0, _pointersDown - 1)
    bump()
  }
  window.addEventListener('pointerup', up, opts)
  window.addEventListener('pointercancel', up, opts)
  // a lost pointerup (released outside the window) must not block forever
  window.addEventListener(
    'blur',
    () => {
      _pointersDown = 0
    },
    opts
  )
  window.addEventListener(
    'pointermove',
    (e) => {
      if (e.buttons) bump()
    },
    opts
  )
  window.addEventListener('keydown', bump, opts)
  window.addEventListener('wheel', bump, opts)
}

export function msSinceInput(): number {
  return Date.now() - _lastInput
}

/** ms of mouse/keyboard quiet an autosave waits for (test hook shortens it) */
export let AUTOSAVE_QUIET_MS = 4000
export function setAutosaveQuietMs(ms: number): void {
  AUTOSAVE_QUIET_MS = Math.max(0, ms)
}

// ---- rules ----

export interface EngineIdleState {
  engineReady: boolean
  queueBusy: boolean
  rpcInFlight: number
  opOpen: boolean
  sketching: boolean
  previewing: boolean
  promptOpen: boolean
  /** any other modal-ish tool state (dimension editor, plane pick, ...) */
  modalOpen: boolean
  reviewing: boolean
}

/** Why a background save must wait right now, or null when it may run. */
export function deferReason(s: EngineIdleState): string | null {
  if (!s.engineReady) return 'engine not ready'
  if (s.reviewing) return 'reviewing an upstream change'
  if (s.queueBusy) return 'command queue busy'
  if (s.rpcInFlight > 0) return 'engine call in flight'
  if (s.opOpen) return 'operation dialog open'
  if (s.sketching) return 'sketch open'
  if (s.previewing) return 'live preview active'
  if (s.promptOpen) return 'prompt open'
  if (s.modalOpen) return 'tool in progress'
  if (_pointersDown > 0) return 'mouse button held'
  if (msSinceInput() < AUTOSAVE_QUIET_MS) return 'user active'
  return null
}

export interface RegistryRowLite {
  pn: string
  lifecycle?: string
}

/**
 * Why this document may NOT be autosaved over its real file, or null when
 * it may. `pn` is the open document's part number (null = not a company
 * part); `row` is that PN's current registry row (undefined = lookup
 * failed).
 */
export function inPlaceBlocker(opts: {
  pn: string | null
  row: RegistryRowLite | null | undefined
  lockedByOther: boolean
}): string | null {
  if (opts.lockedByOther) return 'someone else has this file open'
  if (!opts.pn) return null
  if (!opts.row) return 'part not found in the local registry'
  if (opts.row.pn !== opts.pn) return `superseded by ${opts.row.pn}`
  if (opts.row.lifecycle !== 'in_work') return `released (${opts.row.lifecycle ?? 'no lifecycle'})`
  return null
}

// ---- ECAD ----
//
// KiCad files are edited in KiCad, not here, so GWT-CAD can't save KiCad's
// unsaved editor state (KiCad has its own auto-save for that). What it can
// do is pick up what KiCad already SAVED into an in-work F part's
// <pn_seq>-kicad/ folder and commit + push it on the same interval. Only
// KiCad source files are taken - never KiCad's lock files (~*.lck), its
// _autosave-* files or its -backups/ zips.

const KICAD_SOURCE =
  /\.(kicad_pcb|kicad_sch|kicad_pro|kicad_sym|kicad_mod|kicad_dru|kicad_wks)$|(^|\/)(fp|sym)-lib-table$/

/** Repo-root-relative paths (from `git status --porcelain`) of the KiCad
 *  source files changed under `kicadDirRel` (also repo-root-relative). */
export function kicadSourceChanges(changed: Array<{ path: string }>, kicadDirRel: string): string[] {
  const dir = kicadDirRel.replace(/\/+$/, '')
  if (!dir) return []
  return changed
    .map((c) => c.path)
    .filter((p) => {
      if (p.includes(' -> ')) return false // a rename - left to a real Save / the Git panel
      if (!p.startsWith(dir + '/')) return false
      if (p.includes('-backups/')) return false
      const name = p.slice(p.lastIndexOf('/') + 1)
      if (name.startsWith('_autosave-') || name.startsWith('~')) return false
      return KICAD_SOURCE.test(p)
    })
}
