import { useCallback, useEffect, useState } from 'react'

/**
 * The Data Panel - a vertical banner that slides in from the left edge (toggled
 * by the waffle). Browses directories for designs; New Design / New Folder at
 * any level.
 */
export function DataPanel({
  open,
  onOpenFile,
  onNewDesignAt
}: {
  open: boolean
  onOpenFile: (path: string) => void
  onNewDesignAt: (path: string) => void
}): JSX.Element {
  const [dir, setDir] = useState<string | null>(null)
  const [parent, setParent] = useState<string>('')
  const [items, setItems] = useState<DirEntry[]>([])
  const [error, setError] = useState<string | null>(null)

  const load = useCallback((target?: string): void => {
    window.cad
      .listDir(target)
      .then((r) => {
        setDir(r.dir)
        setParent(r.parent)
        setItems(r.items)
        setError(null)
      })
      .catch((e) => setError(String(e)))
  }, [])

  useEffect(() => {
    if (open && dir === null) load()
  }, [open, dir, load])

  const sep = dir && dir.includes('\\') ? '\\' : '/'

  const newFolder = async (): Promise<void> => {
    if (!dir) return
    const name = window.prompt('New folder name')
    if (!name) return
    await window.cad.mkdir(dir + sep + name)
    load(dir)
  }

  const newDesign = (): void => {
    if (!dir) return
    const name = window.prompt('New design name', 'Untitled')
    if (!name) return
    const file = name.toLowerCase().endsWith('.fcstd') ? name : name + '.FCStd'
    onNewDesignAt(dir + sep + file)
    load(dir)
  }

  return (
    <div className={open ? 'datapanel open' : 'datapanel'}>
      <div className="datapanel-head">
        <span className="datapanel-title">DATA</span>
        <span className="datapanel-actions">
          <button title="New folder" onClick={() => void newFolder()}>
            🗀+
          </button>
          <button title="New design" onClick={newDesign}>
            ◈+
          </button>
        </span>
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
