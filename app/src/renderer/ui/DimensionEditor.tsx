import { useEffect, useRef, useState } from 'react'

/**
 * A dimension's value, floating directly over the dimension it belongs to -
 * not a modal anywhere on screen. Appears the instant a dimension is picked
 * (pre-filled with the live measured value) or double-clicked to retype;
 * Enter/blur commits, Escape cancels, exactly like every other CAD program's
 * in-place dimension editing.
 *
 * Positioning is screen coordinates recomputed by the caller every frame the
 * camera moves (see the `pos` prop) - this component itself is dumb about
 * 3D, it just renders wherever it's told.
 */
export interface DimensionEditorRequest {
  /** screen (client) coordinates to anchor the input at */
  x: number
  y: number
  /** pre-filled text - the live measured value, or the dimension's current one */
  value: string
  /** short hint under the input, e.g. how to type a diameter */
  hint?: string
  onCommit: (text: string) => void
  onCancel: () => void
}

export function DimensionEditor({ req }: { req: DimensionEditorRequest | null }): JSX.Element | null {
  const [text, setText] = useState('')
  const ref = useRef<HTMLInputElement>(null)
  // which request object is currently live, so a new one (even with the same
  // on-screen position) always resets the text and re-focuses
  const reqRef = useRef<DimensionEditorRequest | null>(null)

  useEffect(() => {
    if (req === reqRef.current) return
    reqRef.current = req
    if (!req) return
    setText(req.value)
    // focus + select-all next frame - same pointer-capture race as PromptDialog
    let tries = 0
    let raf = 0
    const grab = (): void => {
      const el = ref.current
      if (el && document.activeElement !== el) {
        el.focus()
        el.select()
      }
      if (++tries < 6) raf = requestAnimationFrame(grab)
    }
    raf = requestAnimationFrame(grab)
    return () => cancelAnimationFrame(raf)
  }, [req])

  if (!req) return null

  const commit = (): void => {
    const t = text.trim()
    if (!t) {
      req.onCancel()
      return
    }
    req.onCommit(t)
  }

  return (
    <div
      className="dim-editor"
      style={{ left: req.x, top: req.y }}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          commit()
        }}
      >
        <input
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              req.onCancel()
            } else if (e.key === 'Enter') {
              // commit directly, rather than relying on a bare keydown to
              // trigger the form's native implicit-submit-on-Enter - that
              // behaviour is tied to a real key press at the UA level and is
              // not guaranteed to fire from a script-dispatched KeyboardEvent
              // (confirmed via a real synthetic-input E2E test: relying on
              // the <form onSubmit> alone left the editor open with the typed
              // value silently discarded)
              e.preventDefault()
              commit()
            }
          }}
          onBlur={() => commit()}
        />
      </form>
      {req.hint && <div className="dim-editor-hint">{req.hint}</div>}
    </div>
  )
}
