import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  api,
  apiQuiet,
  onBusyChange,
  type BodyTree,
  type ImportedNode,
  type RenderMesh,
  type SketchRender,
  type Selection,
  type DrawingView,
  type DrawingPage,
  type AssemblyTree,
  type DatumDTO,
  type PickPlane,
  type SketchRef,
  type CanvasDTO,
  type RenderSettings,
  type ObjectAppearance,
  selectionToRef
} from './rpc'
import { SelectModeToggle, SelectKindList, type SelKind, type SelectMode } from './ui/SelectFilterMenu'
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
import { DrawingSheet, type DrawingSheetApi, type DrawingTool } from './ui/DrawingSheet'
import { AssemblyPanel } from './ui/AssemblyPanel'
import { SketchRibbon } from './ui/SketchRibbon'
import { MeasurePanel, SectionPanel, MassPropsPanel, type SectionState } from './ui/InspectPanels'
import { PromptHost, promptText, promptForm } from './ui/PromptDialog'
import { DimensionEditor, type DimensionEditorRequest } from './ui/DimensionEditor'
import { ParametersPanel } from './ui/ParametersPanel'
import { SettingsPanel } from './ui/SettingsPanel'
import { MaterialsPanel } from './ui/MaterialsPanel'
import { McMasterPanel } from './ui/McMasterPanel'
import { NewPartDialog } from './ui/NewPartDialog'
import { PNBrowserPanel } from './ui/PNBrowserPanel'
import { CompanySettingsPanel } from './ui/CompanySettingsPanel'
import { AppearancePanel } from './ui/AppearancePanel'
import { FirstRun, firstRunDone } from './ui/FirstRun'
import {
  loadPinned,
  savePinned,
  loadHotkeys,
  saveHotkeys,
  comboFromEvent,
  normaliseCombo,
  type PinMap,
  type HotkeyMap
} from './ribbonPrefs'
import { loadMeshPrefs } from './meshPrefs'
import type { MeasureResult, SketchRefGeom, SketchConstraint } from './rpc'
import type { SketchTool, SketchConstraintType } from './viewport/SketchController'
import type { SketchFrameDTO } from './rpc'
import { basename, sketchEntitiesToPolys } from './util'
import { perfProfile } from './perfProfile'
import { CmdQueue } from './cmdQueue'
import { trace, traceSpan } from './trace'

const PERF = perfProfile()

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

// While a feature dialog is open the viewport only accepts the pick kinds that
// operation can actually consume - so a stray click on an edge or vertex while
// the Extrude dialog is up is simply ignored instead of piling a useless ref
// onto the op. null -> no narrowing, use the user's Select-filter as normal.
const opSelKinds = (k: OpKind | null): SelKind[] | null => {
  switch (k) {
    case 'extrude':
    case 'loft':
      return ['sketch', 'face'] // a profile: a sketch outline / filled face, or a flat model face
    case 'sweep':
      return ['sketch', 'edge'] // profile sketch + a path (another sketch or a body edge)
    case 'splitBody':
      return ['plane', 'face', 'sketch'] // the splitting tool
    case 'revolve':
      return ['sketch', 'face', 'edge', 'plane'] // profile + an axis (a body edge or a datum)
    case 'fillet':
    case 'chamfer':
    case 'pressPull':
      return ['edge', 'face']
    case 'shell':
    case 'draft':
    case 'offsetFace':
      return ['face', 'plane']
    case 'align':
      return ['face']
    case 'splitFace':
      return ['face', 'plane']
    case 'hole':
      return ['face', 'edge']
    case 'pipe':
      return ['edge']
    case 'box':
    case 'cylinder':
    case 'sphere':
    case 'torus':
    case 'coil':
      return ['face', 'plane']
    case 'meshPlaneCut':
      return ['face', 'plane']
    case 'move':
      return ['edge', 'vertex']
    case 'datumPlane':
    case 'datumAxis':
    case 'datumPoint':
      return ['face', 'edge', 'vertex', 'plane'] // any geometry - the sidecar picks the mode
    default:
      return null
  }
}

// Revolve axis: the dialog's "Axis" dropdown -> an explicit ReferenceAxis, or
// null + a V/H code meaning "use the sketch's own vertical / horizontal line".
// "Selected edge / datum" falls back to scanning the current selection.
const revolveAxisRef = (
  vAxis: string | undefined,
  selection: Selection[],
  profileSketchId: string | undefined
): { axisRef: import('./rpc').GeomRef | null; axisCode: 'V' | 'H' } => {
  switch (vAxis) {
    case 'Sketch horizontal':
      return { axisRef: null, axisCode: 'H' }
    case 'X':
      return { axisRef: { kind: 'origin', role: 'X_Axis' }, axisCode: 'V' }
    case 'Y':
      return { axisRef: { kind: 'origin', role: 'Y_Axis' }, axisCode: 'V' }
    case 'Z':
      return { axisRef: { kind: 'origin', role: 'Z_Axis' }, axisCode: 'V' }
    case 'Selected edge / datum': {
      for (const s of selection) {
        if (s.kind === 'edge') return { axisRef: { kind: 'edge', bodyId: s.bodyId, sub: s.sub }, axisCode: 'V' }
        if (s.kind === 'plane')
          return {
            axisRef: s.role ? { kind: 'origin', role: s.role } : { kind: 'plane', id: s.planeId },
            axisCode: 'V'
          }
        if (s.kind === 'sketch' && s.sketchId !== profileSketchId)
          return { axisRef: { kind: 'sketch', id: s.sketchId }, axisCode: 'V' }
      }
      return { axisRef: null, axisCode: 'V' }
    }
    default: // 'Sketch vertical'
      return { axisRef: null, axisCode: 'V' }
  }
}

// Mirror / Pattern "Type" dropdown -> the (scope, refs) the sidecar wants.
// Features -> the timeline chip selection; Faces -> the selected face subnames;
// anything else (or an empty pick) -> the whole body.
const transformScope = (
  v: OpValues,
  faces: Array<{ sub: string }>,
  timelineSel: string[]
): { scope: 'body' | 'features' | 'faces'; refs: string[] } => {
  const t = String(v.scope ?? 'Body')
  if (t === 'Features' && timelineSel.length) return { scope: 'features', refs: timelineSel }
  if (t === 'Faces' && faces.length) return { scope: 'faces', refs: faces.map((f) => f.sub) }
  return { scope: 'body', refs: [] }
}

// mirror / pattern "Operation" dropdown -> sidecar op string (matches extrude)
const xformOp = (v: OpValues): 'join' | 'cut' | 'intersect' | 'newbody' =>
  (({ Join: 'join', Cut: 'cut', Intersect: 'intersect', 'New body': 'newbody' }) as const)[
    String(v.operation ?? 'Join') as 'Join' | 'Cut' | 'Intersect' | 'New body'
  ] ?? 'join'

