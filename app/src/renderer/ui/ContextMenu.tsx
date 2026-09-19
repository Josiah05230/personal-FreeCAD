import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface MenuItem {
  label: string
  onClick?: () => void
  danger?: boolean
  separator?: boolean
  disabled?: boolean
}

/** Lightweight right-click menu positioned at a screen point. */
export function ContextMenu({
  x,
  y,
  items,
  onClose
}: {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const nx = Math.min(x, window.innerWidth - r.width - 8)
    const ny = Math.min(y, window.innerHeight - r.height - 8)
    setPos({ x: Math.max(4, nx), y: Math.max(4, ny) })
  }, [x, y])

  useEffect(() => {
    const h = (): void => onClose()
    window.addEventListener('click', h)
    window.addEventListener('resize', h)
    window.addEventListener('blur', h)
    return () => {
      window.removeEventListener('click', h)
      window.removeEventListener('resize', h)
      window.removeEventListener('blur', h)
    }
  }, [onClose])

  // Rendered via a portal straight to <body>, NOT as a normal child of
  // whatever panel opened it. A `position: fixed` element is only viewport-
  // relative if none of its ancestors set filter/backdrop-filter/transform/
  // perspective - any of those establishes a new containing block per spec,
  // silently turning "fixed" into "relative to that ancestor" instead
  // (confirmed live: the model tree's `.browser` has `backdrop-filter:
  // blur(8px)`, which broke this exact menu - it rendered inside the tree's
  // own scrollable box, inflating its scrollHeight and forcing unwanted
  // scrollbars around the tree every time a context menu opened, and could
  // even trigger the outside-click auto-close before the user saw it).
  // Portaling to `document.body` sidesteps the whole containing-block
  // question for good, regardless of what CSS any future host panel adds.
  return createPortal(
    <div
      ref={ref}
      className="ctxmenu"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) =>
        it.separator ? (
          <div key={i} className="ctx-sep" />
        ) : (
          <div
            key={i}
            className={
              'ctx-item' + (it.danger ? ' danger' : '') + (it.disabled ? ' disabled' : '')
            }
            onClick={() => {
              if (!it.disabled) {
                it.onClick?.()
                onClose()
              }
            }}
          >
            {it.label}
          </div>
        )
      )}
    </div>,
    document.body
  )
}
