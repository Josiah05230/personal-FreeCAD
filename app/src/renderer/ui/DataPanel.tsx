import { useCallback, useEffect, useRef, useState } from 'react'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { promptText, promptForm } from './PromptDialog'
import { api, type PartRecord } from '../rpc'
import { pushAppAction } from '../appHistory'
import { fileKind, extOf, type FileKind } from '../../shared/fileTypes'
import { currentRevs, supersededBy } from '../../shared/revisions'

/** the double-click / "Open" label for each usable file kind - App's
 *  onOpenFile does the matching thing (see openDataPanelFile) */
const OPEN_LABEL: Record<FileKind, string> = {
  design: 'Open',
  model: 'Import into current design',
  mesh: 'Import into current design',
  ecad: 'New part from file…',
  archive: 'New part from file…',
  image: 'Open',
  vector: 'Open',
  document: 'Open'
}

/** tell an open Data Panel to re-list after an undo/redo changed the disk */
const fsChanged = (): void => void window.dispatchEvent(new Event('gwtcad-fs-changed'))

export type DataPanelFileAction = 'insertComponent' | 'newPartFromFile' | 'openExternal' | 'insertCanvas'

/** a non-design file's row icon: its extension as a small tag (STEP, PDF,
 *  PNG, ...) - reads at a glance without an icon per format */
function fileIcon(name: string): JSX.Element {
  const kind = fileKind(name)
  if (kind === 'design' || !kind) return <span className="dp-ic">◈</span>
  const ext = extOf(name).replace(/^kicad_/, '').toUpperCase()
  return <span className={`dp-ic dp-ext dp-ext-${kind}`}>{ext.slice(0, 4)}</span>
}

/**
 * The Data Panel - a vertical banner that slides in from the left edge (toggled
 * by the waffle). Browses directories for designs and every other file type
 * GWT-CAD can use (shared/fileTypes.ts - STEP/mesh, KiCad, zip, images, pdf,
 * dxf/svg); folders with nothing usable anywhere beneath them are hidden.
 * Resizable; double-click to open/import; right-click a file or folder for
 * rename / move / git / delete.
 */
