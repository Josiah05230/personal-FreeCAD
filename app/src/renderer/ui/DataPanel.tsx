import { useCallback, useEffect, useRef, useState } from 'react'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { promptText, promptForm } from './PromptDialog'

/**
 * The Data Panel - a vertical banner that slides in from the left edge (toggled
 * by the waffle). Browses directories for designs; resizable; double-click to
 * open; right-click a file or folder for rename / move / git / delete.
 */
export function DataPanel({
  open,
  onOpenFile,
  onNewDesignAt,
  onGitHistory
}: {
  open: boolean
  onOpenFile: (path: string) => void
  onNewDesignAt: (path: string) => void
  onGitHistory: (path: string) => void
}): JSX.Element {
  const [dir, setDir] = useState<string | null>(null)
  const [parent, setParent] = useState<string>('')
  const [items, setItems] = useState<DirEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [thumbs, setThumbs] = useState<Record<string, string | null>>({})
  const [menu, setMenu] = useState<{ x: number; y: number; it: DirEntry } | null>(null)

  const [width, setWidth] = useState<number>(() => {
    const v = Number(localStorage.getItem('gwtcad.datapanel.w'))
    return v >= 180 && v <= 640 ? v : 300
  })
  const resizing = useRef(false)

  const load = useCallback((target?: string): void => {
    window.cad
      .listDir(target)
      .then((r) => {
        setDir(r.dir)
        setParent(r.parent)
        setItems(r.items)
        setError(null)
        setThumbs({})
        for (const it of r.items) {
          if (!it.isDir) {
            window.cad.thumb(it.path).then((t) => setThumbs((m) => ({ ...m, [it.path]: t })))
          }
        }
      })
      .catch((e) => setError(String(e)))
  }, [])

  useEffect(() => {
    if (open && dir === null) load()
  }, [open, dir, load])

  useEffect(() => {
    if (!resizing.current) return
    const onMove = (e: PointerEvent): void => {
      const w = Math.max(180, Math.min(640, e.clientX))
      setWidth(w)
    }
    const onUp = (): void => {
      resizing.current = false
      localStorage.setItem('gwtcad.datapanel.w', String(width))
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  })

  const sep = dir && dir.includes('\\') ? '\\' : '/'

  const newFolder = async (): Promise<void> => {
    if (!dir) return
    const name = await promptText('New folder name')
    if (!name) return
    await window.cad.mkdir(dir + sep + name)
    load(dir)
  }

  const newDesign = async (): Promise<void> => {
    if (!dir) return
    const name = await promptText('New design name', 'Untitled')
    if (!name) return
    const file = name.toLowerCase().endsWith('.fcstd') ? name : name + '.FCStd'
    onNewDesignAt(dir + sep + file)
    load(dir)
  }

  const rename = async (it: DirEntry): Promise<void> => {
    const next = await promptText('Rename', it.name)
    if (!next || next === it.name) return
    await window.cad.move(it.path, it.path.slice(0, -it.name.length) + next)
    load(dir ?? undefined)
  }

  const move = async (it: DirEntry): Promise<void> => {
    const dirs = await window.cad.siblingDirs(it.path)
    const choice = await promptForm('Move to folder', [
      { key: 'dest', label: 'Destination', options: dirs }
    ])
    if (!choice) return
    await window.cad.move(it.path, choice.dest + sep + it.name)
    load(dir ?? undefined)
  }

  const del = async (it: DirEntry): Promise<void> => {
    if (!window.confirm(`Move "${it.name}" to trash?`)) return
    await window.cad.trash(it.path)
    load(dir ?? undefined)
  }

  const menuItems = (it: DirEntry): MenuItem[] =>
    it.isDir
      ? [
          { label: 'Open', onClick: () => load(it.path) },
          { label: 'Rename…', onClick: () => void rename(it) },
          { separator: true, label: '' },
          { label: 'Delete', danger: true, onClick: () => void del(it) }
        ]
      : [
          { label: 'Open', onClick: () => onOpenFile(it.path) },
          { label: 'Rename…', onClick: () => void rename(it) },
          { label: 'Move to folder…', onClick: () => void move(it) },
          { label: 'Git history', onClick: () => onGitHistory(it.path) },
          { separator: true, label: '' },
          { label: 'Delete', danger: true, onClick: () => void del(it) }
        ]

  return (
    <div className={open ? 'datapanel open' : 'datapanel'} style={open ? { width } : undefined}>
      <div className="datapanel-head">
        <span className="datapanel-title">DATA</span>
        <span className="datapanel-actions">
          <button title="New folder" onClick={() => void newFolder()}>
            🗀+
          </button>
          <button title="New design" onClick={() => void newDesign()}>
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
            className={it.isDir ? 'dp-row' : 'dp-row file'}
            onClick={() => it.isDir && load(it.path)}
            onDoubleClick={() => (it.isDir ? load(it.path) : onOpenFile(it.path))}
            onContextMenu={(e) => {
              e.preventDefault()
              setMenu({ x: e.clientX, y: e.clientY, it })
            }}
            title={it.path}
          >
            {!it.isDir && thumbs[it.path] ? (
              <img className="dp-thumb" src={thumbs[it.path] as string} alt="" />
            ) : (
              <span className="dp-ic">{it.isDir ? '▸' : '◈'}</span>
            )}
            <span className="dp-name">{it.name}</span>
          </div>
        ))}
        {dir && !items.length && !error && <div className="dp-empty">No designs here</div>}
      </div>

      {open && (
        <div
          className="datapanel-resize"
          onPointerDown={(e) => {
            e.preventDefault()
            resizing.current = true
          }}
        />
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.it)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}
