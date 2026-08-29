import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, type BodyTree, type RenderMesh } from './rpc'
import { buildCommands } from './commands'
import { Viewport } from './viewport/Viewport'
import type { ViewportApi } from './viewport/types'
import { AppBar } from './ui/AppBar'
import { Ribbon } from './ui/Ribbon'
import { DocTabs, type DocTab } from './ui/DocTabs'
import { DataPanel } from './ui/DataPanel'
import { GitPanel } from './ui/GitPanel'
import { Browser } from './ui/Browser'
import { Timeline } from './ui/Timeline'
import { CommandPalette } from './ui/CommandPalette'
import { basename } from './util'

type Status =
  | { phase: 'boot' }
  | { phase: 'ready'; freecad: string }
  | { phase: 'error'; message: string }

const isTypingTarget = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}

export function App(): JSX.Element {
  const [status, setStatus] = useState<Status>({ phase: 'boot' })
  const [meshes, setMeshes] = useState<RenderMesh[]>([])
  const [bodies, setBodies] = useState<BodyTree[]>([])
  const [docPath, setDocPath] = useState<string | null>(null)
  const [visOverride, setVisOverride] = useState<Record<string, boolean>>({})

  const [dataOpen, setDataOpen] = useState(false)
  const [gitOpen, setGitOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)

  const [tabs, setTabs] = useState<DocTab[]>([{ id: 'd1', name: 'Untitled', dirty: false }])
  const [activeTab, setActiveTab] = useState('d1')

  const vpApi = useRef<ViewportApi | null>(null)
  const bodyId = bodies[0]?.id ?? null

  const markDirty = useCallback(
    (d = true) => setTabs((t) => t.map((x) => (x.id === activeTab ? { ...x, dirty: d } : x))),
    [activeTab]
  )

  const refreshScene = useCallback(async () => {
    const [scene, tree] = await Promise.all([api.sceneGet(), api.treeGet()])
    setMeshes(scene.meshes)
    setBodies(tree.bodies)
    setDocPath(tree.path)
    setVisOverride({})
  }, [])

  const refreshMeshesOnly = useCallback(async () => {
    const scene = await api.sceneGet()
    setMeshes(scene.meshes)
  }, [])

  // ---- feature ops ----
  const runExtrude = useCallback(async () => {
    await api.demoPad(60, 40, 15)
    await refreshScene()
    markDirty()
  }, [refreshScene, markDirty])

  const createSketch = useCallback(async () => {
    // Sketch environment lands in Milestone 1; for now this seeds a base solid.
    await runExtrude()
  }, [runExtrude])

  const rollTo = useCallback(
    async (featureId: string | null) => {
      if (!bodyId) return
      await api.rollTo(bodyId, featureId)
      await refreshScene()
    },
    [bodyId, refreshScene]
  )

  const editFeature = useCallback((id: string) => {
    // feature-edit dialogs arrive with Milestone 1
    console.info('[edit feature]', id)
  }, [])

  const renameFeature = useCallback(
    async (id: string) => {
      const cur = bodies.flatMap((b) => b.features).find((f) => f.id === id)
      const next = window.prompt('Rename', cur?.label ?? '')
      if (next && next.trim()) {
        await api.renameFeature(id, next.trim())
        await refreshScene()
        markDirty()
      }
    },
    [bodies, refreshScene, markDirty]
  )

  const deleteFeature = useCallback(
    async (id: string) => {
      if (!window.confirm('Delete this feature?')) return
      await api.deleteFeature(id)
      await refreshScene()
      markDirty()
    },
    [refreshScene, markDirty]
  )

  const toggleVisibility = useCallback(
    async (id: string, visible: boolean) => {
      setVisOverride((m) => ({ ...m, [id]: visible }))
      await api.setVisibility(id, visible)
      await refreshMeshesOnly()
    },
    [refreshMeshesOnly]
  )

  // ---- file ops ----
  const saveAs = useCallback(async () => {
    const p = await window.cad.saveDialog(docPath ?? undefined)
    if (!p) return
    await api.saveAs(p)
    setDocPath(p)
    setTabs((t) =>
      t.map((x) => (x.id === activeTab ? { ...x, name: basename(p), dirty: false } : x))
    )
  }, [docPath, activeTab])

  const save = useCallback(async () => {
    if (!docPath) return saveAs()
    await api.save()
    markDirty(false)
  }, [docPath, saveAs, markDirty])

  const openDesign = useCallback(async () => {
    const p = await window.cad.openDialog()
    if (!p) return
    await api.open(p)
    await refreshScene()
    setDocPath(p)
    setTabs((t) =>
      t.map((x) => (x.id === activeTab ? { ...x, name: basename(p), dirty: false } : x))
    )
  }, [refreshScene, activeTab])

  const exportModel = useCallback(async () => {
    const p = await window.cad.exportDialog(
      docPath ? docPath.replace(/\.FCStd$/i, '.step') : undefined
    )
    if (!p) return
    if (/\.stl$/i.test(p)) await api.exportStl(p)
    else await api.exportStep(p)
  }, [docPath])

  const importStep = useCallback(async () => {
    const p = await window.cad.openDialog([
      { name: 'STEP / IGES', extensions: ['step', 'stp', 'iges', 'igs', 'brep'] }
    ])
    if (!p) return
    await api.importStep(p)
    await refreshScene()
    markDirty()
  }, [refreshScene, markDirty])

  const newDesign = useCallback(() => {
    const id = `d${Date.now()}`
    setTabs((t) => [...t, { id, name: 'Untitled', dirty: false }])
    setActiveTab(id)
    setDocPath(null)
    void (async () => {
      await api.resetDocument()
      await refreshScene()
    })()
  }, [refreshScene])

  const fitView = useCallback(() => vpApi.current?.fit(), [])

  // ---- boot ----
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const p = await api.ping()
        if (cancelled) return
        setStatus({ phase: 'ready', freecad: `${p.freecad} ${p.build}` })
        await api.demoPad(60, 40, 15)
        if (cancelled) return
        await refreshScene()
      } catch (e) {
        if (!cancelled) setStatus({ phase: 'error', message: (e as Error).message })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [refreshScene])

  // ---- commands + hotkeys ----
  const commands = useMemo(
    () =>
      buildCommands({
        extrude: runExtrude,
        createSketch,
        newDesign,
        open: openDesign,
        save,
        saveAs,
        exportModel,
        importStep,
        fitView,
        toggleData: () => setDataOpen((v) => !v),
        toggleGit: () => setGitOpen((v) => !v)
      }),
    [
      runExtrude,
      createSketch,
      newDesign,
      openDesign,
      save,
      saveAs,
      exportModel,
      importStep,
      fitView
    ]
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isTypingTarget(e.target)) return
      const ctrl = e.ctrlKey || e.metaKey
      if (!ctrl && (e.key === 's' || e.key === 'S')) {
        e.preventDefault()
        setPaletteOpen(true)
      } else if (!ctrl && (e.key === 'e' || e.key === 'E')) {
        void runExtrude()
      } else if (ctrl && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void save()
      } else if (ctrl && e.key.toLowerCase() === 'o') {
        e.preventDefault()
        void openDesign()
      } else if (ctrl && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        newDesign()
      } else if (e.key === 'F6') {
        fitView()
      } else if (e.key === 'Escape') {
        setPaletteOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [runExtrude, save, openDesign, newDesign, fitView])

  const activeName = tabs.find((t) => t.id === activeTab)?.name ?? 'Untitled'
  const activeDirty = tabs.find((t) => t.id === activeTab)?.dirty ?? false

  return (
    <div className="app">
      <AppBar
        dataOpen={dataOpen}
        onToggleData={() => setDataOpen((v) => !v)}
        gitOpen={gitOpen}
        onToggleGit={() => setGitOpen((v) => !v)}
        docName={activeName}
        dirty={activeDirty}
        fileActions={{
          onNew: newDesign,
          onOpen: openDesign,
          onSave: save,
          onSaveAs: saveAs,
          onExport: exportModel,
          onImport: importStep
        }}
      />

      <div className="appbody">
        <DataPanel open={dataOpen} onOpenFile={(p) => void api.open(p).then(refreshScene).then(() => setDocPath(p))} />

        <div className="maincol">
          <Ribbon commands={commands} />
          <DocTabs
            tabs={tabs}
            activeId={activeTab}
            onActivate={setActiveTab}
            onClose={(id) => setTabs((t) => (t.length > 1 ? t.filter((x) => x.id !== id) : t))}
            onNew={newDesign}
          />
          <div className="workspace">
            <div className="viewport-host">
              {status.phase === 'error' && (
                <div className="overlay error">
                  <b>Engine error</b>
                  <div>{status.message}</div>
                  <div className="hint">
                    Check <code>config.local.json</code> points at a valid <code>freecadcmd</code>.
                  </div>
                </div>
              )}
              {status.phase === 'boot' && <div className="overlay">Starting FreeCAD engine…</div>}
              <Viewport meshes={meshes} apiRef={vpApi} />
              <Browser
                bodies={bodies}
                visibility={visOverride}
                handlers={{
                  onToggleVisibility: toggleVisibility,
                  onRename: renameFeature,
                  onDelete: deleteFeature,
                  onEdit: editFeature
                }}
              />
              <Timeline
                bodies={bodies}
                handlers={{
                  onRollTo: rollTo,
                  onEdit: editFeature,
                  onRename: renameFeature,
                  onDelete: deleteFeature
                }}
              />
            </div>
          </div>
        </div>

        <GitPanel open={gitOpen} filePath={docPath} />
      </div>

      <div className="statusbar">
        <span>
          {status.phase === 'ready'
            ? `FreeCAD ${status.freecad}`
            : status.phase === 'error'
              ? 'engine offline'
              : 'connecting…'}
        </span>
        <span className="sb-spacer" />
        <span>{docPath ? basename(docPath) : 'unsaved'}</span>
        <span>mm</span>
        <span>Middle: pan · Shift+Middle: orbit · Wheel: zoom · S: search</span>
      </div>

      <CommandPalette
        commands={commands}
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
      />
    </div>
  )
}
