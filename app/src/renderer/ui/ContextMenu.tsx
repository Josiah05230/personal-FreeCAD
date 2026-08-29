import { useEffect } from 'react'

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
      className="ctxmenu"
      style={{ left: x, top: y }}
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
