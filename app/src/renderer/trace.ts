/**
 * Timestamped action + RPC trace for chasing interaction races (e.g. firing a
 * second op while the engine is still busy with the first).
 *
 * Every line is written to the renderer console, which electron-vite dev pipes
 * into /tmp/gwtcad-run.log as `[renderer:i] [trace ...]`. Lines also collect in
 * an in-memory ring buffer: `window.__trace.dump()` returns the whole thing as
 * text, `window.__trace.rows()` the raw rows.
 *
 * On by default. Disable with `localStorage.setItem('gwtcad.trace', '0')`.
 */

let ON = true
try {
  ON = localStorage.getItem('gwtcad.trace') !== '0'
} catch {
  /* no localStorage (SSR / sandbox) - leave on */
}
export const TRACE_ON = ON

type Row = { t: number; wall: string; evt: string; data?: unknown }
const RING: Row[] = []
const MAX = 5000
const START = Date.now()

function clip(o: unknown): unknown {
  return JSON.parse(
    JSON.stringify(o, (_k, v) => {
      if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : String(v)
      if (typeof v === 'string' && v.length > 140) return v.slice(0, 140) + '...'
      return v
    })
  )
}
function fmt(data?: unknown): string {
  if (data === undefined) return ''
  try {
    return ' ' + JSON.stringify(clip(data))
  } catch {
    return ' <unserialisable>'
  }
}

/** Log one instantaneous event. */
export function trace(evt: string, data?: Record<string, unknown>): void {
  if (!ON) return
  const now = Date.now()
  const wall = new Date(now).toISOString().slice(11, 23) // HH:MM:SS.mmm
  RING.push({ t: now - START, wall, evt, data })
  if (RING.length > MAX) RING.shift()
  // eslint-disable-next-line no-console
  console.log(`[trace ${wall} +${((now - START) / 1000).toFixed(3)}s] ${evt}${fmt(data)}`)
}

/**
 * Log a span: emits `<evt> >` now and returns a function that emits `<evt> <`
 * with the elapsed ms (merge in any extra fields you learn at the end).
 */
export function traceSpan(
  evt: string,
  data?: Record<string, unknown>
): (extra?: Record<string, unknown>) => void {
  if (!ON) return () => {}
  const t = Date.now()
  trace(`${evt} >`, data)
  return (extra?: Record<string, unknown>) => trace(`${evt} <`, { ms: Date.now() - t, ...(extra ?? {}) })
}

export function dumpTrace(): string {
  return RING.map(
    (r) => `+${(r.t / 1000).toFixed(3)}s ${r.wall} ${r.evt}${fmt(r.data)}`
  ).join('\n')
}

try {
  ;(window as unknown as { __trace?: unknown }).__trace = {
    dump: dumpTrace,
    rows: () => RING.slice(),
    on: () => {
      ON = true
      try {
        localStorage.setItem('gwtcad.trace', '1')
      } catch {
        /* ignore */
      }
    },
    off: () => {
      ON = false
      try {
        localStorage.setItem('gwtcad.trace', '0')
      } catch {
        /* ignore */
      }
    }
  }
} catch {
  /* no window */
}
