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

/** Single-field convenience. Resolves to the string, or null if cancelled. */
export function promptText(
  title: string,
  value = '',
  placeholder = ''
): Promise<string | null> {
  return new Promise((resolve) => {
    if (!_open) return resolve(null)
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
    if (!_open) return resolve(null)
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

  useEffect(() => {
    if (req) firstRef.current?.focus()
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
