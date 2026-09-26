import { useCallback, useEffect, useRef, useState } from 'react'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { promptText, promptForm } from './PromptDialog'
import { api, type PartRecord } from '../rpc'

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

  // "where the company CAD actually lives" hint, per the user's own ask -
  // read once when the panel first opens (company.json rarely changes
  // mid-session; Company Directories already has its own dedicated panel
  // for actually editing it).
  const [companyRepos, setCompanyRepos] = useState<{ code: string; path: string }[]>([])
  useEffect(() => {
    if (!open) return
    void api
      .pnGetCompanyConfig()
      .then((cfg) => {
        const seen = new Map<string, string>()
        for (const [code, p] of Object.entries(cfg.projects || {})) {
          if (p?.repoPath) seen.set(p.repoPath, code) // de-dupe: every project code can share one repo
        }
        setCompanyRepos([...seen.entries()].map(([path, code]) => ({ code, path })))
      })
      .catch(() => setCompanyRepos([]))
  }, [open])

  // PN registry metadata (name/description), keyed by filename - "<PN>.FCStd"
  // is always exactly the registry's own pn field, so this joins cleanly
  // regardless of which folder a file happens to sit in or how deep the
  // structure goes. Used for (a) showing name/description inline next to
  // every design row, for human readability regardless of search state,
  // and (b) letting a search match on name/description text, not just the
  // filename - e.g. typing "connector" finds CMC0010.FCStd even though
  // "connector" appears nowhere in that filename.
  const [pnByFilename, setPnByFilename] = useState<Map<string, PartRecord>>(new Map())
  useEffect(() => {
    if (!open) return
    void api
      .pnListAll()
      .then((r) => {
        const m = new Map<string, PartRecord>()
        for (const row of r.parts) m.set(`${row.pn}.FCStd`.toLowerCase(), row)
        setPnByFilename(m)
      })
      .catch(() => setPnByFilename(new Map()))
  }, [open])

  // search: recursive from the CURRENTLY BROWSED folder down (highest
  // level first, then each deeper level - see searchDir's own doc comment
  // for why breadth-first gives that ordering for free), not the whole
  // disk - matches how the model-tree Browser's own search is scoped to
  // what's actually in view, not everything that could ever exist. Also
  // matches PN name/description text (not just the filename) - see
  // pnByFilename above.
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null)
  const [searching, setSearching] = useState(false)
  const searchSeq = useRef(0)

  useEffect(() => {
    const q = query.trim().toLowerCase()
    if (!q || !dir) {
      setSearchResults(null)
      setSearching(false)
      return
    }
    setSearching(true)
    const seq = ++searchSeq.current
    const id = window.setTimeout(() => {
      void window.cad.searchDir(dir, q).then(async (r) => {
        if (searchSeq.current !== seq) return // a newer query already superseded this one
        const byFilename = new Map(r.results.map((x) => [x.name.toLowerCase(), x]))
        // a filename match already covers itself - only need a SECOND pass
        // for a name/description match the filename search wouldn't find
        // (the registry text doesn't appear in the .FCStd's own name).
        const namesToFind = new Set<string>()
        for (const [filename, row] of pnByFilename) {
          if (byFilename.has(filename)) continue
          if (row.name.toLowerCase().includes(q) || row.description.toLowerCase().includes(q)) {
            namesToFind.add(row.pn)
          }
        }
        if (namesToFind.size > 0) {
          // each is an exact-filename search (not a substring one), so this
          // never pulls in something the user didn't actually mean to find
          const extra = await Promise.all(
            [...namesToFind].map((pn) => window.cad.searchDir(dir, pn))
          )
          for (const batch of extra) {
            for (const x of batch.results) {
              if (!byFilename.has(x.name.toLowerCase())) byFilename.set(x.name.toLowerCase(), x)
            }
          }
        }
        if (searchSeq.current !== seq) return // a newer query landed while the extra lookups were in flight
        setSearchResults([...byFilename.values()].sort((a, b) => a.depth - b.depth))
        setSearching(false)
      })
    }, 200) // debounce - a search walks the real filesystem, not an in-memory list
    return () => window.clearTimeout(id)
  }, [query, dir, pnByFilename])

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
      <div className="datapanel-search">
        <input
          type="text"
          placeholder="Search this folder…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <button className="dp-search-clear" title="Clear search" onClick={() => setQuery('')}>
            ×
          </button>
        )}
      </div>
      <div className="datapanel-list">
        {!query && dir && (
          <div className="dp-row up" onClick={() => load(parent)}>
            <span className="dp-ic">↰</span>
            <span className="dp-name">..</span>
          </div>
        )}
        {error && <div className="dp-error">{error}</div>}
        {query ? (
          searching ? (
            <div className="dp-empty">Searching…</div>
          ) : !searchResults?.length ? (
            <div className="dp-empty">No matches for "{query.trim()}"</div>
          ) : (
            searchResults.map((r) => {
              const rec = !r.isDir ? pnByFilename.get(r.name.toLowerCase()) : undefined
              return (
                <div
                  key={r.path}
                  className={r.isDir ? 'dp-row' : 'dp-row file'}
                  onClick={() => r.isDir && load(r.path)}
                  onDoubleClick={() => (r.isDir ? load(r.path) : onOpenFile(r.path))}
                  title={r.path}
                >
                  <span className="dp-ic">{r.isDir ? '▸' : '◈'}</span>
                  <span className="dp-name-col">
                    <span className="dp-name">{r.name}</span>
                    {rec && (rec.name || rec.description) && (
                      <span className="dp-meta">
                        {[rec.name, rec.description].filter(Boolean).join(' — ')}
                      </span>
                    )}
                  </span>
                </div>
              )
            })
          )
        ) : (
          <>
            {items.map((it) => {
              const rec = !it.isDir ? pnByFilename.get(it.name.toLowerCase()) : undefined
              return (
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
                  <span className="dp-name-col">
                    <span className={it.isDir && !it.hasDesign ? 'dp-name dp-name-dim' : 'dp-name'}>
                      {it.name}
                    </span>
                    {rec && (rec.name || rec.description) && (
                      <span className="dp-meta">
                        {[rec.name, rec.description].filter(Boolean).join(' — ')}
                      </span>
                    )}
                  </span>
                </div>
              )
            })}
            {dir && !items.length && !error && (
              <div className="dp-empty">No folders or designs here</div>
            )}
          </>
        )}
      </div>
      {companyRepos.length > 0 && (
        <div className="datapanel-footer" title={companyRepos.map((r) => `${r.code}: ${r.path}`).join('\n')}>
          Company CAD: {companyRepos.map((r) => r.path).join(', ')}
        </div>
      )}

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
