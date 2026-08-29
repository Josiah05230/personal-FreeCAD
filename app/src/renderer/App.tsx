import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  api,
  onBusyChange,
  type BodyTree,
  type RenderMesh,
  type SketchRender,
  type Selection,
  type DrawingView,
  type AssemblyTree,
  type DatumDTO,
  type PickPlane,
  type SketchRef,
  type CanvasDTO,
  selectionToRef
} from './rpc'
import { SelectFilterMenu, type SelKind, type SelectMode } from './ui/SelectFilterMenu'
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
import { SketchBar } from './ui/SketchBar'
import { MeasurePanel, SectionPanel, type SectionState } from './ui/InspectPanels'
import type { MeasureResult } from './rpc'
import type { SketchTool } from './viewport/SketchController'
import type { SketchFrameDTO } from './rpc'
import { basename } from './util'

type Status =
  | { phase: 'boot' }
  | { phase: 'ready'; freecad: string }
  | { phase: 'error'; message: string }

const isTypingTarget = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}
const selKey = (s: Selection): string => {
  if (s.kind === 'body') return `body:${s.bodyId}`
  if (s.kind === 'sketch') return `sketch:${s.sketchId}`
  if (s.kind === 'plane') return `plane:${s.planeId}`
  return `${s.kind}:${s.bodyId}:${s.sub}`
}

