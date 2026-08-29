import { useEffect, useState } from 'react'

/**
 * The Data Panel - a vertical banner that slides in from the left edge (toggled
 * by the waffle). It browses directories for designs; it is not a full file
 * explorer. Opening a design lands with multi-document support (Milestone 1+).
 */
export function DataPanel({
  open,
  onOpenFile
}: {
  open: boolean
  onOpenFile: (path: string) => void
}): JSX.Element {
  const [dir, setDir] = useState<string | null>(null)
  const [parent, setParent] = useState<string>('')
  const [items, setItems] = useState<DirEntry[]>([])
  const [error, setError] = useState<string | null>(null)

  const load = (target?: string): void => {
    window.cad
      .listDir(target)
      .then((r) => {
        setDir(r.dir)
        setParent(r.parent)
        setItems(r.items)
        setError(null)
      })
      .catch((e) => setError(String(e)))
  }

  useEffect(() => {
    if (open && dir === null) load()
  }, [open, dir])

  return (
    <div className={open ? 'datapanel open' : 'datapanel'}>
      <div className="datapanel-head">
        <span className="datapanel-title">DATA</span>
      </div>
      <div className="datapanel-path" title={dir ?? ''}>
        {dir ?? 'Loading…'}
      </div>
      <div className="datapanel-list">
        {dir && (
          <div className="dp-row up" onClick={() => load(parent)}>
            <span className="dp-ic">↰</span>
            <span className="dp-name">..</span>
          </div>
        )}
        {error && <div className="dp-error">{error}</div>}
        {items.map((it) => (
          <div
            key={it.path}
            className="dp-row"
            onClick={() => (it.isDir ? load(it.path) : onOpenFile(it.path))}
            title={it.path}
          >
            <span className="dp-ic">{it.isDir ? '▸' : '◈'}</span>
            <span className="dp-name">{it.name}</span>
          </div>
        ))}
        {dir && !items.length && !error && <div className="dp-empty">No designs here</div>}
      </div>
    </div>
  )
}
