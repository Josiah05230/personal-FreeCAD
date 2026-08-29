import { useEffect, useLayoutEffect, useRef, useState } from 'react'

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

  return (
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
    </div>
  )
}