export function App(): JSX.Element {
  const [status, setStatus] = useState<Status>({ phase: 'boot' })
  // shown in the status bar so the user can always tell which build they're
  // on at a glance (user request, 2026-09-12: "I just want to always make
  // sure/know I am using the newest one") - read once from the packaged
  // app's real package.json via the main process, not hand-maintained here
  const [appVersion, setAppVersion] = useState<string>('')
  useEffect(() => {
    let live = true
    void window.cad
      .appVersion()
      .then((v) => {
        if (live) setAppVersion(v)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])
  const [meshes, setMeshes] = useState<RenderMesh[]>([])
  const [sketches, setSketches] = useState<SketchRender[]>([])
  const [datums, setDatums] = useState<DatumDTO[]>([])
  const [bodies, setBodies] = useState<BodyTree[]>([])
  const [imported, setImported] = useState<ImportedNode[]>([])
  // vertex is OFF by default - enable it in the Select dropdown when you
  // actually need to snap to corners (Fusion-style). Faces / edges / bodies
  // are what you click normally.
  const [selFilter, setSelFilter] = useState<SelKind[]>([
    'face',
    'edge',
    'sketch',
    'datum',
    'body',
    'plane'
  ])
  const [selectMode, setSelectMode] = useState<SelectMode>('paint')
  const [projection, setProjectionState] = useState<'orthographic' | 'perspective'>(() => {
    try {
      return localStorage.getItem('gwtcad.projection') === 'perspective'
        ? 'perspective'
        : 'orthographic'
    } catch {
      return 'orthographic'
    }
  })
  const setProjection = useCallback((p: 'orthographic' | 'perspective') => {
    setProjectionState(p)
    try {
      localStorage.setItem('gwtcad.projection', p)
    } catch {
      /* private mode */
    }
  }, [])
  const [docPath, setDocPath] = useState<string | null>(null)
  const [visOverride, setVisOverride] = useState<Record<string, boolean>>({})
  const [selection, setSelection] = useState<Selection[]>([])

  const [dataOpen, setDataOpen] = useState(false)
  const [gitOpen, setGitOpen] = useState(false)
  const [gitTarget, setGitTarget] = useState<string | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [op, setOp] = useState<OpKind | null>(null)

  const [drawingPageId, setDrawingPageId] = useState<string | null>(null)
  const [drawingPages, setDrawingPages] = useState<DrawingPage[]>([])
  const [drawingTool, setDrawingTool] = useState<DrawingTool>('select')
  const [paramsOpen, setParamsOpen] = useState(false)
  const [materialsOpen, setMaterialsOpen] = useState(false)
  const [mcmasterOpen, setMcMasterOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [newPartOpen, setNewPartOpen] = useState(false)
  const [newPartProject, setNewPartProject] = useState<string | undefined>(undefined)
  const [newPartPrefill, setNewPartPrefill] = useState<
    { name?: string; description?: string; mfg?: string; mfgPn?: string; purchasingLink?: string } | undefined
  >(undefined)
  const [pendingMcMaster, setPendingMcMaster] = useState<
    { stepPath: string; meta: Record<string, unknown> } | undefined
  >(undefined)
  const [pnBrowserOpen, setPnBrowserOpen] = useState(false)
  const [companySettingsOpen, setCompanySettingsOpen] = useState(false)
  const [currentPn, setCurrentPn] = useState<string | null>(null)
  const [currentLifecycle, setCurrentLifecycle] = useState<string | null>(null)
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)
  const [pins, setPins] = useState<PinMap>(() => loadPinned())
  const [hotkeys, setHotkeys] = useState<HotkeyMap>(() => loadHotkeys())
  const setPin = useCallback((id: string, pinned: boolean) => {
    setPins((p) => {
      const next = { ...p, [id]: pinned }
      savePinned(next)
      return next
    })
  }, [])
  const setHotkey = useCallback((id: string, combo: string | null) => {
    setHotkeys((h) => {
      const next = { ...h }
      if (combo) next[id] = combo
      else delete next[id]
      saveHotkeys(next)
      return next
    })
  }, [])

  const [asmTree, setAsmTree] = useState<AssemblyTree | null>(null)
  const [jointType, setJointType] = useState('Revolute')
  const [asmPins, setAsmPins] = useState<AsmPinFile>({})
  // Assembly panel has two mouse modes, like a sketch's tool palette: 'select'
  // (default - click faces to build joint references, exactly as before) and
  // 'move' (drag a whole component around, live-solved against whatever
  // joints touch it). A bare always-on drag would fight click-to-pick-a-face,
  // so dragging only engages while this tool is explicitly on (user request,
  // 2026-09-20: "there is a special move/drag tool ... so that the user's
  // mouse isn't always doing that").
  const [asmTool, setAsmTool] = useState<'select' | 'move'>('select')

  const [sketchSession, setSketchSession] = useState<{
    sketchId: string
    bodyId: string
    frame: SketchFrameDTO
    refGeom: SketchRefGeom | null
    /** true when re-entering an existing sketch (cancel must NOT delete it) */
    isEdit?: boolean
  } | null>(null)
  const [sketchTool, setSketchTool] = useState<SketchTool>('line')
  const [sketchCount, setSketchCount] = useState(0)
  const [sketchInitial, setSketchInitial] = useState<unknown[]>([])
  const [sketchInitialCons, setSketchInitialCons] = useState<SketchConstraint[]>([])
  const [sketchInitialProjected, setSketchInitialProjected] = useState<
    import('./rpc').ProjectedEntity[]
  >([])
  const [sketchConstruction, setSketchConstruction] = useState(false)
  const [sketchAvail, setSketchAvail] = useState<SketchConstraintType[]>([])
  const [sketchConstraintCount, setSketchConstraintCount] = useState(0)
  const [sketchPendingCon, setSketchPendingCon] = useState<SketchConstraintType | null>(null)
  const [sketchNotice, setSketchNotice] = useState<string | null>(null)
  const sketchNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flashSketchNotice = useCallback((msg: string) => {
    setSketchNotice(msg)
    if (sketchNoticeTimer.current) clearTimeout(sketchNoticeTimer.current)
    sketchNoticeTimer.current = setTimeout(() => setSketchNotice(null), 5000)
  }, [])
  const [planePickMode, setPlanePickMode] = useState(false)
  const [pickPlanes, setPickPlanes] = useState<PickPlane[]>([])

  // floating in-place dimension editor - see onSketchDimensionRequest
  const [dimEditor, setDimEditor] = useState<DimensionEditorRequest | null>(null)

  const [measureMode, setMeasureMode] = useState(false)
  // the timeline's chip selection, mirrored up so Mirror / Pattern (Type =
  // Features) can transform exactly those features
  const [timelineSel, setTimelineSel] = useState<string[]>([])
  const timelineSelRef = useRef<string[]>([])
  timelineSelRef.current = timelineSel
  const [measureResult, setMeasureResult] = useState<MeasureResult | null>(null)
  const [massProps, setMassProps] = useState<import('./rpc').MassProperties | null>(null)
  const [section, setSection] = useState<SectionState | null>(null)
  const [sections, setSections] = useState<SectionState[]>([])
  const sectionRef = useRef<SectionState | null>(null)
  sectionRef.current = section
  const sectionsRef = useRef<SectionState[]>([])
  sectionsRef.current = sections
  const [canvases, setCanvases] = useState<CanvasDTO[]>([])
  // while a dress-up dialog (fillet / chamfer / shell / draft) is open, the
  // polylines of the edges/faces the feature references on its BASE shape - the
  // dressed result has consumed them from the visible solid, so this lets the
  // viewport draw them as a highlighted, pickable ghost you can Ctrl-click to
  // deselect. Empty when no such dialog is open.
  const [dressUpGhost, setDressUpGhost] = useState<import('./rpc').BaseRef[]>([])
  const [renderSettings, setRenderSettings] = useState<RenderSettings>({})
  const [showAppearance, setShowAppearance] = useState(false)
  const [showFirstRun, setShowFirstRun] = useState(
    () => !window.cad.isE2E && !firstRunDone()
  )
  const [busy, setBusy] = useState(0)

  useEffect(() => onBusyChange(setBusy), [])

  // one serialised lane for every model mutation - fast double-clicks / key mash
  // queue up and run in order; a task that throws is reported and skipped, never
  // wedging the app. Wired to the notice + spinner just below refreshScene.
  const cmdRef = useRef<CmdQueue>(new CmdQueue())

  const [tabs, setTabs] = useState<DocTab[]>([{ id: 'd1', name: 'Untitled', dirty: false, path: null }])
  const [activeTab, setActiveTab] = useState('d1')

  const vpApi = useRef<ViewportApi | null>(null)
  const drawApi = useRef<DrawingSheetApi | null>(null)
  const bodyId = bodies[0]?.id ?? null

  const markDirty = useCallback(
    (d = true) => setTabs((t) => t.map((x) => (x.id === activeTab ? { ...x, dirty: d } : x))),
    [activeTab]
  )

  // scrubber cache: scene+tree snapshots keyed by rollback position, so moving
  // the timeline marker back over a spot you have already visited is instant
  const rollCacheRef = useRef<
    Map<string, { scene: Awaited<ReturnType<typeof api.sceneGet>>; tree: Awaited<ReturnType<typeof api.treeGet>> }>
  >(new Map())
  const rollSeqRef = useRef(0)

  const applySceneTree = useCallback(
    (
      scene: Awaited<ReturnType<typeof api.sceneGet>>,
      tree: Awaited<ReturnType<typeof api.treeGet>>
    ) => {
      setMeshes(scene.meshes)
      setSketches(scene.sketches ?? [])
      setDatums(scene.datums ?? [])
      setPickPlanes(scene.pickPlanes ?? [])
      setCanvases(scene.canvases ?? [])
      setSections((scene.sections ?? []) as SectionState[])
      if (scene.renderSettings) setRenderSettings(scene.renderSettings)
      setBodies(tree.bodies)
      setImported(tree.imported ?? [])
      setDocPath(tree.path)
      if ('canUndo' in tree) setCanUndo(!!tree.canUndo)
      if ('canRedo' in tree) setCanRedo(!!tree.canRedo)
      // keep the user's show/hide choices across refreshes
    },
    []
  )

  const refreshScene = useCallback(async () => {
    const done = traceSpan('refreshScene')
    rollCacheRef.current.clear()
    const [scene, tree, asm, drawings] = await Promise.all([
      api.sceneGet(),
      api.treeGet(),
      api.assemblyTree().catch(() => null),
      apiQuiet.drawingPageList().catch(() => ({ pages: [] }))
    ])
    applySceneTree(scene, tree)
    setDrawingPages(drawings.pages)
    setAsmTree(asm && asm.assembly ? asm : null)
    if (asm && asm.assembly && docPath) {
      void window.cad
        .asmPinRead(docPath)
        .then(setAsmPins)
        .catch(() => setAsmPins({}))
    } else {
      setAsmPins({})
    }
    done()
  }, [applySceneTree, docPath])

  // route every queued-command failure to a notice + a resync from engine truth,
  // so a rejected op leaves the UI consistent instead of half-applied
  useEffect(() => {
    const q = cmdRef.current
    q.onError = (err, label) => {
      const msg = (err.message || 'command failed').replace(/^RPC \w+\.\w+:\s*/, '')
      flashSketchNotice(`${label}: ${msg}`)
      void refreshScene().catch(() => undefined)
    }
    q.onBusyChange = (b) => setBusy((n) => Math.max(0, n + (b ? 1 : -1)))
    return () => {
      q.onError = null
      q.onBusyChange = null
    }
  }, [refreshScene, flashSketchNotice])

  const refreshMeshesOnly = useCallback(async (quiet = false) => {
    // quiet = no busy spinner (used by the live feature preview, which fires
    // repeatedly as a value is tuned)
    const done = traceSpan('refreshMeshesOnly', { quiet })
    const a = quiet ? apiQuiet : api
    const [scene, tree] = await Promise.all([a.sceneGet(), a.treeGet()])
    setMeshes(scene.meshes)
    setSketches(scene.sketches ?? [])
    setDatums(scene.datums ?? [])
    setPickPlanes(scene.pickPlanes ?? [])
    setSections((scene.sections ?? []) as SectionState[])
    setBodies(tree.bodies)
    setImported(tree.imported ?? [])
    done()
    // keep the user's client-side hide/show across a mesh refresh
  }, [])

  const toggleGroup = useCallback(
    (group: 'bodies' | 'sketches' | 'origin', visible: boolean) => {
      // pure view state - the viewport flips .visible flags. FreeCAD is never
      // touched for show/hide, so there is nothing to wait on.
      setVisOverride((m) => {
        const next = { ...m }
        if (group === 'bodies') for (const mm of meshes) next[mm.id] = visible
        if (group === 'sketches') for (const s of sketches) next[s.id] = visible
        if (group === 'origin')
          for (const b of bodies) for (const o of b.origin) next[o.id] = visible
        return next
      })
    },
    [meshes, sketches, bodies]
  )

  const afterEdit = useCallback(async () => {
    await refreshScene()
    markDirty()
    setSelection([])
  }, [refreshScene, markDirty])

  // ---- selection ----
  const measureModeRef = useRef(false)
  measureModeRef.current = measureMode
  const opRef = useRef<OpKind | null>(null)
  opRef.current = op
  // whether the open operation dialog would let you press OK (mirrors its own
  // `ready`); surfaced through the test bridge so E2E can catch "preview renders
  // but OK stays disabled" bugs.
  const opReadyRef = useRef(false)
  if (!op) opReadyRef.current = false
  const setOpReady = useCallback((r: boolean) => {
    opReadyRef.current = r
  }, [])

  const openOp = useCallback((k: OpKind | null) => {
    trace('ACTION openOp', { k, from: opRef.current, queueBusy: cmdRef.current.busy })
    setOp(k)
    if (k == null) setDressUpGhost([]) // dialog closed - drop the ghost overlay
  }, [])

  const onSelectCore = useCallback(
    (sel: Selection | null, additive: boolean) => {
      trace('ACTION pick', {
        sel: sel ? selKey(sel) : null,
        additive,
        op: opRef.current,
        queueBusy: cmdRef.current.busy
      })
      if (!sel) {
        // a miss-click (empty space) must NOT wipe the op's inputs while a
        // feature dialog is open - only Cancel does that. Otherwise it is easy
        // to lose the profile sketch mid-extrude and end up picking a face of
        // the now-orphaned preview solid.
        if (!additive && opRef.current == null) setSelection([])
        return
      }
      // measure mode: every click adds a probe (face / edge / vertex), rolling
      // at two, no coplanar lock, no shift needed. Click the same one to drop it.
      if (measureModeRef.current && (sel.kind === 'face' || sel.kind === 'edge' || sel.kind === 'vertex')) {
        setSelection((cur) => {
          const k = selKey(sel)
          if (cur.some((s) => selKey(s) === k)) return cur.filter((s) => selKey(s) !== k)
          const probes = cur.filter(
            (s) => s.kind === 'face' || s.kind === 'edge' || s.kind === 'vertex'
          )
          return [...probes, sel].slice(-2)
        })
        return
      }
      const activeFilter = opSelKinds(opRef.current) ?? selFilter
      if (!activeFilter.includes(sel.kind as SelKind)) return // selection filter (narrowed while an op dialog is open)
      // A feature dialog is open. For ops with a SKETCH PROFILE (extrude /
      // revolve / loft) a plain click must not wipe that profile, so force
      // additive - cancel the dialog to start over. For reference-picking ops
      // (fillet, chamfer, shell, draft, hole, and the datum tools) do what the
      // user expects: a plain click REPLACES the reference set (so a stray pick
      // is easy to undo) and Ctrl / Shift / Cmd-click adds or removes one.
      const refPickOp =
        opRef.current === 'fillet' ||
        opRef.current === 'chamfer' ||
        opRef.current === 'shell' ||
        opRef.current === 'draft' ||
        opRef.current === 'hole' ||
        opRef.current === 'datumPlane' ||
        opRef.current === 'datumAxis' ||
        opRef.current === 'datumPoint'
      if (opRef.current != null && !refPickOp) additive = true
      // for a dress-up op the live preview renumbers the body's Edge*/Face*
      // names, so two clicks on the SAME real edge can come back with different
      // sub names, and two clicks on DIFFERENT edges can collide on one name.
      // Match by the 3D click point instead while such a dialog is open.
      const dressUpPick =
        opRef.current === 'fillet' ||
        opRef.current === 'chamfer' ||
        opRef.current === 'shell' ||
        opRef.current === 'draft'
      const realPt = (p?: number[]): p is number[] =>
        !!p && (Math.abs(p[0]) > 1e-9 || Math.abs(p[1]) > 1e-9 || Math.abs(p[2]) > 1e-9)
      const samePick = (a: Selection, b: Selection): boolean => {
        if (a.kind !== b.kind) return false
        const pa = (a as { point?: number[] }).point
        const pb = (b as { point?: number[] }).point
        // for a dress-up op the live preview renumbers Edge*/Face*, so two
        // clicks on the same real edge can carry different sub names - match by
        // the 3D click point instead. Only when BOTH points are real (a
        // [0,0,0] sentinel from a test / non-viewport caller must never match).
        if (dressUpPick && realPt(pa) && realPt(pb)) {
          return Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]) < 1.0
        }
        return selKey(a) === selKey(b)
      }
      setSelection((cur) => {
        if (!additive) return [sel]
        if (cur.some((s) => samePick(s, sel))) return cur.filter((s) => !samePick(s, sel))
        // extrude / revolve / loft already have a sketch profile: a face click
        // is almost always a stray hit on the live-preview solid. Allow at most
        // ONE extra face (an "up to" target) and never let a face pile up or
        // shadow the sketch as a profile.
        if (
          sel.kind === 'face' &&
          (opRef.current === 'extrude' || opRef.current === 'revolve' || opRef.current === 'loft') &&
          cur.some((s) => s.kind === 'sketch') &&
          cur.some((s) => s.kind === 'face')
        ) {
          trace('pick ignored: face on preview solid (sketch profile already set)', { op: opRef.current })
          return cur
        }
        // multi-face pick: once one face is chosen, only add coplanar faces
        // (clear the selection to start on a different plane). Only for extrude
        // / no dialog - shell, draft, etc. legitimately want faces on many planes.
        // The Assembly panel's joint picker needs the opposite: it always wants
        // "one face on each of two DIFFERENT components", which are almost
        // never coplanar/parallel by construction (a hinge face and the face
        // it hinges against typically point different directions) - this lock
        // made "Add joint" nearly impossible to use, since the second
        // ctrl-click on the other component's face was silently dropped
        // (found live: picking an enclosure interior face after a PCB top
        // face left the selection at 1, "Add joint" stayed disabled - user
        // asked specifically whether joints work, 2026-09-19).
        const coplanarLock = (opRef.current == null && !asmTree) || opRef.current === 'extrude'
        if (coplanarLock && sel.kind === 'face' && sel.normal) {
          const first = cur.find((s) => s.kind === 'face' && s.normal) as
            | Extract<Selection, { kind: 'face' }>
            | undefined
          if (first?.normal) {
            const [nx, ny, nz] = first.normal
            const [mx, my, mz] = sel.normal
            const parallel = Math.abs(nx * mx + ny * my + nz * mz) > 0.999
            const dp =
              (sel.point[0] - first.point[0]) * nx +
              (sel.point[1] - first.point[1]) * ny +
              (sel.point[2] - first.point[2]) * nz
            if (!parallel || Math.abs(dp) > 0.05) return cur // not coplanar - ignore
          }
        }
        return [...cur, sel]
      })
    },
    [selFilter, asmTree]
  )

  // shift-click "select the loop": for an edge pick, resolve the whole
  // tangent-continuous chain through it (server-side, against the real
  // topology - stops at a sharp corner or a branch, same as a rounded
  // profile continuing smoothly but a 90-degree corner not) and add every
  // edge in it, same as an additive pick of each one. ctrl/cmd-click still
  // adds just the one edge, unchanged. A non-edge pick (or the loop RPC
  // failing) falls straight through to the plain additive/replace path.
  const onSelect = useCallback(
    (sel: Selection | null, mode: 'replace' | 'additive' | 'loop') => {
      if (mode === 'loop' && sel && sel.kind === 'edge') {
        void (async () => {
          try {
            const { edges } = await api.edgeLoopFrom(sel.bodyId, sel.sub)
            if (edges.length <= 1) {
              onSelectCore(sel, false)
              return
            }
            let first = true
            for (const sub of edges) {
              const idx = Number(sub.slice(4)) - 1
              onSelectCore(
                { kind: 'edge', bodyId: sel.bodyId, index: idx, sub, point: sel.point },
                first ? false : true
              )
              first = false
            }
          } catch {
            onSelectCore(sel, false)
          }
        })()
        return
      }
      onSelectCore(sel, mode === 'additive')
    },
    [onSelectCore]
  )

  // ---- feature ops ----
  const sweep = useCallback(async () => {
    const sk = selection
      .filter((s) => s.kind === 'sketch')
      .map((s) => (s as { sketchId: string }).sketchId)
    const edge = selection.find((s) => s.kind === 'edge') as
      | { bodyId: string; sub: string }
      | undefined
    if (sk.length === 2) {
      // profile + path sketches
    } else if (sk.length === 1 && edge) {
      // profile sketch + a body edge as the path - fine
    } else {
      window.alert('Select a profile sketch plus a path: another sketch, or a body edge.')
      return
    }
    try {
      if (sk.length === 2) await api.sweep(sk[0], sk[1])
      else await api.sweep(sk[0], null, false, { kind: 'edge', bodyId: edge!.bodyId, sub: edge!.sub })
      await afterEdit()
    } catch (e) {
      window.alert((e as Error).message)
    }
  }, [selection, afterEdit])

  const resetSketchUi = useCallback(() => {
    setSketchTool('line')
    setSketchCount(0)
    setSketchConstruction(false)
    setSketchAvail([])
    setSketchConstraintCount(0)
    setSelection([])
  }, [])

  const sketchOnRef = useRef<Promise<{ sketchId: string; bodyId: string }> | null>(null)

  const beginSketch = useCallback(
    async (ref: SketchRef) => {
      trace('ACTION beginSketch', { ref, queueBusy: cmdRef.current.busy })
      setPlanePickMode(false)
      // origin planes have a known frame - enter the sketcher instantly and let
      // the engine create the sketch object in the background
      const ORIGIN_FRAMES: Record<string, SketchFrameDTO> = {
        XY_Plane: { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] },
        XZ_Plane: { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 0, 1], z: [0, -1, 0] },
        YZ_Plane: { origin: [0, 0, 0], x: [0, 1, 0], y: [0, 0, 1], z: [1, 0, 0] }
      }
      if (ref.kind === 'origin' && ORIGIN_FRAMES[ref.role]) {
        setSketchSession({ sketchId: '', bodyId: bodyId ?? '', frame: ORIGIN_FRAMES[ref.role], refGeom: null })
        resetSketchUi()
        sketchOnRef.current = api
          .sketchOn(ref)
          .then((r) => {
            setSketchSession((s) => (s ? { ...s, sketchId: r.sketchId, bodyId: r.bodyId } : s))
            return { sketchId: r.sketchId, bodyId: r.bodyId }
          })
        return
      }
      const r = await api.sketchOn(ref)
      setSketchSession({
        sketchId: r.sketchId,
        bodyId: r.bodyId,
        frame: r.frame,
        refGeom: r.refGeom
      })
      resetSketchUi()
    },
    [resetSketchUi, bodyId]
  )

  const createSketch = useCallback(async () => {
    const face = selection.find((s) => s.kind === 'face') as
      | { bodyId: string; sub: string }
      | undefined
    setSketchInitial([])
    setSketchInitialCons([])
    setSketchInitialProjected([])
    if (face) {
      void beginSketch({ kind: 'face', bodyId: face.bodyId, sub: face.sub })
    } else {
      setPlanePickMode(true) // click a plane / face in the viewport
    }
  }, [selection, beginSketch])

  // While picking a sketch plane, show the real origin (and construction)
  // planes; restore their prior visibility when the pick ends.
  const datumsRef = useRef(datums)
  datumsRef.current = datums
  const planeVisSaved = useRef<Record<string, boolean | undefined>>({})
  useEffect(() => {
    const planeIds = datumsRef.current.filter((d) => d.kind === 'plane').map((d) => d.id)
    if (planePickMode) {
      if (Object.keys(planeVisSaved.current).length) return
      const saved: Record<string, boolean | undefined> = {}
      setVisOverride((prev) => {
        const next = { ...prev }
        for (const id of planeIds) {
          saved[id] = prev[id]
          next[id] = true
        }
        return next
      })
      planeVisSaved.current = saved
    } else {
      const saved = planeVisSaved.current
      if (!Object.keys(saved).length) return
      setVisOverride((prev) => {
        const next = { ...prev }
        for (const [id, was] of Object.entries(saved)) {
          if (was === undefined) delete next[id]
          else next[id] = was
        }
        return next
      })
      planeVisSaved.current = {}
    }
  }, [planePickMode])

  const editSketch = useCallback(
    async (sketchId: string) => {
      const r = await api.sketchReopen(sketchId)
      setSketchInitial(r.entities)
      setSketchInitialCons(r.constraints ?? [])
      setSketchInitialProjected(r.projected ?? [])
      setSketchSession({
        sketchId,
        bodyId: r.bodyId ?? '',
        frame: r.frame,
        refGeom: r.refGeom,
        isEdit: true
      })
      resetSketchUi()
      setSketchTool('select')
      setSketchCount(r.entities.length)
      // show the model as of this sketch while editing, same as editFeature's
      // dialog does for every other feature kind - roll the marker (and the
      // timeline's own scroll position) back to right after it, restored on
      // Finish/Cancel below. Previously this never touched the marker at
      // all, so reopening an old sketch left the timeline sitting wherever
      // it already was - looking like nothing happened (user report,
      // 2026-09-12: "when I go and edit a previous sketch or feature, the
      // timeline should scroll back to right after that feature").
      if (r.bodyId) {
        try {
          await apiQuiet.rollTo(r.bodyId, sketchId)
          await refreshScene()
        } catch {
          /* the editor still opens; not fatal if the marker didn't move */
        }
      }
    },
    [resetSketchUi, refreshScene]
  )

  const finishSketch = useCallback(async () => {
    trace('ACTION finishSketch', { queueBusy: cmdRef.current.busy })
    if (!sketchSession) return
    const newEnts = vpApi.current?.getNewSketchEntities() ?? []
    const allEnts = vpApi.current?.getSketchEntities() ?? []
    const cons = (vpApi.current?.getNewSketchConstraints() ?? []) as SketchConstraint[]
    const removedCons = (vpApi.current?.getRemovedSketchConstraints() ?? []) as SketchConstraint[]
    const removedEnts = vpApi.current?.getRemovedSketchEntities() ?? []
    const convertedEnts = vpApi.current?.getConvertedSketchEntities() ?? []
    // sketch.finish's `elements` is purely additive (every entry becomes a
    // fresh sk.addGeometry() server-side) and getNewSketchEntities() only
    // ever covers entities added since reopen - a base entity whose raw
    // SHAPE was dragged this session, with no dimension recording the new
    // value, had no channel to reach the sidecar at all: the edit looked
    // committed in the editor, but Finish silently dropped it (real user
    // report, 2026-09-14 - a Sweep downstream of the edited sketch "didn't
    // error or update" because nothing was ever actually sent). Send each
    // edited base entity's new raw shape as an IN-PLACE update against its
    // existing geo id (movedElements) - not a delete+re-add, which would
    // silently drop every OTHER still-valid constraint on that same entity
    // (FreeCAD auto-removes a deleted geometry's dependent constraints).
    const movedEnts = vpApi.current?.getEditedBaseSketchEntities() ?? []
    const { frame, isEdit, bodyId: sketchBodyId } = sketchSession
    // optimistic origin-plane entry may not have the real id back yet
    let id = sketchSession.sketchId
    if (!id && sketchOnRef.current) {
      try {
        id = (await sketchOnRef.current).sketchId
      } catch {
        /* handled below */
      }
    }
    if (!id) {
      window.alert('The sketch is still being created - try Finish again in a moment.')
      return
    }
    sketchOnRef.current = null

    // 1. leave sketch mode and paint the finished sketch immediately from the
    //    entities we already have - no waiting on the engine.
    const optimistic = { id, label: id, polys: sketchEntitiesToPolys(allEnts as never[], frame), visible: true }
    setSketches((prev) => [...prev.filter((s) => s.id !== id), optimistic])
    setSketchSession(null)
    setSketchInitial([])
    setSketchInitialCons([])
    setSketchInitialProjected([])
    resetSketchUi()
    setSelection([{ kind: 'sketch', sketchId: id }])
    markDirty()
    rollCacheRef.current.clear()

    // 2. commit to the engine in the background, then reconcile with the real
    //    (constraint-solved) geometry. Uses the quiet RPC path - no spinner.
    const erroredBefore = new Set(
      bodies.flatMap((b) => b.features).filter((f) => f.error).map((f) => f.id)
    )
    try {
      await apiQuiet.sketchFinish(id, newEnts, cons, removedCons, removedEnts, convertedEnts, movedEnts)
      const [scene, tree] = await Promise.all([apiQuiet.sceneGet(), apiQuiet.treeGet()])
      setMeshes(scene.meshes)
      setSketches(scene.sketches ?? [])
      setDatums(scene.datums ?? [])
      setBodies(tree.bodies)
      setImported(tree.imported ?? [])
      // A feature downstream of this sketch (Sweep, Pad, ...) can fail to
      // regenerate on recompute with NO exception thrown - FreeCAD just
      // leaves it in an error state holding its last-good shape, silently.
      // Flag anything that newly went red so the edit doesn't look like it
      // "did nothing" when it actually broke something further down the
      // tree. (User report, 2026-09-14: a Sweep "didn't error or update"
      // after a profile edit + Finish + roll down the timeline.)
      const newlyErrored = tree.bodies
        .flatMap((b) => b.features)
        .filter((f) => f.error && !erroredBefore.has(f.id))
      if (newlyErrored.length) {
        flashSketchNotice(
          `${newlyErrored.map((f) => f.label).join(', ')} failed to update from this sketch change` +
            (newlyErrored[0].errorText ? `: ${newlyErrored[0].errorText}` : '.')
        )
      }
      // Re-finishing an EXISTING sketch (editSketch rolled the marker back to
      // it) must resume all the way to the tip, same as cancelling an edit
      // already does - sketch.finish's own marker logic instead parks on the
      // sketch itself, which is correct for a BRAND NEW sketch drawn mid
      // timeline (see the comment on that block) but wrong here: an edited
      // sketch already has real downstream consumers (Pad/Sweep/...), and
      // leaving the marker sitting on it forces its raw wireframe visible as
      // an "at the rollback point" overlay on top of the already-correctly-
      // updated solid - the exact stale-looking "ghost" of the pre-edit shape
      // the user reported (2026-09-14), right up until they happened to also
      // scrub the timeline themselves.
      if (isEdit && sketchBodyId) {
        await apiQuiet.rollTo(sketchBodyId, null).catch(() => undefined)
        rollCacheRef.current.clear()
        await refreshScene()
      }
    } catch (e) {
      window.alert((e as Error).message)
      await refreshScene()
    }
  }, [sketchSession, resetSketchUi, markDirty, refreshScene, bodies, flashSketchNotice])

  const cancelSketch = useCallback(async () => {
    trace('ACTION cancelSketch', { queueBusy: cmdRef.current.busy })
    if (sketchSession) {
      let id = sketchSession.sketchId
      if (!id && sketchOnRef.current) {
        try {
          id = (await sketchOnRef.current).sketchId
        } catch {
          /* never got created */
        }
      }
      // a re-opened sketch is left exactly as it was - the edits only ever lived
      // in the editor and were never sent. Only a brand-new sketch is discarded,
      // and that happens in the background (leave the editor immediately).
      if (id && !sketchSession.isEdit) {
        const deadId = id
        void (async () => {
          try {
            await api.deleteFeature(deadId)
          } catch {
            /* fresh sketch may already be gone */
          }
          await refreshScene()
        })()
      } else {
        // editing an existing sketch rolled the marker back to it (editSketch)
        // - roll home again, same as cancelling a full feature edit does
        if (sketchSession.isEdit && sketchSession.bodyId) {
          void apiQuiet
            .rollTo(sketchSession.bodyId, null)
            .catch(() => {})
            .then(() => refreshScene())
        } else {
          void refreshScene()
        }
      }
    }
    setSketchSession(null)
    setSketchInitial([])
    setSketchInitialCons([])
    setSketchInitialProjected([])
    sketchOnRef.current = null
  }, [sketchSession, refreshScene])

  // live-preview lifecycle (defined fully below applyOp; the ref is stable).
  // There is ever only ONE live-preview feature on the model. `featureId` is its
  // id; discarding the preview DELETES exactly that feature (never api.undo(),
  // which could eat a committed edit if a counter ever drifts). `kind`/`opSig`
  // gate whether a value change can be pushed in place vs. needs a rebuild.
  const livePreviewRef = useRef<{
    seq: number
    running: boolean
    pending: boolean
    featureId: string | null
    kind: OpKind | null
    opSig: string
    /** dress-up (fillet/chamfer/shell/draft/hole) preview: the edge/face sub
     * list currently applied, so adding one more updates the feature's Base in
     * place instead of tearing the whole preview down and rebuilding it */
    baseSig: string
    /** applyOp is mid-commit - the dialog unmount it triggers must NOT drain
     * the preview feature (in the fast path that feature IS the commit) */
    committing: boolean
    /** editing an existing feature: id of that feature. Preview then recomputes
     * only it (no throwaway feature, no downstream rebuild until Finish). */
    editing: string | null
  }>({
    seq: 0,
    running: false,
    pending: false,
    featureId: null,
    kind: null,
    opSig: '',
    baseSig: '',
    committing: false,
    editing: null
  })
  // full edit context: the feature being edited + a snapshot of its committed
  // params/refs so Cancel can put it back (editPreview mutates it in place).
  const editingFeatureRef = useRef<{
    id: string
    label: string
    values: OpValues
    refs: import('./rpc').FeatureEdit['refs']
  } | null>(null)
  const [editInit, setEditInit] = useState<OpValues | null>(null)
  const [editLabel, setEditLabel] = useState<string | null>(null)

  // OperationDialog's own role assignment (Profile / Path / Axis...) for the
  // apply currently in flight - the authoritative source for which pick is
  // which role on a spec.slots op (Sweep, Revolve), set right before the
  // commit and read once by that op's own case in applyOpImpl. Not state -
  // this only matters for the one apply it was set for.
  const applySlotSelRef = useRef<Record<string, Selection[]> | null>(null)

  // signature of the inputs that decide the feature's shape topology (so a
  // number tweak keeps the fast path but a Join->Cut switch forces a rebuild)
  const previewSig = useCallback((kind: OpKind, v: OpValues): string => {
    // EVERY selected reference matters, not just the first - a fillet gaining a
    // second edge, or an extrude re-pointed at a different face, must invalidate
    // the in-place fast path and force a full rebuild so the new ref set lands.
    const refs = selection
      .map((s) => selKey(s))
      .sort()
      .join(',')
    return [
      kind,
      refs || 'none',
      String(v.operation ?? ''),
      String(v.mode ?? ''),
      String(v.cut ?? ''),
      String(v.axis ?? '')
    ].join('|')
  }, [selection])

  // current selection -> the ref shape feature.update / feature.editPreview want
  const buildEditRefs = useCallback(
    (kind: OpKind, v?: OpValues): import('./rpc').FeatureEdit['refs'] => {
      const refs: import('./rpc').FeatureEdit['refs'] = {}
      const sk = selection.find((s) => s.kind === 'sketch') as { sketchId: string } | undefined
      const fc = selection.filter((s) => s.kind === 'face') as Array<{ bodyId: string; sub: string }>
      const ed = selection.filter((s) => s.kind === 'edge') as Array<{ bodyId: string; sub: string }>
      const pl = selection.find((s) => s.kind === 'plane') as
        | { role?: string; planeId: string }
        | undefined
      if (kind === 'extrude' || kind === 'revolve') {
        if (sk) refs.profile = { kind: 'sketch', id: sk.sketchId }
        else if (fc[0]) refs.profile = { kind: 'face', bodyId: fc[0].bodyId, sub: fc[0].sub }
        if (kind === 'revolve') {
          if (ed[0]) refs.axis = { kind: 'edge', bodyId: ed[0].bodyId, sub: ed[0].sub }
          else if (pl?.role) refs.axis = { kind: 'origin', role: pl.role }
          else if (pl) refs.axis = { kind: 'plane', id: pl.planeId }
        }
      } else if (kind === 'fillet' || kind === 'chamfer') {
        // Face* subs ride in the same list - PartDesign rounds all their edges
        refs.edges = [...ed.map((e) => e.sub), ...fc.map((f) => f.sub)]
      } else if (kind === 'shell' || kind === 'draft') {
        refs.faces = fc.map((f) => f.sub)
      } else if (kind === 'splitFace') {
        if (pl?.role) refs.planeOrAxis = { kind: 'origin', role: pl.role }
        else if (pl) refs.planeOrAxis = { kind: 'plane', id: pl.planeId }
        else if (fc[0]) refs.planeOrAxis = { kind: 'face', bodyId: fc[0].bodyId, sub: fc[0].sub }
      } else if (kind === 'sweep') {
        // same slot-based resolution as the CREATE path (case 'sweep' below)
        // - a flat `selection` scan can't tell "profile sketch" from "path
        // sketch" apart when both are sketches, so the dialog's own
        // Profile/Path boxes (applySlotSelRef) are authoritative here too.
        const slotSel = applySlotSelRef.current
        const profileSketchId = (slotSel?.profile ?? []).find((s) => s.kind === 'sketch')?.sketchId
        const pathItems = slotSel?.path ?? selection.filter((s) => s.kind !== 'sketch' || s.sketchId !== profileSketchId)
        const pathSketchSel = pathItems.find(
          (s) => s.kind === 'sketch' && s.sketchId !== profileSketchId
        ) as Extract<Selection, { kind: 'sketch' }> | undefined
        const pathEdges = pathItems.filter((s) => s.kind === 'edge') as Array<{
          bodyId: string
          sub: string
        }>
        const pathBodyId = pathEdges[0]?.bodyId
        const pathSubs = pathEdges.filter((e) => e.bodyId === pathBodyId).map((e) => e.sub)
        if (profileSketchId) refs.profile = { kind: 'sketch', id: profileSketchId }
        if (pathSketchSel) refs.path = { kind: 'sketch', id: pathSketchSel.sketchId }
        else if (pathBodyId && pathSubs.length) refs.path = { kind: 'edge', bodyId: pathBodyId, sub: pathSubs }
      } else if (kind === 'mirror' || kind === 'patternLinear' || kind === 'patternCircular') {
        // plane / axis / direction pick: a datum-plane or an edge/face
        if (pl?.role) refs.planeOrAxis = { kind: 'origin', role: pl.role }
        else if (pl) refs.planeOrAxis = { kind: 'plane', id: pl.planeId }
        else if (ed[0]) refs.planeOrAxis = { kind: 'edge', bodyId: ed[0].bodyId, sub: ed[0].sub }
        else if (fc[0]) refs.planeOrAxis = { kind: 'face', bodyId: fc[0].bodyId, sub: fc[0].sub }
        const scope = String(v?.scope ?? 'Body')
        refs.scope = scope
        if (scope === 'Features' && timelineSelRef.current.length)
          refs.features = timelineSelRef.current.slice()
      }
      return refs
    },
    [selection]
  )

  // discard the live-preview feature (if any) by DELETING it by id - deterministic,
  // it can never touch the user's committed features the way api.undo() could.
  const drainPreview = useCallback(async () => {
    const lp = livePreviewRef.current
    const id = lp.featureId
    lp.featureId = null
    lp.kind = null
    lp.opSig = ''
    lp.baseSig = ''
    if (!id) return
    trace('preview drain', { id })
    try {
      await apiQuiet.deleteFeature(id)
    } catch {
      /* already gone / cascaded away - fine */
    }
    setDressUpGhost([])
  }, [])

  // apply a preview RPC result: swap the affected body's mesh, and (for a
  // dress-up) refresh the ghost overlay of its base-shape edge/face refs
  const applyPreviewResult = useCallback(
    (res: { mesh: RenderMesh; baseRefs?: import('./rpc').BaseRef[] }) => {
      const { mesh } = res
      setMeshes((ms) => {
        const hit = ms.some((m) => m.id === mesh.id)
        return hit ? ms.map((m) => (m.id === mesh.id ? mesh : m)) : [...ms, mesh]
      })
      if (res.baseRefs) setDressUpGhost(res.baseRefs)
    },
    []
  )

  // op kind -> FreeCAD property names for the in-place fast path. A kind absent
  // here (or a mode that changes topology, e.g. extrude "To object") always
  // takes the full rebuild path instead.
  const previewProps = useCallback(
    (kind: OpKind, v: OpValues): Record<string, number | boolean> | null => {
      const n = (k: string): number | null => {
        const x = Number(v[k])
        return Number.isFinite(x) && x !== 0 ? x : null
      }
      switch (kind) {
        case 'extrude': {
          const len = n('length')
          // Intersect builds a scratch body + PartDesign::Boolean - no single
          // Length prop to nudge, so always take the full rebuild path.
          if (len == null || String(v.mode) === 'To object' || String(v.operation) === 'Intersect')
            return null
          return { Length: len, Midplane: Boolean(v.midplane), Reversed: Boolean(v.reversed) }
        }
        case 'revolve': {
          const a = n('angle')
          return a == null ? null : { Angle: a }
        }
        case 'fillet': {
          const r = n('radius')
          return r == null ? null : { Radius: r }
        }
        case 'chamfer': {
          const s = n('size')
          return s == null ? null : { Size: s }
        }
        case 'shell': {
          const t = n('thickness')
          return t == null ? null : { Thickness: t }
        }
        case 'draft': {
          const a = n('angle')
          return a == null ? null : { Angle: a }
        }
        case 'hole': {
          const d = n('diameter')
          const dep = n('depth')
          if (d == null) return null
          return dep == null ? { Diameter: d } : { Diameter: d, Depth: dep }
        }
        default:
          return null // rib (pad fallback), etc. - rebuild path
      }
    },
    []
  )

  // does this op have a usable primary number yet? a blank / 0 / half-typed
  // field (which happens constantly mid-edit) must NOT tear the preview down.
  const previewHasValue = useCallback((kind: OpKind, v: OpValues): boolean => {
    const key: Record<string, string> = {
      extrude: 'length',
      revolve: 'angle',
      fillet: 'radius',
      chamfer: 'size',
      shell: 'thickness',
      hole: 'diameter',
      draft: 'angle',
      rib: 'thickness'
    }
    const k = key[kind]
    if (!k) return true
    const n = Number(v[k])
    return Number.isFinite(n) && n !== 0
  }, [])

  const applyOpImpl = useCallback(
    async (kind: OpKind, v: OpValues, exprs: Record<string, string> = {}) => {
      const lp = livePreviewRef.current

      // EDIT COMMIT: reopened an existing feature - write params + refs back in
      // place (feature.update), then roll the marker home. No create, no promote.
      const edit = editingFeatureRef.current
      if (edit) {
        lp.committing = true
        lp.seq++
        lp.editing = null
        editingFeatureRef.current = null
        setEditInit(null)
        setEditLabel(null)
        setOp(null)
        try {
          await api.featureUpdate(edit.id, v, buildEditRefs(kind, v), exprs)
        } finally {
          try {
            if (bodyId) await apiQuiet.rollTo(bodyId, null) // back to the tip
          } catch {
            /* refreshScene below re-syncs anyway */
          }
          rollCacheRef.current.clear()
          await refreshScene()
          markDirty()
          setSelection([])
          lp.committing = false
        }
        return
      }

      // FAST COMMIT: the live preview already built exactly this feature (same
      // profile, same operation), so keep it instead of undo + re-extrude +
      // full scene refresh. Only its final number might differ if Finish beat
      // the debounce - push that in (~8ms) and we are done.
      // from here until we return / finish, the dialog unmount that setOp(null)
      // triggers must not let endLivePreview drain the preview feature - in the
      // fast path that feature IS the thing we are committing
      lp.committing = true
      const fastProps = previewProps(kind, v)
      // dress-up ops (fillet / chamfer / shell / draft) NEVER take the promote
      // fast path: the preview feature's Base can lag the current pick set by a
      // click (the live preview is debounced / async), and promoting it would
      // freeze that stale edge set into the commit. They rebuild from the full
      // current selection instead - cheap, and always correct.
      const dressUpCommit =
        kind === 'fillet' || kind === 'chamfer' || kind === 'shell' || kind === 'draft'
      if (
        !dressUpCommit &&
        lp.featureId != null &&
        lp.kind === kind &&
        lp.opSig === previewSig(kind, v) &&
        fastProps != null &&
        Object.keys(exprs).length === 0
      ) {
        // promote the preview feature to the committed one: detach it from the
        // live-preview bookkeeping BEFORE closing the dialog, so nothing can
        // delete it as a "leftover preview"
        const promotedId = lp.featureId
        lp.featureId = null
        lp.kind = null
        lp.opSig = ''
        lp.seq++
        trace('applyOp: FAST commit (promote preview)', { kind, featureId: promotedId, fastProps })
        setOp(null)
        try {
          const { mesh } = await apiQuiet.previewUpdate(promotedId, fastProps)
          setMeshes((ms) => ms.map((m) => (m.id === mesh.id ? mesh : m)))
          rollCacheRef.current.clear() // history changed - drop stale roll snapshots
          const tree = await api.treeGet()
          setBodies(tree.bodies)
          setImported(tree.imported ?? [])
          if ('canUndo' in tree) setCanUndo(!!tree.canUndo)
          if ('canRedo' in tree) setCanRedo(!!tree.canRedo)
          setSketches((ss) =>
            ss.filter((s) => !selection.some((x) => 'sketchId' in x && x.sketchId === s.id))
          )
          markDirty()
          setSelection([])
          lp.committing = false
          return
        } catch {
          // the promote failed - put the id back so the rebuild path can clean
          // it up, then fall through
          lp.featureId = promotedId
          await drainPreview()
        }
      }

      // discard any live-preview attempt so the real commit starts from a clean
      // model (applyOp stays the single source of truth for the committed feature)
      trace('applyOp: FULL commit (rebuild)', { kind, hadPreview: livePreviewRef.current.featureId })
      livePreviewRef.current.seq++
      await drainPreview()
      // close the dialog the instant the user commits - the engine rebuild and
      // scene refresh run behind the status spinner and reconcile when they land
      if (kind === 'datumPlane') setDatumGhostHold(true) // keep the ghost until the real datum lands
      setOp(null)
      const edgeSels = selection.filter((s) => s.kind === 'edge') as Array<{
        sub: string
        point?: [number, number, number]
      }>
      const edges = edgeSels.map((s) => s.sub)
      const faces = selection.filter((s) => s.kind === 'face') as Array<{
        bodyId: string
        sub: string
        point: [number, number, number]
        normal?: [number, number, number]
      }>
      // the exact 3D click point for every picked edge / face, POSITIONALLY
      // paired with the sub-name list above - a numbering-independent selector
      // the sidecar uses to resolve a dress-up set against the feature's real
      // base (the live preview shifts Edge* numbering, so names alone break for
      // a 2nd / 3rd Ctrl-clicked edge). Keep nulls so positions stay aligned.
      const dressUpPoints = [
        ...edgeSels.map((s) => s.point ?? null),
        ...faces.map((f) => f.point ?? null)
      ] as ([number, number, number] | null)[]
      const sketchIds = selection
        .filter((s) => s.kind === 'sketch')
        .map((s) => (s as { sketchId: string }).sketchId)
      try {
        switch (kind) {
          case 'extrude': {
            // extrude a sketch, OR (no sketch selected) a flat model face
            const faceProfile =
              !sketchIds[0] && faces[0] ? { bodyId: faces[0].bodyId, sub: faces[0].sub } : null
            if (!sketchIds[0] && !faceProfile)
              throw new Error(
                'Select a sketch (its outline / filled face) or a flat face of the model to extrude.'
              )
            const toObject = String(v.mode) === 'To object'
            if (!toObject && !(Number.isFinite(Number(v.length)) && Number(v.length) !== 0))
              throw new Error('Enter a non-zero distance.')
            // in "to object" mode the second selected face is the target
            const upToFace = toObject
              ? faces[faceProfile ? 1 : 0]
              : undefined
            const upTo =
              (upToFace
                ? { kind: 'face', bodyId: upToFace.bodyId, sub: upToFace.sub }
                : null) as import('./rpc').GeomRef | null
            const opMap: Record<string, 'join' | 'cut' | 'intersect' | 'newBody'> = {
              Join: 'join',
              Cut: 'cut',
              Intersect: 'intersect',
              'New body': 'newBody'
            }
            const operation = opMap[String(v.operation)] ?? 'join'
            await api.extrude(
              sketchIds[0] ?? null,
              Number(v.length),
              operation === 'cut',
              Boolean(v.midplane),
              Boolean(v.reversed),
              upTo,
              operation,
              toObject ? Number(v.offset ?? 0) : 0,
              faceProfile,
              Number(v.taper ?? 0),
              v.mode === 'Two Sides' ? Number(v.length2 ?? 0) : 0,
              Boolean(v.throughAll)
            )
            break
          }
          case 'revolve': {
            // the dialog's own Profile / Axis boxes (see OperationDialog's
            // spec.slots) are authoritative when present - a reselect that
            // landed a pick at the END of the flat `selection` array (e.g.
            // "go back and change just the axis") must not be misread as
            // the PROFILE just because sketchIds[0]/faces[0] happens to grab
            // whatever is first/last in that flat list instead of whichever
            // box it actually belongs to.
            const slotSel = applySlotSelRef.current
            const profileItems = slotSel?.profile ?? selection.filter((s) => s.kind === 'sketch' || s.kind === 'face')
            const axisItems = slotSel?.axis ?? selection
            const profileSketchId = profileItems.find((s) => s.kind === 'sketch')?.sketchId
            const profileFaceSel = profileItems.find((s) => s.kind === 'face') as
              | Extract<Selection, { kind: 'face' }>
              | undefined
            // axis: the dialog dropdown (Sketch vertical/horizontal, X/Y/Z, or a
            // selected edge / datum). A face profile always needs an explicit one.
            let { axisRef, axisCode } = revolveAxisRef(
              String(v.axis ?? ''),
              axisItems,
              profileSketchId
            )
            // no sketch selected: revolve a flat model face (needs an axis pick)
            const faceProfile =
              !profileSketchId && profileFaceSel
                ? { bodyId: profileFaceSel.bodyId, sub: profileFaceSel.sub }
                : null
            if (!profileSketchId && !faceProfile)
              throw new Error('Select a sketch, or a flat face of the model plus an axis, to revolve.')
            // a face has no vertical/horizontal of its own - fall back to any
            // edge / datum in the selection even if the dropdown was left on a
            // sketch option
            if (faceProfile && !axisRef) {
              axisRef = revolveAxisRef('Selected edge / datum', axisItems, profileSketchId).axisRef
            }
            if (faceProfile && !axisRef)
              throw new Error(
                'Revolving a face needs an axis - set Axis to X/Y/Z, or "Selected edge / datum" and click a straight edge or datum axis.'
              )
            const revOpMap: Record<string, 'join' | 'cut' | 'intersect' | 'newbody'> = {
              'New body': 'newbody',
              Join: 'join',
              Cut: 'cut',
              Intersect: 'intersect'
            }
            const revOp = revOpMap[String(v.operation ?? 'Join')] ?? 'join'
            const revAngle = v.full ? 360 : Number(v.angle)
            await api.revolve(
              profileSketchId ?? null,
              revAngle,
              axisCode,
              revOp === 'cut',
              axisRef,
              faceProfile,
              revOp
            )
            break
          }
          case 'loft': {
            const loftOpMap: Record<string, 'join' | 'cut' | 'intersect' | 'newbody'> = {
              'New body': 'newbody',
              Join: 'join',
              Cut: 'cut',
              Intersect: 'intersect'
            }
            const loftOp = loftOpMap[String(v.operation ?? 'Join')] ?? 'join'
            await api.loft(sketchIds, loftOp === 'cut', loftOp, Boolean(v.ruled), Boolean(v.closed))
            break
          }
          case 'sweep': {
            // the dialog's own Profile / Path boxes are authoritative when
            // present - same reasoning as revolve above. Falls back to the
            // old flat-list inference only if this op was applied some other
            // way (e.g. a test hook calling applyOp directly, bypassing the
            // dialog and its slots entirely).
            const slotSel = applySlotSelRef.current
            const profileSketchId =
              (slotSel?.profile ?? sketchIds.slice(0, 1).map((id) => ({ kind: 'sketch' as const, sketchId: id })))
                .find((s) => s.kind === 'sketch')?.sketchId
            const pathItems = slotSel?.path ?? selection
            const pathSketchId = pathItems.find(
              (s) => s.kind === 'sketch' && s.sketchId !== profileSketchId
            ) as Extract<Selection, { kind: 'sketch' }> | undefined
            // a path can be MULTIPLE connected edges (around a bend/corner),
            // not just one - ctrl-click each edge along the chain. They must
            // all be on the same body (a path spanning two different bodies
            // has no meaning), so only take edges past the first from a
            // different body as a mis-click rather than silently mixing them.
            const pathEdges = pathItems.filter((s) => s.kind === 'edge') as Array<{
              bodyId: string
              sub: string
            }>
            const pathBodyId = pathEdges[0]?.bodyId
            const pathSubs = pathEdges
              .filter((e) => e.bodyId === pathBodyId)
              .map((e) => e.sub)
            const sweepOpMap: Record<string, 'join' | 'cut' | 'intersect' | 'newbody'> = {
              'New body': 'newbody',
              Join: 'join',
              Cut: 'cut',
              Intersect: 'intersect'
            }
            const sweepOp = sweepOpMap[String(v.operation ?? 'Join')] ?? 'join'
            const orientation = String(v.orientation ?? 'Path') as 'Path' | 'Parallel'
            const transition = String(v.transition ?? 'Transformed') as
              | 'Transformed'
              | 'Right corner'
              | 'Round corner'
            if (!profileSketchId) {
              throw new Error(
                'Select a profile sketch, then click the path: another sketch, or one or more connected body edges.'
              )
            } else if (pathSketchId) {
              await api.sweep(
                profileSketchId,
                pathSketchId.sketchId,
                sweepOp === 'cut',
                null,
                sweepOp,
                orientation,
                transition
              )
            } else if (pathBodyId && pathSubs.length) {
              await api.sweep(
                profileSketchId,
                null,
                sweepOp === 'cut',
                { kind: 'edge', bodyId: pathBodyId, sub: pathSubs },
                sweepOp,
                orientation,
                transition
              )
            } else {
              throw new Error(
                'Select a profile sketch, then click the path: another sketch, or one or more connected body edges.'
              )
            }
            break
          }
          case 'draft': {
            // a selected plane, or a face not being drafted, is the neutral plane
            const draftSubs = new Set(faces.map((f) => f.sub))
            const neutral =
              (selection
                .map(selectionToRef)
                .find(
                  (r) =>
                    r &&
                    (r.kind === 'plane' ||
                      r.kind === 'origin' ||
                      (r.kind === 'face' && !draftSubs.has(r.sub)))
                ) as import('./rpc').GeomRef | undefined) ?? null
            await api.draft(faces.map((f) => f.sub), Number(v.angle), null, neutral)
            break
          }
          case 'rib':
            await api.rib(sketchIds[0], Number(v.thickness), Boolean(v.reversed))
            break
          case 'combine': {
            const bs = selection.filter((s) => s.kind === 'body').map((s) => (s as { bodyId: string }).bodyId)
            await api.combine(String(v.op), bs[0] ?? null, bs.slice(1), Boolean(v.keepTools))
            break
          }
          case 'fillet':
            // a picked face means "round every edge of this face" - PartDesign
            // takes Face* subs in the same list as Edge* subs
            await api.fillet(
              [...edges, ...faces.map((f) => f.sub)],
              Number(v.radius),
              dressUpPoints
            )
            break
          case 'chamfer':
            await api.chamfer(
              [...edges, ...faces.map((f) => f.sub)],
              Number(v.size),
              String(v.mode ?? 'Equal') as 'Equal' | 'Two distances' | 'Distance and angle',
              Number(v.size2 ?? 0),
              Number(v.angle ?? 45),
              dressUpPoints
            )
            break
          case 'shell':
            await api.shell(
              faces.map((f) => f.sub),
              Number(v.thickness),
              String(v.direction ?? 'Inside') as 'Inside' | 'Outside' | 'Both'
            )
            break
          case 'hole':
            await api.hole(
              faces[0].sub,
              faces[0].point,
              Number(v.diameter),
              Number(v.depth),
              Boolean(v.throughAll),
              String(v.cutType || 'None') as 'None' | 'Counterbore' | 'Countersink',
              Number(v.cutDiameter),
              Number(v.cutDepth)
            )
            break
          case 'move': {
            const tgt = selection.find((s) => s.kind === 'body' || s.kind === 'face') as
              | { bodyId: string }
              | undefined
            const id = tgt?.bodyId ?? bodies[0]?.id
            if (!id) break
            const modeMap: Record<string, 'translate' | 'rotate' | 'pointToPoint'> = {
              Translate: 'translate',
              Rotate: 'rotate',
              'Point to Point': 'pointToPoint'
            }
            const axisDirMap: Record<string, number[]> = {
              X: [1, 0, 0],
              Y: [0, 1, 0],
              Z: [0, 0, 1]
            }
            const pts = selection.filter((s) => s.kind === 'vertex') as Array<{
              point: [number, number, number]
            }>
            const edgeSel = selection.find((s) => s.kind === 'edge') as
              | { bodyId: string; sub: string }
              | undefined
            const axisDir =
              v.axis === 'Selected edge' && edgeSel
                ? undefined // sidecar falls back to its default when axisDir omitted; keep simple
                : axisDirMap[String(v.axis ?? 'Z')] ?? [0, 0, 1]
            await api.moveCopy({
              ids: [id],
              mode: modeMap[String(v.mode ?? 'Translate')] ?? 'translate',
              dx: Number(v.dx ?? 0),
              dy: Number(v.dy ?? 0),
              dz: Number(v.dz ?? 0),
              axisDir,
              angle: Number(v.angle ?? 0),
              fromPoint: pts[0]?.point ?? [0, 0, 0],
              toPoint: pts[1]?.point ?? [0, 0, 0],
              createCopy: Boolean(v.createCopy),
              copies: Math.max(1, Number(v.copies ?? 1))
            })
            break
          }
          case 'scale': {
            const tgt = selection.find((s) => s.kind === 'body' || s.kind === 'face') as
              | { bodyId: string }
              | undefined
            const id = tgt?.bodyId ?? bodies[0]?.id ?? null
            await api.scaleBody({
              id,
              uniform: Boolean(v.uniform ?? true),
              factor: Number(v.factor ?? 2),
              fx: Number(v.fx ?? 1),
              fy: Number(v.fy ?? 1),
              fz: Number(v.fz ?? 1)
            })
            break
          }
          case 'align': {
            // first picked face = FROM, second = TO
            const fs = selection.filter((s) => s.kind === 'face') as Array<{
              bodyId: string
              sub: string
            }>
            if (fs.length >= 2) {
              await api.alignBody(
                fs[0].bodyId,
                { kind: 'face', bodyId: fs[0].bodyId, sub: fs[0].sub },
                { kind: 'face', bodyId: fs[1].bodyId, sub: fs[1].sub }
              )
            }
            break
          }
          case 'pressPull': {
            const subs = [...edges, ...faces.map((f) => f.sub)]
            if (subs.length) await api.pressPull(subs, Number(v.distance ?? 2))
            break
          }
          case 'offsetFace': {
            if (faces.length) await api.offsetFace(faces.map((f) => f.sub), Number(v.distance ?? 2))
            break
          }
          case 'splitFace': {
            const plane = selection
              .filter((s) => s.kind === 'plane')
              .map(selectionToRef)
              .find(Boolean) ?? null
            if (faces.length) await api.splitFace(faces.map((f) => f.sub), plane)
            break
          }
          case 'patternLinear': {
            const { scope, refs } = transformScope(v, faces, timelineSel)
            // the direction pick is anything that is not one of the scope faces
            const dirRef =
              selection.filter((s) => s.kind !== 'face').map(selectionToRef).find(Boolean) ??
              selection.map(selectionToRef).find(Boolean) ??
              null
            await api.patternLinear(
              [1, 0, 0],
              Number(v.count),
              Number(v.spacing),
              dirRef,
              scope,
              refs,
              xformOp(v)
            )
            break
          }
          case 'patternCircular': {
            const { scope, refs } = transformScope(v, faces, timelineSel)
            const ref =
              selection.filter((s) => s.kind !== 'face').map(selectionToRef).find(Boolean) ??
              selection.map(selectionToRef).find(Boolean) ??
              null
            await api.patternCircular(
              Number(v.count),
              Number(v.angle),
              ref,
              'XY',
              scope,
              refs,
              xformOp(v)
            )
            break
          }
          case 'mirror': {
            const { scope, refs } = transformScope(v, faces, timelineSel)
            // mirror plane: a datum / origin plane, or a flat face that is NOT
            // one of the scope faces
            const scopeFaceSubs = new Set(scope === 'faces' ? refs : [])
            const ref =
              selection
                .filter((s) => s.kind !== 'face' || !scopeFaceSubs.has((s as { sub: string }).sub))
                .map(selectionToRef)
                .find(Boolean) ??
              selection.map(selectionToRef).find(Boolean) ??
              null
            await api.mirror(ref, 'YZ', scope, refs, xformOp(v))
            break
          }
          case 'datumPlane': {
            const refs = selection
              .map(selectionToRef)
              .filter(Boolean) as import('./rpc').GeomRef[]
            await api.datumPlane(
              null,
              Number(v.offset ?? 0),
              'XY',
              null,
              refs,
              Number(v.angle ?? 0),
              Boolean(v.flip)
            )
            break
          }
          case 'datumAxis': {
            const refs = selection
              .map(selectionToRef)
              .filter(Boolean) as import('./rpc').GeomRef[]
            await api.datumAxis(refs, Number(v.offset ?? 0), Boolean(v.flip))
            break
          }
          case 'datumPoint': {
            const refs = selection
              .map(selectionToRef)
              .filter(Boolean) as import('./rpc').GeomRef[]
            await api.datumPoint(refs)
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

          // --- CREATE: primitives ---
          case 'box':
          case 'cylinder':
          case 'sphere':
          case 'torus':
          case 'coil': {
            const opMap: Record<string, string> = {
              'New body': 'newbody',
              Join: 'join',
              Cut: 'cut',
              Intersect: 'intersect'
            }
            const operation = opMap[String(v.operation ?? 'New body')] ?? 'newbody'
            const planeRef =
              selection
                .filter((s) => s.kind === 'plane' || s.kind === 'face')
                .map(selectionToRef)
                .find(Boolean) ?? null
            if (kind === 'box')
              await api.primBox({
                length: Number(v.length),
                width: Number(v.width),
                height: Number(v.height),
                operation,
                planeRef
              })
            else if (kind === 'cylinder')
              await api.primCylinder({
                diameter: Number(v.diameter),
                height: Number(v.height),
                operation,
                planeRef
              })
            else if (kind === 'sphere')
              await api.primSphere({ diameter: Number(v.diameter), operation, planeRef })
            else if (kind === 'torus')
              await api.primTorus({
                meanDiameter: Number(v.meanDiameter),
                sectionDiameter: Number(v.sectionDiameter),
                operation,
                planeRef
              })
            else
              await api.primCoil({
                diameter: Number(v.diameter),
                pitch: Number(v.pitch),
                height: Number(v.pitch) * Number(v.turns ?? 1),
                sectionDiameter: Number(v.sectionDiameter),
                turns: Number(v.turns ?? 1),
                operation,
                planeRef
              })
            break
          }
          case 'pipe': {
            const opMap: Record<string, string> = {
              'New body': 'newbody',
              Join: 'join',
              Cut: 'cut',
              Intersect: 'intersect'
            }
            const pathRefs = (
              selection.filter((s) => s.kind === 'edge') as Array<{ bodyId: string; sub: string }>
            ).map((e) => ({ bodyId: e.bodyId, sub: e.sub }))
            if (pathRefs.length)
              await api.primPipe({
                pathRefs,
                sectionDiameter: Number(v.sectionDiameter),
                wallThickness: Number(v.wallThickness ?? 0),
                operation: opMap[String(v.operation ?? 'New body')] ?? 'newbody'
              })
            break
          }

          // --- MESH tab ---
          case 'meshFromBRep': {
            const tgt = selection.find((s) => s.kind === 'body' || s.kind === 'face') as
              | { bodyId: string }
              | undefined
            await api.meshFromBRep({
              bodyId: tgt?.bodyId ?? bodies[0]?.id ?? null,
              deflection: Number(v.deflection ?? 0.1),
              angularDeflection: Number(v.angularDeflection ?? 0.5)
            })
            break
          }
          case 'meshReduce':
            await api.meshReduce({
              id: null,
              targetFactor: Number(v.targetFactor ?? 0.5),
              targetCount: Number(v.targetCount ?? 0)
            })
            break
          case 'meshSmooth':
            await api.meshSmooth({ id: null, iterations: Number(v.iterations ?? 2) })
            break
          case 'meshPlaneCut': {
            const planeRef =
              selection
                .filter((s) => s.kind === 'plane' || s.kind === 'face')
                .map(selectionToRef)
                .find(Boolean) ?? null
            await api.meshPlaneCut({
              id: null,
              planeRef,
              base: [0, 0, 0],
              normal: [0, 0, 1],
              keep: String(v.keep ?? 'both'),
              fill: Boolean(v.fill)
            })
            break
          }
          case 'meshFlipNormals':
            await api.meshFlipNormals(null)
            break
          case 'meshRepair':
            await api.meshRepair({
              id: null,
              fixNormals: Boolean(v.fixNormals ?? true),
              fillHoles: Boolean(v.fillHoles ?? true),
              removeNonManifold: Boolean(v.removeNonManifold ?? true),
              removeDuplicates: Boolean(v.removeDuplicates ?? true)
            })
            break
          case 'meshSeparate':
            await api.meshSeparate(null)
            break
          case 'meshToSolid':
            await api.meshToSolid({
              id: null,
              mode: String(v.mode ?? 'faceted'),
              sewTolerance: Number(v.sewTolerance ?? 0.1)
            })
            break
        }
        // persist any dimension expressions against the feature just created
        const exprKeys = Object.keys(exprs)
        if (exprKeys.length) {
          const propByField: Record<string, Record<string, string>> = {
            extrude: { length: 'Length' },
            revolve: { angle: 'Angle' },
            fillet: { radius: 'Radius' },
            chamfer: { size: 'Size' },
            shell: { thickness: 'Value' },
            hole: { diameter: 'Diameter', depth: 'Depth' }
          }
          const map = propByField[kind]
          if (map) {
            const tree = await api.treeGet()
            const tip = tree.bodies.flatMap((b) => b.features).find((f) => f.isTip)
            if (tip) {
              for (const k of exprKeys) {
                if (map[k]) {
                  try {
                    await api.featureSetExpr(tip.id, map[k], exprs[k])
                  } catch {
                    /* keep the numeric value already applied */
                  }
                }
              }
            }
          }
        }
        await afterEdit()
      } finally {
        setDatumGhostHold(false)
        livePreviewRef.current.committing = false
      }
    },
    [
      selection,
      afterEdit,
      drainPreview,
      previewProps,
      previewSig,
      buildEditRefs,
      bodyId,
      refreshScene,
      markDirty
    ]
  )

  // public entry: every apply goes through the serialised queue, so a second
  // Finish click (or a click landing while one is mid-flight) waits its turn
  // instead of racing, and a failed op is reported + resynced, never half-left.
  const applyOp = useCallback(
    (
      kind: OpKind,
      v: OpValues,
      exprs: Record<string, string> = {},
      slotSel?: Record<string, Selection[]>
    ) => {
      const lp = livePreviewRef.current
      applySlotSelRef.current = slotSel ?? null
      trace('ACTION applyOp', {
        kind,
        v,
        exprs,
        queueBusy: cmdRef.current.busy,
        preview: { featureId: lp.featureId, kind: lp.kind, running: lp.running, pending: lp.pending }
      })
      return cmdRef.current.run(`Apply ${kind}`, () => applyOpImpl(kind, v, exprs))
    },
    [applyOpImpl]
  )

  // ---- live feature preview ----
  // Builds the feature in the engine (which is transactional) as the dialog's
  // number changes, rolling the previous attempt back first, so you see the
  // real result while tuning. Apply keeps it; Cancel / close rolls it back.
  const previewCall = useCallback(
    (kind: OpKind, v: OpValues): Promise<unknown> | null => {
      const faces = selection.filter((s) => s.kind === 'face') as Array<{
        bodyId: string
        sub: string
        point: [number, number, number]
      }>
      const edgeSels = selection.filter((s) => s.kind === 'edge') as Array<{
        sub: string
        point?: [number, number, number]
      }>
      const edges = edgeSels.map((s) => s.sub)
      const dressUpPoints = [
        ...edgeSels.map((s) => s.point ?? null),
        ...faces.map((f) => f.point ?? null)
      ] as ([number, number, number] | null)[]
      const sk = selection.find((s) => s.kind === 'sketch') as { sketchId: string } | undefined
      // preview only with plain finite numbers - a half-typed value or an
      // expression ("10mm") would send NaN to the engine and blank the result
      const num = (key: string): number | null => {
        const n = Number(v[key])
        return Number.isFinite(n) && n !== 0 ? n : null
      }
      switch (kind) {
        case 'extrude': {
          const opMap: Record<string, 'join' | 'cut' | 'intersect' | 'newBody'> = {
            Join: 'join',
            Cut: 'cut',
            Intersect: 'intersect',
            'New body': 'newBody'
          }
          const operation = opMap[String(v.operation)] ?? 'join'
          const faceProfile = !sk && faces[0] ? { bodyId: faces[0].bodyId, sub: faces[0].sub } : null
          const len = num('length')
          // Intersect spins up a scratch body + Boolean - not worth previewing
          // live (and hard to drain cleanly); it just commits on OK.
          if (
            (!sk && !faceProfile) ||
            len == null ||
            String(v.mode) === 'To object' ||
            operation === 'intersect'
          )
            return null
          return api.extrude(
            sk?.sketchId ?? null,
            len,
            operation === 'cut',
            Boolean(v.midplane),
            Boolean(v.reversed),
            null,
            operation,
            0,
            faceProfile,
            Number(v.taper ?? 0),
            v.mode === 'Two Sides' ? Number(v.length2 ?? 0) : 0,
            Boolean(v.throughAll)
          )
        }
        case 'revolve': {
          const ang = v.full ? 360 : num('angle')
          if (ang == null) return null
          const revCut = String(v.operation ?? 'Join') === 'Cut'
          const { axisRef, axisCode } = revolveAxisRef(
            String(v.axis ?? ''),
            selection,
            sk?.sketchId
          )
          // sketch profile: preview about the chosen axis (matches commit)
          if (sk) return api.revolve(sk.sketchId, ang, axisCode, revCut, axisRef)
          // face profile: needs a flat face plus an axis (edge / datum / X-Y-Z)
          const faceProfile = faces[0] ? { bodyId: faces[0].bodyId, sub: faces[0].sub } : null
          const faceAxis =
            axisRef ?? revolveAxisRef('Selected edge / datum', selection, undefined).axisRef
          return faceProfile && faceAxis
            ? api.revolve(null, ang, axisCode, revCut, faceAxis, faceProfile)
            : null
        }
        case 'fillet': {
          const rad = num('radius')
          const subs = [...edges, ...faces.map((f) => f.sub)]
          return subs.length && rad != null ? api.fillet(subs, rad, dressUpPoints) : null
        }
        case 'chamfer': {
          const sz = num('size')
          const subs = [...edges, ...faces.map((f) => f.sub)]
          return subs.length && sz != null
            ? api.chamfer(subs, sz, 'Equal', 0, 45, dressUpPoints)
            : null
        }
        case 'shell': {
          const th = num('thickness')
          return faces.length && th != null
            ? api.shell(
                faces.map((f) => f.sub),
                th,
                String(v.direction ?? 'Inside') as 'Inside' | 'Outside' | 'Both'
              )
            : null
        }
        case 'hole': {
          const dia = num('diameter')
          const dep = num('depth')
          return faces[0] && dia != null && dep != null
            ? api.hole(
                faces[0].sub,
                faces[0].point,
                dia,
                dep,
                Boolean(v.throughAll),
                String(v.cutType || 'None') as 'None' | 'Counterbore' | 'Countersink',
                Number(v.cutDiameter) || 0,
                Number(v.cutDepth) || 0
              )
            : null
        }
        case 'draft': {
          const ang = num('angle')
          return faces.length && ang != null
            ? api.draft(faces.map((f) => f.sub), ang, null, null)
            : null
        }
        case 'rib': {
          const th = num('thickness')
          return sk && th != null ? api.rib(sk.sketchId, th, Boolean(v.reversed)) : null
        }
        default:
          return null
      }
    },
    [selection]
  )

  const lastPreviewArgs = useRef<{ kind: OpKind; v: OpValues } | null>(null)

  const runLivePreview = useCallback(
    async (kind: OpKind, v: OpValues) => {
      const lp = livePreviewRef.current
      lastPreviewArgs.current = { kind, v }
      trace('preview request', {
        kind,
        v,
        running: lp.running,
        featureId: lp.featureId,
        lpKind: lp.kind,
        seq: lp.seq
      })
      // one in flight at a time; remember that a newer value is waiting so we
      // run exactly once more when this finishes (no stacking, no missed edit)
      if (lp.running) {
        lp.pending = true
        return
      }
      lp.running = true
      const t0 = performance.now()
      try {
        do {
          lp.pending = false
          const args = lastPreviewArgs.current!
          const seq = ++lp.seq
          try {
            // blank / zero / half-typed value: leave whatever preview is on
            // screen exactly as it is - do not drain or rebuild it
            if (!previewHasValue(args.kind, args.v)) {
              trace('preview skip: no usable value, keeping current')
              continue
            }

            // EDIT MODE: recompute ONLY the feature being edited (its downstream
            // chain stays as-is until Finish). No throwaway feature, no drain.
            if (lp.editing) {
              trace('preview EDIT', { id: lp.editing })
              try {
                const res = await apiQuiet.editPreview(
                  lp.editing,
                  args.v,
                  buildEditRefs(args.kind, args.v)
                )
                if (seq !== lp.seq) continue
                applyPreviewResult(res)
                setSketchNotice(null)
              } catch (e) {
                trace('preview EDIT error', { msg: (e as Error).message })
                setSketchNotice(
                  `Preview: ${(e as Error).message.replace(/^RPC \w+\.\w+:\s*/, '')}`
                )
              }
              continue
            }

            const fast = previewProps(args.kind, args.v)
            const sig = previewSig(args.kind, args.v)

            // DRESS-UP IN PLACE: fillet / chamfer / shell / draft / hole whose
            // edge/face set (or number) changed - re-point the existing preview
            // feature's Base and/or push the number. Never drain + rebuild, so
            // adding a second fillet edge just restyles the current preview
            // instead of it blinking away; a bad pick just shows a notice.
            const dressUp =
              args.kind === 'fillet' ||
              args.kind === 'chamfer' ||
              args.kind === 'shell' ||
              args.kind === 'draft' ||
              args.kind === 'hole'
            if (dressUp && lp.featureId && lp.kind === args.kind) {
              const wantEdges = args.kind === 'fillet' || args.kind === 'chamfer'
              const picks = selection.filter((s) =>
                wantEdges ? s.kind === 'edge' : s.kind === 'face'
              ) as Array<{ sub: string; point?: [number, number, number] }>
              const subs = picks.map((s) => s.sub)
              // positionally paired with `subs`; key the "did this change" sig
              // off the 3D points (rounded), NOT the Edge* names - once the
              // preview feature is on the body its names shift, so a name-based
              // sig would never register the 2nd / 3rd edge as "new"
              const points = picks.map((s) => s.point ?? null) as (
                | [number, number, number]
                | null
              )[]
              const allPts = points.every(Boolean)
              const baseSig = allPts
                ? (points as [number, number, number][])
                    .map((p) => p.map((n) => n.toFixed(2)).join(':'))
                    .sort()
                    .join('|')
                : subs.slice().sort().join(',')
              try {
                if (picks.length && baseSig !== lp.baseSig) {
                  trace('preview dress-up setBase', { id: lp.featureId, subs, points })
                  const res = await apiQuiet.previewSetBase(lp.featureId, subs, points)
                  if (seq !== lp.seq) continue
                  lp.baseSig = baseSig
                  applyPreviewResult(res)
                }
                if (fast) {
                  const res = await apiQuiet.previewUpdate(lp.featureId, fast)
                  if (seq !== lp.seq) continue
                  applyPreviewResult(res)
                }
                lp.opSig = sig
                setSketchNotice(null)
                trace('preview dress-up done', { ms: Math.round(performance.now() - t0) })
              } catch (e) {
                trace('preview dress-up error', { msg: (e as Error).message })
                setSketchNotice(
                  `Preview: ${(e as Error).message.replace(/^RPC \w+\.\w+:\s*/, '')}`
                )
              }
              continue
            }

            // FAST PATH: the preview feature already exists and only its numbers
            // changed - push them straight in (one recompute, one body meshed).
            if (lp.featureId && lp.kind === args.kind && lp.opSig === sig && fast) {
              trace('preview FAST', { id: lp.featureId, fast })
              const res = await apiQuiet.previewUpdate(lp.featureId, fast)
              if (seq !== lp.seq) continue
              applyPreviewResult(res)
              setSketchNotice(null)
              trace('preview FAST done', { ms: Math.round(performance.now() - t0) })
              continue
            }

            // FULL PATH: first preview of this kind, or a topology change - roll
            // back the old attempt and build a fresh one.
            trace('preview FULL', { featureId: lp.featureId, lpKind: lp.kind, want: args.kind, fast: !!fast })
            await drainPreview()
            // snapshot existing feature ids so we can be SURE the id we later
            // treat as "the preview feature" is genuinely new - discarding it
            // must never be able to delete a feature the user already committed
            const before = new Set(
              (bodies ?? []).flatMap((b) => b.features ?? []).map((f) => f.id)
            )
            const call = previewCall(args.kind, args.v)
            if (!call) {
              trace('preview FULL: previewCall null (bad/absent value)')
              await refreshMeshesOnly(true)
              continue
            }
            const res = (await call) as { bodies?: BodyTree[] }
            const created = (res?.bodies ?? [])
              .flatMap((b) => b.features ?? [])
              .filter((f) => f.kind !== 'sketch' && f.kind !== 'datum' && !before.has(f.id))
            const newest = created.at(-1)
            lp.featureId = newest?.id ?? null // only ever a brand-new feature
            lp.kind = args.kind
            lp.opSig = sig
            // remember the dress-up pick set (by 3D point, so the sig still
            // matches after the preview feature shifts Edge* numbering) so a
            // later add updates Base in place instead of rebuilding
            {
              const we = args.kind === 'fillet' || args.kind === 'chamfer'
              const du =
                args.kind === 'fillet' ||
                args.kind === 'chamfer' ||
                args.kind === 'shell' ||
                args.kind === 'draft' ||
                args.kind === 'hole'
              if (du) {
                const dpicks = selection.filter((s) =>
                  we ? s.kind === 'edge' : s.kind === 'face'
                ) as Array<{ sub: string; point?: [number, number, number] }>
                const dpts = dpicks
                  .map((s) => s.point)
                  .filter(Boolean) as [number, number, number][]
                lp.baseSig =
                  dpts.length === dpicks.length
                    ? dpts
                        .map((p) => p.map((n) => n.toFixed(2)).join(':'))
                        .sort()
                        .join('|')
                    : dpicks
                        .map((s) => s.sub)
                        .sort()
                        .join(',')
              } else {
                lp.baseSig = ''
              }
            }
            if (seq !== lp.seq) {
              await drainPreview() // a newer value already superseded this build
              continue
            }
            setSketchNotice(null)
            // pull just the new body's mesh in via the light path when we can
            // (keeps even the first preview snappy); otherwise fall back to a
            // full scene refresh so consumed sketches/datums reconcile
            let light = false
            if (lp.featureId) {
              try {
                const res = await apiQuiet.previewUpdate(lp.featureId, {})
                applyPreviewResult(res)
                // hide a sketch this feature just consumed so it does not show
                // through the preview solid
                setSketches((ss) => ss.filter((s) => !selection.some((x) => 'sketchId' in x && x.sketchId === s.id)))
                light = true
              } catch {
                /* fall through to the full refresh */
              }
            }
            if (!light) await refreshMeshesOnly(true)
            trace('preview FULL done', { ms: Math.round(performance.now() - t0), light, featureId: lp.featureId })
          } catch (e) {
            trace('preview ERROR', { msg: (e as Error).message })
            await drainPreview()
            const msg = (e as Error).message || 'preview failed'
            setSketchNotice(`Preview: ${msg.replace(/^RPC \w+\.\w+:\s*/, '')}`)
          }
        } while (lp.pending)
      } finally {
        lp.running = false
      }
    },
    [previewCall, previewProps, previewSig, previewHasValue, drainPreview, refreshMeshesOnly, selection, bodies, buildEditRefs]
  )

  const endLivePreview = useCallback(async () => {
    const lp = livePreviewRef.current
    trace('preview end', { featureId: lp.featureId, editing: lp.editing, committing: lp.committing })
    // applyOp is promoting / rebuilding this preview right now - it owns the
    // feature's fate; draining here would delete the feature being committed
    if (lp.committing) {
      lp.seq++
      lp.pending = false
      return
    }
    lp.seq++
    lp.pending = false
    setSketchNotice(null)
    // Cancel while editing: editPreview mutated the real feature in place, so
    // put its committed params/refs back, then roll the marker home.
    if (lp.editing) {
      const snap = editingFeatureRef.current
      lp.editing = null
      editingFeatureRef.current = null
      setEditInit(null)
      setEditLabel(null)
      try {
        if (snap) await api.featureUpdate(snap.id, snap.values, snap.refs ?? {})
        if (bodyId) await apiQuiet.rollTo(bodyId, null)
      } catch {
        /* refreshScene re-syncs */
      }
      rollCacheRef.current.clear()
      await refreshScene()
      return
    }
    if (lp.featureId) {
      await drainPreview()
      await refreshScene()
    }
  }, [drainPreview, refreshScene, bodyId])

  const cachePut = useCallback(
    (key: string, val: { scene: Awaited<ReturnType<typeof api.sceneGet>>; tree: Awaited<ReturnType<typeof api.treeGet>> }) => {
      const c = rollCacheRef.current
      c.delete(key) // move-to-newest for the LRU trim below
      c.set(key, val)
      while (c.size > PERF.rollCacheMax) c.delete(c.keys().next().value as string)
    },
    []
  )

  const rollTo = useCallback(
    async (featureId: string | null) => {
      trace('ACTION rollTo', { featureId, queueBusy: cmdRef.current.busy })
      if (!bodyId) return
      const key = `${bodyId}:${featureId ?? 'TIP'}`
      const seq = ++rollSeqRef.current
      const cached = rollCacheRef.current.get(key)
      if (cached) applySceneTree(cached.scene, cached.tree) // instant paint from cache

      if (!cached) {
        await api.rollTo(bodyId, featureId)
        if (rollSeqRef.current !== seq) return
        const [scene, tree] = await Promise.all([api.sceneGet(), api.treeGet()])
        if (rollSeqRef.current !== seq) return
        cachePut(key, { scene, tree })
        applySceneTree(scene, tree)
      }

      // Warm a few neighbouring positions in the background so a one- or two-step
      // scrub lands instantly. Sized by the machine's perf tier. Leaves the
      // engine back on `featureId` when done (or on cache-hit-only, re-syncs it).
      const feats = bodies[0]?.features ?? []
      const idx = featureId == null ? feats.length - 1 : feats.findIndex((f) => f.id === featureId)
      const wants: (string | null)[] = []
      for (let dd = 1; dd <= PERF.prefetchRadius; dd++) {
        for (const j of [idx - dd, idx + dd]) {
          if (j < 0 || j >= feats.length) continue
          const fid = j === feats.length - 1 ? null : feats[j].id
          if (!rollCacheRef.current.has(`${bodyId}:${fid ?? 'TIP'}`)) wants.push(fid)
        }
      }
      const needResync = cached && (wants.length === 0 || PERF.prefetchRadius === 0)
      if (needResync) {
        void apiQuiet.rollTo(bodyId, featureId).catch(() => undefined)
        return
      }
      if (!wants.length) return
      void (async () => {
        for (const fid of wants) {
          if (rollSeqRef.current !== seq) return
          try {
            await apiQuiet.rollTo(bodyId, fid)
            if (rollSeqRef.current !== seq) return
            const [scene, tree] = await Promise.all([apiQuiet.sceneGet(), apiQuiet.treeGet()])
            if (rollSeqRef.current !== seq) return
            cachePut(`${bodyId}:${fid ?? 'TIP'}`, { scene, tree })
          } catch {
            /* prefetch is best-effort */
          }
        }
        if (rollSeqRef.current === seq) await apiQuiet.rollTo(bodyId, featureId).catch(() => undefined)
      })()
    },
    [bodyId, bodies, applySceneTree, cachePut]
  )

  // (removed) "pre-cache previous build stages" - it rolled the LIVE document
  // back to an earlier feature and forward again in the background, so any
  // scene.get / screenshot / refresh that landed in that window saw the model
  // silently rolled back (blank / missing the latest feature). The first
  // timeline step-back now just does one engine roll; correctness beats the
  // ~100ms it saved. Scrubbing is still cached from real rollTo calls.

  const renameFeature = useCallback(
    async (id: string) => {
      const cur = bodies.flatMap((b) => b.features).find((f) => f.id === id)
      const next = await promptText('Rename', cur?.label ?? '')
      const label = next?.trim()
      if (!label) return
      // a rename is pure metadata - update the tree in place, persist quietly,
      // and never round-trip the scene / recompute (that was the slow part)
      setBodies((bs) =>
        bs.map((b) => ({
          ...b,
          label: b.id === id ? label : b.label,
          features: b.features.map((f) => (f.id === id ? { ...f, label } : f))
        }))
      )
      setSketches((ss) => ss.map((s) => (s.id === id ? { ...s, label } : s)))
      markDirty()
      try {
        await api.renameFeature(id, label)
      } catch (e) {
        window.alert((e as Error).message)
        await refreshScene()
      }
    },
    [bodies, markDirty, refreshScene]
  )

  const deleteFeature = useCallback(
    (id: string) => {
      trace('ACTION deleteFeature', { id, queueBusy: cmdRef.current.busy })
      // deleting the sketch you are CURRENTLY editing used to leave the
      // editor open on a now-dead object: the local live-preview solver needs
      // no server round-trip to keep drawing, so nothing failed until Finish
      // was clicked minutes later ("no object 'Sketch001'"), silently losing
      // every bit of work drawn in between (user report, 2026-09-11 - traced
      // from a real debug log showing exactly that sequence: reopen, delete
      // the same id mid-edit, ~60s of drawing, then a failed Finish). Warn
      // clearly and back out of the sketch editor as PART of the delete, so
      // the deletion still happens but you are never left drawing into thin
      // air.
      const deletingOwnSketch = sketchSession?.sketchId === id
      const msg = deletingOwnSketch
        ? 'You are currently editing this sketch. Deleting it will discard your unsaved changes and close the sketch editor. Delete anyway?'
        : 'Delete this feature?'
      if (!window.confirm(msg)) return Promise.resolve()
      if (deletingOwnSketch) {
        setSketchSession(null)
        setSketchInitial([])
        setSketchInitialCons([])
        setSketchInitialProjected([])
        sketchOnRef.current = null
      }
      // drop it from EVERY view state right away - tree, viewport meshes /
      // sketches / datums, selection - so it disappears the instant you click.
      // The engine rebuild runs behind the spinner and reconciles when it lands.
      setBodies((bs) => bs.map((b) => ({ ...b, features: b.features.filter((f) => f.id !== id) })))
      setMeshes((ms) => ms.filter((m) => m.id !== id))
      setSketches((ss) => ss.filter((s) => s.id !== id))
      setDatums((ds) => ds.filter((dm) => dm.id !== id))
      setVisOverride((m) => ({ ...m, [id]: false }))
      setSelection((cur) => cur.filter((s) => !('sketchId' in s && s.sketchId === id)))
      markDirty()
      return cmdRef.current.run('Delete feature', async () => {
        await api.deleteFeature(id)
        const [scene, tree] = await Promise.all([api.sceneGet(), api.treeGet()])
        applySceneTree(scene, tree)
      })
    },
    [markDirty, applySceneTree, sketchSession]
  )

  const suppressFeature = useCallback(
    (id: string, suppressed: boolean) =>
      cmdRef.current.run('Suppress feature', async () => {
        await api.featureSuppress(id, suppressed)
        await afterEdit()
      }),
    [afterEdit]
  )

  const suppressFeaturesMany = useCallback(
    (ids: string[], suppressed: boolean) => {
      if (!ids.length) return Promise.resolve()
      return cmdRef.current.run('Suppress features', async () => {
        for (const id of ids) await api.featureSuppress(id, suppressed)
        await afterEdit()
      })
    },
    [afterEdit]
  )

  const deleteFeaturesMany = useCallback(
    (ids: string[]) => {
      trace('ACTION deleteFeaturesMany', { ids, queueBusy: cmdRef.current.busy })
      if (!ids.length) return Promise.resolve()
      if (ids.length === 1) return deleteFeature(ids[0])
      if (!window.confirm(`Delete ${ids.length} features?`)) return Promise.resolve()
      const set = new Set(ids)
      // drop every target from view state at once so they vanish immediately
      setBodies((bs) =>
        bs.map((b) => ({ ...b, features: b.features.filter((f) => !set.has(f.id)) }))
      )
      setMeshes((ms) => ms.filter((m) => !set.has(m.id)))
      setSketches((ss) => ss.filter((s) => !set.has(s.id)))
      setDatums((ds) => ds.filter((dm) => !set.has(dm.id)))
      setVisOverride((m) => {
        const n = { ...m }
        ids.forEach((id) => (n[id] = false))
        return n
      })
      setSelection((cur) => cur.filter((s) => !('sketchId' in s && set.has(s.sketchId))))
      markDirty()
      // delete newest-first so earlier features never rebuild against a
      // dependant that is about to be removed anyway
      const order = (bodies[0]?.features ?? [])
        .map((f) => f.id)
        .filter((id) => set.has(id))
        .reverse()
      return cmdRef.current.run('Delete features', async () => {
        for (const id of order) {
          try {
            await api.deleteFeature(id)
          } catch (e) {
            // deleting one feature can cascade to its dependants, so a later id
            // in the batch may already be gone - that is success, not failure
            const m = (e as Error).message || ''
            if (/no object|not found|already|unknown feature/i.test(m)) continue
            throw e
          }
        }
        const [scene, tree] = await Promise.all([api.sceneGet(), api.treeGet()])
        applySceneTree(scene, tree)
      })
    },
    [deleteFeature, bodies, markDirty, applySceneTree]
  )

  const doUndo = useCallback(() => {
    if (!canUndo) return Promise.resolve()
    trace('ACTION undo', { queueBusy: cmdRef.current.busy })
    return cmdRef.current.run('Undo', async () => {
      const r = await api.undo()
      setCanUndo(r.canUndo)
      setCanRedo(r.canRedo)
      rollCacheRef.current.clear()
      // history moved - drop stale manual show/hide choices and trust the engine,
      // so e.g. undoing an extrude un-hides the sketch it had consumed
      setVisOverride({})
      await refreshScene()
      markDirty()
    })
  }, [canUndo, refreshScene, markDirty])

  const doRedo = useCallback(() => {
    if (!canRedo) return Promise.resolve()
    trace('ACTION redo', { queueBusy: cmdRef.current.busy })
    return cmdRef.current.run('Redo', async () => {
      const r = await api.redo()
      setCanUndo(r.canUndo)
      setCanRedo(r.canRedo)
      rollCacheRef.current.clear()
      setVisOverride({})
      await refreshScene()
      markDirty()
    })
  }, [canRedo, refreshScene, markDirty])

  const editFeatureDim = useCallback(
    async (id: string) => {
      let pd
      try {
        pd = await api.featurePrimaryDim(id)
      } catch (e) {
        window.alert((e as Error).message)
        return
      }
      if (!pd.prop) {
        window.alert('This feature has no editable dimension.')
        return
      }
      const cur = pd.expr ?? String(pd.value ?? '')
      const next = await promptText(`${pd.prop} (number or expression)`, cur)
      if (next == null || next === cur) return
      try {
        await api.featureSetExpr(id, pd.prop, next)
        rollCacheRef.current.clear()
        await refreshScene()
        markDirty()
      } catch (e) {
        window.alert((e as Error).message)
      }
    },
    [refreshScene, markDirty]
  )

  // reopen a committed feature in its real operation dialog: values + references
  // editable, live-previewed against just that feature, applied in place.
  const editFeature = useCallback(
    async (id: string) => {
      trace('ACTION editFeature', { id })
      let info: import('./rpc').FeatureEdit
      try {
        info = await apiQuiet.featureGet(id)
      } catch (e) {
        window.alert((e as Error).message)
        return
      }
      if (!info.kind) {
        // patterns / mirror / datums have no full dialog yet - quick value edit
        return editFeatureDim(id)
      }
      const kind = info.kind as OpKind
      const r = info.refs ?? {}
      const bid = bodyId ?? bodies[0]?.id ?? ''
      const sels: Selection[] = []
      if (r.profile?.kind === 'sketch')
        sels.push({ kind: 'sketch', sketchId: r.profile.id } as Selection)
      if (r.profile?.kind === 'face')
        sels.push({
          kind: 'face',
          bodyId: r.profile.bodyId,
          sub: r.profile.sub,
          point: [0, 0, 0]
        } as Selection)
      // sweep: the path, either another sketch or one or more connected
      // body edges (ctrl/shift-clicked around a bend)
      if (r.path?.kind === 'sketch') sels.push({ kind: 'sketch', sketchId: r.path.id } as Selection)
      else if (r.path?.kind === 'edge')
        for (const sub of r.path.sub ?? [])
          sels.push({ kind: 'edge', bodyId: r.path.bodyId, sub, point: [0, 0, 0] } as Selection)
      for (const e of r.edges ?? [])
        sels.push({
          // fillet / chamfer let a Face* sub ride in the edge list ("round all
          // its edges") - re-seed it as a face pick so highlighting stays right
          kind: /^Face/i.test(e) ? 'face' : 'edge',
          bodyId: bid,
          sub: e,
          point: [0, 0, 0]
        } as Selection)
      for (const f of r.faces ?? [])
        sels.push({ kind: 'face', bodyId: bid, sub: f, point: [0, 0, 0] } as Selection)
      if (r.axis?.kind === 'edge')
        sels.push({
          kind: 'edge',
          bodyId: r.axis.bodyId,
          sub: r.axis.sub,
          point: [0, 0, 0]
        } as Selection)
      if (r.axis?.kind === 'origin')
        sels.push({ kind: 'plane', planeId: '', role: r.axis.role } as Selection)
      // mirror / pattern: the plane / axis / direction reference
      const pa = r.planeOrAxis
      if (pa?.kind === 'origin') sels.push({ kind: 'plane', planeId: '', role: pa.role } as Selection)
      else if (pa?.kind === 'plane') sels.push({ kind: 'plane', planeId: pa.id } as Selection)
      else if (pa?.kind === 'edge')
        sels.push({ kind: 'edge', bodyId: pa.bodyId, sub: pa.sub, point: [0, 0, 0] } as Selection)
      else if (pa?.kind === 'face')
        sels.push({ kind: 'face', bodyId: pa.bodyId, sub: pa.sub, point: [0, 0, 0] } as Selection)
      // seed the timeline chip selection so a Type=Features edit keeps its set
      if (r.features?.length) setTimelineSel(r.features)

      editingFeatureRef.current = {
        id,
        label: info.label,
        values: info.values ?? {},
        refs: r
      }
      livePreviewRef.current.editing = id
      livePreviewRef.current.seq++
      setEditInit(info.values ?? {})
      setEditLabel(info.label)
      setSelection(sels)
      // show the model as of this feature while editing (downstream hidden)
      try {
        if (bid) await apiQuiet.rollTo(bid, id)
        await refreshScene()
      } catch {
        /* the dialog still opens; preview will surface any issue */
      }
      openOp(kind)
      // dress-up edit: seed the ghost overlay of its referenced base edges now
      // (they've been consumed from the visible solid), so you can Ctrl-click to
      // deselect before touching anything
      if (kind === 'fillet' || kind === 'chamfer' || kind === 'shell' || kind === 'draft') {
        try {
          const res = await apiQuiet.editPreview(id, info.values ?? {}, r)
          if (res.baseRefs) setDressUpGhost(res.baseRefs)
        } catch {
          /* the first real preview will populate it */
        }
      }
    },
    [bodyId, bodies, editFeatureDim, refreshScene, openOp]
  )

  // double-click / "Edit…" on any timeline or browser row: sketches open the
  // sketcher, everything else opens its operation dialog for a full edit.
  const onEditRow = useCallback(
    (id: string) => {
      const f = bodies.flatMap((b) => b.features).find((x) => x.id === id)
      if (f?.kind === 'sketch' || sketches.some((s) => s.id === id)) return void editSketch(id)
      void editFeature(id)
    },
    [bodies, sketches, editSketch, editFeature]
  )

  const toggleVisibility = useCallback((id: string, visible: boolean) => {
    // pure view state: instant, no engine round-trip, no spinner. scene.get
    // already ships every body / sketch / datum so there is always something
    // to toggle back on.
    setVisOverride((m) => ({ ...m, [id]: visible }))
  }, [])

  // ---- appearances (view layer; also queued to the engine for persistence) ----
  // apply instantly to the local mesh, then fire the RPC quietly so it lands in
  // the .gwtcad companion + on the FreeCAD object. merge=true means the change
  // touches only the keys given.
  const setObjectAppearance = useCallback(
    (targetId: string, patch: ObjectAppearance, merge = true) => {
      setMeshes((ms) =>
        ms.map((m) =>
          m.id === targetId
            ? { ...m, appearance: merge ? { ...(m.appearance ?? {}), ...patch } : patch }
            : m
        )
      )
      markDirty(true)
      void apiQuiet
        .appearanceSet(targetId, patch, merge)
        .catch((e) => flashSketchNotice(`appearance: ${(e as Error).message}`))
    },
    [markDirty, flashSketchNotice]
  )

  const clearObjectAppearance = useCallback(
    (targetId: string) => {
      setMeshes((ms) =>
        ms.map((m) => (m.id === targetId ? { ...m, appearance: undefined } : m))
      )
      markDirty(true)
      void apiQuiet.appearanceClear(targetId).catch(() => undefined)
    },
    [markDirty]
  )

  // per-face colour: `color` null clears that face's override
  const setFaceColor = useCallback(
    (targetId: string, subs: string[], color: [number, number, number] | null) => {
      const facesPatch: Record<string, [number, number, number] | null> = {}
      for (const s of subs) facesPatch[s] = color
      setMeshes((ms) =>
        ms.map((m) => {
          if (m.id !== targetId) return m
          const faces = { ...(m.appearance?.faces ?? {}) }
          for (const s of subs) {
            if (color) faces[s] = color
            else delete faces[s]
          }
          return { ...m, appearance: { ...(m.appearance ?? {}), faces } }
        })
      )
      markDirty(true)
      void apiQuiet
        .appearanceSet(targetId, { faces: facesPatch } as ObjectAppearance, true)
        .catch((e) => flashSketchNotice(`face colour: ${(e as Error).message}`))
    },
    [markDirty, flashSketchNotice]
  )

  const applyRenderSettings = useCallback(
    (patch: RenderSettings, merge = true) => {
      setRenderSettings((cur) => {
        const next = merge ? { ...cur, ...patch } : patch
        vpApi.current?.setRenderSettings(next)
        return next
      })
      markDirty(true)
      void apiQuiet.appearanceRenderSet(patch, merge).catch(() => undefined)
    },
    [markDirty]
  )

  // ---- file ops ----
  const saveAs = useCallback(async () => {
    const p = await window.cad.saveDialog(docPath ?? undefined)
    if (!p) return
    if (!currentPn) {
      const dir = p.slice(0, p.length - basename(p).length - 1)
      const owner = await api.pnRepoForPath(dir).catch(() => ({ project: null }))
      if (owner.project) {
        setNewPartProject(owner.project)
        setNewPartOpen(true)
        return
      }
    }
    await api.saveAs(p)
    setDocPath(p)
    setTabs((t) =>
      t.map((x) => (x.id === activeTab ? { ...x, name: basename(p), dirty: false, path: p } : x))
    )
    void window.cad.captureThumb(p).catch(() => undefined)
  }, [docPath, activeTab, currentPn])

  const save = useCallback(async () => {
    if (!docPath) return saveAs()
    await api.save()
    markDirty(false)
    void window.cad.captureThumb(docPath).catch(() => undefined)
  }, [docPath, saveAs, markDirty])

  const openDesign = useCallback(
    async (path?: string) => {
      const p = path ?? (await window.cad.openDialog())
      if (!p) return
      // the sidecar holds one document: opening replaces it. Reflect that as a
      // fresh tab rather than mutating whatever tab is in front.
      const opened = await api.open(p)
      // if this file is already a tab (e.g. re-activating it, see onActivate
      // below), reuse that tab instead of piling up a duplicate
      const existing = tabs.find((x) => x.path === p)
      const id = existing?.id ?? `d${Date.now()}`
      setTabs((t) =>
        existing
          ? t
          : [...t.filter((x) => x.name !== 'Untitled' || x.dirty), { id, name: basename(p), dirty: false, path: p }]
      )
      setActiveTab(id)
      setDocPath(p)
      setDrawingPageId(null)
      setCurrentPn(opened.partNumber?.pn ?? null)
      setCurrentLifecycle(null)
      if (opened.partNumber?.pn) {
        const pnSeq = opened.partNumber.pn.slice(0, -1)
        void api
          .pnResolve(pnSeq)
          .then((r) => setCurrentLifecycle(r.row.lifecycle ?? null))
          .catch(() => setCurrentLifecycle(null))
        void api
          .pnCheckLocation(pnSeq, p)
          .then((check) => {
            if (check.matches) return
            if (
              window.confirm(
                `${opened.partNumber?.pn} was opened from a different location than the registry ` +
                  `expects (expected ${check.expectedPath}). Update the registry to point here instead?`
              )
            ) {
              void api.pnRelocate(pnSeq, p).catch((e) => window.alert((e as Error).message))
            }
          })
          .catch(() => undefined)
      }
      await refreshScene()
    },
    [refreshScene, tabs]
  )

  const exportModel = useCallback(async () => {
    const p = await window.cad.exportDialog(
      docPath ? docPath.replace(/\.FCStd$/i, '.step') : undefined
    )
    if (!p) return
    try {
      // engine dispatches by extension: STEP/STP/IGES/IGS/BREP or STL/OBJ/3MF/PLY/OFF
      await api.exportModel2(p)
    } catch (e) {
      window.alert((e as Error).message)
    }
  }, [docPath])

  const saveDebugLog = useCallback(async () => {
    const dump =
      (window as unknown as { __trace?: { dump: () => string } }).__trace?.dump() ?? ''
    if (!dump) {
      window.alert('No trace recorded yet - tracing is on by default; try reproducing the issue first.')
      return
    }
    const stem = docPath
      ? docPath
          .replace(/\\/g, '/')
          .split('/')
          .pop()
          ?.replace(/\.FCStd$/i, '') ?? 'gwtcad'
      : 'gwtcad'
    await window.cad.saveDebugLog(dump, `${stem}-trace-${Date.now()}.log`)
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
      const prefs = loadMeshPrefs()
      const r = await api.importModel(p, prefs.importFacetCap, prefs.autoSimplifyOnImport)
      await afterEdit()
      if (r.simplified.length) {
        const s = r.simplified[0]
        window.alert(
          `Imported mesh was ${s.trisBefore.toLocaleString()} triangles - ` +
            `auto-simplified to ${s.tris.toLocaleString()} (see Mesh Import settings to change the limit).`
        )
      }
    } catch (e) {
      window.alert((e as Error).message)
    }
  }, [afterEdit])

  const importKicad = useCallback(async () => {
    const p = await window.cad.openDialog([{ name: 'KiCad PCB', extensions: ['kicad_pcb'] }])
    if (!p) return
    try {
      const r = await api.kicadImport(p)
      await afterEdit()
      vpApi.current?.fit()
      window.alert(
        `PCB imported: ${r.kicad.components} components, ` +
          `${r.kicad.size[0]} x ${r.kicad.size[1]} x ${r.kicad.size[2]} mm`
      )
    } catch (e) {
      window.alert((e as Error).message)
    }
  }, [afterEdit])

  const reimportKicad = useCallback(async () => {
    try {
      await api.kicadReimport()
      await afterEdit()
    } catch (e) {
      window.alert((e as Error).message)
    }
  }, [afterEdit])

  const selRefs = useCallback(
    () => selection.map(selectionToRef).filter(Boolean) as import('./rpc').GeomRef[],
    [selection]
  )
  const surfaceRuled = useCallback(async () => {
    try {
      await api.surfaceRuled(selRefs())
      await afterEdit()
    } catch (e) {
      window.alert((e as Error).message)
    }
  }, [selRefs, afterEdit])
  const surfaceFill = useCallback(async () => {
    try {
      await api.surfaceFill(selRefs())
      await afterEdit()
    } catch (e) {
      window.alert((e as Error).message)
    }
  }, [selRefs, afterEdit])
  const surfaceStitch = useCallback(async () => {
    try {
      await api.surfaceStitch(selRefs())
      await afterEdit()
    } catch (e) {
      window.alert((e as Error).message)
    }
  }, [selRefs, afterEdit])
  const surfaceOffset = useCallback(async () => {
    const txt = await promptText('Offset distance (mm)', '1')
    if (txt == null) return
    const n = Number(txt)
    if (!n) return
    try {
      await api.surfaceOffset(selRefs(), n)
      await afterEdit()
    } catch (e) {
      window.alert((e as Error).message)
    }
  }, [selRefs, afterEdit])

  const scaleBody = useCallback(async () => {
    const target = selection.find((s) => s.kind === 'face' || s.kind === 'body') as
      | { bodyId: string }
      | undefined
    const id = target?.bodyId ?? bodies[0]?.id ?? meshes[0]?.id
    if (!id) {
      window.alert('Select a body first.')
      return
    }
    const UNITS = ['mm', 'cm', 'm', 'in', 'ft', 'thou']
    const r = await promptForm(
      'Scale',
      [
        { key: 'mode', label: 'Mode', options: ['Uniform factor', 'Convert units'] },
        { key: 'factor', label: 'Factor', value: '2' },
        { key: 'from', label: 'From units', options: UNITS },
        { key: 'to', label: 'To units', options: [...UNITS.slice(1), 'mm'] }
      ],
      'Apply'
    )
    if (!r) return
    try {
      if (r.mode === 'Convert units') {
        await api.bodyConvertUnits(id, r.from, r.to)
      } else {
        const f = Number(r.factor)
        if (f && f > 0) await api.bodyScale(id, f)
      }
      await afterEdit()
    } catch (e) {
      window.alert((e as Error).message)
    }
  }, [selection, bodies, meshes, afterEdit])

  const runInterference = useCallback(() => {
    void (async () => {
      try {
        const sel = selection
          .filter((s) => s.kind === 'body')
          .map((s) => (s as { bodyId: string }).bodyId)
        const r = await api.interference(sel)
        const hits = r.pairs.filter((p) => p.hasInterference)
        if (!hits.length) {
          flashSketchNotice('No interference between the bodies.')
          return
        }
        window.alert(
          'Interference:\n' +
            hits
              .map((p) => `  ${p.a} <-> ${p.b}: ${p.volume.toFixed(3)} mm3`)
              .join('\n') +
            `\n\nTotal overlap volume: ${r.totalVolume.toFixed(3)} mm3`
        )
      } catch (e) {
        window.alert((e as Error).message)
      }
    })()
  }, [selection, flashSketchNotice])

  const runCenterOfMass = useCallback(() => {
    void (async () => {
      try {
        const sel = selection
          .filter((s) => s.kind === 'body' || s.kind === 'face')
          .map((s) => (s as { bodyId: string }).bodyId)
        const r = await api.centerOfMass([...new Set(sel)])
        setMassProps(r)
      } catch (e) {
        window.alert((e as Error).message)
      }
    })()
  }, [selection])

  const newDesign = useCallback(() => {
    const id = `d${Date.now()}`
    setTabs((t) => [...t, { id, name: 'Untitled', dirty: false, path: null }])
    setActiveTab(id)
    setDocPath(null)
    setDrawingPageId(null)
    void (async () => {
      await api.resetDocument()
      await refreshScene()
    })()
  }, [refreshScene])

  // A PN was just reserved (registry row committed) - reset to a clean
  // document, save it at the reserved path, tag the session with the PN so
  // it gets mirrored onto real FreeCAD document properties on every save,
  // then open the New Part dialog's result as the active tab. If a McMaster
  // download is pending (the dialog was opened from the MMC panel rather
  // than File > New), import that STEP file into this newly-tagged document
  // and re-save so the saved file carries both the PN and the actual CAD
  // geometry, not just an empty PN-tagged shell.
  const createPart = useCallback(
    async (info: { pn: string; path: string; name: string; description: string }) => {
      setNewPartOpen(false)
      const mcmaster = pendingMcMaster
      setPendingMcMaster(undefined)
      setNewPartPrefill(undefined)
      try {
        await api.resetDocument()
        await api.pnTagDocument(info.pn, info.name, info.description)
        await api.saveAs(info.path)
        if (mcmaster) {
          const r = await api.importModel(mcmaster.stepPath)
          const partNumber = (mcmaster.meta.partNumber as string) ?? 'unknown'
          for (const id of r.imported) {
            await api.tagMcMaster(id, partNumber, mcmaster.meta)
          }
          await api.save()
        }
        const id = `d${Date.now()}`
        setTabs((t) => [...t, { id, name: basename(info.path), dirty: false, path: info.path }])
        setActiveTab(id)
        setDocPath(info.path)
        setDrawingPageId(null)
        setCurrentPn(info.pn)
        setCurrentLifecycle('in_work') // pn.reserve always seeds new parts in_work
        await refreshScene()
      } catch (e) {
        window.alert(
          `${info.pn} was reserved in the registry but the file could not be saved: ` +
            `${(e as Error).message}. The PN is still reserved - use Save As to retry at the same path.`
        )
      }
    },
    [refreshScene, pendingMcMaster]
  )

  const newRevision = useCallback(async () => {
    if (!currentPn || !docPath) return
    const reason = await promptText('Reason for this revision (required)')
    if (!reason || !reason.trim()) return
    const pnSeq = currentPn.slice(0, -1)
    try {
      const res = await api.pnNewRevision(pnSeq, reason.trim())
      await api.pnTagDocument(res.pn, res.name, res.description)
      await api.saveAs(res.path ?? docPath)
      setTabs((t) =>
        t.map((x) =>
          x.id === activeTab
            ? { ...x, name: basename(res.path ?? docPath), dirty: false, path: res.path ?? docPath }
            : x
        )
      )
      setDocPath(res.path ?? docPath)
      setCurrentPn(res.pn)
      setCurrentLifecycle('in_work') // pn.newRevision always resets to in_work
      // Re-derive the kit BOM from the assembly at its new revision and
      // persist it - keeps bom.csv from ever drifting behind what's
      // actually in the CAD document. A part with no App::Link children
      // just saves an empty BOM, which reads back as "no BOM defined."
      try {
        const bom = await api.assemblyBomPns()
        await api.pnSaveBom(res.pn, bom.items)
      } catch (bomErr) {
        console.error('Failed to save BOM for new revision:', bomErr)
      }
    } catch (e) {
      window.alert((e as Error).message)
    }
  }, [currentPn, docPath, activeTab])

  // Lifecycle can only be changed on the currently open document (see
  // pn.setLifecycle) - this guarantees the BOM re-capture below always
  // reflects the actual live assembly, with no separate "open this other
  // file in the background" resolution needed.
  const setLifecycle = useCallback(
    async (lifecycle: 'in_work' | 'active' | 'discontinued') => {
      if (!currentPn) return
      const pnSeq = currentPn.slice(0, -1)
      try {
        await api.pnSetLifecycle(pnSeq, lifecycle)
        setCurrentLifecycle(lifecycle)
        // Re-derive and persist the BOM on every lifecycle change, not just
        // revision bumps - marking a part active is exactly the moment its
        // assembly should be considered validated/trustworthy, so this is
        // when a stale bom.csv snapshot most needs correcting.
        try {
          const bom = await api.assemblyBomPns()
          await api.pnSaveBom(currentPn, bom.items)
        } catch (bomErr) {
          console.error('Failed to save BOM for lifecycle change:', bomErr)
        }
      } catch (e) {
        window.alert((e as Error).message)
      }
    },
    [currentPn]
  )

  const openPnFile = useCallback(
    async (path: string) => {
      setPnBrowserOpen(false)
      await openDesign(path)
    },
    [openDesign]
  )

  const fitView = useCallback(() => vpApi.current?.fit(), [])

  const [calibrateId, setCalibrateId] = useState<string | null>(null)
  const startCalibrate = useCallback(
    (id?: string) => {
      const cid = id ?? canvases[canvases.length - 1]?.id
      if (!cid) {
        window.alert('Insert a canvas first.')
        return
      }
      setCalibrateId(cid)
    },
    [canvases]
  )

  const onCalibrateLine = useCallback(
    async (measuredMm: number) => {
      const id = calibrateId
      setCalibrateId(null)
      if (!id || measuredMm <= 0) return
      const real = await promptText(
        `That line is ${measuredMm.toFixed(2)} mm on the canvas now. Real length?`,
        measuredMm.toFixed(2)
      )
      if (!real) return
      const n = Number(real)
      if (!n || n <= 0) return
      await api.canvasCalibrate(id, n, measuredMm)
      await refreshMeshesOnly(true)
    },
    [calibrateId, refreshMeshesOnly]
  )

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
    const r = await api.canvasInsert('XY', w, h, dataUrl)
    await refreshMeshesOnly(true)
    // calibration is part of placing a canvas, not a separate tool
    if (r?.id) setCalibrateId(r.id)
  }, [refreshMeshesOnly])

  // ---- inspect ----
  const startMeasure = useCallback(() => {
    setMeasureMode((v) => !v)
    setMeasureResult(null)
    setSelection([])
  }, [])

  // Section views are saved objects (model tree, .gwtcad companion). `sections`
  // mirrors what the engine has; `section` is the panel's live working copy for
  // a NEW cut or one being edited (its `id` says which).
  const toggleSection = useCallback(() => {
    setSection((s) => (s ? null : { plane: 'XY', offset: 0, flip: false }))
  }, [])

  const commitSection = useCallback(async () => {
    const draft = sectionRef.current
    if (!draft) return
    try {
      if (draft.id) {
        await apiQuiet.sectionSet(draft.id, {
          plane: draft.plane,
          offset: draft.offset,
          flip: draft.flip,
          visible: true
        })
      } else {
        await apiQuiet.sectionCreate(draft.plane, draft.offset, draft.flip)
      }
      markDirty()
      const scene = await api.sceneGet()
      setSections((scene.sections ?? []) as SectionState[])
    } catch (e) {
      flashSketchNotice(`Section: ${(e as Error).message}`)
    }
    setSection(null)
  }, [])

  const editSection = useCallback(
    (id: string) => {
      const s = sectionsRef.current.find((x) => x.id === id)
      if (s) setSection({ ...s })
    },
    []
  )

  const toggleSectionVisible = useCallback(async (id: string, visible: boolean) => {
    setSections((cur) => cur.map((s) => (s.id === id ? { ...s, visible } : s)))
    try {
      await apiQuiet.sectionSet(id, { visible })
      markDirty()
    } catch {
      /* keep the optimistic state; a refresh will reconcile */
    }
  }, [])

  const deleteSection = useCallback(async (id: string) => {
    setSections((cur) => cur.filter((s) => s.id !== id))
    setSection((d) => (d && d.id === id ? null : d))
    try {
      await apiQuiet.sectionDelete(id)
      markDirty()
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    if (!measureMode) return
    const picks = selection.filter(
      (s) => s.kind === 'face' || s.kind === 'edge' || s.kind === 'vertex'
    ) as Array<{ bodyId: string; sub: string }>
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
  const refreshDrawingPages = useCallback(async () => {
    try {
      const { pages } = await apiQuiet.drawingPageList()
      setDrawingPages(pages)
    } catch {
      /* ignore */
    }
  }, [])

  const makeView = useCallback(
    async (dir: string): Promise<DrawingView | null> => {
      if (!drawingPageId) return null
      try {
        return await api.drawingAddView(drawingPageId, null, dir, 1)
      } catch (e) {
        window.alert((e as Error).message)
        return null
      }
    },
    [drawingPageId]
  )

  // creates a fresh drawing page and enters it - the "Drawing from Design"
  // ribbon entry point. Reopening an existing one goes through openDrawing
  // (Browser "Drawings" section double-click), not this.
  const startDrawing = useCallback(async () => {
    try {
      const page = await api.drawingPageCreate()
      setDrawingPageId(page.id)
      void refreshDrawingPages()
    } catch (e) {
      window.alert((e as Error).message)
    }
  }, [refreshDrawingPages])

  const openDrawing = useCallback((pageId: string) => {
    setDrawingPageId(pageId)
  }, [])

  const renameDrawing = useCallback(
    async (pageId: string, label: string) => {
      try {
        await api.drawingPageRename(pageId, label)
        void refreshDrawingPages()
      } catch (e) {
        window.alert((e as Error).message)
      }
    },
    [refreshDrawingPages]
  )

  const deleteDrawing = useCallback(
    async (pageId: string) => {
      if (!window.confirm('Delete this drawing? This cannot be undone.')) return
      try {
        await api.drawingPageDelete(pageId)
        if (drawingPageId === pageId) setDrawingPageId(null)
        void refreshDrawingPages()
        markDirty()
      } catch (e) {
        window.alert((e as Error).message)
      }
    },
    [drawingPageId, refreshDrawingPages]
  )

  // ---- assemblies ----
  // insert a component by path (no file dialog) - shared by the ribbon action
  // and the E2E harness. `pin` is optional: a git-based version lock/track
  // (commit or branch) resolved to a real file BEFORE linking, so the
  // sidecar's App::Link always points at a concrete path on disk exactly
  // like the unpinned case - git resolution happens entirely up here in
  // the main process, the sidecar needs no awareness of it at all.
  const addComponentFile = useCallback(
    async (p: string, pin?: { mode: PinMode; ref: string }) => {
      await api.assemblyCreate()
      let linkPath = p
      let resolvedCommit: string | undefined
      let drift: boolean | undefined
      if (pin) {
        const resolved = await window.cad.asmPinResolve({ sourcePath: p, mode: pin.mode, ref: pin.ref })
        linkPath = resolved.linkPath
        resolvedCommit = resolved.commit
        drift = resolved.drift
      }
      const name = basename(p).replace(/\.FCStd$/i, '')
      const tree = await api.assemblyAddComponent(linkPath, name)
      if (pin && docPath) {
        const added = tree.components[tree.components.length - 1]
        if (added) {
          await window.cad.asmPinSet(docPath, added.id, {
            sourcePath: p,
            mode: pin.mode,
            ref: pin.ref,
            resolvedCommit,
            drift
          })
        }
      }
      await refreshScene()
    },
    [refreshScene, docPath]
  )

  const addComponent = useCallback(async () => {
    const p = await window.cad.openDialog()
    if (!p) return
    await addComponentFile(p)
  }, [addComponentFile])

  // set/clear/refresh a component's pin. Re-linking is done by removing and
  // re-adding the App::Link at the resolved path - simplest correct way to
  // change what an existing link points at without new sidecar surface.
  const setComponentPin = useCallback(
    async (componentId: string, sourcePath: string, pin: { mode: PinMode; ref: string } | null) => {
      if (!docPath) return
      if (pin === null) {
        await window.cad.asmPinSet(docPath, componentId, null)
        // relink live (unpinned) at the real source path
        await api.assemblyRemoveComponent(componentId).catch(() => undefined)
        await addComponentFile(sourcePath)
        return
      }
      // validate the ref resolves before tearing down the existing link, so a
      // typo'd branch/commit name fails loudly without losing the component
      await window.cad.asmPinResolve({ sourcePath, mode: pin.mode, ref: pin.ref })
      await api.assemblyRemoveComponent(componentId).catch(() => undefined)
      await addComponentFile(sourcePath, pin)
    },
    [docPath, addComponentFile]
  )

  // re-resolve every pinned component against its ref right now - moves a
  // branch-tracked pin to the branch's current tip, and refreshes drift
  // status for commit-pinned ones. Called after opening/reopening an
  // assembly so pins reflect current reality, not stale cached state.
  const refreshAssemblyPins = useCallback(async () => {
    if (!docPath || !asmTree) return
    const pins = await window.cad.asmPinRead(docPath)
    for (const [componentId, pin] of Object.entries(pins)) {
      if (!pin.ref) continue
      const resolved = await window.cad.asmPinResolve(pin)
      if (pin.mode === 'branch' && resolved.commit && resolved.commit !== pin.resolvedCommit) {
        // branch tip moved - re-link at the new resolved commit, which also
        // persists the updated pin (resolvedCommit + drift) via addComponentFile
        await api.assemblyRemoveComponent(componentId).catch(() => undefined)
        await addComponentFile(pin.sourcePath, { mode: pin.mode, ref: pin.ref })
      } else {
        // commit-mode pin, or a branch pin whose tip hasn't moved - just
        // refresh the drift flag against the source repo's current state
        await window.cad.asmPinSet(docPath, componentId, { ...pin, drift: resolved.drift })
      }
    }
    setAsmPins(await window.cad.asmPinRead(docPath))
  }, [docPath, asmTree, addComponentFile])

  // re-resolve pins once per opened-assembly (not on every refreshScene -
  // that would re-run for every unrelated edit). Fires when a document that
  // has an assembly finishes its first load.
  const pinRefreshedForRef = useRef<string | null>(null)
  useEffect(() => {
    if (!docPath || !asmTree?.assembly) return
    const key = `${docPath}:${asmTree.assembly}`
    if (pinRefreshedForRef.current === key) return
    pinRefreshedForRef.current = key
    void refreshAssemblyPins()
  }, [docPath, asmTree?.assembly, refreshAssemblyPins])

  const groundComponent = useCallback(
    async (id: string) => {
      await api.assemblyGround(id)
      await refreshScene()
    },
    [refreshScene]
  )

  const addJoint = useCallback(async () => {
    const fs = selection.filter((s) => s.kind === 'face') as Array<{ bodyId: string; sub: string }>
    if (fs.length !== 2) {
      window.alert(
        'Select two faces (one on each component) to mate, then run Joint. Joint type is set in the Assembly panel.'
      )
      return
    }
    const r = await api.assemblyAddJoint(jointType, fs[0].bodyId, fs[0].sub, fs[1].bodyId, fs[1].sub)
    await refreshScene()
    setSelection([])
    if (!r.solved)
      window.alert(
        `Joint "${jointType}" added (${r.engine}) but did not solve (rc ${r.solveRc ?? '?'}). ` +
          `Check the two faces actually make sense for a ${jointType} joint (e.g. two roughly-facing planar faces for Revolute) - a bad reference pair can leave the joint recorded but unconstrained.`
      )
  }, [selection, jointType, refreshScene])

  // --- assembly component drag (real solver-backed, per-frame RPC - see
  // assembly.dragStart/Move/End's docstrings in sidecar/gwtcad/assembly.py).
  // Only armed while asmTool === 'move' (Viewport gates onDown on this), so
  // dragging never fights the Assembly panel's normal click-to-pick-a-face
  // flow for building joint references.
  const asmDragRef = useRef<{ dragId: string; base: [number, number, number] } | null>(null)
  const asmDragStart = useCallback(async (componentId: string) => {
    const comp = asmTree?.components.find((c) => c.id === componentId)
    if (!comp) return
    const r = await api.assemblyDragStart(componentId)
    asmDragRef.current = { dragId: r.dragId, base: comp.placement.base as [number, number, number] }
  }, [asmTree])
  const asmDragMove = useCallback(async (deltaWorld: [number, number, number]) => {
    const d = asmDragRef.current
    if (!d) return
    const base: [number, number, number] = [
      d.base[0] + deltaWorld[0],
      d.base[1] + deltaWorld[1],
      d.base[2] + deltaWorld[2]
    ]
    const r = await api.assemblyDragMove(d.dragId, base, [0, 0, 1], 0)
    setAsmTree(r)
  }, [])
  const asmDragEnd = useCallback(async () => {
    const d = asmDragRef.current
    if (!d) return
    asmDragRef.current = null
    await api.assemblyDragEnd(d.dragId)
    await refreshScene()
  }, [refreshScene])

  // test / automation bridge - drives the same handlers the buttons call, so an
  // out-of-band script can exercise the app end to end (see test/e2e).
  useEffect(() => {
    const bridge = {
      perf: PERF,
      refresh: () => refreshScene(),
      fit: () => vpApi.current?.fit(),
      getProjection: () => vpApi.current?.getProjection() ?? projection,
      // real camera projection for synthetic pointer events, so an E2E can
      // dispatch an ACTUAL PointerEvent/KeyboardEvent at the viewport canvas
      // and exercise the real Picker raycast / hover / keydown handlers,
      // instead of only the semantic pick()/select() shortcuts below
      projectToScreen: (world: [number, number, number]) =>
        vpApi.current?.testProjectToScreen(world) ?? null,
      sketchUVToScreen: (u: number, v: number) => {
        const w = vpApi.current?.testSketchUVToWorld(u, v)
        return w ? vpApi.current?.testProjectToScreen(w) ?? null : null
      },
      cameraDebug: () => vpApi.current?.testCameraDebug() ?? null,
      symbolWorldScale: () => vpApi.current?.testSymbolWorldScale() ?? null,
      pendingConState: () => vpApi.current?.testPendingConState() ?? null,
      constrainedIndices: () => vpApi.current?.testConstrainedIndices() ?? [],
      entityColorHex: (idx: number) => vpApi.current?.testEntityColorHex(idx) ?? null,
      entitySnapshot: (idx: number) => vpApi.current?.testEntitySnapshot(idx) ?? null,
      setView: (dir: [number, number, number]) => vpApi.current?.setView(dir),
      nudgeCamera: (delta: [number, number, number]) => vpApi.current?.testNudgeCamera(delta),
      setProjection: (p: 'orthographic' | 'perspective') => {
        vpApi.current?.setProjection(p)
        setProjection(p)
      },

      // --- ops (ribbon -> dialog -> apply) ---
      openOp: (k: OpKind) => openOp(k),
      closeOp: () => openOp(null),
      applyOp: (k: OpKind, v: OpValues, exprs?: Record<string, string>) => applyOp(k, v, exprs),
      // drive the SAME live-preview path the OperationDialog fires on a value
      // change - so an E2E can exercise "preview feature on the body, then add
      // another edge" exactly like the real dialog does
      livePreview: (k: OpKind, v: OpValues) => runLivePreview(k, v),
      livePreviewState: () => {
        const lp = livePreviewRef.current
        return { featureId: lp.featureId, kind: lp.kind, running: lp.running, baseSig: lp.baseSig }
      },
      // dress-up ghost overlay (fillet/chamfer/shell/draft dialogs): the base
      // edges/faces you can Ctrl-click to deselect
      dressUpGhost: () => dressUpGhost.map((r) => r.sub),
      dressUpGhostToggle: (sub: string) => {
        const ref = dressUpGhost.find((r) => r.sub === sub) ?? dressUpGhost[0]
        if (!ref) return false
        const p = ref.polys[0] ?? []
        const n = p.length / 3
        const mid = n >= 2 ? [p[Math.floor(n / 2) * 3], p[Math.floor(n / 2) * 3 + 1], p[Math.floor(n / 2) * 3 + 2]] : null
        setSelection((cur) => {
          const cand = cur.filter((s) => s.kind === 'edge' || s.kind === 'face')
          let drop = cand.find((s) => (s as { sub: string }).sub === ref.sub)
          if (!drop && mid) {
            let bd = Infinity
            for (const s of cand) {
              const q = (s as { point?: number[] }).point
              if (!q) continue
              const d = Math.hypot(q[0] - mid[0], q[1] - mid[1], q[2] - mid[2])
              if (d < bd) {
                bd = d
                drop = s
              }
            }
          }
          return drop ? cur.filter((s) => s !== drop) : cur
        })
        return true
      },

      // --- selection ---
      select: (sels: Selection[]) => setSelection(sels ?? []),
      // routes through the real onSelect handler (filters, op-scoped kinds,
      // coplanar lock, additive-while-dialog) - use this to test click behaviour
      pick: (sel: Selection | null, additive: boolean | 'loop' = false) =>
        onSelect(sel, additive === 'loop' ? 'loop' : additive ? 'additive' : 'replace'),
      selectFace: (bodyId: string, sub: string) =>
        setSelection([{ kind: 'face', bodyId, sub, point: [0, 0, 0] } as Selection]),
      selectSketch: (sketchId: string) => setSelection([{ kind: 'sketch', sketchId } as Selection]),
      clearSelection: () => setSelection([]),
      // the timeline's feature-chip selection (Mirror / Pattern Type=Features)
      selectFeatures: (ids: string[]) => setTimelineSel(ids ?? []),
      addComponentFile: (p: string) => addComponentFile(p),
      addComponentFilePinned: (p: string, mode: PinMode, ref: string) =>
        addComponentFile(p, { mode, ref }),
      setComponentPin: (
        componentId: string,
        sourcePath: string,
        pin: { mode: PinMode; ref: string } | null
      ) => setComponentPin(componentId, sourcePath, pin),
      refreshAssemblyPins: () => refreshAssemblyPins(),
      getAsmPins: () => asmPins,

      // --- sketch ---
      beginSketch,
      createSketch,
      finishSketch: () => finishSketch(),
      cancelSketch: () => cancelSketch(),
      editSketch,

      // --- history / features ---
      undo: () => doUndo(),
      redo: () => doRedo(),
      deleteFeature: (id: string) => deleteFeature(id),
      editFeature: (id: string) => editFeature(id),
      suppressFeature: (id: string, s: boolean) => suppressFeature(id, s),
      rollTo: (fid: string | null) => rollTo(fid),

      // --- ribbon commands (every wired button) ---
      commandIds: () => commandsRef.current.filter((c) => c.run).map((c) => c.id),
      runCommand: (id: string) => {
        const c = commandsRef.current.find((x) => x.id === id)
        trace('ACTION runCommand', { id, found: !!c })
        c?.run?.()
      },

      // --- sketch controller (test-drives the real 2D editor) ---
      sketch: {
        addEntity: (
          ent: import('./viewport/SketchController').SketchEntity,
          snapTo?: Array<{ idx: number; pt: 1 | 2 | 3 } | null>
        ) => vpApi.current?.testAddSketchEntity(ent, snapTo) ?? -1,
        commitTool: (
          tool: import('./viewport/SketchController').SketchTool,
          points: [number, number][],
          snapTo?: Array<{ idx: number; pt: 1 | 2 | 3 } | null>
        ) => vpApi.current?.testCommitSketchTool(tool, points, snapTo) ?? -1,
        select: (indices: number[]) => vpApi.current?.testSelectSketch(indices),
        selectPoints: (pts: Array<{ e: number; pt: 1 | 2 | 3 }>) =>
          vpApi.current?.testSelectSketchPoints(pts),
        selectDim: (owner: number) => vpApi.current?.testSelectSketchDim(owner) ?? false,
        selectedCount: () => vpApi.current?.sketchSelectedCount() ?? 0,
        available: () => vpApi.current?.availableSketchConstraints() ?? [],
        applyConstraint: (t: import('./viewport/SketchController').SketchConstraintType) =>
          vpApi.current?.applySketchConstraint(t) ?? false,
        setDimension: (i: number, v: number, as?: 'radius' | 'diameter') =>
          vpApi.current?.setSketchDimension(i, v, as) ?? false,
        toggleDimKind: () => vpApi.current?.toggleSketchDimKind() ?? null,
        deleteSelection: () => vpApi.current?.testDeleteSketchSelection(),
        toggleConstruction: () => vpApi.current?.testToggleSketchConstruction() ?? false,
        convertedEntities: () => vpApi.current?.getConvertedSketchEntities() ?? [],
        project: async (bodyId: string, sub: string) => {
          const sid = sketchSession?.sketchId
          if (!sid) return []
          const r = await apiQuiet.sketchProject(sid, [{ bodyId, sub }])
          vpApi.current?.setSketchProjected(r.projected)
          markDirty()
          return r.projected
        },
        unproject: async (geoIds?: number[]) => {
          const sid = sketchSession?.sketchId
          if (!sid) return []
          const r = await apiQuiet.sketchUnproject(sid, geoIds)
          vpApi.current?.setSketchProjected(r.projected)
          return r.projected
        },
        projected: () =>
          (vpApi.current?.getSketchProjected() ?? []).map((p) => ({ geoId: p.geoId, ...p.ent })),
        entities: () => vpApi.current?.getSketchEntities() ?? [],
        constraints: () => vpApi.current?.getSketchConstraints() ?? [],
        newConstraints: () => vpApi.current?.getNewSketchConstraints() ?? [],
        removedEntities: () => vpApi.current?.getRemovedSketchEntities() ?? [],
        setConstruction: (on: boolean) => vpApi.current?.setSketchConstruction(on),
        constrainedIndices: () => vpApi.current?.testConstrainedIndices() ?? [],
        entityColorHex: (idx: number) => vpApi.current?.testEntityColorHex(idx) ?? null,
        entitySnapshot: (idx: number) => vpApi.current?.testEntitySnapshot(idx) ?? null,
        handlePointCount: () => vpApi.current?.testHandlePointCount() ?? 0,
        fillCount: () => vpApi.current?.testFillCount() ?? 0,
        dimPicksState: () => vpApi.current?.testDimPicksState() ?? [],
        dimAxisKind: () => vpApi.current?.testDimAxisKind() ?? { kind: 'distance', forced: null }
      },

      // --- observe ---
      getState: () => ({
        status: status.phase,
        busy,
        notice: sketchNotice,
        docPath,
        op,
        opReady: opReadyRef.current,
        sketchMode: !!sketchSession,
        selection: selection.map(selKey),
        bodies: bodies.map((b) => ({
          id: b.id,
          marker: b.marker ?? null,
          features: b.features.map((f) => ({ id: f.id, kind: f.kind, error: !!f.error }))
        })),
        meshes: meshes.map((m) => ({ id: m.id, tris: Math.floor((m.positions?.length ?? 0) / 9) })),
        sketches: sketches.map((s) => s.id),
        timelineSel,
        assembly: asmTree?.assembly
          ? {
              components: (asmTree.components ?? []).map((c) => ({
                id: c.id,
                label: c.label,
                grounded: !!c.grounded
              })),
              joints: (asmTree.joints ?? []).length
            }
          : null,
        canUndo,
        canRedo
      })
    }
    ;(window as unknown as { __gwtcad?: unknown }).__gwtcad = bridge
  }, [
    refreshScene,
    applyOp,
    beginSketch,
    createSketch,
    finishSketch,
    cancelSketch,
    editSketch,
    doUndo,
    doRedo,
    deleteFeature,
    editFeature,
    suppressFeature,
    rollTo,
    onSelect,
    openOp,
    runLivePreview,
    dressUpGhost,
    addComponentFile,
    setComponentPin,
    refreshAssemblyPins,
    asmPins,
    sketchSession,
    status.phase,
    busy,
    sketchNotice,
    docPath,
    op,
    selection,
    bodies,
    meshes,
    sketches,
    timelineSel,
    asmTree,
    canUndo,
    canRedo
  ])

  // ---- boot ----
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      // the FreeCAD sidecar can take several seconds to import; keep pinging
      let lastErr: unknown = null
      for (let i = 0; i < 30 && !cancelled; i++) {
        try {
          const p = await api.ping()
          if (cancelled) return
          // finish the first scene / tree load BEFORE dropping the boot scrim,
          // so the app never appears "ready" while it is still populating
          await refreshScene()
          if (cancelled) return
          setStatus({ phase: 'ready', freecad: `${p.freecad} ${p.build}` })
          return
        } catch (e) {
          lastErr = e
          await new Promise((r) => setTimeout(r, 600))
        }
      }
      if (!cancelled) setStatus({ phase: 'error', message: (lastErr as Error)?.message ?? 'no engine' })
    })()
    return () => {
      cancelled = true
    }
  }, [refreshScene])

  // the geometry engine can hard-crash on bad OCCT input; the main process
  // respawns it, but the new doc is empty - refetch and tell the user
  useEffect(() => {
    const off = window.cad.onSidecarRespawned?.(() => {
      livePreviewRef.current.featureId = null
      livePreviewRef.current.kind = null
      livePreviewRef.current.opSig = ''
      rollCacheRef.current.clear()
      setSketchNotice('The geometry engine restarted after an error - unsaved model state was lost. Reopen the file to continue.')
      void refreshScene()
    })
    return () => off?.()
  }, [refreshScene])

  // ---- commands + hotkeys ----
  const commands = useMemo(
    () =>
      buildCommands({
        openOp: (k) => openOp(k),
        sweep,
        createSketch,
        newDesign,
        open: () => openDesign(),
        save,
        saveAs,
        exportModel,
        importStep,
        saveDebugLog,
        fitView,
        projection,
        toggleProjection: () => {
          const next =
            vpApi.current?.toggleProjection() ??
            (projection === 'orthographic' ? 'perspective' : 'orthographic')
          setProjection(next)
        },
        toggleData: () => setDataOpen((v) => !v),
        toggleGit: () => setGitOpen((v) => !v),
        toggleSettings: () => setSettingsOpen((v) => !v),
        startDrawing,
        drawingAddViewDir: (dir) => drawApi.current?.addView(dir) ?? Promise.resolve(),
        drawingAutoLayout: () => drawApi.current?.autoLayout() ?? Promise.resolve(),
        drawingSectionTool: () => drawApi.current?.sectionTool(),
        drawingDetailTool: () => drawApi.current?.detailTool(),
        drawingBrokenTool: () => drawApi.current?.brokenTool(),
        drawingDimensionTool: () => setDrawingTool((t) => (t === 'dimension' ? 'select' : 'dimension')),
        drawingNoteTool: () => setDrawingTool((t) => (t === 'note' ? 'select' : 'note')),
        drawingCleanupTool: () => setDrawingTool((t) => (t === 'cleanup' ? 'select' : 'cleanup')),
        drawingInsertBom: () => drawApi.current?.insertBom() ?? Promise.resolve(),
        drawingInsertTable: () => drawApi.current?.insertTable() ?? Promise.resolve(),
        drawingSaveAsTemplate: () => drawApi.current?.saveAsTemplate() ?? Promise.resolve(),
        drawingLoadSheetTemplate: () => drawApi.current?.loadSheetTemplate() ?? Promise.resolve(),
        drawingToggleTitleBlock: () => drawApi.current?.toggleTitleBlock(),
        drawingSaveSheetTemplate: () => drawApi.current?.saveSheetTemplate() ?? Promise.resolve(),
        drawingNewSheet: startDrawing,
        drawingRenameSheet: async () => {
          if (!drawingPageId) return
          const dw = drawingPages.find((p) => p.id === drawingPageId)
          const next = window.prompt('Rename drawing', dw?.label ?? '')
          if (next && next.trim()) await renameDrawing(drawingPageId, next.trim())
        },
        drawingDeleteSheet: async () => {
          if (drawingPageId) await deleteDrawing(drawingPageId)
        },
        drawingExportPdf: () => drawApi.current?.exportPdf() ?? Promise.resolve(),
        drawingExportDxf: () => drawApi.current?.exportDxf() ?? Promise.resolve(),
        startMeasure,
        toggleSection,
        scale: scaleBody,
        interference: runInterference,
        centerOfMass: runCenterOfMass,
        insertCanvas,
        toggleParams: () => setParamsOpen((v) => !v),
        toggleMaterials: () => setMaterialsOpen((v) => !v),
        toggleAppearance: () => setShowAppearance((v) => !v),
        toggleMcMaster: () => setMcMasterOpen((v) => !v),
        importKicad,
        reimportKicad,
        surfaceRuled,
        surfaceFill,
        surfaceStitch,
        surfaceOffset,
        addComponent,
        addJoint,
        selectFilterNode: <SelectModeToggle mode={selectMode} onMode={setSelectMode} />,
        selectFilterMenuNode: <SelectKindList active={selFilter} onActive={setSelFilter} />
      }),
    [
      openOp,
      sweep,
      createSketch,
      newDesign,
      openDesign,
      save,
      saveAs,
      exportModel,
      importStep,
      saveDebugLog,
      importKicad,
      reimportKicad,
      surfaceRuled,
      surfaceFill,
      surfaceStitch,
      surfaceOffset,
      addComponent,
      addJoint,
      fitView,
      projection,
      setProjection,
      startDrawing,
      drawingPageId,
      drawingPages,
      renameDrawing,
      deleteDrawing,
      startMeasure,
      toggleSection,
      scaleBody,
      runInterference,
      runCenterOfMass,
      insertCanvas,
      startCalibrate,
      selectMode,
      selFilter
    ]
  )
  // exposed to the test bridge (defined earlier); plain render assignment like opRef
  const commandsRef = useRef<typeof commands>([])
  commandsRef.current = commands

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
        else if (k === 'd') setSketchTool('dimension')
        else if (k === 'p') setSketchTool('project')
        else if (k === 'x' && !ctrl) {
          const on = vpApi.current?.toggleSketchConstruction() ?? !sketchConstruction
          setSketchConstruction(on)
        } else if (e.key === 'Escape') setSketchTool('select')
        return
      }
      if (ctrl && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void save()
        return
      }
      if (ctrl && e.key.toLowerCase() === 'o') {
        e.preventDefault()
        void openDesign()
        return
      }
      if (ctrl && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        newDesign()
        return
      }
      // while a drawing is open, its own keydown handler owns Ctrl+Z/Y (a
      // separate undo/redo stack over drawing edits, not model history) -
      // this global handler must not also fire and undo an unrelated 3D
      // feature out from under the user (confirmed report: Ctrl+Z did
      // nothing useful while editing a drawing, because model history had
      // nothing to undo there in the first place).
      if (!drawingPageId) {
        if (ctrl && e.key.toLowerCase() === 'z' && !e.shiftKey) {
          e.preventDefault()
          void doUndo()
          return
        }
        if (ctrl && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
          e.preventDefault()
          void doRedo()
          return
        }
      }
      if (!ctrl && (e.key === 's' || e.key === 'S')) {
        e.preventDefault()
        setPaletteOpen(true)
        return
      }
      if (e.key === 'Escape') {
        setPaletteOpen(false)
        openOp(null)
        setSelectMode('paint')
        setSelection([])
        return
      }
      // data-driven command hotkeys (user-overridable)
      const combo = comboFromEvent(e)
      const cmd = commands.find((c) => {
        const h = hotkeys[c.id] ?? c.hotkey
        return h && normaliseCombo(h) === combo && c.run
      })
      if (cmd) {
        e.preventDefault()
        cmd.run?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sketchSession, sketchConstruction, save, openDesign, newDesign, doUndo, doRedo, commands, hotkeys, openOp, drawingPageId])

  const activeName = tabs.find((t) => t.id === activeTab)?.name ?? 'Untitled'
  const activeDirty = tabs.find((t) => t.id === activeTab)?.dirty ?? false

  // client-side visibility: the viewport just flips object .visible flags on
  // this set. An id is hidden if the user hid it, or (no explicit choice) the
  // engine's own visible hint says so.
  const hiddenIds = useMemo(() => {
    const s = new Set<string>()
    const consider = (id: string, serverVisible: boolean | undefined): void => {
      const hidden = id in visOverride ? !visOverride[id] : serverVisible === false
      if (hidden) s.add(id)
    }
    for (const m of meshes) consider(m.id, m.visible)
    for (const sk of sketches) consider(sk.id, sk.visible)
    for (const dm of datums) consider(dm.id, dm.visible)
    // the sketch currently open for editing has its own LIVE 2D editor
    // overlay (SketchController's entGroup, redrawn every frame including
    // mid-drag) - the outer 3D scene's copy of that same sketch is a static
    // snapshot from whenever it was last reopened/finished and never tracks
    // a live drag, so leaving it visible draws a frozen duplicate of the
    // pre-drag shape right on top of (or next to) the one actually moving.
    // (User report, 2026-09-15, screenshot: dragging a slot profile showed
    // the old un-dragged outline still sitting there as a separate copy.)
    if (sketchSession?.sketchId) s.add(sketchSession.sketchId)
    return s
  }, [visOverride, meshes, sketches, datums, sketchSession])

  const onSketchChange = useCallback(() => {
    setSketchCount(vpApi.current?.getSketchEntities().length ?? 0)
    setSketchAvail(vpApi.current?.availableSketchConstraints() ?? [])
    setSketchConstraintCount(vpApi.current?.getSketchConstraints().length ?? 0)
    setSketchPendingCon(vpApi.current?.pendingSketchConstraint() ?? null)
  }, [])

  // sketch "Project geometry" tool: a model edge/face was clicked -> project it
  // as real external geometry (survives save/reopen) and push it into the editor
  const onSketchProject = useCallback(
    async (bodyId: string, sub: string) => {
      const sid = sketchSession?.sketchId
      if (!sid) return
      try {
        const r = await apiQuiet.sketchProject(sid, [{ bodyId, sub }])
        vpApi.current?.setSketchProjected(r.projected)
        markDirty()
        if (!r.added) flashSketchNotice('That geometry could not be projected.')
      } catch (e) {
        flashSketchNotice(`project: ${(e as Error).message}`)
      }
    },
    [sketchSession, markDirty, flashSketchNotice]
  )

  // --- Offset Plane live preview ---
  const [previewPlane, setPreviewPlane] = useState<{
    origin: [number, number, number]
    x: [number, number, number]
    y: [number, number, number]
    size: number
  } | null>(null)
  const previewTok = useRef(0)
  // keep the datum ghost on screen from the moment Apply is clicked until the
  // real datum lands, so creating a plane feels instant
  const [datumGhostHold, setDatumGhostHold] = useState(false)
  const [planeHandleDrag, setPlaneHandleDrag] = useState<{
    delta: number
    phase: 'move' | 'end'
    seq: number
  } | null>(null)
  const planeDragSeq = useRef(0)
  const sectionDragBase = useRef<number | null>(null)
  const onPreviewHandleDrag = useCallback(
    (deltaMm: number, phase: 'move' | 'end') => {
      if (op === 'datumPlane') {
        setPlaneHandleDrag({ delta: deltaMm, phase, seq: ++planeDragSeq.current })
        return
      }
      // section plane: drag the handle to slide the cut
      setSection((s) => {
        if (!s) return s
        if (sectionDragBase.current == null) sectionDragBase.current = s.offset
        const next = Math.round((sectionDragBase.current + deltaMm) * 10) / 10
        return { ...s, offset: next }
      })
      if (phase === 'end') sectionDragBase.current = null
    },
    [op]
  )

  // which cut the viewport actually clips with: the panel's live draft while it
  // is open, otherwise the first visible saved section
  const activeSection = useMemo<SectionState | null>(() => {
    if (section) return section
    return sections.find((s) => s.visible) ?? null
  }, [section, sections])

  // ghost plane for an active section cut (no RPC - it is just an origin plane)
  const sectionGhost = useMemo(() => {
    if (!section) return null
    const o = section.offset
    const F: Record<string, { origin: [number, number, number]; x: [number, number, number]; y: [number, number, number] }> = {
      XY: { origin: [0, 0, o], x: [1, 0, 0], y: [0, 1, 0] },
      XZ: { origin: [0, o, 0], x: [1, 0, 0], y: [0, 0, 1] },
      YZ: { origin: [o, 0, 0], x: [0, 1, 0], y: [0, 0, 1] }
    }
    return { ...F[section.plane], size: 80 }
  }, [section])
  const onDatumPlanePreview = useCallback(
    async (info: { offset: number; angle: number; flip: boolean } | null) => {
      const tok = ++previewTok.current
      if (!info) {
        setPreviewPlane(null)
        return
      }
      const refs = selection.map(selectionToRef).filter(Boolean) as import('./rpc').GeomRef[]
      if (!refs.length) {
        setPreviewPlane(null)
        return
      }
      try {
        const r = await api.datumPlanePreview(
          null,
          info.offset,
          null,
          refs,
          info.angle,
          info.flip
        )
        if (tok === previewTok.current) {
          setPreviewPlane({ origin: r.origin, x: r.x, y: r.y, size: r.size })
        }
      } catch {
        if (tok === previewTok.current) setPreviewPlane(null)
      }
    },
    [selection]
  )

  // shared "resolve a typed value, which may be an expression" step used by
  // both branches below
  const resolveDimValue = useCallback(async (txt: string, unitKind: 'length' | 'angle' = 'length'): Promise<number | null> => {
    const value = Number(txt)
    if (!isNaN(value)) return value
    try {
      return (await api.exprEval(txt, unitKind)).value
    } catch (e) {
      flashSketchNotice((e as Error).message)
      return null
    }
  }, [flashSketchNotice])

  const onSketchDimensionRequest = useCallback(
    async (entityIndex: number | null, kind: 'linear' | 'radius' | 'distance' | 'angle') => {
      const pos = vpApi.current?.sketchDimRequestWorldPos?.(entityIndex, kind) ?? null
      const screen = pos ? vpApi.current?.projectToScreen?.(pos) ?? null : null
      // fall back to the old blocking prompt if there is nowhere sane to
      // float the editor (camera looking away from the sketch plane, etc.) -
      // should not happen in practice, but never silently drop the pick
      const useFloating = !!screen

      if (kind === 'angle') {
        // two non-parallel lines picked - auto-detected as an angle rather
        // than a (geometrically meaningless) perpendicular-gap distance,
        // same click/switch/ctrl-add/place flow as a distance dimension
        const cur = vpApi.current?.sketchAnglePickValue?.() ?? null
        const initial = cur != null ? String(Math.round(cur * 100) / 100) : ''
        const commit = async (txt: string): Promise<void> => {
          const value = await resolveDimValue(txt, 'angle')
          if (value == null) return
          // FreeCAD's Angle constraint does not reject an out-of-range value
          // as conflicting/redundant - it just solves SOME configuration for
          // it, which for e.g. 400 degrees visibly relocates both lines away
          // from their shared vertex entirely (confirmed live: neither
          // line's own endpoint stayed at the vertex any more). Validate the
          // sane range client-side instead of letting that reach the solver
          // at all (user report, 2026-09-14: "if I type a value, it needs
          // to... show an error that the value is invalid").
          if (!(value > 0) || value >= 360) {
            flashSketchNotice(`Angle must be between 0 and 360 degrees (got ${value}).`)
            return
          }
          const ok = vpApi.current?.setSketchAngleDimension(value) ?? false
          if (!ok) {
            flashSketchNotice('Could not set that angle - the picked lines are no longer valid.')
            return
          }
          onSketchChange()
        }
        if (useFloating) {
          setDimEditor({
            x: screen!.x,
            y: screen!.y,
            value: initial,
            hint: 'degrees',
            onCommit: (txt) => {
              setDimEditor(null)
              void commit(txt)
            },
            onCancel: () => setDimEditor(null)
          })
          return
        }
        const txt = await promptText('Angle (degrees, or an expression)', initial)
        if (!txt) return
        await commit(txt)
        return
      }

      if (kind === 'distance') {
        const cur = vpApi.current?.sketchDistancePickValue?.() ?? null
        const initial = cur != null ? String(Math.round(cur * 1000) / 1000) : ''
        const commit = async (txt: string): Promise<void> => {
          const value = await resolveDimValue(txt)
          if (value == null) return
          if (!(value > 0)) {
            flashSketchNotice(`Distance must be a positive number (got ${value}).`)
            return
          }
          const ok = vpApi.current?.setSketchDistanceDimension(value) ?? false
          if (!ok) {
            flashSketchNotice('Could not set that distance - the picked geometry is no longer valid.')
            return
          }
          onSketchChange()
        }
        if (useFloating) {
          setDimEditor({
            x: screen!.x,
            y: screen!.y,
            value: initial,
            onCommit: (txt) => {
              setDimEditor(null)
              void commit(txt)
            },
            onCancel: () => setDimEditor(null)
          })
          return
        }
        const txt = await promptText('Distance (number or expression)', initial)
        if (!txt) return
        await commit(txt)
        return
      }
      // stop an over-dimensioning attempt before the user even types a number
      const block = await (vpApi.current?.checkSketchDimension?.(entityIndex as number) ??
        Promise.resolve(null))
      if (block) {
        flashSketchNotice(block)
        return
      }
      // circle/arc: let the user type "d 20" / "20 dia" / "Ø20" for a diameter,
      // or a plain number for a radius. "r 20" forces radius.
      const parseDimAs = (raw: string): { txt: string; dimAs?: 'radius' | 'diameter' } => {
        if (kind !== 'radius') return { txt: raw }
        const m = raw.trim().match(/^(?:d|dia|diam|diameter|Ø|⌀)\s*(.+)$|^(.+?)\s*(?:d|dia|diameter)$/i)
        if (m) return { txt: (m[1] ?? m[2]).trim(), dimAs: 'diameter' }
        if (/^r\s+/i.test(raw.trim())) return { txt: raw.trim().replace(/^r\s+/i, ''), dimAs: 'radius' }
        return { txt: raw }
      }
      const commit = async (raw: string): Promise<void> => {
        const { txt, dimAs } = parseDimAs(raw)
        const value = await resolveDimValue(txt)
        if (value == null) return
        if (!(value > 0)) {
          flashSketchNotice(`${kind === 'radius' ? 'Radius/diameter' : 'Length'} must be a positive number (got ${value}).`)
          return
        }
        const ok = vpApi.current?.setSketchDimension(entityIndex as number, value, dimAs) ?? false
        if (!ok) {
          flashSketchNotice('Could not set that dimension - the geometry is no longer valid.')
          return
        }
        onSketchChange()
      }
      // pre-fill with the LIVE measured value, same as the distance branch -
      // otherwise the floating editor opens blank, defeating the whole point
      // of showing it right on top of the dimension it edits
      const liveEnt = entityIndex != null ? vpApi.current?.getSketchEntities()?.[entityIndex] : null
      let liveValue = ''
      if (liveEnt) {
        if (liveEnt.type === 'circle' || liveEnt.type === 'arc') {
          liveValue = String(Math.round(liveEnt.r * 1000) / 1000)
        } else if (liveEnt.type === 'line') {
          const dx = liveEnt.b[0] - liveEnt.a[0]
          const dy = liveEnt.b[1] - liveEnt.a[1]
          liveValue = String(Math.round(Math.hypot(dx, dy) * 1000) / 1000)
        }
      }
      const label = kind === 'radius' ? 'Radius / Diameter' : 'Length'
      const hint = kind === 'radius' ? 'number = radius, "d20"/"Ø20" = diameter' : undefined
      if (useFloating) {
        setDimEditor({
          x: screen!.x,
          y: screen!.y,
          value: liveValue,
          hint,
          onCommit: (txt) => {
            setDimEditor(null)
            void commit(txt)
          },
          onCancel: () => setDimEditor(null)
        })
        return
      }
      const txt = await promptText(`${label}${hint ? ' (' + hint + ')' : ''} (number or expression)`, liveValue)
      if (!txt) return
      await commit(txt)
    },
    [onSketchChange, flashSketchNotice, resolveDimValue]
  )

  return (
    <div className="app">
      {showFirstRun && (
        <FirstRun
          onDone={(initial) => {
            setShowFirstRun(false)
            // a brand-new, untouched document must not open already flagged
            // dirty - the wizard is setting an app-level viewport preference,
            // not editing a document, so don't mark the tab unsaved for it
            // (was showing "Untitled *" before the user had done anything).
            if (initial && Object.keys(initial).length) {
              applyRenderSettings(initial)
              markDirty(false)
            }
          }}
        />
      )}
      <AppBar
        dataOpen={dataOpen}
        onToggleData={() => setDataOpen((v) => !v)}
        gitOpen={gitOpen}
        onToggleGit={() =>
          setGitOpen((v) => {
            if (v) setGitTarget(null)
            return !v
          })
        }
        docName={activeName}
        dirty={activeDirty}
        fileActions={{
          onNew: newDesign,
          onOpen: () => openDesign(),
          onSave: save,
          onSaveAs: saveAs,
          onExport: exportModel,
          onImport: importStep,
          onNewPart: () => setNewPartOpen(true),
          onNewRevision: currentPn ? newRevision : undefined,
          onPnBrowser: () => setPnBrowserOpen(true),
          onCompanySettings: () => setCompanySettingsOpen(true),
          currentLifecycle,
          onSetLifecycle: currentPn ? setLifecycle : undefined
        }}
        history={{
          onUndo: () => void doUndo(),
          onRedo: () => void doRedo(),
          canUndo,
          canRedo
        }}
      />

      <div className="appbody">
        <DataPanel
          open={dataOpen}
          onOpenFile={(p) => void openDesign(p)}
          onNewDesignAt={(p) => {
            void (async () => {
              const dir = p.slice(0, p.length - basename(p).length - 1)
              const owner = await api.pnRepoForPath(dir).catch(() => ({ project: null }))
              if (owner.project) {
                // This folder lives inside a configured company repo - a
                // plain untracked filename isn't allowed here, route through
                // PN assignment instead (pre-selected to this project).
                setNewPartProject(owner.project)
                setNewPartOpen(true)
                return
              }
              await api.resetDocument()
              await api.saveAs(p)
              setDocPath(p)
              const id = `d${Date.now()}`
              setTabs((t) => [...t, { id, name: basename(p), dirty: false, path: p }])
              setActiveTab(id)
              await refreshScene()
            })()
          }}
          onGitHistory={(p) => {
            setGitTarget(p)
            setGitOpen(true)
          }}
        />

        <div className="maincol">
          {status.phase !== 'ready' && (
            <div className="boot-scrim">
              <div className="boot-scrim-msg">
                {status.phase === 'error' ? (
                  <>
                    <b>Engine offline</b>
                    <span>{status.message}</span>
                  </>
                ) : (
                  <>
                    <span className="boot-spinner" />
                    Starting the FreeCAD engine…
                  </>
                )}
              </div>
            </div>
          )}
          <Ribbon
            commands={commands}
            pins={pins}
            hotkeys={hotkeys}
            onSetPin={setPin}
            onSetHotkey={setHotkey}
            showAssemble={bodies.filter((b) => b.features.length > 0).length >= 2}
            sketchMode={!!sketchSession}
            drawingMode={!!drawingPageId}
            sketchPanel={
              <SketchRibbon
                tool={sketchTool}
                onTool={setSketchTool}
                construction={sketchConstruction}
                onToggleConstruction={() => {
                  const on = vpApi.current?.toggleSketchConstruction() ?? !sketchConstruction
                  setSketchConstruction(on)
                }}
                available={sketchAvail}
                pendingConstraint={sketchPendingCon ?? null}
                onConstraint={(t) => {
                  // apply straight away if the selection already supports it,
                  // otherwise drop into "click the geometry" mode
                  const applied = vpApi.current?.applySketchConstraint(t) ?? false
                  trace('ACTION sketchConstraint', { type: t, appliedImmediately: applied })
                  if (!applied) {
                    vpApi.current?.startSketchConstraint(t)
                  }
                  onSketchChange()
                }}
                onUndo={() => {
                  vpApi.current?.sketchUndo()
                  onSketchChange()
                }}
                onFinish={() => void finishSketch()}
                onCancel={() => void cancelSketch()}
                count={sketchCount}
                constraintCount={sketchConstraintCount}
                pins={pins}
                onSetPin={setPin}
              />
            }
          />
          <DocTabs
            tabs={tabs}
            activeId={activeTab}
            onActivate={(id) => {
              if (id === activeTab) return
              const target = tabs.find((t) => t.id === id)
              if (!target) return
              // The sidecar holds exactly one document - switching tabs must
              // actually reopen that file, not just relabel the UI. A tab
              // with no saved path (a never-saved "Untitled") has nothing on
              // disk to reopen; its in-memory state was already replaced the
              // moment the user navigated away from it, so it can't be
              // switched back to - drop it rather than pretend to activate a
              // document that no longer exists anywhere.
              if (!target.path) {
                setTabs((t) => t.filter((x) => x.id !== id))
                return
              }
              void openDesign(target.path)
            }}
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

              {drawingPageId ? (
                <DrawingSheet
                  key={drawingPageId}
                  ref={drawApi}
                  pageId={drawingPageId}
                  makeView={makeView}
                  docPath={docPath}
                  assembly={asmTree}
                  onBack={() => setDrawingPageId(null)}
                  tool={drawingTool}
                  onToolChange={setDrawingTool}
                />
              ) : (
                <>
                  <Viewport
                    meshes={meshes}
                    sketches={sketches}
                    datums={datums}
                    hiddenIds={hiddenIds}
                    selection={selection}
                    onSelect={onSelect}
                    section={activeSection}
                    planePickMode={planePickMode}
                    pickPlanes={pickPlanes}
                    onPickPlane={(ref) => void beginSketch(ref)}
                    selectMode={selectMode}
                    selFilter={measureMode ? [...selFilter, 'vertex', 'face', 'edge'] : selFilter}
                    previewPlane={op === 'datumPlane' || datumGhostHold ? previewPlane : sectionGhost}
                    onPreviewHandleDrag={onPreviewHandleDrag}
                    onWindowSelect={(sels, additive) =>
                      setSelection((cur) => {
                        if (!additive) return sels
                        const keys = new Set(cur.map(selKey))
                        return [...cur, ...sels.filter((s) => !keys.has(selKey(s)))]
                      })
                    }
                    canvases={canvases}
                    calibrateCanvas={
                      calibrateId ? canvases.find((c) => c.id === calibrateId) ?? null : null
                    }
                    onCalibrate={(mm) => void onCalibrateLine(mm)}
                    sketchFrame={sketchSession?.frame ?? null}
                    sketchRefGeom={sketchSession?.refGeom ?? null}
                    sketchInitialEntities={sketchInitial}
                    sketchInitialConstraints={sketchInitialCons}
                    sketchInitialProjected={sketchInitialProjected}
                    onSketchProject={(bodyId, sub) => void onSketchProject(bodyId, sub)}
                    sketchTool={sketchTool}
                    onSketchChange={onSketchChange}
                    onSketchDimensionRequest={(i, k) => void onSketchDimensionRequest(i, k)}
                    onSketchSolve={async (ents, cons, proj) => {
                      try {
                        return await apiQuiet.sketchSolve(
                          ents as unknown[],
                          cons as unknown as SketchConstraint[],
                          proj as unknown as import('./rpc').ProjectedEntity[]
                        )
                      } catch {
                        return null
                      }
                    }}
                    onSketchDrag={{
                      start: async (ents, cons, proj) => {
                        try {
                          return await apiQuiet.sketchDragStart(
                            ents as unknown[],
                            cons as unknown as SketchConstraint[],
                            proj as unknown as import('./rpc').ProjectedEntity[]
                          )
                        } catch {
                          return null
                        }
                      },
                      move: async (dragId, element, sub, posId, pos) => {
                        try {
                          return await apiQuiet.sketchDragMove(dragId, element, sub, posId, pos)
                        } catch {
                          return null
                        }
                      },
                      end: async (dragId) => {
                        try {
                          await apiQuiet.sketchDragEnd(dragId)
                        } catch {
                          // best-effort - the sidecar's own 30s GC net closes
                          // an abandoned scratch document either way
                        }
                      }
                    }}
                    onSketchNotice={flashSketchNotice}
                    renderSettings={renderSettings}
                    projection={projection}
                    onProjectionChange={setProjection}
                    dressUpGhost={dressUpGhost}
                    onDressUpGhostToggle={(sub, midpoint) => {
                      // Ctrl-click a ghost edge -> drop that ref from the set;
                      // the preview / commit rebuilds without it. Match the
                      // dropped selection entry by its sub name OR, since names
                      // can be stale after a preview renumber, by the click
                      // point nearest the ghost edge's midpoint.
                      setSelection((cur) => {
                        const cand = cur.filter((s) => s.kind === 'edge' || s.kind === 'face')
                        if (!cand.length) return cur
                        let drop = cand.find((s) => (s as { sub: string }).sub === sub)
                        if (!drop && midpoint) {
                          let bd = Infinity
                          for (const s of cand) {
                            const p = (s as { point?: number[] }).point
                            if (!p) continue
                            const d = Math.hypot(
                              p[0] - midpoint[0],
                              p[1] - midpoint[1],
                              p[2] - midpoint[2]
                            )
                            if (d < bd) {
                              bd = d
                              drop = s
                            }
                          }
                        }
                        return drop ? cur.filter((s) => s !== drop) : cur
                      })
                    }}
                    asmTool={asmTree ? asmTool : undefined}
                    onAssemblyDrag={{
                      start: async (componentId) => {
                        await asmDragStart(componentId)
                      },
                      move: async (delta) => {
                        await asmDragMove(delta)
                      },
                      end: async () => {
                        await asmDragEnd()
                      }
                    }}
                    apiRef={vpApi}
                  />
                  {sketchNotice && (
                    <div className="hintbar warn">
                      {sketchNotice}
                      <button onClick={() => setSketchNotice(null)}>Dismiss</button>
                    </div>
                  )}
                  {planePickMode && (
                    <div className="hintbar">
                      Click an origin plane, construction plane, or a flat face to
                      start the sketch
                      <button onClick={() => setPlanePickMode(false)}>Cancel</button>
                    </div>
                  )}
                  {calibrateId && (
                    <div className="hintbar">
                      Click the two ends of a known length on the canvas
                      <button onClick={() => setCalibrateId(null)}>Cancel</button>
                    </div>
                  )}
                  <Browser
                    bodies={bodies}
                    imported={imported}
                    canvases={canvases}
                    sections={sections.map((s) => ({
                      id: s.id!,
                      label: s.label ?? s.id!,
                      visible: s.visible ?? true
                    }))}
                    drawings={drawingPages}
                    visibility={visOverride}
                    selection={selection}
                    handlers={{
                      onToggleVisibility: toggleVisibility,
                      onToggleGroup: toggleGroup,
                      onRename: renameFeature,
                      onDelete: deleteFeature,
                      onEdit: (id) => onEditRow(id),
                      onEditDim: (id) => void editFeatureDim(id),
                      onSelect: (sel, add) => onSelect(sel, add ? 'additive' : 'replace'),
                      onCalibrateCanvas: (id) => startCalibrate(id),
                      onDeleteCanvas: (id) => void api.canvasDelete(id).then(() => refreshMeshesOnly()),
                      onToggleSection: (id, v) => void toggleSectionVisible(id, v),
                      onEditSection: (id) => editSection(id),
                      onDeleteSection: (id) => void deleteSection(id),
                      onOpenDrawing: (id) => openDrawing(id),
                      onRenameDrawing: (id) => {
                        const dw = drawingPages.find((p) => p.id === id)
                        const next = window.prompt('Rename drawing', dw?.label ?? '')
                        if (next && next.trim()) void renameDrawing(id, next.trim())
                      },
                      onDeleteDrawing: (id) => void deleteDrawing(id)
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
                      pins={asmPins}
                      onSetPin={setComponentPin}
                      tool={asmTool}
                      onSetTool={setAsmTool}
                    />
                  )}
                  {op && (
                    <OperationDialog
                      kind={op}
                      selection={selection}
                      onSelectionChange={setSelection}
                      onApply={applyOp}
                      onCancel={() => openOp(null)}
                      onPreview={onDatumPlanePreview}
                      onReady={setOpReady}
                      onLivePreview={runLivePreview}
                      onLivePreviewEnd={endLivePreview}
                      handleDrag={planeHandleDrag}
                      initialValues={editInit}
                      editingLabel={editLabel}
                    />
                  )}
                  {measureMode && (
                    <MeasurePanel
                      result={measureResult}
                      picks={
                        selection.filter(
                          (s) => s.kind === 'face' || s.kind === 'edge' || s.kind === 'vertex'
                        ).length
                      }
                      onReset={() => {
                        setSelection([])
                        setMeasureResult(null)
                      }}
                      onClose={() => {
                        setMeasureMode(false)
                        setMeasureResult(null)
                        setSelection([])
                      }}
                    />
                  )}
                  {section && (
                    <SectionPanel
                      state={section}
                      onChange={setSection}
                      onOk={() => void commitSection()}
                      onCancel={() => setSection(null)}
                    />
                  )}
                  {massProps && (
                    <MassPropsPanel data={massProps} onClose={() => setMassProps(null)} />
                  )}
                  {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
                  {paramsOpen && (
                    <ParametersPanel
                      onClose={() => setParamsOpen(false)}
                      onModelChanged={() => {
                        rollCacheRef.current.clear()
                        void refreshScene()
                      }}
                    />
                  )}
                  {materialsOpen &&
                    (() => {
                      const selBody = selection.find(
                        (s) => s.kind === 'body' || s.kind === 'face'
                      ) as { bodyId: string } | undefined
                      const tid = selBody?.bodyId ?? bodies[0]?.id ?? null
                      const label = bodies.find((b) => b.id === tid)?.id ?? null
                      return (
                        <MaterialsPanel
                          targetId={tid}
                          targetLabel={label}
                          onClose={() => setMaterialsOpen(false)}
                          onModelChanged={() => {
                            rollCacheRef.current.clear()
                            void refreshScene()
                          }}
                        />
                      )
                    })()}
                  {mcmasterOpen && (
                    <McMasterPanel
                      onClose={() => setMcMasterOpen(false)}
                      onReady={(info) => {
                        // a purchased MMC part is a real company part - route it
                        // through the same PN-reserve flow as File > New instead
                        // of dropping an untagged file on disk. createPart() picks
                        // pendingMcMaster back up once a PN is assigned, imports
                        // the downloaded STEP file, and tags it.
                        setMcMasterOpen(false)
                        setPendingMcMaster(info)
                        const meta = info.meta
                        setNewPartPrefill({
                          name: (meta.title as string) || undefined,
                          description: (meta.subtitle as string) || undefined,
                          mfg: 'McMaster-Carr',
                          mfgPn: (meta.partNumber as string) || undefined,
                          purchasingLink: (meta.url as string) || undefined
                        })
                        setNewPartOpen(true)
                      }}
                    />
                  )}
                  {newPartOpen && (
                    <NewPartDialog
                      initialProject={newPartProject}
                      prefill={newPartPrefill}
                      onClose={() => {
                        setNewPartOpen(false)
                        setNewPartProject(undefined)
                        setNewPartPrefill(undefined)
                        setPendingMcMaster(undefined)
                      }}
                      onCreated={(info) => {
                        setNewPartProject(undefined)
                        void createPart(info)
                      }}
                    />
                  )}
                  {pnBrowserOpen && (
                    <PNBrowserPanel
                      onClose={() => setPnBrowserOpen(false)}
                      onOpen={(p) => void openPnFile(p)}
                    />
                  )}
                  {companySettingsOpen && (
                    <CompanySettingsPanel onClose={() => setCompanySettingsOpen(false)} />
                  )}
                  {showAppearance &&
                    (() => {
                      const selBody = selection.find(
                        (s) => s.kind === 'body' || s.kind === 'face'
                      ) as { bodyId: string; sub?: string } | undefined
                      const tid = selBody?.bodyId ?? meshes[0]?.id ?? null
                      const target = meshes.find((m) => m.id === tid) ?? null
                      const selFaces = selection
                        .filter((s) => s.kind === 'face' && s.bodyId === tid)
                        .map((s) => (s as { sub: string }).sub)
                      return (
                        <AppearancePanel
                          targetId={tid}
                          targetLabel={target?.label ?? tid}
                          appearance={target?.appearance}
                          selectedFaces={selFaces}
                          renderSettings={renderSettings}
                          vpApi={vpApi}
                          docPath={docPath}
                          onSetAppearance={setObjectAppearance}
                          onSetFaceColor={setFaceColor}
                          onClearAppearance={clearObjectAppearance}
                          onSetRender={applyRenderSettings}
                          onClose={() => setShowAppearance(false)}
                        />
                      )
                    })()}
                  <Timeline
                    bodies={bodies}
                    sketchActive={!!sketchSession}
                    handlers={{
                      onRollTo: rollTo,
                      onEdit: (id) => onEditRow(id),
                      onEditDim: (id) => void editFeatureDim(id),
                      onRename: renameFeature,
                      onDelete: deleteFeature,
                      onDeleteMany: (ids) => void deleteFeaturesMany(ids),
                      onSuppress: (id, s) => void suppressFeature(id, s),
                      onSuppressMany: (ids, s) => void suppressFeaturesMany(ids, s),
                      onSelectFeatures: setTimelineSel
                    }}
                  />
                </>
              )}
            </div>
          </div>
        </div>

        <GitPanel open={gitOpen} filePath={gitTarget ?? docPath} />
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
        {appVersion && <span title="GWT-CAD version">GWT-CAD v{appVersion}</span>}
        <span className="sb-spacer" />
        <span>{selection.length ? `${selection.length} selected` : ''}</span>
        <span>{docPath ? basename(docPath) : 'unsaved'}</span>
        <span>mm</span>
        <span
          title={`${PERF.cores} cores · ~${PERF.memGB}GB · ${PERF.softwareGL ? 'software GL' : 'GPU'} · prefetch ${PERF.prefetchRadius} · cache ${PERF.rollCacheMax}`}
        >
          perf: {PERF.tier}
        </span>
        <span>Click: select · Middle: pan · Shift+Middle: orbit · S: search</span>
      </div>

      <CommandPalette
        commands={commands}
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
      />
      <PromptHost />
      <DimensionEditor req={dimEditor} />
    </div>
  )
}
