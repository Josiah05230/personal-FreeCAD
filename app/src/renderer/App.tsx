import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  api,
  apiQuiet,
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
import { DrawingSheet } from './ui/DrawingSheet'
import { AssemblyPanel } from './ui/AssemblyPanel'
import { SketchRibbon } from './ui/SketchRibbon'
import { MeasurePanel, SectionPanel, type SectionState } from './ui/InspectPanels'
import { PromptHost, promptText, promptForm } from './ui/PromptDialog'
import { ParametersPanel } from './ui/ParametersPanel'
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
import type { MeasureResult, SketchRefGeom, SketchConstraint } from './rpc'
import type { SketchTool, SketchConstraintType } from './viewport/SketchController'
import type { SketchFrameDTO } from './rpc'
import { basename, sketchEntitiesToPolys } from './util'
import { perfProfile } from './perfProfile'

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

export function App(): JSX.Element {
  const [status, setStatus] = useState<Status>({ phase: 'boot' })
  const [meshes, setMeshes] = useState<RenderMesh[]>([])
  const [sketches, setSketches] = useState<SketchRender[]>([])
  const [datums, setDatums] = useState<DatumDTO[]>([])
  const [bodies, setBodies] = useState<BodyTree[]>([])
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
  const [docPath, setDocPath] = useState<string | null>(null)
  const [visOverride, setVisOverride] = useState<Record<string, boolean>>({})
  const [selection, setSelection] = useState<Selection[]>([])

  const [dataOpen, setDataOpen] = useState(false)
  const [gitOpen, setGitOpen] = useState(false)
  const [gitTarget, setGitTarget] = useState<string | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [op, setOp] = useState<OpKind | null>(null)

  const [showDrawing, setShowDrawing] = useState(false)
  const [paramsOpen, setParamsOpen] = useState(false)
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
      setBodies(tree.bodies)
      setDocPath(tree.path)
      if ('canUndo' in tree) setCanUndo(!!tree.canUndo)
      if ('canRedo' in tree) setCanRedo(!!tree.canRedo)
      // keep the user's show/hide choices across refreshes
    },
    []
  )

  const refreshScene = useCallback(async () => {
    rollCacheRef.current.clear()
    const [scene, tree, asm] = await Promise.all([
      api.sceneGet(),
      api.treeGet(),
      api.assemblyTree().catch(() => null)
    ])
    applySceneTree(scene, tree)
    setAsmTree(asm && asm.assembly ? asm : null)
  }, [applySceneTree])

  const refreshMeshesOnly = useCallback(async () => {
    const [scene, tree] = await Promise.all([api.sceneGet(), api.treeGet()])
    setMeshes(scene.meshes)
    setSketches(scene.sketches ?? [])
    setDatums(scene.datums ?? [])
    setPickPlanes(scene.pickPlanes ?? [])
    setBodies(tree.bodies)
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
  const onSelect = useCallback(
    (sel: Selection | null, additive: boolean) => {
      if (!sel) {
        if (!additive) setSelection([])
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
      if (!selFilter.includes(sel.kind as SelKind)) return // selection filter
      setSelection((cur) => {
        if (!additive) return [sel]
        const k = selKey(sel)
        if (cur.some((s) => selKey(s) === k)) return cur.filter((s) => selKey(s) !== k)
        // multi-face pick: once one face is chosen, only add coplanar faces
        // (clear the selection to start on a different plane). Only for extrude
        // / no dialog - shell, draft, etc. legitimately want faces on many planes.
        const coplanarLock = opRef.current == null || opRef.current === 'extrude'
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
    [selFilter]
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
    },
    [resetSketchUi]
  )

  const finishSketch = useCallback(async () => {
    if (!sketchSession) return
    const newEnts = vpApi.current?.getNewSketchEntities() ?? []
    const allEnts = vpApi.current?.getSketchEntities() ?? []
    const cons = (vpApi.current?.getNewSketchConstraints() ?? []) as SketchConstraint[]
    const removedCons = (vpApi.current?.getRemovedSketchConstraints() ?? []) as SketchConstraint[]
    const { frame } = sketchSession
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
    resetSketchUi()
    setSelection([{ kind: 'sketch', sketchId: id }])
    markDirty()
    rollCacheRef.current.clear()

    // 2. commit to the engine in the background, then reconcile with the real
    //    (constraint-solved) geometry. Uses the quiet RPC path - no spinner.
    try {
      await apiQuiet.sketchFinish(id, newEnts, cons, removedCons)
      const [scene, tree] = await Promise.all([apiQuiet.sceneGet(), apiQuiet.treeGet()])
      setMeshes(scene.meshes)
      setSketches(scene.sketches ?? [])
      setDatums(scene.datums ?? [])
      setBodies(tree.bodies)
    } catch (e) {
      window.alert((e as Error).message)
      await refreshScene()
    }
  }, [sketchSession, resetSketchUi, markDirty, refreshScene])

  const cancelSketch = useCallback(async () => {
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
        void refreshScene()
      }
    }
    setSketchSession(null)
    setSketchInitial([])
    setSketchInitialCons([])
    sketchOnRef.current = null
  }, [sketchSession, refreshScene])

  // live-preview lifecycle (defined fully below applyOp; the ref is stable)
  const livePreviewRef = useRef({ seq: 0, applied: false, running: false })

  const applyOp = useCallback(
    async (kind: OpKind, v: OpValues, exprs: Record<string, string> = {}) => {
      // discard any live-preview attempt so the real commit starts from a clean
      // model (applyOp stays the single source of truth for the committed feature)
      livePreviewRef.current.seq++
      if (livePreviewRef.current.applied) {
        livePreviewRef.current.applied = false
        try {
          await api.undo()
        } catch {
          /* nothing to roll back */
        }
      }
      // close the dialog the instant the user commits - the engine rebuild and
      // scene refresh run behind the status spinner and reconcile when they land
      if (kind === 'datumPlane') setDatumGhostHold(true) // keep the ghost until the real datum lands
      setOp(null)
      const edges = selection.filter((s) => s.kind === 'edge').map((s) => (s as { sub: string }).sub)
      const faces = selection.filter((s) => s.kind === 'face') as Array<{
        bodyId: string
        sub: string
        point: [number, number, number]
        normal?: [number, number, number]
      }>
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
            // in "to object" mode the second selected face is the target
            const upToFace = toObject
              ? faces[faceProfile ? 1 : 0]
              : undefined
            const upTo =
              (upToFace
                ? { kind: 'face', bodyId: upToFace.bodyId, sub: upToFace.sub }
                : null) as import('./rpc').GeomRef | null
            const opMap: Record<string, 'join' | 'cut' | 'newBody'> = {
              Join: 'join',
              Cut: 'cut',
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
              faceProfile
            )
            break
          }
          case 'revolve': {
            // axis: first non-profile edge / sketch line / datum axis in the selection
            let axisRef: import('./rpc').GeomRef | null = null
            for (const s of selection) {
              if (s.kind === 'edge') {
                axisRef = { kind: 'edge', bodyId: s.bodyId, sub: s.sub }
                break
              }
              if (s.kind === 'plane') {
                axisRef = s.role
                  ? { kind: 'origin', role: s.role }
                  : { kind: 'plane', id: s.planeId }
                break
              }
              if (s.kind === 'sketch' && s.sketchId !== sketchIds[0]) {
                axisRef = { kind: 'sketch', id: s.sketchId }
                break
              }
            }
            await api.revolve(sketchIds[0], Number(v.angle), 'V', Boolean(v.cut), axisRef)
            break
          }
          case 'loft':
            await api.loft(sketchIds, Boolean(v.cut))
            break
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
              Boolean(v.throughAll),
              String(v.cutType || 'None') as 'None' | 'Counterbore' | 'Countersink',
              Number(v.cutDiameter),
              Number(v.cutDepth)
            )
            break
          case 'moveBody': {
            const tgt = selection.find((s) => s.kind === 'body' || s.kind === 'face') as
              | { bodyId: string }
              | undefined
            const id = tgt?.bodyId ?? bodies[0]?.id
            if (id)
              await api.bodyTransform(
                id,
                [Number(v.dx), Number(v.dy), Number(v.dz)],
                [Number(v.rx), Number(v.ry), Number(v.rz)]
              )
            break
          }
          case 'copyBody': {
            const tgt = selection.find((s) => s.kind === 'body' || s.kind === 'face') as
              | { bodyId: string }
              | undefined
            const id = tgt?.bodyId ?? bodies[0]?.id
            if (id) await api.bodyCopy(id)
            break
          }
          case 'patternLinear': {
            const dirRef = selection.map(selectionToRef).find(Boolean) ?? null
            await api.patternLinear([1, 0, 0], Number(v.count), Number(v.spacing), dirRef)
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
            const refs = selection
              .map(selectionToRef)
              .filter(Boolean) as import('./rpc').GeomRef[]
            const base = refs[0] ?? null
            const target = v.mode === 'To object' ? refs[1] ?? null : null
            await api.datumPlane(base, Number(v.offset), 'XY', target)
            break
          }
          case 'datumAxis': {
            const refs = selection
              .map(selectionToRef)
              .filter(Boolean) as import('./rpc').GeomRef[]
            await api.datumAxis(refs)
            break
          }
          case 'datumPoint': {
            const ref = selection.map(selectionToRef).find(Boolean) ?? null
            await api.datumPoint(ref)
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
      } catch (e) {
        window.alert((e as Error).message)
      } finally {
        setDatumGhostHold(false)
      }
    },
    [selection, afterEdit]
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
      const edges = selection.filter((s) => s.kind === 'edge').map((s) => (s as { sub: string }).sub)
      const sk = selection.find((s) => s.kind === 'sketch') as { sketchId: string } | undefined
      switch (kind) {
        case 'extrude': {
          const opMap: Record<string, 'join' | 'cut' | 'newBody'> = {
            Join: 'join',
            Cut: 'cut',
            'New body': 'newBody'
          }
          const operation = opMap[String(v.operation)] ?? 'join'
          const faceProfile = !sk && faces[0] ? { bodyId: faces[0].bodyId, sub: faces[0].sub } : null
          if (!sk && !faceProfile) return null
          return api.extrude(
            sk?.sketchId ?? null,
            Number(v.length),
            operation === 'cut',
            Boolean(v.midplane),
            Boolean(v.reversed),
            null,
            operation,
            0,
            faceProfile
          )
        }
        case 'revolve':
          if (!sk) return null
          return api.revolve(sk.sketchId, Number(v.angle), 'V', Boolean(v.cut), null)
        case 'fillet':
          return edges.length ? api.fillet(edges, Number(v.radius)) : null
        case 'chamfer':
          return edges.length ? api.chamfer(edges, Number(v.size)) : null
        case 'shell':
          return faces.length ? api.shell(faces.map((f) => f.sub), Number(v.thickness)) : null
        case 'hole':
          return faces[0]
            ? api.hole(
                faces[0].sub,
                faces[0].point,
                Number(v.diameter),
                Number(v.depth),
                Boolean(v.throughAll),
                String(v.cutType || 'None') as 'None' | 'Counterbore' | 'Countersink',
                Number(v.cutDiameter),
                Number(v.cutDepth)
              )
            : null
        case 'draft':
          return faces.length
            ? api.draft(faces.map((f) => f.sub), Number(v.angle), null, null)
            : null
        case 'rib':
          return sk ? api.rib(sk.sketchId, Number(v.thickness), Boolean(v.reversed)) : null
        default:
          return null
      }
    },
    [selection]
  )

  const rollbackPreview = useCallback(async () => {
    const lp = livePreviewRef.current
    if (!lp.applied) return
    lp.applied = false
    try {
      await api.undo()
    } catch {
      /* nothing to undo */
    }
  }, [])

  const runLivePreview = useCallback(
    async (kind: OpKind, v: OpValues) => {
      const lp = livePreviewRef.current
      if (lp.running) return
      lp.running = true
      const seq = ++lp.seq
      try {
        await rollbackPreview()
        const call = previewCall(kind, v)
        if (!call) return
        await call
        if (seq !== lp.seq) {
          // superseded while the engine was working - undo this attempt
          try {
            await api.undo()
          } catch {
            /* ignore */
          }
          return
        }
        lp.applied = true
        await refreshMeshesOnly()
      } catch {
        // invalid params at this value - just leave the model as it was
        livePreviewRef.current.applied = false
      } finally {
        lp.running = false
      }
    },
    [previewCall, rollbackPreview, refreshMeshesOnly]
  )

  const endLivePreview = useCallback(async () => {
    livePreviewRef.current.seq++
    if (livePreviewRef.current.applied) {
      await rollbackPreview()
      await refreshScene()
    }
  }, [rollbackPreview, refreshScene])

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

  // after the model changes and we are sitting at the tip, quietly cache the
  // previous couple of build stages so the first "step back" is instant (the
  // stage you want was rendered seconds ago). Best-effort, cancels on new edits.
  useEffect(() => {
    const b = bodies[0]
    if (!bodyId || !b || b.marker) return
    const feats = b.features
    const wants: (string | null)[] = []
    for (let dd = 1; dd <= Math.min(2, feats.length - 1); dd++) {
      const j = feats.length - 1 - dd
      const fid = feats[j]?.id ?? null
      if (fid && !rollCacheRef.current.has(`${bodyId}:${fid}`)) wants.push(fid)
    }
    if (!wants.length) return
    const seq = ++rollSeqRef.current
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
          /* best effort */
        }
      }
      if (rollSeqRef.current === seq) await apiQuiet.rollTo(bodyId, null).catch(() => undefined)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bodies, bodyId])

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
    async (id: string) => {
      if (!window.confirm('Delete this feature?')) return
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
      try {
        await api.deleteFeature(id)
        const [scene, tree] = await Promise.all([api.sceneGet(), api.treeGet()])
        applySceneTree(scene, tree)
      } catch (e) {
        window.alert((e as Error).message)
        await refreshScene()
      }
    },
    [markDirty, applySceneTree, refreshScene]
  )

  const suppressFeature = useCallback(
    async (id: string, suppressed: boolean) => {
      await api.featureSuppress(id, suppressed)
      await afterEdit()
    },
    [afterEdit]
  )

  const doUndo = useCallback(async () => {
    if (!canUndo) return
    const r = await api.undo()
    setCanUndo(r.canUndo)
    setCanRedo(r.canRedo)
    rollCacheRef.current.clear()
    // history moved - drop stale manual show/hide choices and trust the engine,
    // so e.g. undoing an extrude un-hides the sketch it had consumed
    setVisOverride({})
    await refreshScene()
    markDirty()
  }, [canUndo, refreshScene, markDirty])

  const doRedo = useCallback(async () => {
    if (!canRedo) return
    const r = await api.redo()
    setCanUndo(r.canUndo)
    setCanRedo(r.canRedo)
    rollCacheRef.current.clear()
    setVisOverride({})
    await refreshScene()
    markDirty()
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

  const toggleVisibility = useCallback((id: string, visible: boolean) => {
    // pure view state: instant, no engine round-trip, no spinner. scene.get
    // already ships every body / sketch / datum so there is always something
    // to toggle back on.
    setVisOverride((m) => ({ ...m, [id]: visible }))
  }, [])

  // ---- file ops ----
  const saveAs = useCallback(async () => {
    const p = await window.cad.saveDialog(docPath ?? undefined)
    if (!p) return
    await api.saveAs(p)
    setDocPath(p)
    setTabs((t) =>
      t.map((x) => (x.id === activeTab ? { ...x, name: basename(p), dirty: false } : x))
    )
    void window.cad.captureThumb(p).catch(() => undefined)
  }, [docPath, activeTab])

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
      await api.open(p)
      const id = `d${Date.now()}`
      setTabs((t) => [...t.filter((x) => x.name !== 'Untitled' || x.dirty), { id, name: basename(p), dirty: false }])
      setActiveTab(id)
      setDocPath(p)
      setShowDrawing(false)
      await refreshScene()
    },
    [refreshScene]
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
      await refreshMeshesOnly()
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
    await refreshMeshesOnly()
    // calibration is part of placing a canvas, not a separate tool
    if (r?.id) setCalibrateId(r.id)
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
        `Joint "${jointType}" added (${r.engine}). Headless joint solving is experimental; it will move components once the solver session lands.`
      )
  }, [selection, jointType, refreshScene])

  // test / automation bridge - lets an out-of-band script refresh the scene
  // after driving the engine directly (used for screenshots + UI smoke runs)
  useEffect(() => {
    ;(window as unknown as { __gwtcad?: unknown }).__gwtcad = {
      refresh: () => refreshScene(),
      fit: () => vpApi.current?.fit(),
      applyOp: (k: OpKind, v: OpValues) => void applyOp(k, v),
      beginSketch,
      editSketch,
      perf: PERF
    }
  }, [refreshScene, applyOp, beginSketch, editSketch])

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
        toggleParams: () => setParamsOpen((v) => !v),
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
      sweep,
      createSketch,
      newDesign,
      openDesign,
      save,
      saveAs,
      exportModel,
      importStep,
      importKicad,
      reimportKicad,
      surfaceRuled,
      surfaceFill,
      surfaceStitch,
      surfaceOffset,
      addComponent,
      addJoint,
      fitView,
      startDrawing,
      startMeasure,
      toggleSection,
      scaleBody,
      insertCanvas,
      startCalibrate,
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
        else if (k === 'd') setSketchTool('dimension')
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
      if (!ctrl && (e.key === 's' || e.key === 'S')) {
        e.preventDefault()
        setPaletteOpen(true)
        return
      }
      if (e.key === 'Escape') {
        setPaletteOpen(false)
        setOp(null)
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
  }, [sketchSession, sketchConstruction, save, openDesign, newDesign, doUndo, doRedo, commands, hotkeys])

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
    return s
  }, [visOverride, meshes, sketches, datums])

  const onSketchChange = useCallback(() => {
    setSketchCount(vpApi.current?.getSketchEntities().length ?? 0)
    setSketchAvail(vpApi.current?.availableSketchConstraints() ?? [])
    setSketchConstraintCount(vpApi.current?.getSketchConstraints().length ?? 0)
    setSketchPendingCon(vpApi.current?.pendingSketchConstraint() ?? null)
  }, [])

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
    async (info: { mode: string; offset: number } | null) => {
      const tok = ++previewTok.current
      if (!info) {
        setPreviewPlane(null)
        return
      }
      const refs = selection.map(selectionToRef).filter(Boolean) as import('./rpc').GeomRef[]
      const base = refs[0] ?? null
      const target = info.mode === 'To object' ? refs[1] ?? null : null
      if (info.mode === 'To object' && !target) {
        setPreviewPlane(null)
        return
      }
      try {
        const r = await api.datumPlanePreview(base, info.offset, target)
        if (tok === previewTok.current) {
          setPreviewPlane({ origin: r.origin, x: r.x, y: r.y, size: r.size })
        }
      } catch {
        if (tok === previewTok.current) setPreviewPlane(null)
      }
    },
    [selection]
  )

  const onSketchDimensionRequest = useCallback(
    async (entityIndex: number, kind: 'linear' | 'radius') => {
      // stop an over-dimensioning attempt before the user even types a number
      const block = await (vpApi.current?.checkSketchDimension?.(entityIndex) ??
        Promise.resolve(null))
      if (block) {
        flashSketchNotice(block)
        return
      }
      const label = kind === 'radius' ? 'Radius' : 'Length'
      const txt = await promptText(`${label} (number or expression)`, '')
      if (!txt) return
      let value = Number(txt)
      if (isNaN(value)) {
        try {
          value = (await api.exprEval(txt, 'length')).value
        } catch (e) {
          window.alert((e as Error).message)
          return
        }
      }
      vpApi.current?.setSketchDimension(entityIndex, value)
      onSketchChange()
    },
    [onSketchChange, flashSketchNotice]
  )

  return (
    <div className="app">
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
          onImport: importStep
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
              await api.resetDocument()
              await api.saveAs(p)
              setDocPath(p)
              const id = `d${Date.now()}`
              setTabs((t) => [...t, { id, name: basename(p), dirty: false }])
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
                  if (!vpApi.current?.applySketchConstraint(t)) {
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
                    hiddenIds={hiddenIds}
                    selection={selection}
                    onSelect={onSelect}
                    section={section}
                    planePickMode={planePickMode}
                    pickPlanes={pickPlanes}
                    onPickPlane={(ref) => void beginSketch(ref)}
                    selectMode={selectMode}
                    selFilter={measureMode ? [...selFilter, 'vertex', 'face', 'edge'] : selFilter}
                    previewPlane={op === 'datumPlane' || datumGhostHold ? previewPlane : sectionGhost}
                    onPreviewHandleDrag={onPreviewHandleDrag}
                    onWindowSelect={(sels) =>
                      setSelection((cur) => {
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
                    sketchTool={sketchTool}
                    onSketchChange={onSketchChange}
                    onSketchDimensionRequest={(i, k) => void onSketchDimensionRequest(i, k)}
                    onSketchSolve={async (ents, cons) => {
                      try {
                        return await apiQuiet.sketchSolve(
                          ents as unknown[],
                          cons as unknown as SketchConstraint[]
                        )
                      } catch {
                        return null
                      }
                    }}
                    onSketchNotice={flashSketchNotice}
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
                    canvases={canvases}
                    visibility={visOverride}
                    selection={selection}
                    handlers={{
                      onToggleVisibility: toggleVisibility,
                      onToggleGroup: toggleGroup,
                      onRename: renameFeature,
                      onDelete: deleteFeature,
                      onEdit: (id) => void editSketch(id),
                      onEditDim: (id) => void editFeatureDim(id),
                      onSelect: (sel, add) => onSelect(sel, add),
                      onCalibrateCanvas: (id) => startCalibrate(id),
                      onDeleteCanvas: (id) => void api.canvasDelete(id).then(refreshMeshesOnly)
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
                      onPreview={onDatumPlanePreview}
                      onLivePreview={runLivePreview}
                      onLivePreviewEnd={endLivePreview}
                      handleDrag={planeHandleDrag}
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
                      onClose={() => setSection(null)}
                    />
                  )}
                  {paramsOpen && (
                    <ParametersPanel
                      onClose={() => setParamsOpen(false)}
                      onModelChanged={() => {
                        rollCacheRef.current.clear()
                        void refreshScene()
                      }}
                    />
                  )}
                  <Timeline
                    bodies={bodies}
                    handlers={{
                      onRollTo: rollTo,
                      onEdit: (id) => void editSketch(id),
                      onEditDim: (id) => void editFeatureDim(id),
                      onRename: renameFeature,
                      onDelete: deleteFeature,
                      onSuppress: (id, s) => void suppressFeature(id, s)
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
    </div>
  )
}
