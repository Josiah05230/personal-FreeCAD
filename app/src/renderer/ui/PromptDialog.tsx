import { useEffect, useRef, useState } from 'react'

/**
 * Electron's built-in window.prompt() is a no-op ("prompt() is not supported").
 * This is a small promise-based replacement: call promptText(...) anywhere,
 * mount <PromptHost/> once at the app root.
 */

export interface PromptField {
  key: string
  label: string
  value?: string
  placeholder?: string
  /** render as a <select> instead of a text input */
  options?: string[]
}

interface PromptRequest {
  title: string
  fields: PromptField[]
  okLabel?: string
  resolve: (v: Record<string, string> | null) => void
}

let _open: ((req: PromptRequest) => void) | null = null

/** under the --e2e / fuzz harness nobody answers a prompt - auto-cancel so the
 * run never hangs (a real user would hit Escape) */
const _e2e = (): boolean =>
  typeof window !== 'undefined' &&
  !!(window as unknown as { __E2E_ENV?: unknown }).__E2E_ENV

/** Single-field convenience. Resolves to the string, or null if cancelled. */
export function promptText(
  title: string,
  value = '',
  placeholder = ''
): Promise<string | null> {
  return new Promise((resolve) => {
    if (!_open || _e2e()) return resolve(null)
    _open({
      title,
      fields: [{ key: 'v', label: title, value, placeholder }],
      resolve: (r) => resolve(r ? r.v : null)
    })
  })
}

/** Multi-field form. Resolves to a {key: value} map, or null if cancelled. */
export function promptForm(
  title: string,
  fields: PromptField[],
  okLabel = 'OK'
): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    if (!_open || _e2e()) return resolve(null)
    _open({ title, fields, okLabel, resolve })
  })
}

export function PromptHost(): JSX.Element | null {
  const [req, setReq] = useState<PromptRequest | null>(null)
  const [vals, setVals] = useState<Record<string, string>>({})
  const firstRef = useRef<HTMLInputElement | HTMLSelectElement>(null)

  useEffect(() => {
    _open = (r) => {
      setReq(r)
      setVals(Object.fromEntries(r.fields.map((f) => [f.key, f.value ?? (f.options?.[0] ?? '')])))
    }
    return () => {
      _open = null
    }
  }, [])

  // Focus (and select) the first field so the user can just type and hit Enter.
  // A single focus() call can lose the race against pointer capture from the
  // canvas that triggered the prompt, so retry across a few frames.
  useEffect(() => {
    if (!req) return
    let tries = 0
    const grab = (): void => {
      const el = firstRef.current
      if (el && document.activeElement !== el) {
        el.focus()
        if (el instanceof HTMLInputElement) el.select()
      }
      if (++tries < 6) raf = requestAnimationFrame(grab)
    }
    let raf = requestAnimationFrame(grab)
    return () => cancelAnimationFrame(raf)
  }, [req])

  if (!req) return null

  const done = (ok: boolean): void => {
    const r = req
    setReq(null)
    r.resolve(ok ? vals : null)
  }

  return (
    <div className="prompt-scrim" onMouseDown={() => done(false)}>
      <div className="prompt-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="prompt-title">{req.title}</div>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            done(true)
          }}
        >
          {req.fields.map((f, i) => (
            <label key={f.key} className="prompt-field">
              <span>{f.label}</span>
              {f.options ? (
                <select
                  ref={i === 0 ? (firstRef as React.RefObject<HTMLSelectElement>) : undefined}
                  value={vals[f.key] ?? ''}
                  onChange={(e) => setVals((v) => ({ ...v, [f.key]: e.target.value }))}
                >
                  {f.options.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  ref={i === 0 ? (firstRef as React.RefObject<HTMLInputElement>) : undefined}
                  autoFocus={i === 0}
                  value={vals[f.key] ?? ''}
                  placeholder={f.placeholder}
                  onChange={(e) => setVals((v) => ({ ...v, [f.key]: e.target.value }))}
                />
              )}
            </label>
          ))}
          <div className="prompt-buttons">
            <button type="button" className="sk-btn ghost" onClick={() => done(false)}>
              Cancel
            </button>
            <button type="submit" className="sk-btn primary">
              {req.okLabel ?? 'OK'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
