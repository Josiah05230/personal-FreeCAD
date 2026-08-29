import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  api,
  type BodyTree,
  type RenderMesh,
  type SketchRender,
  type Selection,
  type DrawingView,
  type AssemblyTree
} from './rpc'
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
import { OperationDialog, type OpKind, type OpValues } from './ui/OperationDialog'
import { DrawingSheet } from './ui/DrawingSheet'
import { AssemblyPanel } from './ui/AssemblyPanel'
import { basename } from './util'

type Status =
  | { phase: 'boot' }
  | { phase: 'ready'; freecad: string }
  | { phase: 'error'; message: string }

const isTypingTarget = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}
const selKey = (s: Selection): string =>
  s.kind === 'body' ? `body:${s.bodyId}` : `${s.kind}:${s.bodyId}:${s.sub}`

export function App(): JSX.Element {
  const [status, setStatus] = useState<Status>({ phase: 'boot' })
  const [meshes, setMeshes] = useState<RenderMesh[]>([])
  const [sketches, setSketches] = useState<SketchRender[]>([])
  const [bodies, setBodies] = useState<BodyTree[]>([])
  const [docPath, setDocPath] = useState<string | null>(null)
  const [visOverride, setVisOverride] = useState<Record<string, boolean>>({})
  const [selection, setSelection] = useState<Selection[]>([])

  const [dataOpen, setDataOpen] = useState(false)
  const [gitOpen, setGitOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [op, setOp] = useState<OpKind | null>(null)

  const [drawingViews, setDrawingViews] = useState<DrawingView[]>([])
  const [showDrawing, setShowDrawing] = useState(false)

  const [asmTree, setAsmTree] = useState<AssemblyTree | null>(null)
  const [jointType, setJointType] = useState('Revolute')

  const [tabs, setTabs] = useState<DocTab[]>([{ id: 'd1', name: 'Untitled', dirty: false }])
  const [activeTab, setActiveTab] = useState('d1')

  const vpApi = useRef<ViewportApi | null>(null)
  const bodyId = bodies[0]?.id ?? null

  const markDirty = useCallback(
    (d = true) => setTabs((t) => t.map((x) => (x.id === activeTab ? { ...x, dirty: d } : x))),
    [activeTab]
  )

  const refreshScene = useCallback(async () => {
    const [scene, tree, asm] = await Promise.all([
      api.sceneGet(),
      api.treeGet(),
      api.assemblyTree().catch(() => null)
    ])
    setMeshes(scene.meshes)
    setSketches(scene.sketches ?? [])
    setBodies(tree.bodies)
    setDocPath(tree.path)
    setVisOverride({})
    setAsmTree(asm && asm.assembly ? asm : null)
  }, [])

  const refreshMeshesOnly = useCallback(async () => {
    const scene = await api.sceneGet()
    setMeshes(scene.meshes)
    setSketches(scene.sketches ?? [])
  }, [])

  const afterEdit = useCallback(async () => {
    await refreshScene()
    markDirty()
    setSelection([])
  }, [refreshScene, markDirty])

  // ---- selection ----
  const onSelect = useCallback((sel: Selection | null, additive: boolean) => {
    if (!sel) {
      if (!additive) setSelection([])
      return
    }
    setSelection((cur) => {
      if (!additive) return [sel]
      const k = selKey(sel)
      return cur.some((s) => selKey(s) === k) ? cur.filter((s) => selKey(s) !== k) : [...cur, sel]
    })
  }, [])

  // ---- feature ops ----
  const runExtrude = useCallback(async () => {
    await api.demoPad(60, 40, 15)
    await afterEdit()
  }, [afterEdit])

  const createSketch = useCallback(async () => {
    await api.box(40, 40, 40)
    await afterEdit()
  }, [afterEdit])

  const applyOp = useCallback(
    async (kind: OpKind, v: OpValues) => {
      const edges = selection.filter((s) => s.kind === 'edge').map((s) => (s as { sub: string }).sub)
      const faces = selection.filter((s) => s.kind === 'face') as Array<{
        sub: string
        point: [number, number, number]
      }>
      try {
        switch (kind) {
          case 'box':
            await api.box(Number(v.width), Number(v.depth), Number(v.height))
            break
          case 'cylinder':
            await api.cylinder(Number(v.diameter), Number(v.height))
            break
          case 'fillet':
            await api.fillet(edges, Number(v.radius))
            break
          case 'chamfer':
            await api.chamfer(edges, Number(v.size))
            break
          case 'shell':
            await api.shell(faces.map((f) => f.sub), Number(v.thickness))
            break
          case 'hole':
            await api.hole(
              faces[0].sub,
              faces[0].point,
              Number(v.diameter),
              Number(v.depth),
              Boolean(v.throughAll)
            )
            break
          case 'patternLinear': {
            const ax = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] }[String(v.axis)] ?? [1, 0, 0]
            await api.patternLinear(ax, Number(v.count), Number(v.spacing))
            break
          }
          case 'mirror':
            await api.mirror(String(v.plane))
            break
          case 'datumPlane':
            await api.datumPlane(String(v.basePlane), Number(v.offset))
            break
        }
        setOp(null)
        await afterEdit()
      } catch (e) {
        window.alert((e as Error).message)
      }
    },
    [selection, afterEdit]
  )

  const rollTo = useCallback(
    async (featureId: string | null) => {
      if (!bodyId) return
      await api.rollTo(bodyId, featureId)
      await refreshScene()
    },
    [bodyId, refreshScene]
  )

  const renameFeature = useCallback(
    async (id: string) => {
      const cur = bodies.flatMap((b) => b.features).find((f) => f.id === id)
      const next = window.prompt('Rename', cur?.label ?? '')
      if (next && next.trim()) {
        await api.renameFeature(id, next.trim())
        await afterEdit()
      }
    },
    [bodies, afterEdit]
  )

  const deleteFeature = useCallback(
    async (id: string) => {
      if (!window.confirm('Delete this feature?')) return
      await api.deleteFeature(id)
      await afterEdit()
    },
    [afterEdit]
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

  const openDesign = useCallback(
    async (path?: string) => {
      const p = path ?? (await window.cad.openDialog())
      if (!p) return
      await api.open(p)
      await refreshScene()
      setDocPath(p)
      setTabs((t) =>
        t.map((x) => (x.id === activeTab ? { ...x, name: basename(p), dirty: false } : x))
      )
    },
    [refreshScene, activeTab]
  )

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
    await afterEdit()
  }, [afterEdit])

  const newDesign = useCallback(() => {
    const id = `d${Date.now()}`
    setTabs((t) => [...t, { id, name: 'Untitled', dirty: false }])
    setActiveTab(id)
    setDocPath(null)
    setShowDrawing(false)
    void (async () => {
      await api.resetDocument()
      await refreshScene()
    })()
  }, [refreshScene])

  const fitView = useCallback(() => vpApi.current?.fit(), [])

  // ---- drawings ----
  const addDrawingView = useCallback(async (dir: string) => {
    const v = await api.drawingAddView(null, dir, 1)
    setDrawingViews((cur) => [...cur.filter((x) => x.direction !== dir), v])
  }, [])

  const startDrawing = useCallback(async () => {
    setShowDrawing(true)
    setDrawingViews([])
    for (const d of ['front', 'top', 'right', 'iso']) {
      try {
        const v = await api.drawingAddView(null, d, 1)
        setDrawingViews((cur) => [...cur.filter((x) => x.direction !== d), v])
      } catch {
        /* body may be missing */
      }
    }
  }, [])

  // ---- assemblies ----
  const addComponent = useCallback(async () => {
    const p = await window.cad.openDialog()
    if (!p) return
    await api.assemblyCreate()
    await api.assemblyAddComponent(p, basename(p).replace(/\.FCStd$/i, ''))
    await refreshScene()
  }, [refreshScene])

  const groundComponent = useCallback(
    async (id: string) => {
      await api.assemblyGround(id)
      await refreshScene()
    },
    [refreshScene]
  )

  const addJoint = useCallback(async () => {
    const fs = selection.filter((s) => s.kind === 'face') as Array<{ bodyId: string; sub: string }>
    if (fs.length !== 2) return
    const r = await api.assemblyAddJoint(jointType, fs[0].bodyId, fs[0].sub, fs[1].bodyId, fs[1].sub)
    await refreshScene()
    setSelection([])
    if (!r.solved)
      window.alert(
        `Joint "${jointType}" added (${r.engine}). Headless joint solving is experimental; it will move components once the solver session lands.`
      )
  }, [selection, jointType, refreshScene])

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
        openOp: (k) => setOp(k),
        extrude: runExtrude,
        createSketch,
        newDesign,
        open: () => openDesign(),
        save,
        saveAs,
        exportModel,
        importStep,
        fitView,
        toggleData: () => setDataOpen((v) => !v),
        toggleGit: () => setGitOpen((v) => !v),
        startDrawing
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
      fitView,
      startDrawing
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
      } else if (!ctrl && (e.key === 'f' || e.key === 'F')) {
        setOp('fillet')
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
        setOp(null)
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
          onOpen: () => openDesign(),
          onSave: save,
          onSaveAs: saveAs,
          onExport: exportModel,
          onImport: importStep
        }}
      />

      <div className="appbody">
        <DataPanel open={dataOpen} onOpenFile={(p) => void openDesign(p)} />

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
                    Check <code>config.local.json</code> points at a valid{' '}
                    <code>freecadcmd</code>.
                  </div>
                </div>
              )}
              {status.phase === 'boot' && <div className="overlay">Starting FreeCAD engine…</div>}

              {showDrawing ? (
                <DrawingSheet
                  views={drawingViews}
                  onBack={() => setShowDrawing(false)}
                  onAddView={(d) => void addDrawingView(d)}
                />
              ) : (
                <>
                  <Viewport
                    meshes={meshes}
                    sketches={sketches}
                    selection={selection}
                    onSelect={onSelect}
                    apiRef={vpApi}
                  />
                  <Browser
                    bodies={bodies}
                    visibility={visOverride}
                    handlers={{
                      onToggleVisibility: toggleVisibility,
                      onRename: renameFeature,
                      onDelete: deleteFeature,
                      onEdit: () => undefined
                    }}
                  />
                  {asmTree && (
                    <AssemblyPanel
                      tree={asmTree}
                      selection={selection}
                      jointType={jointType}
                      onSetJointType={setJointType}
                      onAddComponent={addComponent}
                      onGround={groundComponent}
                      onAddJoint={addJoint}
                    />
                  )}
                  {op && (
                    <OperationDialog
                      kind={op}
                      selection={selection}
                      onApply={applyOp}
                      onCancel={() => setOp(null)}
                    />
                  )}
                  <Timeline
                    bodies={bodies}
                    handlers={{
                      onRollTo: rollTo,
                      onEdit: () => undefined,
                      onRename: renameFeature,
                      onDelete: deleteFeature
                    }}
                  />
                </>
              )}
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
        <span>{selection.length ? `${selection.length} selected` : ''}</span>
        <span>{docPath ? basename(docPath) : 'unsaved'}</span>
        <span>mm</span>
        <span>Click: select · Middle: pan · Shift+Middle: orbit · S: search</span>
      </div>

      <CommandPalette
        commands={commands}
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
      />
    </div>
  )
}
