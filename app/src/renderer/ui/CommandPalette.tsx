import { useEffect, useMemo, useRef, useState } from 'react'
import type { Command } from '../commands'
import { Icon } from './icons'

/** Fusion's 's' search: a centred mini-window to find and run any tool. */
export function CommandPalette({
  commands,
  open,
  onClose
}: {
  commands: Command[]
  open: boolean
  onClose: () => void
}): JSX.Element | null {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setQ('')
      setSel(0)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const scored = commands
      .map((c) => {
        const hay = `${c.title} ${c.group} ${c.tab}`.toLowerCase()
        if (!needle) return { c, score: c.run ? 1 : 0.5 }
        const i = hay.indexOf(needle)
        if (i < 0) {
          // subsequence match
          let k = 0
          for (const ch of hay) if (ch === needle[k]) k++
          return { c, score: k === needle.length ? 0.2 : -1 }
        }
        return { c, score: 3 - i / 100 + (c.run ? 1 : 0) }
      })
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 40)
    return scored.map((x) => x.c)
  }, [q, commands])

  useEffect(() => setSel(0), [q])

  if (!open) return null

  const choose = (c?: Command): void => {
    if (c?.run) {
      void c.run()
      onClose()
    }
  }

  return (
    <div className="palette-scrim" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Search for a tool or command…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setSel((s) => Math.min(s + 1, results.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setSel((s) => Math.max(s - 1, 0))
            } else if (e.key === 'Enter') {
              choose(results[sel])
            } else if (e.key === 'Escape') {
              onClose()
            }
          }}
        />
        <div className="palette-list">
          {results.map((c, i) => {
            const Glyph = Icon[c.icon]
            return (
              <div
                key={c.id}
                className={
                  'palette-row' + (i === sel ? ' sel' : '') + (c.run ? '' : ' soon')
                }
                onMouseEnter={() => setSel(i)}
                onClick={() => choose(c)}
              >
                <span className="palette-ic">
                  <Glyph />
                </span>
                <span className="palette-title">{c.title}</span>
                <span className="palette-group">{c.group}</span>
                {c.hotkey && <span className="palette-key">{c.hotkey}</span>}
                {!c.run && <span className="palette-soon">soon</span>}
              </div>
            )
          })}
          {!results.length && <div className="palette-empty">No matching command</div>}
        </div>
      </div>
    </div>
  )
}