export function DataPanel({
  open,
  onOpenFile,
  onFileAction,
  onNewDesignAt,
  onGitHistory
}: {
  open: boolean
  /** double-click: open a design, import a model, insert an image, ... by kind */
  onOpenFile: (path: string) => void
  /** the right-click extras (insert as assembly component, etc.) */
  onFileAction?: (path: string, action: DataPanelFileAction) => void
  onNewDesignAt: (path: string) => void
  onGitHistory: (path: string) => void
}): JSX.Element {
  const [dir, setDir] = useState<string | null>(null)
  const [parent, setParent] = useState<string>('')
  const [items, setItems] = useState<DirEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [thumbs, setThumbs] = useState<Record<string, string | null>>({})
  const [menu, setMenu] = useState<{ x: number; y: number; it: DirEntry } | null>(null)

  // right-click prefs: folders the user hid (also skipped by search) and the
  // folder the panel starts in; "show hidden" is a per-session peek
  const [prefs, setPrefs] = useState<DataPanelPrefs>({ hidden: [], defaultDir: null })
  const [showHidden, setShowHidden] = useState(false)
  const [pathMenu, setPathMenu] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => {
    if (open) void window.cad.dataPanelPrefs().then(setPrefs).catch(() => undefined)
  }, [open])

  // "where the company CAD actually lives" hint, per the user's own ask -
  // read once when the panel first opens (company.json rarely changes
  // mid-session; Company Directories already has its own dedicated panel
  // for actually editing it).
  const [companyRepos, setCompanyRepos] = useState<{ code: string; path: string }[]>([])
  // company repo roots always show, even while they hold nothing usable yet
  // (a brand new ECAD repo with just a README) - it's where designs get made
  const [alwaysShow, setAlwaysShow] = useState<Set<string>>(new Set())
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
        const roots = [...seen.keys(), cfg.ecadRepoPath].filter(Boolean) as string[]
        setAlwaysShow(new Set(roots.map((r) => r.replace(/[\\/]+$/, ''))))
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
  // current revision per PN sequence: an older revision's files (PSJ0010.*
  // once PSJ0011 exists) never show here - they're viewed read-only from the
  // newest revision's History panel
  const [currentBySeq, setCurrentBySeq] = useState<ReturnType<typeof currentRevs>>(new Map())
  useEffect(() => {
    if (!open) return
    void api
      .pnListAll()
      .then((r) => {
        const m = new Map<string, PartRecord>()
        for (const row of r.parts) m.set(`${row.pn}.FCStd`.toLowerCase(), row)
        setPnByFilename(m)
        setCurrentBySeq(currentRevs(r.parts))
      })
      .catch(() => {
        setPnByFilename(new Map())
        setCurrentBySeq(new Map())
      })
  }, [open])

  // search: recursive from the CURRENTLY BROWSED folder down, shallowest
  // first, not the whole disk - matches how the model-tree Browser's own
  // search is scoped to what's in view. Answered from the main process's
  // in-memory index (fileFilter.ts FileIndex; built when a folder is shown),
  // skipping hidden folders. Also matches PN name/description text (not
  // just the filename) - see pnByFilename above.
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchPartial, setSearchPartial] = useState(false)
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
    // registry name/description matches ("connector" finds CMC0010.FCStd):
    // their "<PN>.FCStd" filenames ride along in the same search
    const alsoMatch: string[] = []
    for (const row of pnByFilename.values()) {
      if (row.name.toLowerCase().includes(q) || row.description.toLowerCase().includes(q)) {
        alsoMatch.push(`${row.pn}.fcstd`)
      }
    }
    // a first search of a big tree answers with what's indexed so far
    // (`partial`) - show that and keep asking until the index is complete
    const run = (): void => {
      void window.cad
        .searchDir(dir, q, alsoMatch)
        .then((r) => {
          if (searchSeq.current !== seq) return // a newer query already superseded this one
          setSearchResults(r.results)
          setSearchPartial(!!r.partial)
          setSearching(false)
          if (r.partial) window.setTimeout(run, 300)
        })
        .catch(() => {
          if (searchSeq.current !== seq) return
          setSearchResults([])
          setSearchPartial(false)
          setSearching(false)
        })
    }
    const id = window.setTimeout(run, 60) // short debounce - searches run against an in-memory index
    return () => window.clearTimeout(id)
  }, [query, dir, pnByFilename])

  const [width, setWidth] = useState<number>(() => {
    const v = Number(localStorage.getItem('gwtcad.datapanel.w'))
    return v >= 180 && v <= 640 ? v : 300
  })
  const resizing = useRef(false)

  // list first (instant), then refine: folders the main process hasn't
  // already answered for get the recursive "anything usable beneath?" walk
  // afterwards, and drop out of the list if the answer is no. A newer
  // navigation supersedes a pending refine.
  const loadSeq = useRef(0)
  const load = useCallback((target?: string): void => {
    const seq = ++loadSeq.current
    window.cad
      .listDir(target)
      .then((r) => {
        if (seq !== loadSeq.current) return
        setDir(r.dir)
        void window.cad.warmIndex(r.dir).catch(() => undefined)
        setParent(r.parent)
        setItems(r.items)
        setError(null)
        setThumbs({})
        for (const it of r.items) {
          const k = it.isDir ? null : fileKind(it.name)
          if (k === 'design' || k === 'image' || extOf(it.name) === 'svg') {
            window.cad.thumb(it.path).then((t) => setThumbs((m) => ({ ...m, [it.path]: t })))
          }
        }
        const unknown = r.items.filter((it) => it.isDir && it.relevant === undefined).map((it) => it.path)
        if (!unknown.length) return
        void window.cad
          .dirRelevance(unknown)
          .then((rel) => {
            if (seq !== loadSeq.current) return
            setItems((cur) => cur.map((it) => (it.isDir && it.path in rel ? { ...it, relevant: rel[it.path] } : it)))
          })
          .catch(() => undefined) // a failed refine just leaves every folder showing
      })
      .catch((e) => setError(String(e)))
  }, [])

  useEffect(() => {
    if (open && dir === null) load()
  }, [open, dir, load])

  // an undo/redo of a panel action (appHistory) changed the disk or prefs:
  // re-list the folder being shown
  const dirRef = useRef(dir)
  dirRef.current = dir
  useEffect(() => {
    const onChange = (): void => {
      if (dirRef.current) load(dirRef.current)
      void window.cad.dataPanelPrefs().then(setPrefs).catch(() => undefined)
    }
    window.addEventListener('gwtcad-fs-changed', onChange)
    return () => window.removeEventListener('gwtcad-fs-changed', onChange)
  }, [load])

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

  // a folder is hidden once it's KNOWN to hold nothing usable; not-yet-
  // checked (undefined) and gave-up (null) folders stay visible
  const hiddenSet = new Set(prefs.hidden)
  const visibleItems = items.filter(
    (it) =>
      (!it.isDir || it.relevant !== false || alwaysShow.has(it.path)) &&
      (showHidden || !(it.hidden || hiddenSet.has(it.path))) &&
      (it.isDir || !supersededBy(it.name, currentBySeq))
  )
  const shownResults = searchResults?.filter((r) => r.isDir || !supersededBy(r.name, currentBySeq)) ?? null

  const setHidden = async (it: DirEntry, hidden: boolean): Promise<void> => {
    const p = await window.cad.setFolderHidden(it.path, hidden)
    setPrefs(p)
    setItems((cur) => cur.map((x) => (x.path === it.path ? { ...x, hidden: hidden || undefined } : x)))
    if (!p.hidden.length) setShowHidden(false)
    pushAppAction({
      label: `${hidden ? 'Hide' : 'Unhide'} folder ${it.name}`,
      undo: async () => {
        await window.cad.setFolderHidden(it.path, !hidden)
        fsChanged()
      },
      redo: async () => {
        await window.cad.setFolderHidden(it.path, hidden)
        fsChanged()
      }
    })
  }

  const setDefault = async (path: string | null): Promise<void> => {
    const prev = prefs.defaultDir
    setPrefs(await window.cad.setDefaultFolder(path))
    pushAppAction({
      label: path ? 'Set default folder' : 'Clear default folder',
      undo: async () => {
        await window.cad.setDefaultFolder(prev)
        fsChanged()
      },
      redo: async () => {
        await window.cad.setDefaultFolder(path)
        fsChanged()
      }
    })
  }

  const defaultItem = (path: string): MenuItem =>
    prefs.defaultDir === path
      ? { label: 'Clear default folder', onClick: () => void setDefault(null) }
      : { label: 'Set as default folder', onClick: () => void setDefault(path) }

  const newFolder = async (): Promise<void> => {
    if (!dir) return
    const name = await promptText('New folder name')
    if (!name) return
    const path = dir + sep + name
    await window.cad.mkdir(path)
    load(dir)
    let held = ''
    pushAppAction({
      label: `New folder ${name}`,
      undo: async () => {
        held = (await window.cad.softDelete(path)).held
        fsChanged()
      },
      redo: async () => {
        await window.cad.restore(held, path)
        fsChanged()
      }
    })
  }

  const newDesign = async (): Promise<void> => {
    if (!dir) return
    const name = await promptText('New design name', 'Untitled')
    if (!name) return
    const file = name.toLowerCase().endsWith('.fcstd') ? name : name + '.FCStd'
    onNewDesignAt(dir + sep + file)
    load(dir)
  }

  /** a rename/move, recorded for Ctrl+Z */
  const moveUndoable = async (src: string, dest: string, label: string): Promise<void> => {
    await window.cad.move(src, dest)
    load(dir ?? undefined)
    pushAppAction({
      label,
      undo: async () => {
        await window.cad.move(dest, src)
        fsChanged()
      },
      redo: async () => {
        await window.cad.move(src, dest)
        fsChanged()
      }
    })
  }

  const rename = async (it: DirEntry): Promise<void> => {
    const next = await promptText('Rename', it.name)
    if (!next || next === it.name) return
    await moveUndoable(it.path, it.path.slice(0, -it.name.length) + next, `Rename ${it.name} to ${next}`)
  }

  const move = async (it: DirEntry): Promise<void> => {
    const dirs = await window.cad.siblingDirs(it.path)
    const choice = await promptForm('Move to folder', [
      { key: 'dest', label: 'Destination', options: dirs }
    ])
    if (!choice) return
    await moveUndoable(it.path, choice.dest + sep + it.name, `Move ${it.name}`)
  }

  // undoable (Ctrl+Z): the item moves into ~/.gwtcad/deleted and back
  const del = async (it: DirEntry): Promise<void> => {
    let held = (await window.cad.softDelete(it.path)).held
    load(dir ?? undefined)
    window.dispatchEvent(new CustomEvent('gwtcad-notice', { detail: `Deleted ${it.name} - Ctrl+Z to undo` }))
    pushAppAction({
      label: `Delete ${it.name}`,
      undo: async () => {
        await window.cad.restore(held, it.path)
        fsChanged()
      },
      redo: async () => {
        held = (await window.cad.softDelete(it.path)).held
        fsChanged()
      }
    })
  }

  const fileExtras = (it: DirEntry): MenuItem[] => {
    if (!onFileAction) return []
    const k = fileKind(it.name)
    const out: MenuItem[] = []
    if (k === 'design') {
      out.push({ label: 'Insert into current design', onClick: () => onFileAction(it.path, 'insertComponent') })
    }
    if (k === 'model' || k === 'mesh') {
      out.push({ label: 'New part from file…', onClick: () => onFileAction(it.path, 'newPartFromFile') })
    }
    if (k === 'image') {
      out.push({ label: 'Insert as canvas', onClick: () => onFileAction(it.path, 'insertCanvas') })
    }
    if (k === 'image' || k === 'ecad' || k === 'vector' || k === 'document') {
      out.push({ label: 'Open in system viewer', onClick: () => onFileAction(it.path, 'openExternal') })
    }
    return out
  }

  const menuItems = (it: DirEntry): MenuItem[] =>
    it.isDir
      ? [
          { label: 'Open', onClick: () => load(it.path) },
          { label: 'Rename…', onClick: () => void rename(it) },
          it.hidden || hiddenSet.has(it.path)
            ? { label: 'Unhide folder', onClick: () => void setHidden(it, false) }
            : { label: 'Hide folder', onClick: () => void setHidden(it, true) },
          defaultItem(it.path),
          { separator: true, label: '' },
          { label: 'Delete', danger: true, onClick: () => void del(it) }
        ]
      : [
          { label: OPEN_LABEL[fileKind(it.name) ?? 'design'], onClick: () => onOpenFile(it.path) },
          ...fileExtras(it),
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
      <div
        className="datapanel-path"
        title={dir ? `${dir}${prefs.defaultDir === dir ? '\n(default folder)' : ''}` : ''}
        onContextMenu={(e) => {
          e.preventDefault()
          if (dir) setPathMenu({ x: e.clientX, y: e.clientY })
        }}
      >
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
          searching || (searchPartial && !shownResults?.length) ? (
            <div className="dp-empty">Searching…</div>
          ) : !shownResults?.length ? (
            <div className="dp-empty">No matches for "{query.trim()}"</div>
          ) : (
            [...shownResults.map((r) => {
              const rec = !r.isDir ? pnByFilename.get(r.name.toLowerCase()) : undefined
              return (
                <div
                  key={r.path}
                  className={r.isDir ? 'dp-row' : 'dp-row file'}
                  onClick={() => r.isDir && load(r.path)}
                  onDoubleClick={() => (r.isDir ? load(r.path) : onOpenFile(r.path))}
                  title={r.path}
                >
                  {r.isDir ? <span className="dp-ic">▸</span> : fileIcon(r.name)}
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
            }),
            ...(searchPartial ? [<div key="__partial" className="dp-empty">Still searching…</div>] : [])]
          )
        ) : (
          <>
            {visibleItems.map((it) => {
              const rec = !it.isDir ? pnByFilename.get(it.name.toLowerCase()) : undefined
              return (
                <div
                  key={it.path}
                  className={
                    (it.isDir ? 'dp-row' : 'dp-row file') + (it.hidden || hiddenSet.has(it.path) ? ' dp-hidden' : '')
                  }
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
                  ) : it.isDir ? (
                    <span className="dp-ic">▸</span>
                  ) : (
                    fileIcon(it.name)
                  )}
                  <span className="dp-name-col">
                    <span className="dp-name">{it.name}</span>
                    {rec && (rec.name || rec.description) && (
                      <span className="dp-meta">
                        {[rec.name, rec.description].filter(Boolean).join(' — ')}
                      </span>
                    )}
                  </span>
                </div>
              )
            })}
            {dir && !visibleItems.length && !error && (
              <div className="dp-empty">No folders or usable files here</div>
            )}
          </>
        )}
      </div>
      {prefs.hidden.length > 0 && (
        <div className="datapanel-hiddenbar">
          <span>
            {prefs.hidden.length} hidden folder{prefs.hidden.length === 1 ? '' : 's'}
          </span>
          <button onClick={() => setShowHidden((v) => !v)}>
            {showHidden ? 'Hide hidden folders' : 'Show hidden folders'}
          </button>
        </div>
      )}
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
      {pathMenu && dir && (
        <ContextMenu x={pathMenu.x} y={pathMenu.y} items={[defaultItem(dir)]} onClose={() => setPathMenu(null)} />
      )}
    </div>
  )
}