export function App(): JSX.Element {
  const [status, setStatus] = useState<Status>({ phase: 'boot' })
  const [meshes, setMeshes] = useState<RenderMesh[]>([])
  const [sketches, setSketches] = useState<SketchRender[]>([])
  const [datums, setDatums] = useState<DatumDTO[]>([])
  const [bodies, setBodies] = useState<BodyTree[]>([])
  const [selFilter, setSelFilter] = useState<SelKind[]>([
    'face',
    'edge',
    'sketch',
    'datum',
    'body',
    'plane'
  ])
  const [selectMode, setSelectMode] = useState<SelectMode>('paint')
  const [docPath, setDocPath] = useState<string | null>(null)
  const [visOverride, setVisOverride] = useState<Record<string, boolean>>({})
  const [selection, setSelection] = useState<Selection[]>([])

  const [dataOpen, setDataOpen] = useState(false)
  const [gitOpen, setGitOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [op, setOp] = useState<OpKind | null>(null)

  const [showDrawing, setShowDrawing] = useState(false)

  const [asmTree, setAsmTree] = useState<AssemblyTree | null>(null)
  const [jointType, setJointType] = useState('Revolute')

  const [sketchSession, setSketchSession] = useState<{
    sketchId: string
    bodyId: string
    frame: SketchFrameDTO
  } | null>(null)
  const [sketchTool, setSketchTool] = useState<SketchTool>('line')
  const [sketchCount, setSketchCount] = useState(0)
  const [sketchInitial, setSketchInitial] = useState<unknown[]>([])
  const [planePickMode, setPlanePickMode] = useState(false)
  const [pickPlanes, setPickPlanes] = useState<PickPlane[]>([])

  const [measureMode, setMeasureMode] = useState(false)
  const [measureResult, setMeasureResult] = useState<MeasureResult | null>(null)
  const [section, setSection] = useState<SectionState | null>(null)
  const [canvases, setCanvases] = useState<CanvasDTO[]>([])
  const [busy, setBusy] = useState(0)

  useEffect(() => onBusyChange(setBusy), [])

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
    setDatums(scene.datums ?? [])
    setPickPlanes(scene.pickPlanes ?? [])
    setCanvases(scene.canvases ?? [])
    setBodies(tree.bodies)
    setDocPath(tree.path)
    setVisOverride({})
    setAsmTree(asm && asm.assembly ? asm : null)
  }, [])

  const refreshMeshesOnly = useCallback(async () => {
    const [scene, tree] = await Promise.all([api.sceneGet(), api.treeGet()])
    setMeshes(scene.meshes)
    setSketches(scene.sketches ?? [])
    setDatums(scene.datums ?? [])
    setPickPlanes(scene.pickPlanes ?? [])
    setBodies(tree.bodies)
  }, [])

  const toggleGroup = useCallback(
    async (group: 'bodies' | 'sketches' | 'origin', visible: boolean) => {
      await api.setVisibilityGroup(group, visible)
      await refreshMeshesOnly()
    },
    [refreshMeshesOnly]
  )

  const afterEdit = useCallback(async () => {
    await refreshScene()
    markDirty()
    setSelection([])
  }, [refreshScene, markDirty])

  // ---- selection ----
  const onSelect = useCallback(
    (sel: Selection | null, additive: boolean) => {
      if (!sel) {
        if (!additive) setSelection([])
        return
      }
      if (!selFilter.includes(sel.kind as SelKind)) return // selection filter
      setSelection((cur) => {
        if (!additive) return [sel]
        const k = selKey(sel)
        return cur.some((s) => selKey(s) === k)
          ? cur.filter((s) => selKey(s) !== k)
          : [...cur, sel]
      })
    },
    [selFilter]
  )

  // ---- feature ops ----
  const sweep = useCallback(async () => {
    const sk = selection.filter((s) => s.kind === 'sketch').map((s) => (s as { sketchId: string }).sketchId)
    if (sk.length !== 2) {
      window.alert('Select the profile sketch then the path sketch (2 sketches).')
      return
    }
    try {
      await api.sweep(sk[0], sk[1])
      await afterEdit()
    } catch (e) {
      window.alert((e as Error).message)
    }
  }, [selection, afterEdit])

  const beginSketch = useCallback(
    async (ref: SketchRef) => {
      setPlanePickMode(false)
      const r = await api.sketchOn(ref)
      setSketchSession({ sketchId: r.sketchId, bodyId: r.bodyId, frame: r.frame })
      setSketchTool('line')
      setSketchCount(0)
      setSelection([])
    },
    []
  )

  const createSketch = useCallback(async () => {
    const face = selection.find((s) => s.kind === 'face') as
      | { bodyId: string; sub: string }
      | undefined
    setSketchInitial([])
    if (face) {
      void beginSketch({ kind: 'face', bodyId: face.bodyId, sub: face.sub })
    } else {
      setPlanePickMode(true) // click a plane / face in the viewport
    }
  }, [selection, beginSketch])

  const editSketch = useCallback(async (sketchId: string) => {
    const r = await api.sketchReopen(sketchId)
    setSketchInitial(r.entities)
    setSketchSession({ sketchId, bodyId: r.bodyId ?? '', frame: r.frame })
    setSketchTool('select')
    setSketchCount(r.entities.length)
    setSelection([])
  }, [])

  const finishSketch = useCallback(async () => {
    if (!sketchSession) return
    const ents = vpApi.current?.getNewSketchEntities() ?? []
    if (ents.length) await api.sketchAddGeometry(sketchSession.sketchId, ents)
    await api.sketchFinish(sketchSession.sketchId)
    const id = sketchSession.sketchId
    setSketchSession(null)
    setSketchInitial([])
    await refreshScene()
    setSelection([{ kind: 'sketch', sketchId: id }])
    markDirty()
  }, [sketchSession, refreshScene, markDirty])

  const cancelSketch = useCallback(async () => {
    if (sketchSession) {
      try {
        await api.deleteFeature(sketchSession.sketchId)
      } catch {
        /* fresh sketch may already be gone */
      }
    }
    setSketchSession(null)
    await refreshScene()
  }, [sketchSession, refreshScene])

  const applyOp = useCallback(
    async (kind: OpKind, v: OpValues) => {
      const edges = selection.filter((s) => s.kind === 'edge').map((s) => (s as { sub: string }).sub)
      const faces = selection.filter((s) => s.kind === 'face') as Array<{
        sub: string
        point: [number, number, number]
      }>
      const sketchIds = selection
        .filter((s) => s.kind === 'sketch')
        .map((s) => (s as { sketchId: string }).sketchId)
      try {
        switch (kind) {
          case 'box':
            await api.box(Number(v.width), Number(v.depth), Number(v.height))
            break
          case 'cylinder':
            await api.cylinder(Number(v.diameter), Number(v.height))
            break
          case 'extrude':
            await api.extrude(
              sketchIds[0],
              Number(v.length),
              Boolean(v.cut),
              Boolean(v.midplane),
              Boolean(v.reversed)
            )
            break
          case 'revolve':
            await api.revolve(sketchIds[0], Number(v.angle), String(v.axis), Boolean(v.cut))
            break
          case 'loft':
            await api.loft(sketchIds, Boolean(v.cut))
            break
          case 'draft':
            await api.draft(faces.map((f) => f.sub), Number(v.angle), null)
            break
          case 'combine': {
            const bs = selection.filter((s) => s.kind === 'body').map((s) => (s as { bodyId: string }).bodyId)
            await api.combine(String(v.op), bs[0] ?? null, bs.slice(1))
            break
          }
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
          case 'patternCircular': {
            const ref = selection.map(selectionToRef).find(Boolean) ?? null
            await api.patternCircular(Number(v.count), Number(v.angle), ref)
            break
          }
          case 'mirror': {
            const ref = selection.map(selectionToRef).find(Boolean) ?? null
            await api.mirror(ref)
            break
          }
          case 'datumPlane': {
            const ref = selection.map(selectionToRef).find(Boolean) ?? null
            await api.datumPlane(ref, Number(v.offset))
            break
          }
          case 'splitBody': {
            const ref = selection.map(selectionToRef).find(Boolean)
            const b = selection.find((s) => s.kind === 'body') as { bodyId: string } | undefined
            const target =
              b?.bodyId ??
              (selection.find((s) => s.kind === 'face') as { bodyId: string } | undefined)?.bodyId ??
              bodies[0]?.id
            if (ref && target) await api.splitBody(target, ref)
            break
          }
          case 'baseFlange': {
            const sk = sketchIds[0]
            if (sk) await api.sheetBaseFlange(sk, Number(v.thickness))
            break
          }
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
      {
        name: '3D models',
        extensions: ['step', 'stp', 'iges', 'igs', 'brep', 'stl', 'obj', '3mf', 'ply', 'off']
      }
    ])
    if (!p) return
    try {
      await api.importModel(p)
      await afterEdit()
    } catch (e) {
      window.alert((e as Error).message)
    }
  }, [afterEdit])

  const scaleBody = useCallback(
    async (mode: 'factor' | 'units') => {
      const target = selection.find((s) => s.kind === 'face' || s.kind === 'body') as
        | { bodyId: string }
        | undefined
      const id = target?.bodyId ?? bodies[0]?.id ?? meshes[0]?.id
      if (!id) {
        window.alert('Select a body first.')
        return
      }
      try {
        if (mode === 'factor') {
          const f = Number(window.prompt('Scale factor', '2'))
          if (f && f > 0) await api.bodyScale(id, f)
        } else {
          const from = window.prompt('Current units (mm, cm, m, in, ft, thou)', 'in')
          const to = window.prompt('Convert to', 'mm')
          if (from && to) await api.bodyConvertUnits(id, from, to)
        }
        await afterEdit()
      } catch (e) {
        window.alert((e as Error).message)
      }
    },
    [selection, bodies, meshes, afterEdit]
  )

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

  const insertCanvas = useCallback(async () => {
    const p = await window.cad.openDialog([
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }
    ])
    if (!p) return
    const dataUrl = await window.cad.readImage(p)
    const img = new Image()
    img.src = dataUrl
    await img.decode().catch(() => undefined)
    const w = 100
    const h = img.naturalHeight && img.naturalWidth ? (100 * img.naturalHeight) / img.naturalWidth : 100
    await api.canvasInsert('XY', w, h, dataUrl)
    
    await refreshMeshesOnly()
  }, [refreshMeshesOnly])

  // ---- inspect ----
  const startMeasure = useCallback(() => {
    setMeasureMode((v) => !v)
    setMeasureResult(null)
    setSelection([])
  }, [])

  const toggleSection = useCallback(() => {
    setSection((s) => (s ? null : { plane: 'XY', offset: 0, flip: false }))
  }, [])

  useEffect(() => {
    if (!measureMode) return
    const picks = selection.filter((s) => s.kind === 'face' || s.kind === 'edge') as Array<{
      bodyId: string
      sub: string
    }>
    if (picks.length >= 1 && picks.length <= 2) {
      void api
        .measure(picks.map((p) => ({ bodyId: p.bodyId, sub: p.sub })))
        .then(setMeasureResult)
        .catch(() => setMeasureResult(null))
    } else {
      setMeasureResult(null)
    }
  }, [selection, measureMode])

  // ---- drawings ----
  const makeView = useCallback(async (dir: string): Promise<DrawingView | null> => {
    try {
      return await api.drawingAddView(null, dir, 1)
    } catch (e) {
      window.alert((e as Error).message)
      return null
    }
  }, [])

  const startDrawing = useCallback(async () => {
    setShowDrawing(true) // opens a blank sheet; user adds views
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
        sweep,
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
        startDrawing,
        startMeasure,
        toggleSection,
        scale: scaleBody,
        insertCanvas,
        selectFilterNode: (
          <SelectFilterMenu
            mode={selectMode}
            onMode={setSelectMode}
            active={selFilter}
            onActive={setSelFilter}
          />
        )
      }),
    [
      sweep,
      createSketch,
      newDesign,
      openDesign,
      save,
      saveAs,
      exportModel,
      importStep,
      fitView,
      startDrawing,
      startMeasure,
      toggleSection,
      scaleBody,
      insertCanvas,
      selectMode,
      selFilter
    ]
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isTypingTarget(e.target)) return
      const ctrl = e.ctrlKey || e.metaKey
      if (sketchSession) {
        const k = e.key.toLowerCase()
        if (k === 'l') setSketchTool('line')
        else if (k === 'r') setSketchTool('rect')
        else if (k === 'c') setSketchTool('circle')
        else if (k === 'a') setSketchTool('arc')
        else if (e.key === 'Escape') setSketchTool('select')
        return
      }
      if (!ctrl && (e.key === 's' || e.key === 'S')) {
        e.preventDefault()
        setPaletteOpen(true)
      } else if (!ctrl && (e.key === 'e' || e.key === 'E')) {
        setOp('extrude')
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
  }, [sketchSession, save, openDesign, newDesign, fitView])

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
        <DataPanel
          open={dataOpen}
          onOpenFile={(p) => void openDesign(p)}
          onNewDesignAt={(p) => {
            void (async () => {
              await api.resetDocument()
              await api.saveAs(p)
              setDocPath(p)
              const id = `d${Date.now()}`
              setTabs((t) => [...t, { id, name: basename(p), dirty: false }])
              setActiveTab(id)
              await refreshScene()
            })()
          }}
        />

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
                  makeView={makeView}
                  docPath={docPath}
                  assembly={asmTree}
                  onBack={() => setShowDrawing(false)}
                />
              ) : (
                <>
                  <Viewport
                    meshes={meshes}
                    sketches={sketches}
                    datums={datums}
                    selection={selection}
                    onSelect={onSelect}
                    section={section}
                    planePickMode={planePickMode}
                    pickPlanes={pickPlanes}
                    onPickPlane={(ref) => void beginSketch(ref)}
                    selectMode={selectMode}
                    onWindowSelect={(sels) =>
                      setSelection((cur) => {
                        const keys = new Set(cur.map(selKey))
                        return [...cur, ...sels.filter((s) => !keys.has(selKey(s)))]
                      })
                    }
                    canvases={canvases}
                    sketchFrame={sketchSession?.frame ?? null}
                    sketchInitialEntities={sketchInitial}
                    sketchTool={sketchTool}
                    onSketchChange={() =>
                      setSketchCount(vpApi.current?.getSketchEntities().length ?? 0)
                    }
                    apiRef={vpApi}
                  />
                  {planePickMode && (
                    <div className="hintbar">
                      Click an origin plane, construction plane, or a flat face to
                      start the sketch
                      <button onClick={() => setPlanePickMode(false)}>Cancel</button>
                    </div>
                  )}
                  {sketchSession && (
                    <SketchBar
                      tool={sketchTool}
                      onTool={setSketchTool}
                      onUndo={() => {
                        vpApi.current?.sketchUndo()
                        setSketchCount(vpApi.current?.getSketchEntities().length ?? 0)
                      }}
                      onFinish={() => void finishSketch()}
                      onCancel={() => void cancelSketch()}
                      count={sketchCount}
                    />
                  )}
                  <Browser
                    bodies={bodies}
                    visibility={visOverride}
                    selection={selection}
                    handlers={{
                      onToggleVisibility: toggleVisibility,
                      onToggleGroup: toggleGroup,
                      onRename: renameFeature,
                      onDelete: deleteFeature,
                      onEdit: (id) => void editSketch(id),
                      onSelect: (sel, add) => onSelect(sel, add)
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
                  {measureMode && (
                    <MeasurePanel
                      result={measureResult}
                      onClose={() => {
                        setMeasureMode(false)
                        setMeasureResult(null)
                      }}
                    />
                  )}
                  {section && (
                    <SectionPanel
                      state={section}
                      onChange={setSection}
                      onClose={() => setSection(null)}
                    />
                  )}
                  <Timeline
                    bodies={bodies}
                    handlers={{
                      onRollTo: rollTo,
                      onEdit: (id) => void editSketch(id),
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
        {busy > 0 && <span className="sb-spinner" title="Working…" />}
        <span>
          {busy > 0
            ? 'Working…'
            : status.phase === 'ready'
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
