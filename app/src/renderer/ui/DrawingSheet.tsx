import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import {
  api,
  apiQuiet,
  type AssemblyTree,
  type BomRow,
  type CleanupLine,
  type DimensionFormat,
  type DimensionType,
  type DrawingDimension,
  type DrawingNote,
  type DrawingView,
  type DrawingPageContents,
  type SnapTarget,
  type TableColumn,
  type TableTemplate
} from '../rpc'
import { basename } from '../util'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { promptText, promptForm } from './PromptDialog'
import { formatDimension, DEFAULT_DIM_FORMAT } from '../dimensionFormat'

interface Placed {
  view: DrawingView
  x: number // sheet mm, top-left of the view's bbox
  y: number
  scale: number
  /** how this view was created, so deleteView's undo can recreate an
   *  equivalent one - a plain view keeps its make_view args; section/
   *  detail/broken keep their own creation call, tolerant of the base
   *  view having since been deleted itself (recreate() just fails loudly
   *  in that case, same as the original create action would have). */
  recreate?: () => Promise<DrawingView>
}

// ISO A3 landscape sheet in mm
const SHEET_W = 420
const SHEET_H = 297
const MARGIN = 10

const flip = (poly: number[][]): [number, number][] => poly.map((p) => [p[0], -p[1]])

/** A jagged "break line" glyph across a view's bbox at the given axis/
 *  position, standard CAD convention for marking a broken-out section -
 *  purely visual (see DrawingView.breaks' comment for why). Returns SVG
 *  path point strings for the zigzag line, in the view's own local (y-up,
 *  pre-flip) coordinate space. */
function breakLinePoints(
  axis: 'x' | 'y',
  pos: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number
): [number, number][] {
  const zigzags = 5
  const amp = axis === 'x' ? (maxX - minX) * 0.02 : (maxY - minY) * 0.02
  const pts: [number, number][] = []
  if (axis === 'x') {
    const span = maxY - minY
    for (let i = 0; i <= zigzags; i++) {
      const y = minY + (span * i) / zigzags
      pts.push([pos + (i % 2 === 0 ? -amp : amp), y])
    }
  } else {
    const span = maxX - minX
    for (let i = 0; i <= zigzags; i++) {
      const x = minX + (span * i) / zigzags
      pts.push([x, pos + (i % 2 === 0 ? -amp : amp)])
    }
  }
  return pts
}

export type DrawingTool = 'select' | 'dimension' | 'note' | 'cleanup'

export interface DrawingSheetApi {
  addView: (dir: string) => Promise<void>
  autoLayout: () => Promise<void>
  setTool: (tool: DrawingTool) => void
  sectionTool: () => void
  detailTool: () => void
  brokenTool: () => void
  insertBom: () => Promise<void>
  insertTable: (template?: TableTemplate) => Promise<void>
  saveAsTemplate: () => Promise<void>
  loadSheetTemplate: () => Promise<void>
  exportPdf: () => Promise<void>
  exportDxf: () => Promise<void>
}

function ViewBox({
  placed,
  selected,
  hovered,
  tool,
  snapTargets,
  onDown,
  onContextMenu,
  onPick,
  onHover
}: {
  placed: Placed
  selected: boolean
  hovered: boolean
  tool: DrawingTool
  snapTargets: SnapTarget[]
  onDown: (e: React.PointerEvent) => void
  onContextMenu: (e: React.MouseEvent) => void
  onPick: (sub: string, p: [number, number]) => void
  onHover: (over: boolean) => void
}): JSX.Element {
  const { view } = placed
  const [minX, minY, maxX, maxY] = view.bbox
  const w = (maxX - minX) * placed.scale
  const h = (maxY - minY) * placed.scale
  const svgRef = useRef<SVGSVGElement>(null)

  const toData = (e: React.MouseEvent): [number, number] => {
    const svg = svgRef.current!
    const pt = svg.createSVGPoint()
    pt.x = e.clientX
    pt.y = e.clientY
    const p = pt.matrixTransform(svg.getScreenCTM()!.inverse())
    return [p.x, -p.y]
  }

  // distance from p to the segment a-b (not just its endpoints) - a click
  // naturally lands mid-edge, and edge endpoints alone can be 10+mm away
  // from a click dead-center on a long edge (confirmed live: a click on the
  // exact midpoint of a 20mm edge measured ~10mm from either endpoint,
  // always missing a tight endpoint-only threshold).
  const distToSegment = (p: [number, number], a: [number, number], b: [number, number]): number => {
    const abx = b[0] - a[0]
    const aby = b[1] - a[1]
    const lenSq = abx * abx + aby * aby
    if (lenSq === 0) return Math.hypot(p[0] - a[0], p[1] - a[1])
    let t = ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / lenSq
    t = Math.max(0, Math.min(1, t))
    const cx = a[0] + t * abx
    const cy = a[1] + t * aby
    return Math.hypot(p[0] - cx, p[1] - cy)
  }

  const nearestTarget = (p: [number, number]): SnapTarget | null => {
    let best: SnapTarget | null = null
    let bestD = Infinity
    for (const t of snapTargets) {
      const d = t.p
        ? Math.hypot(t.p[0] - p[0], t.p[1] - p[1])
        : t.p1 && t.p2
          ? distToSegment(p, t.p1, t.p2)
          : Infinity
      if (d < bestD) {
        bestD = d
        best = t
      }
    }
    return bestD < 4 / placed.scale ? best : null
  }

  // Selection/hover hit-testing and dimension/cleanup snap-picking used to
  // fight over the same click via CSS pointer-events routing (a stroke-only
  // rect so clicks could "fall through" to the nested view <svg> below) -
  // that made a view only draggable/hoverable along its exact border pixel,
  // and picking tools only work when the click also happened to land on
  // that border. Route both through ONE handler on a rect that always
  // covers the FULL bbox instead: decide in JS whether a click/hover is a
  // "pick a snap target" action (tool is dimension/cleanup) or a "grab the
  // view" action (tool is select), rather than relying on which DOM element
  // physically received the event.
  const [snapHover, setSnapHover] = useState<[number, number] | null>(null)

  const handlePointerDown = (e: React.PointerEvent): void => {
    if (tool === 'select') {
      onDown(e)
      return
    }
    if (tool === 'dimension' || tool === 'cleanup') {
      const p = toData(e)
      const target = nearestTarget(p)
      onPick(target?.sub ?? '', target ? (target.p ?? target.p1 ?? p) : p)
    }
  }

  // a picking tool (dimension/cleanup) with no visual cue for what's about
  // to be picked is indistinguishable from "the tool doesn't work" - show a
  // small highlighted ring at whatever snap target the cursor is nearest,
  // so a click's result is predictable instead of a silent miss.
  const handlePointerMoveForSnap = (e: React.PointerEvent): void => {
    if (tool !== 'dimension' && tool !== 'cleanup') {
      if (snapHover) setSnapHover(null)
      return
    }
    const p = toData(e)
    const target = nearestTarget(p)
    setSnapHover(target ? (target.p ?? target.p1 ?? null) : null)
  }

  return (
    <g
      data-view-box={placed.view.id}
      transform={`translate(${placed.x} ${placed.y})`}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => {
        onHover(false)
        setSnapHover(null)
      }}
    >
      <rect
        width={w}
        height={h}
        fill="#ffffff01"
        stroke={selected ? '#0696d7' : hovered ? '#0696d766' : '#00000022'}
        strokeWidth={selected || hovered ? 0.5 : 0.3}
        style={{ cursor: tool === 'select' ? 'move' : 'crosshair', pointerEvents: 'visiblePainted' }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMoveForSnap}
        onContextMenu={onContextMenu}
      />
      <svg
        ref={svgRef}
        x={0}
        y={0}
        width={w}
        height={h}
        viewBox={`${minX} ${-maxY} ${maxX - minX} ${maxY - minY}`}
        style={{ pointerEvents: 'none' }}
      >
        {view.hidden.map((poly, i) => (
          <polyline
            key={`h${i}`}
            points={flip(poly).map((p) => p.join(',')).join(' ')}
            fill="none"
            stroke="#999"
            strokeWidth={0.25}
            strokeDasharray="1.4 1"
          />
        ))}
        {view.visible.map((poly, i) => (
          <polyline
            key={`v${i}`}
            points={flip(poly).map((p) => p.join(',')).join(' ')}
            fill="none"
            stroke="#111"
            strokeWidth={0.45}
          />
        ))}
        {view.kind === 'broken' &&
          (view.breaks ?? []).map((b, i) => {
            const half = b.gap / 2
            const lineA = breakLinePoints(b.axis, b.position - half, minX, minY, maxX, maxY)
            const lineB = breakLinePoints(b.axis, b.position + half, minX, minY, maxX, maxY)
            return (
              <g key={`brk${i}`}>
                <polyline
                  points={flip(lineA).map((p) => p.join(',')).join(' ')}
                  fill="none"
                  stroke="#0696d7"
                  strokeWidth={0.4}
                />
                <polyline
                  points={flip(lineB).map((p) => p.join(',')).join(' ')}
                  fill="none"
                  stroke="#0696d7"
                  strokeWidth={0.4}
                />
              </g>
            )
          })}
        {snapHover && (
          <circle
            cx={snapHover[0]}
            cy={-snapHover[1]}
            r={1.6 / placed.scale}
            fill="none"
            stroke="#0696d7"
            strokeWidth={0.5 / placed.scale}
          />
        )}
      </svg>
      <text x={0} y={h + 4} fontSize={3.4} fill={hovered || selected ? '#0696d7' : '#333'}>
        {view.label} — {view.direction}
        {view.kind !== 'part' ? ` (${view.kind})` : ''}
      </text>
    </g>
  )
}

function viewsToDxf(placed: Placed[]): string {
  const seg: string[] = ['0', 'SECTION', '2', 'ENTITIES']
  for (const pl of placed) {
    for (const poly of pl.view.visible) {
      for (let i = 0; i + 1 < poly.length; i++) {
        seg.push(
          '0', 'LINE', '8', pl.view.label,
          '10', String(poly[i][0] + pl.x), '20', String(poly[i][1] - pl.y),
          '11', String(poly[i + 1][0] + pl.x), '21', String(poly[i + 1][1] - pl.y)
        )
      }
    }
  }
  seg.push('0', 'ENDSEC', '0', 'EOF')
  return seg.join('\n')
}

const RADIAL_TYPES: DimensionType[] = ['Radius', 'Diameter']

/**
 * Drawing sheet editor. Views/dimensions/notes/tables/cleanup-lines are all
 * backed by real TechDraw/Spreadsheet objects in the .FCStd (see
 * sidecar/gwtcad/drawing.py + tables.py) - this component is a thin,
 * optimistic-local-then-reconcile client over those RPCs, the same pattern
 * used for sketches and sections elsewhere in the app.
 */
export const DrawingSheet = forwardRef<
  DrawingSheetApi,
  {
    pageId: string
    makeView: (dir: string) => Promise<DrawingView | null>
    docPath: string | null
    assembly: AssemblyTree | null
    onBack: () => void
    tool?: DrawingTool
    onToolChange?: (tool: DrawingTool) => void
  }
>(function DrawingSheet({ pageId, makeView, docPath, assembly, onBack, tool: toolProp, onToolChange }, ref) {
  const [placed, setPlaced] = useState<Placed[]>([])
  const [sel, setSel] = useState<number | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const [dims, setDims] = useState<DrawingDimension[]>([])
  const [notes, setNotes] = useState<DrawingNote[]>([])
  const [selNote, setSelNote] = useState<string | null>(null)
  // rubber-band window-select: everything ELSE selected alongside sel/
  // selNote (which stay the "primary" selection - the one a context menu
  // or a single-item tool like Section View acts on). Delete and group-drag
  // act on sel/selNote UNION these sets, same two-tier pattern the main 3D
  // viewport doesn't need (it has no single-vs-primary distinction) but the
  // drawing sheet does, since several existing tools (sectionTool etc.)
  // already assume exactly one base view.
  const [selMultiViews, setSelMultiViews] = useState<Set<string>>(new Set())
  const [selMultiNotes, setSelMultiNotes] = useState<Set<string>>(new Set())
  const [band, setBand] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  // a band-drag's pointerup and the resulting synthetic click land on the
  // SAME target - without this, the click handler's "empty sheet click
  // deselects everything" logic would immediately undo the selection the
  // band drag just made, one event later in the same gesture.
  const justBandSelected = useRef(false)
  const groupDrag = useRef<{
    startX: number
    startY: number
    views: Map<string, { x: number; y: number }>
    notes: Map<string, { x: number; y: number }>
  } | null>(null)
  const noteDrag = useRef<{ id: string; ox: number; oy: number; origX: number; origY: number } | null>(null)
  const [cleanupLines, setCleanupLines] = useState<Record<string, CleanupLine[]>>({})
  const [snapTargets, setSnapTargets] = useState<Record<string, SnapTarget[]>>({})
  const [table, setTable] = useState<{
    id: string
    rows: Array<BomRow | Record<string, string | number>>
    columns: TableColumn[]
    showGrid: boolean
    gridColor: string
    rowHeight: number
  } | null>(null)
  const [editingCell, setEditingCell] = useState<{ row: number; col: number; value: string } | null>(null)
  // command-pattern undo/redo: each entry knows its own real inverse RPC
  // call, not just a local-state snapshot - a plain state snapshot would
  // leave orphaned server-side TechDraw objects behind (e.g. undoing
  // "add view" would need to actually delete the view object, not just
  // hide it from `placed`). App.tsx's global Ctrl+Z is scoped away from
  // this while a drawing is open (see the App.tsx wiring), so this stack
  // is the only thing driving undo/redo while editing a drawing.
  const undoStack = useRef<Array<{ undo: () => Promise<void>; redo: () => Promise<void> }>>([])
  const redoStack = useRef<Array<{ undo: () => Promise<void>; redo: () => Promise<void> }>>([])
  const pushUndo = useCallback((entry: { undo: () => Promise<void>; redo: () => Promise<void> }) => {
    undoStack.current.push(entry)
    if (undoStack.current.length > 100) undoStack.current.shift()
    redoStack.current = []
  }, [])
  const undoInFlight = useRef(false)
  const doDrawingUndo = useCallback(async () => {
    if (undoInFlight.current) return
    const entry = undoStack.current.pop()
    if (!entry) return
    undoInFlight.current = true
    try {
      await entry.undo()
      redoStack.current.push(entry)
    } catch (e) {
      window.alert((e as Error).message)
    } finally {
      undoInFlight.current = false
    }
  }, [])
  const doDrawingRedo = useCallback(async () => {
    if (undoInFlight.current) return
    const entry = redoStack.current.pop()
    if (!entry) return
    undoInFlight.current = true
    try {
      await entry.redo()
      undoStack.current.push(entry)
    } catch (e) {
      window.alert((e as Error).message)
    } finally {
      undoInFlight.current = false
    }
  }, [])
  // a brand-new page has NO title block - it's opt-in via "Load Template",
  // per the user's ask that a new drawing start genuinely blank rather than
  // always pre-filling a title block regardless of intent
  const [showTitleBlock, setShowTitleBlock] = useState(false)
  // sheet zoom/pan - a totally separate concept from a placed VIEW's own
  // `scale` field (that's how big a projection is drawn on the page; this
  // is how close the camera looking at the page is). viewBox = a sub-
  // rectangle of the fixed SHEET_W x SHEET_H page: zoom shrinks/grows that
  // rectangle around the cursor, pan translates it.
  const [viewBox, setViewBox] = useState({ x: 0, y: 0, w: SHEET_W, h: SHEET_H })
  const panRef = useRef<{ x: number; y: number; vbx: number; vby: number } | null>(null)
  const spaceHeld = useRef(false)
  // bumped only to force a re-render when spaceHeld's REF value changes (a
  // ref alone doesn't trigger one), purely so the pan cursor updates
  const [, setForceRerender] = useState(0)
  const [toolState, setToolState] = useState<DrawingTool>('select')
  const tool = toolProp ?? toolState
  const setTool = useCallback(
    (t: DrawingTool) => {
      onToolChange?.(t)
      setToolState(t)
    },
    [onToolChange]
  )
  const [dimPending, setDimPending] = useState<{
    viewId: string
    sub: string
    p: [number, number]
  } | null>(null)
  const [dimLabelPos, setDimLabelPos] = useState<Record<string, [number, number]>>({})
  const [menu, setMenu] = useState<{ x: number; y: number; viewId: string } | null>(null)
  const [dimMenu, setDimMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [dimFormats, setDimFormats] = useState<{
    default: DimensionFormat
    overrides: Record<string, DimensionFormat>
  }>({ default: {}, overrides: {} })
  const sheetRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ i: number; ox: number; oy: number } | null>(null)

  const name = docPath ? basename(docPath).replace(/\.FCStd$/i, '') : 'Untitled'
  const today = useMemo(() => new Date().toISOString().slice(0, 10), [])

  // pull snap targets for a view once it's placed, so dimension/cleanup
  // clicks can resolve to real edge/vertex/cleanup-line refs
  const refreshSnapTargets = useCallback(async (viewId: string) => {
    try {
      const { targets } = await apiQuiet.drawingSnapTargets(viewId)
      setSnapTargets((cur) => ({ ...cur, [viewId]: targets }))
    } catch {
      /* ignore */
    }
  }, [])

  const refreshDimFormats = useCallback(async () => {
    try {
      setDimFormats(await apiQuiet.drawingGetDimensionFormats())
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    void refreshDimFormats()
  }, [refreshDimFormats])

  // rehydrate from whatever is already on this page - reopening a drawing
  // (Browser "Drawings" double-click, or just switching back into an
  // already-open one) must not start blank: the views/dimensions/notes/
  // table/cleanup-lines are all real objects already living in the .FCStd,
  // drawing.pageContents just re-derives the same payload shapes the
  // individual add* RPCs return.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const c: DrawingPageContents = await apiQuiet.drawingPageContents(pageId)
        if (cancelled) return
        const specs: [string, number, number][] = [
          ['front', 40, 60],
          ['right', 200, 60],
          ['top', 40, 170],
          ['iso', 220, 170]
        ]
        setPlaced(
          c.views.map((v, i) => {
            const [minX, minY, maxX, maxY] = v.bbox
            const fit = Math.min(120 / Math.max(maxX - minX, 1), 90 / Math.max(maxY - minY, 1), 2)
            const [, x, y] = specs[i % specs.length]
            return { view: v, x: x - 24 + (i * 12) % 60, y: y - 40 + (i * 12) % 60, scale: fit }
          })
        )
        setDims(c.dimensions)
        setNotes(c.notes)
        setCleanupLines(c.cleanupLines)
        if (c.tables[0]) {
          setTable({
            id: c.tables[0].id,
            rows: c.tables[0].rows,
            columns: c.tables[0].columns,
            showGrid: true,
            gridColor: '#111',
            rowHeight: 5
          })
        }
        for (const v of c.views) void refreshSnapTargets(v.id)
      } catch {
        /* a brand-new page has nothing to rehydrate - blank sheet is correct */
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId])

  const addView = useCallback(
    async (dir: string): Promise<void> => {
      const v = await makeView(dir)
      if (!v) return
      const [minX, minY, maxX, maxY] = v.bbox
      const fit = Math.min(120 / Math.max(maxX - minX, 1), 90 / Math.max(maxY - minY, 1), 2)
      const x = MARGIN + 6 + placed.length * 12
      const y = MARGIN + 20 + placed.length * 12
      const recreate = async (): Promise<DrawingView> => {
        const v2 = await makeView(dir)
        if (!v2) throw new Error('could not recreate this view')
        return v2
      }
      setPlaced((cur) => [...cur, { view: v, x, y, scale: fit, recreate }])
      void refreshSnapTargets(v.id)
      pushUndo({
        undo: async () => {
          await api.drawingRemoveView(v.id)
          setPlaced((cur) => cur.filter((pl) => pl.view.id !== v.id))
        },
        redo: async () => {
          const v2 = await makeView(dir)
          if (!v2) return
          setPlaced((cur) => [...cur, { view: v2, x, y, scale: fit }])
          void refreshSnapTargets(v2.id)
        }
      })
    },
    [makeView, refreshSnapTargets, placed, pushUndo]
  )

  const autoLayout = useCallback(async (): Promise<void> => {
    setPlaced([])
    const specs: [string, number, number][] = [
      ['front', 40, 60],
      ['right', 200, 60],
      ['top', 40, 170],
      ['iso', 220, 170]
    ]
    for (const [dir, x, y] of specs) {
      const v = await makeView(dir)
      if (!v) continue
      const [minX, minY, maxX, maxY] = v.bbox
      const fit = Math.min(120 / Math.max(maxX - minX, 1), 90 / Math.max(maxY - minY, 1), 2)
      setPlaced((cur) => [...cur, { view: v, x, y, scale: fit }])
      void refreshSnapTargets(v.id)
    }
  }, [makeView, refreshSnapTargets])

  const loadSheetTemplate = useCallback(async (): Promise<void> => {
    try {
      const { templates } = await api.drawingListSheetTemplates()
      const res = await promptForm('Load Template', [
        {
          key: 'name',
          label: 'Template',
          value: templates[0]?.name ?? 'Blank',
          options: templates.map((t) => t.name)
        }
      ])
      if (!res) return
      const tpl = await api.drawingApplySheetTemplate(res.name)
      setShowTitleBlock(tpl.titleBlock)
      const specs: [string, number, number][] = [
        ['front', 40, 60],
        ['right', 200, 60],
        ['top', 40, 170],
        ['iso', 220, 170]
      ]
      for (let i = 0; i < tpl.views.length; i++) {
        const dir = tpl.views[i]
        const [, x, y] = specs[i % specs.length]
        const v = await makeView(dir)
        if (!v) continue
        const [minX, minY, maxX, maxY] = v.bbox
        const fit = Math.min(120 / Math.max(maxX - minX, 1), 90 / Math.max(maxY - minY, 1), 2)
        setPlaced((cur) => [...cur, { view: v, x, y, scale: fit }])
        void refreshSnapTargets(v.id)
      }
    } catch (e) {
      window.alert((e as Error).message)
    }
  }, [makeView, refreshSnapTargets])

  // wheel-to-zoom, centred on the cursor: convert the pointer's CLIENT
  // position to sheet-space BEFORE resizing viewBox, then re-anchor so that
  // same sheet point stays under the cursor after the resize (standard
  // "zoom toward cursor" math for an SVG viewBox).
  const onWheel = (e: React.WheelEvent<SVGSVGElement>): void => {
    e.preventDefault()
    const svg = e.currentTarget
    const pt = svg.createSVGPoint()
    pt.x = e.clientX
    pt.y = e.clientY
    const before = pt.matrixTransform(svg.getScreenCTM()!.inverse())
    const factor = e.deltaY > 0 ? 1.12 : 1 / 1.12
    setViewBox((vb) => {
      const w = Math.min(Math.max(vb.w * factor, 20), SHEET_W * 4)
      const h = w * (vb.h / vb.w)
      const x = before.x - ((before.x - vb.x) / vb.w) * w
      const y = before.y - ((before.y - vb.y) / vb.h) * h
      return { x, y, w, h }
    })
  }

  const zoomFit = useCallback((): void => setViewBox({ x: 0, y: 0, w: SHEET_W, h: SHEET_H }), [])
  const zoomBy = useCallback((factor: number): void => {
    setViewBox((vb) => {
      const w = Math.min(Math.max(vb.w * factor, 20), SHEET_W * 4)
      const h = w * (vb.h / vb.w)
      const cx = vb.x + vb.w / 2
      const cy = vb.y + vb.h / 2
      return { x: cx - w / 2, y: cy - h / 2, w, h }
    })
  }, [])

  const onPointerMove = (e: React.PointerEvent): void => {
    if (panRef.current && sheetRef.current) {
      const { x, y, vbx, vby } = panRef.current
      const svg = sheetRef.current.querySelector('svg') as SVGSVGElement
      const scaleX = viewBox.w / svg.clientWidth
      const scaleY = viewBox.h / svg.clientHeight
      setViewBox((vb) => ({ ...vb, x: vbx - (e.clientX - x) * scaleX, y: vby - (e.clientY - y) * scaleY }))
      return
    }
    if (band && sheetRef.current) {
      const svg = sheetRef.current.querySelector('svg') as SVGSVGElement
      const pt = svg.createSVGPoint()
      pt.x = e.clientX
      pt.y = e.clientY
      const p = pt.matrixTransform(svg.getScreenCTM()!.inverse())
      setBand((b) => (b ? { ...b, x1: p.x, y1: p.y } : b))
      return
    }
    if (groupDrag.current && sheetRef.current) {
      const svg = sheetRef.current.querySelector('svg') as SVGSVGElement
      const pt = svg.createSVGPoint()
      pt.x = e.clientX
      pt.y = e.clientY
      const p = pt.matrixTransform(svg.getScreenCTM()!.inverse())
      const { startX, startY, views, notes: notesStart } = groupDrag.current
      const dx = p.x - startX
      const dy = p.y - startY
      setPlaced((cur) =>
        cur.map((pl) => {
          const orig = views.get(pl.view.id)
          return orig ? { ...pl, x: orig.x + dx, y: orig.y + dy } : pl
        })
      )
      setNotes((cur) =>
        cur.map((n) => {
          const orig = notesStart.get(n.id)
          return orig ? { ...n, x: orig.x + dx, y: orig.y + dy } : n
        })
      )
      return
    }
    if (noteDrag.current && sheetRef.current) {
      const svg = sheetRef.current.querySelector('svg') as SVGSVGElement
      const pt = svg.createSVGPoint()
      pt.x = e.clientX
      pt.y = e.clientY
      const p = pt.matrixTransform(svg.getScreenCTM()!.inverse())
      const { id, ox, oy } = noteDrag.current
      const x = p.x - ox
      const y = p.y - oy
      setNotes((cur) => cur.map((n) => (n.id === id ? { ...n, x, y } : n)))
      return
    }
    if (!drag.current || !sheetRef.current) return
    const svg = sheetRef.current.querySelector('svg') as SVGSVGElement
    const pt = svg.createSVGPoint()
    pt.x = e.clientX
    pt.y = e.clientY
    const p = pt.matrixTransform(svg.getScreenCTM()!.inverse())
    const { i, ox, oy } = drag.current
    setPlaced((cur) => cur.map((pl, k) => (k === i ? { ...pl, x: p.x - ox, y: p.y - oy } : pl)))
  }

  const exportPdf = useCallback(async (): Promise<void> => {
    const p = await window.cad.saveDialog(docPath ? docPath.replace(/\.FCStd$/i, '.pdf') : undefined)
    if (!p || !sheetRef.current) return
    const html = `<!doctype html><meta charset="utf-8"><style>
      html,body{margin:0;background:#fff}svg{width:100%;height:auto}
      polyline{vector-effect:non-scaling-stroke}</style>${sheetRef.current.innerHTML}`
    await window.cad.exportPdf(html, p)
  }, [docPath])

  const exportDxf = useCallback(async (): Promise<void> => {
    const p = await window.cad.saveDialog(docPath ? docPath.replace(/\.FCStd$/i, '.dxf') : undefined)
    if (!p) return
    await window.cad.writeText(viewsToDxf(placed), p)
  }, [docPath, placed])

  const addDimension = useCallback(
    async (
      viewId: string,
      refs: Array<{ sub: string }>,
      kind: DimensionType = 'Distance',
      labelPos?: [number, number]
    ) => {
      try {
        const d = await api.drawingAddDimension(pageId, viewId, refs, kind)
        setDims((cur) => [...cur, d])
        if (labelPos) setDimLabelPos((cur) => ({ ...cur, [d.id]: labelPos }))
        pushUndo({
          undo: async () => {
            await api.drawingRemoveDimension(d.id)
            setDims((cur) => cur.filter((x) => x.id !== d.id))
          },
          redo: async () => {
            const d2 = await api.drawingAddDimension(pageId, viewId, refs, kind)
            setDims((cur) => [...cur, d2])
            if (labelPos) setDimLabelPos((cur) => ({ ...cur, [d2.id]: labelPos }))
          }
        })
      } catch (e) {
        window.alert((e as Error).message)
      }
    },
    [pageId, pushUndo]
  )

  const onViewPick = useCallback(
    (viewId: string) =>
      (sub: string, p: [number, number]) => {
        if (!sub) return
        if (tool === 'dimension') {
          if (!dimPending) {
            setDimPending({ viewId, sub, p })
          } else if (dimPending.viewId === viewId) {
            const mid: [number, number] = [(dimPending.p[0] + p[0]) / 2, (dimPending.p[1] + p[1]) / 2]
            void addDimension(viewId, [{ sub: dimPending.sub }, { sub }], 'Distance', mid)
            setDimPending(null)
          } else {
            setDimPending({ viewId, sub, p })
          }
        }
        // cleanup-line placement is handled via ViewBox's own two-click
        // sequence below (see cleanupPending)
      },
    [tool, dimPending, addDimension]
  )

  const [cleanupPending, setCleanupPending] = useState<{ viewId: string; p: [number, number] } | null>(null)

  const onViewPickPoint = useCallback(
    (viewId: string) =>
      (sub: string, p: [number, number]) => {
        if (tool === 'cleanup') {
          if (!cleanupPending) {
            setCleanupPending({ viewId, p })
          } else if (cleanupPending.viewId === viewId) {
            void api
              .drawingAddCleanupLine(viewId, cleanupPending.p, p)
              .then((cl) => {
                setCleanupLines((cur) => ({ ...cur, [viewId]: [...(cur[viewId] ?? []), cl] }))
                pushUndo({
                  undo: async () => {
                    await api.drawingRemoveCleanupLine(viewId, cl.id)
                    setCleanupLines((cur) => ({ ...cur, [viewId]: (cur[viewId] ?? []).filter((x) => x.id !== cl.id) }))
                  },
                  redo: async () => {
                    const cl2 = await api.drawingAddCleanupLine(viewId, cl.p1, cl.p2)
                    setCleanupLines((cur) => ({ ...cur, [viewId]: [...(cur[viewId] ?? []), cl2] }))
                  }
                })
              })
              .catch((e: Error) => window.alert(e.message))
            setCleanupPending(null)
          } else {
            setCleanupPending({ viewId, p })
          }
          return
        }
        onViewPick(viewId)(sub, p)
      },
    [tool, cleanupPending, onViewPick, pushUndo]
  )

  const sectionTool = useCallback(async () => {
    if (sel === null) {
      window.alert('Select a view first, then choose Section View.')
      return
    }
    const base = placed[sel]
    // a cut plane whose normal is parallel to the view's own line of sight
    // shows no new geometry (rejected server-side) - default to a plane
    // that's always safe for this view's direction instead of a fixed "XY"
    // (which is degenerate for a top/bottom view, whose direction IS Z).
    const safePlane = base.view.direction === 'top' || base.view.direction === 'bottom' ? 'XZ' : 'XY'
    const res = await promptForm('Section View', [
      { key: 'plane', label: 'Cut plane (XY / XZ / YZ)', value: safePlane },
      { key: 'offset', label: 'Offset (mm)', value: '0' }
    ])
    if (!res) return
    const plane = (res.plane.toUpperCase() as 'XY' | 'XZ' | 'YZ') || 'XY'
    const offset = Number(res.offset) || 0
    try {
      const v = await api.drawingAddSectionView(pageId, base.view.id, plane, offset)
      const x = base.x + 60
      const y = base.y
      const recreate = (): Promise<DrawingView> => api.drawingAddSectionView(pageId, base.view.id, plane, offset)
      setPlaced((cur) => [...cur, { view: v, x, y, scale: base.scale, recreate }])
      void refreshSnapTargets(v.id)
      pushUndo({
        undo: async () => {
          await api.drawingRemoveView(v.id)
          setPlaced((cur) => cur.filter((pl) => pl.view.id !== v.id))
        },
        redo: async () => {
          const v2 = await api.drawingAddSectionView(pageId, base.view.id, plane, offset)
          setPlaced((cur) => [...cur, { view: v2, x, y, scale: base.scale }])
          void refreshSnapTargets(v2.id)
        }
      })
    } catch (e) {
      window.alert((e as Error).message)
    }
  }, [sel, placed, pageId, refreshSnapTargets, pushUndo])

  const detailTool = useCallback(async () => {
    if (sel === null) {
      window.alert('Select a view first, then choose Detail View.')
      return
    }
    const base = placed[sel]
    const res = await promptForm('Detail View', [
      { key: 'x', label: 'Anchor X (mm)', value: '0' },
      { key: 'y', label: 'Anchor Y (mm)', value: '0' },
      { key: 'radius', label: 'Circle radius (mm)', value: '5' }
    ])
    if (!res) return
    const ax = Number(res.x) || 0
    const ay = Number(res.y) || 0
    const radius = Number(res.radius) || 5
    try {
      const v = await api.drawingAddDetailView(pageId, base.view.id, ax, ay, radius)
      const x = base.x + 60
      const y = base.y
      const scale = Math.max(base.scale, 0.5)
      const recreate = (): Promise<DrawingView> => api.drawingAddDetailView(pageId, base.view.id, ax, ay, radius)
      setPlaced((cur) => [...cur, { view: v, x, y, scale, recreate }])
      void refreshSnapTargets(v.id)
      pushUndo({
        undo: async () => {
          await api.drawingRemoveView(v.id)
          setPlaced((cur) => cur.filter((pl) => pl.view.id !== v.id))
        },
        redo: async () => {
          const v2 = await api.drawingAddDetailView(pageId, base.view.id, ax, ay, radius)
          setPlaced((cur) => [...cur, { view: v2, x, y, scale }])
          void refreshSnapTargets(v2.id)
        }
      })
    } catch (e) {
      window.alert((e as Error).message)
    }
  }, [sel, placed, pageId, refreshSnapTargets, pushUndo])

  const brokenTool = useCallback(async () => {
    if (sel === null) {
      window.alert('Select a view first, then choose Broken View.')
      return
    }
    const base = placed[sel]
    const res = await promptForm('Broken View', [
      { key: 'axis', label: 'Break axis (x / y)', value: 'x' },
      { key: 'pos', label: 'Break position (mm)', value: '0' },
      { key: 'gap', label: 'Gap (mm)', value: '10' }
    ])
    if (!res) return
    const breaks = [{ axis: (res.axis as 'x' | 'y') || 'x', pos: Number(res.pos) || 0, gap: Number(res.gap) || 10 }]
    try {
      const v = await api.drawingAddBrokenView(pageId, base.view.id, breaks)
      const x = base.x
      const y = base.y + 80
      const recreate = (): Promise<DrawingView> => api.drawingAddBrokenView(pageId, base.view.id, breaks)
      setPlaced((cur) => [...cur, { view: v, x, y, scale: base.scale, recreate }])
      void refreshSnapTargets(v.id)
      pushUndo({
        undo: async () => {
          await api.drawingRemoveView(v.id)
          setPlaced((cur) => cur.filter((pl) => pl.view.id !== v.id))
        },
        redo: async () => {
          const v2 = await api.drawingAddBrokenView(pageId, base.view.id, breaks)
          setPlaced((cur) => [...cur, { view: v2, x, y, scale: base.scale }])
          void refreshSnapTargets(v2.id)
        }
      })
    } catch (e) {
      window.alert((e as Error).message)
    }
  }, [sel, placed, pageId, refreshSnapTargets, pushUndo])

  const convertView = useCallback(
    async (viewId: string, toKind: 'part' | 'section') => {
      try {
        const v = await api.drawingConvertView(pageId, viewId, toKind)
        setPlaced((cur) => cur.map((pl) => (pl.view.id === viewId ? { ...pl, view: v } : pl)))
        void refreshSnapTargets(v.id)
        if (v.orphanedDimensions?.length) {
          window.alert(
            `${v.orphanedDimensions.length} dimension(s) referenced the old view and may need to be redrawn.`
          )
        }
      } catch (e) {
        window.alert((e as Error).message)
      }
    },
    [pageId, refreshSnapTargets]
  )

  const deleteView = useCallback(
    async (viewId: string) => {
      const doomed = placed.find((pl) => pl.view.id === viewId)
      // Cleanup lines have simple p1/p2 snapshots and can be faithfully
      // re-added to a recreated view. Dimensions cannot: their refs are raw
      // edge/vertex names ("Edge3") resolved against the ORIGINAL view
      // object, which a delete-then-recreate replaces with a new one whose
      // geometry may not even enumerate edges in the same order - same
      // "orphaned, may need to be redrawn" limitation convertView already
      // has to live with (see its own orphanedDimensions handling below).
      const removedCleanup = cleanupLines[viewId] ?? []
      const removedDimCount = dims.filter((d) => d.viewId === viewId).length
      try {
        const res = await api.drawingRemoveView(viewId)
        setPlaced((cur) => cur.filter((pl) => pl.view.id !== viewId))
        setDims((cur) => cur.filter((d) => !res.removedDimensions.includes(d.id)))
        setCleanupLines((cur) => {
          const next = { ...cur }
          delete next[viewId]
          return next
        })
        setSel(null)
        setHover(null)
        if (doomed?.recreate) {
          const { recreate, x, y, scale } = doomed
          // tracks whichever id this view CURRENTLY has, across however
          // many undo/redo cycles happen - redo needs the id undo's own
          // recreate() call just produced, not the original (now-deleted)
          // viewId this whole action closed over.
          const liveId = { current: viewId }
          pushUndo({
            undo: async () => {
              const v2 = await recreate()
              liveId.current = v2.id
              setPlaced((cur) => [...cur, { view: v2, x, y, scale, recreate }])
              void refreshSnapTargets(v2.id)
              for (const cl of removedCleanup) {
                const cl2 = await api.drawingAddCleanupLine(v2.id, cl.p1, cl.p2)
                setCleanupLines((cur) => ({ ...cur, [v2.id]: [...(cur[v2.id] ?? []), cl2] }))
              }
              if (removedDimCount > 0) {
                window.alert(
                  `The view is back, but ${removedDimCount} dimension(s) on it could not be restored and will need to be redrawn.`
                )
              }
            },
            redo: async () => {
              await api.drawingRemoveView(liveId.current)
              setPlaced((cur) => cur.filter((pl) => pl.view.id !== liveId.current))
              setCleanupLines((cur) => {
                const next = { ...cur }
                delete next[liveId.current]
                return next
              })
            }
          })
        }
      } catch (e) {
        window.alert((e as Error).message)
      }
    },
    [placed, dims, cleanupLines, refreshSnapTargets, pushUndo]
  )

  const deleteNote = useCallback(
    async (noteId: string) => {
      const doomed = notes.find((n) => n.id === noteId)
      try {
        await api.drawingRemoveNote(noteId)
        setNotes((cur) => cur.filter((n) => n.id !== noteId))
        setSelNote((cur) => (cur === noteId ? null : cur))
        if (doomed) {
          const liveId = { current: noteId }
          pushUndo({
            undo: async () => {
              const n2 = await api.drawingAddNote(pageId, doomed.text, doomed.x, doomed.y, undefined, undefined, doomed.font, doomed.textSize)
              liveId.current = n2.id
              setNotes((cur) => [...cur, n2])
            },
            redo: async () => {
              await api.drawingRemoveNote(liveId.current)
              setNotes((cur) => cur.filter((n) => n.id !== liveId.current))
            }
          })
        }
      } catch (e) {
        window.alert((e as Error).message)
      }
    },
    [notes, pageId, pushUndo]
  )

  // Delete/Backspace removes whichever view(s)/note(s) are currently
  // selected - the single primary selection AND anything from a rubber-
  // band multi-select, together - skip while typing in any input (the
  // note text editor, a promptForm field, etc.) so Backspace there edits
  // text, not deletes.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      const viewIds = new Set(selMultiViews)
      if (sel !== null && placed[sel]) viewIds.add(placed[sel].view.id)
      const noteIds = new Set(selMultiNotes)
      if (selNote) noteIds.add(selNote)
      if (viewIds.size === 0 && noteIds.size === 0) return
      e.preventDefault()
      for (const id of viewIds) void deleteView(id)
      for (const id of noteIds) void deleteNote(id)
      setSelMultiViews(new Set())
      setSelMultiNotes(new Set())
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [sel, placed, selNote, selMultiViews, selMultiNotes, deleteView, deleteNote])

  // Ctrl+Z/Ctrl+Y (or Cmd on macOS) undo/redo drawing edits while a drawing
  // is open. App.tsx's own global Ctrl+Z is scoped away from this case (see
  // its wiring) specifically so the two don't fight over the same keys -
  // this is the ONLY handler for them while editing a drawing.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const ctrl = e.ctrlKey || e.metaKey
      if (!ctrl) return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      if (e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault()
        void doDrawingUndo()
      } else if (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey)) {
        e.preventDefault()
        void doDrawingRedo()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [doDrawingUndo, doDrawingRedo])

  // space+drag pans the sheet (checked live via the ref in onPointerDown,
  // not React state, so it never lags a frame behind the actual key state)
  useEffect(() => {
    const down = (e: KeyboardEvent): void => {
      if (e.code === 'Space' && !spaceHeld.current) {
        const target = e.target as HTMLElement | null
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
        spaceHeld.current = true
        setForceRerender((n) => n + 1)
      }
    }
    const up = (e: KeyboardEvent): void => {
      if (e.code === 'Space') {
        spaceHeld.current = false
        setForceRerender((n) => n + 1)
      }
    }
    document.addEventListener('keydown', down)
    document.addEventListener('keyup', up)
    return () => {
      document.removeEventListener('keydown', down)
      document.removeEventListener('keyup', up)
    }
  }, [])

  const insertBom = useCallback(
    async (template?: TableTemplate) => {
      const previous = table
      try {
        const { rows } = await api.drawingBomRows(assembly?.assembly ?? undefined)
        if (rows.length === 0) {
          window.alert('Nothing to list yet - add a body or component to the model first.')
          return
        }
        const t = await api.drawingMakeTable(
          pageId,
          rows,
          template?.spec.columns,
          template?.spec,
          table?.id
        )
        const next = {
          id: t.id,
          rows: t.rows,
          columns: t.columns,
          showGrid: template?.spec.showGrid ?? true,
          gridColor: template?.spec.gridColor ?? '#111',
          rowHeight: template?.spec.rowHeight ?? 5
        }
        setTable(next)
        pushUndo(
          previous
            ? {
                undo: async () => {
                  await api.drawingMakeTable(pageId, previous.rows, previous.columns, undefined, previous.id)
                  setTable(previous)
                },
                redo: async () => {
                  await api.drawingMakeTable(pageId, next.rows, next.columns, undefined, next.id)
                  setTable(next)
                }
              }
            : {
                undo: async () => {
                  await api.drawingRemoveTable(t.id)
                  setTable(null)
                },
                redo: async () => {
                  const t2 = await api.drawingMakeTable(pageId, rows, template?.spec.columns, template?.spec, t.id)
                  setTable({ ...next, id: t2.id, rows: t2.rows, columns: t2.columns })
                }
              }
        )
      } catch (e) {
        window.alert((e as Error).message)
      }
    },
    [assembly, pageId, table, pushUndo]
  )

  // A plain table is NOT a BOM - it should start genuinely blank (the user's
  // own row/column count, empty cells to fill in themselves), not silently
  // reuse the BOM's auto-populated part list. Only "Insert BOM" auto-fills
  // from the model.
  const insertTable = useCallback(
    async (template?: TableTemplate) => {
      const res = await promptForm('Insert Table', [
        { key: 'rows', label: 'Rows', value: '3' },
        { key: 'cols', label: 'Columns', value: String(template?.spec.columns?.length ?? 3) }
      ])
      if (!res) return
      const nRows = Math.max(1, Number(res.rows) || 3)
      const nCols = Math.max(1, Number(res.cols) || 3)
      const columns =
        template?.spec.columns ??
        Array.from({ length: nCols }, (_, i) => ({
          key: `col${i}`,
          header: `Column ${i + 1}`,
          source: `col${i}`
        }))
      const rows = Array.from({ length: nRows }, (_, r) => {
        const row: Record<string, string | number> = { index: r + 1 }
        for (const c of columns) row[c.source] = ''
        return row
      })
      const previous = table
      try {
        const t = await api.drawingMakeTable(pageId, rows, columns, template?.spec, table?.id)
        const next = {
          id: t.id,
          rows: t.rows,
          columns: t.columns,
          showGrid: template?.spec.showGrid ?? true,
          gridColor: template?.spec.gridColor ?? '#111',
          rowHeight: template?.spec.rowHeight ?? 5
        }
        setTable(next)
        pushUndo(
          previous
            ? {
                undo: async () => {
                  await api.drawingMakeTable(pageId, previous.rows, previous.columns, undefined, previous.id)
                  setTable(previous)
                },
                redo: async () => {
                  await api.drawingMakeTable(pageId, next.rows, next.columns, undefined, next.id)
                  setTable(next)
                }
              }
            : {
                undo: async () => {
                  await api.drawingRemoveTable(t.id)
                  setTable(null)
                },
                redo: async () => {
                  const t2 = await api.drawingMakeTable(pageId, rows, columns, template?.spec, t.id)
                  setTable({ ...next, id: t2.id, rows: t2.rows, columns: t2.columns })
                }
              }
        )
      } catch (e) {
        window.alert((e as Error).message)
      }
    },
    [pageId, table, pushUndo]
  )

  const saveAsTemplate = useCallback(async () => {
    if (!table) {
      window.alert('Insert a table first, then save it as a template.')
      return
    }
    const name2 = await promptText('Template name', '')
    if (!name2 || !name2.trim()) return
    try {
      await api.drawingSaveTableTemplate(name2.trim(), {
        columns: table.columns,
        showGrid: table.showGrid,
        gridColor: table.gridColor,
        rowHeight: table.rowHeight
      })
    } catch (e) {
      window.alert((e as Error).message)
    }
  }, [table])

  const setTableCell = useCallback(
    async (rowIdx: number, source: string, value: string) => {
      if (!table) return
      const oldValue = String((table.rows[rowIdx] as unknown as Record<string, unknown>)?.[source] ?? '')
      const rows = table.rows.map((row, i) => (i === rowIdx ? { ...row, [source]: value } : row))
      const tableId = table.id
      const columns = table.columns
      setTable((cur) => (cur ? { ...cur, rows } : cur))
      try {
        const t = await api.drawingMakeTable(pageId, rows, columns, undefined, tableId)
        setTable((cur) => (cur ? { ...cur, rows: t.rows } : cur))
        if (String(oldValue) !== value) {
          pushUndo({
            undo: async () => {
              const revertRows = rows.map((row, i) => (i === rowIdx ? { ...row, [source]: oldValue } : row))
              const t2 = await api.drawingMakeTable(pageId, revertRows, columns, undefined, tableId)
              setTable((cur) => (cur ? { ...cur, rows: t2.rows } : cur))
            },
            redo: async () => {
              const t2 = await api.drawingMakeTable(pageId, rows, columns, undefined, tableId)
              setTable((cur) => (cur ? { ...cur, rows: t2.rows } : cur))
            }
          })
        }
      } catch (e) {
        window.alert((e as Error).message)
      }
    },
    [table, pageId, pushUndo]
  )

  const setTableGridStyle = useCallback((style: Partial<{ showGrid: boolean; gridColor: string; rowHeight: number }>) => {
    setTable((cur) => (cur ? { ...cur, ...style } : cur))
  }, [])

  const addNote = useCallback(
    async (viewId: string | null, p: [number, number]) => {
      const text = await promptText('Note text', '')
      if (!text || !text.trim()) return
      try {
        const n = await api.drawingAddNote(
          pageId,
          text.trim(),
          p[0],
          p[1],
          viewId ?? undefined,
          viewId ? p : undefined
        )
        setNotes((cur) => [...cur, n])
        const liveId = { current: n.id }
        pushUndo({
          undo: async () => {
            await api.drawingRemoveNote(liveId.current)
            setNotes((cur) => cur.filter((x) => x.id !== liveId.current))
          },
          redo: async () => {
            const n2 = await api.drawingAddNote(pageId, n.text, n.x, n.y, viewId ?? undefined, viewId ? p : undefined, n.font, n.textSize)
            liveId.current = n2.id
            setNotes((cur) => [...cur, n2])
          }
        })
      } catch (e) {
        window.alert((e as Error).message)
      }
    },
    [pageId, pushUndo]
  )

  const editNoteText = useCallback(async (noteId: string) => {
    const current = notes.find((n) => n.id === noteId)
    if (!current) return
    const oldText = current.text
    const text = await promptText('Note text', current.text)
    if (text === null || text === undefined) return
    try {
      const n = await api.drawingSetNoteText(noteId, text)
      setNotes((cur) => cur.map((x) => (x.id === noteId ? { ...x, ...n } : x)))
      if (text !== oldText) {
        pushUndo({
          undo: async () => {
            const n2 = await api.drawingSetNoteText(noteId, oldText)
            setNotes((cur) => cur.map((x) => (x.id === noteId ? { ...x, ...n2 } : x)))
          },
          redo: async () => {
            const n2 = await api.drawingSetNoteText(noteId, text)
            setNotes((cur) => cur.map((x) => (x.id === noteId ? { ...x, ...n2 } : x)))
          }
        })
      }
    } catch (e) {
      window.alert((e as Error).message)
    }
  }, [notes, pushUndo])

  const moveNote = useCallback(
    async (noteId: string, x: number, y: number, from?: { x: number; y: number }) => {
      // optimistic local move so dragging feels instant; reconciled by the
      // RPC response (same pattern as everywhere else in this file)
      setNotes((cur) => cur.map((n) => (n.id === noteId ? { ...n, x, y } : n)))
      try {
        const n = await api.drawingMoveNote(noteId, x, y)
        setNotes((cur) => cur.map((x2) => (x2.id === noteId ? { ...x2, ...n } : x2)))
        if (from && (from.x !== x || from.y !== y)) {
          pushUndo({
            undo: async () => {
              await api.drawingMoveNote(noteId, from.x, from.y)
              setNotes((cur) => cur.map((n2) => (n2.id === noteId ? { ...n2, x: from.x, y: from.y } : n2)))
            },
            redo: async () => {
              await api.drawingMoveNote(noteId, x, y)
              setNotes((cur) => cur.map((n2) => (n2.id === noteId ? { ...n2, x, y } : n2)))
            }
          })
        }
      } catch (e) {
        window.alert((e as Error).message)
      }
    },
    [pushUndo]
  )

  const setNoteStyle = useCallback(
    async (noteId: string, style: { font?: string; textSize?: number }) => {
      const current = notes.find((n) => n.id === noteId)
      const oldStyle = current ? { font: current.font, textSize: current.textSize } : undefined
      try {
        const n = await api.drawingSetNoteStyle(noteId, style)
        setNotes((cur) => cur.map((x) => (x.id === noteId ? { ...x, ...n } : x)))
        if (oldStyle) {
          pushUndo({
            undo: async () => {
              const n2 = await api.drawingSetNoteStyle(noteId, oldStyle)
              setNotes((cur) => cur.map((x) => (x.id === noteId ? { ...x, ...n2 } : x)))
            },
            redo: async () => {
              const n2 = await api.drawingSetNoteStyle(noteId, style)
              setNotes((cur) => cur.map((x) => (x.id === noteId ? { ...x, ...n2 } : x)))
            }
          })
        }
      } catch (e) {
        window.alert((e as Error).message)
      }
    },
    [notes, pushUndo]
  )

  const setDimensionType = useCallback(
    async (dimId: string, kind: DimensionType) => {
      const oldKind = dims.find((x) => x.id === dimId)?.type
      try {
        const d = await api.drawingSetDimensionType(dimId, kind)
        setDims((cur) => cur.map((x) => (x.id === dimId ? d : x)))
        if (oldKind) {
          pushUndo({
            undo: async () => {
              const d2 = await api.drawingSetDimensionType(dimId, oldKind)
              setDims((cur) => cur.map((x) => (x.id === dimId ? d2 : x)))
            },
            redo: async () => {
              const d2 = await api.drawingSetDimensionType(dimId, kind)
              setDims((cur) => cur.map((x) => (x.id === dimId ? d2 : x)))
            }
          })
        }
      } catch (e) {
        window.alert((e as Error).message)
      }
    },
    [dims, pushUndo]
  )

  // NOT pushed onto the undo stack: DrawingDimension never retains its
  // original edge/point refs (raw names like "Edge3", resolved once against
  // the view at add-time and not read back anywhere - see _dimension_raw_
  // value in drawing.py), so add_dimension has no way to recreate an
  // equivalent one without a fresh re-pick from the user. Silently pushing
  // a "successful-looking" undo entry that either throws (add_dimension
  // requires at least one ref) or fabricates a wrong dimension would be
  // worse than no undo at all for this one action.
  const deleteDimension = useCallback(async (dimId: string) => {
    try {
      await api.drawingRemoveDimension(dimId)
      setDims((cur) => cur.filter((d) => d.id !== dimId))
    } catch (e) {
      window.alert((e as Error).message)
    }
  }, [])

  useImperativeHandle(
    ref,
    () => ({
      addView,
      autoLayout,
      setTool,
      sectionTool,
      detailTool,
      brokenTool,
      insertBom,
      insertTable,
      saveAsTemplate,
      loadSheetTemplate,
      exportPdf,
      exportDxf
    }),
    [addView, autoLayout, setTool, sectionTool, detailTool, brokenTool, insertBom, insertTable, saveAsTemplate, loadSheetTemplate, exportPdf, exportDxf]
  )

  return (
    <div className="drawing">
      <div className="drawing-bar">
        <button className="drawing-back" onClick={onBack}>
          ← Model
        </button>
        <span className="drawing-title">Drawing — {name}</span>
        {tool !== 'select' && (
          <span className="drawing-tool-active">
            {tool === 'dimension' ? 'Dimension' : tool === 'note' ? 'Note' : 'Cleanup Line'} tool active
            <button
              onClick={() => {
                setTool('select')
                setDimPending(null)
                setCleanupPending(null)
              }}
            >
              Done
            </button>
          </span>
        )}
        <span className="drawing-spacer" />
        {(dims.length > 0 || placed.length > 0 || notes.length > 0) && (
          <button
            className="drawing-adddir"
            onClick={() => {
              setPlaced([])
              setDims([])
              setDimLabelPos({})
              setNotes([])
              setTable(null)
            }}
          >
            Clear
          </button>
        )}
        <span className="drawing-zoom">
          <button title="Zoom out" onClick={() => zoomBy(1.25)}>
            −
          </button>
          <button title="Zoom to fit the whole sheet" onClick={zoomFit}>
            {Math.round((SHEET_W / viewBox.w) * 100)}%
          </button>
          <button title="Zoom in" onClick={() => zoomBy(1 / 1.25)}>
            +
          </button>
        </span>
      </div>

      <div className="drawing-sheet" ref={sheetRef}>
        <svg
          className="drawing-page-svg"
          viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
          onWheel={onWheel}
          onPointerDown={(e) => {
            // space+drag (or the middle mouse button) pans the sheet,
            // regardless of the active tool - same modifier convention the
            // main 3D viewport uses for its own pan gesture
            if (spaceHeld.current || e.button === 1) {
              e.preventDefault()
              panRef.current = { x: e.clientX, y: e.clientY, vbx: viewBox.x, vby: viewBox.y }
              return
            }
            // an empty-sheet pointerdown in select mode starts a rubber-
            // band window-select, same left-to-right="contained" / right-
            // to-left="touches" convention the main 3D viewport uses
            const target = e.target as Element
            if (tool === 'select' && !target.closest('[data-view-box]') && !target.closest('[data-note]')) {
              const svg = e.currentTarget
              const pt = svg.createSVGPoint()
              pt.x = e.clientX
              pt.y = e.clientY
              const p = pt.matrixTransform(svg.getScreenCTM()!.inverse())
              setBand({ x0: p.x, y0: p.y, x1: p.x, y1: p.y })
            }
          }}
          onPointerMove={onPointerMove}
          onPointerUp={() => {
            drag.current = null
            panRef.current = null
            if (band) {
              const x0 = Math.min(band.x0, band.x1)
              const x1 = Math.max(band.x0, band.x1)
              const y0 = Math.min(band.y0, band.y1)
              const y1 = Math.max(band.y0, band.y1)
              const crossing = band.x1 < band.x0
              const viewIds = new Set<string>()
              for (const pl of placed) {
                const [minX, minY, maxX, maxY] = pl.view.bbox
                // ViewBox's own hit-rect spans (placed.x, placed.y) to
                // (placed.x + w, placed.y + h) where w/h = (max-min)*scale
                // are already positive magnitudes (see ViewBox render) -
                // no sign flip needed here, unlike the polylines inside it.
                const vx0 = pl.x
                const vx1 = pl.x + (maxX - minX) * pl.scale
                const vy0 = pl.y
                const vy1 = pl.y + (maxY - minY) * pl.scale
                const intersects = vx0 < x1 && vx1 > x0 && vy0 < y1 && vy1 > y0
                const contained = vx0 >= x0 && vx1 <= x1 && vy0 >= y0 && vy1 <= y1
                if (crossing ? intersects : contained) viewIds.add(pl.view.id)
              }
              const noteIds = new Set<string>()
              for (const n of notes) {
                if (n.x >= x0 && n.x <= x1 && n.y >= y0 && n.y <= y1) noteIds.add(n.id)
              }
              if (viewIds.size || noteIds.size) {
                justBandSelected.current = true
                setSelMultiViews(viewIds)
                setSelMultiNotes(noteIds)
                setSel(null)
                setSelNote(null)
              }
              setBand(null)
            }
            const gd = groupDrag.current
            if (gd) {
              const movedViews = gd.views
              const movedNotes = gd.notes
              groupDrag.current = null
              const viewMoves: Array<{ id: string; from: { x: number; y: number }; to: { x: number; y: number } }> = []
              for (const pl of placed) {
                const orig = movedViews.get(pl.view.id)
                if (orig && (orig.x !== pl.x || orig.y !== pl.y)) {
                  viewMoves.push({ id: pl.view.id, from: orig, to: { x: pl.x, y: pl.y } })
                }
              }
              if (viewMoves.length) {
                pushUndo({
                  undo: async () => {
                    setPlaced((cur) => cur.map((pl) => {
                      const m = viewMoves.find((vm) => vm.id === pl.view.id)
                      return m ? { ...pl, x: m.from.x, y: m.from.y } : pl
                    }))
                  },
                  redo: async () => {
                    setPlaced((cur) => cur.map((pl) => {
                      const m = viewMoves.find((vm) => vm.id === pl.view.id)
                      return m ? { ...pl, x: m.to.x, y: m.to.y } : pl
                    }))
                  }
                })
              }
              for (const n of notes) {
                const orig = movedNotes.get(n.id)
                if (orig) void moveNote(n.id, n.x, n.y, orig)
              }
            }
            if (noteDrag.current) {
              const { id, origX, origY } = noteDrag.current
              noteDrag.current = null
              const n = notes.find((x) => x.id === id)
              if (n) void moveNote(id, n.x, n.y, { x: origX, y: origY })
            }
          }}
          style={{ cursor: spaceHeld.current ? 'grab' : undefined }}
          onClick={(e) => {
            // the sheet's own white background <rect> sits directly under
            // the root <svg> and should count as "empty sheet," same as the
            // root itself - only a click that landed on a placed view's own
            // hit-test rect (data-view-box on its wrapping <g>, see ViewBox)
            // should be excluded here, since that view's rect already
            // handles the click itself (select/drag or a dimension/cleanup
            // pick) and this handler must not also deselect it.
            const target = e.target as Element
            const clickedInsideView = target.closest('[data-view-box]') !== null
            if (justBandSelected.current) {
              justBandSelected.current = false
              return
            }
            if (!clickedInsideView) {
              setSel(null)
              setSelNote(null)
              setSelMultiViews(new Set())
              setSelMultiNotes(new Set())
              if (tool === 'note') {
                const svg = e.currentTarget as SVGSVGElement
                const pt = svg.createSVGPoint()
                pt.x = e.clientX
                pt.y = e.clientY
                const p = pt.matrixTransform(svg.getScreenCTM()!.inverse())
                void addNote(null, [p.x, p.y])
              }
            }
          }}
        >
          <rect x={0} y={0} width={SHEET_W} height={SHEET_H} fill="#fff" />
          <rect
            x={MARGIN}
            y={MARGIN}
            width={SHEET_W - MARGIN * 2}
            height={SHEET_H - MARGIN * 2}
            fill="none"
            stroke="#111"
            strokeWidth={0.6}
          />

          {placed.length === 0 && (
            <text x={SHEET_W / 2} y={SHEET_H / 2} fontSize={6} fill="#bbb" textAnchor="middle">
              Blank sheet — use “Add View”
            </text>
          )}

          {placed.map((pl, i) => (
            <ViewBox
              key={pl.view.id}
              placed={pl}
              selected={sel === i || selMultiViews.has(pl.view.id)}
              hovered={hover === i}
              tool={tool}
              snapTargets={snapTargets[pl.view.id] ?? []}
              onHover={(over) => setHover((cur) => (over ? i : cur === i ? null : cur))}
              onDown={(e) => {
                const svg = (e.currentTarget as SVGElement).ownerSVGElement!
                const pt = svg.createSVGPoint()
                pt.x = e.clientX
                pt.y = e.clientY
                const p = pt.matrixTransform(svg.getScreenCTM()!.inverse())
                // dragging an item that's already part of a multi-select
                // moves the WHOLE group together; otherwise this click
                // replaces the selection with just this one item (standard
                // click-vs-click-on-selection convention)
                if (selMultiViews.has(pl.view.id) || selMultiNotes.size > 0) {
                  const views = new Map<string, { x: number; y: number }>()
                  for (const p2 of placed) if (selMultiViews.has(p2.view.id)) views.set(p2.view.id, { x: p2.x, y: p2.y })
                  const notesMap = new Map<string, { x: number; y: number }>()
                  for (const n of notes) if (selMultiNotes.has(n.id)) notesMap.set(n.id, { x: n.x, y: n.y })
                  groupDrag.current = { startX: p.x, startY: p.y, views, notes: notesMap }
                  return
                }
                setSel(i)
                setSelNote(null)
                setSelMultiViews(new Set())
                setSelMultiNotes(new Set())
                drag.current = { i, ox: p.x - pl.x, oy: p.y - pl.y }
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                setSel(i)
                setMenu({ x: e.clientX, y: e.clientY, viewId: pl.view.id })
              }}
              onPick={onViewPickPoint(pl.view.id)}
            />
          ))}

          {/* cleanup (construction) lines - dashed grey, snap targets only */}
          {placed.map((pl) =>
            (cleanupLines[pl.view.id] ?? []).map((cl) => (
              <line
                key={cl.id}
                x1={pl.x + cl.p1[0] * pl.scale}
                y1={pl.y - cl.p1[1] * pl.scale}
                x2={pl.x + cl.p2[0] * pl.scale}
                y2={pl.y - cl.p2[1] * pl.scale}
                stroke="#8ab"
                strokeDasharray="0.8 0.8"
                strokeWidth={0.25}
                style={{ cursor: 'context-menu', pointerEvents: 'stroke' }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setMenu(null)
                  setDimMenu({
                    x: e.clientX,
                    y: e.clientY,
                    items: [
                      {
                        label: 'Delete Cleanup Line',
                        danger: true,
                        onClick: () => {
                          void (async () => {
                            try {
                              await api.drawingRemoveCleanupLine(pl.view.id, cl.id)
                              setCleanupLines((cur) => ({
                                ...cur,
                                [pl.view.id]: (cur[pl.view.id] ?? []).filter((x) => x.id !== cl.id)
                              }))
                              pushUndo({
                                undo: async () => {
                                  const cl2 = await api.drawingAddCleanupLine(pl.view.id, cl.p1, cl.p2)
                                  setCleanupLines((cur) => ({ ...cur, [pl.view.id]: [...(cur[pl.view.id] ?? []), cl2] }))
                                },
                                redo: async () => {
                                  await api.drawingRemoveCleanupLine(pl.view.id, cl.id)
                                  setCleanupLines((cur) => ({
                                    ...cur,
                                    [pl.view.id]: (cur[pl.view.id] ?? []).filter((x) => x.id !== cl.id)
                                  }))
                                }
                              })
                            } catch (e) {
                              window.alert((e as Error).message)
                            }
                          })()
                        }
                      }
                    ]
                  })
                }}
              />
            ))
          )}

          {dims.map((d) => {
            const pl = placed.find((p) => p.view.id === d.viewId)
            if (!pl || d.value === null) return null
            const fmt = { ...dimFormats.default, ...(dimFormats.overrides[d.id] ?? {}) }
            const text = formatDimension(d.value, d.type, fmt || DEFAULT_DIM_FORMAT)
            const localPos = dimLabelPos[d.id]
            const labelX = localPos ? pl.x + localPos[0] * pl.scale : pl.x + 2
            const labelY = localPos ? pl.y - localPos[1] * pl.scale : pl.y - 2
            return (
              <g
                key={d.id}
                stroke="#c47f16"
                fill="#c47f16"
                strokeWidth={0.3}
                onContextMenu={(e) => {
                  e.preventDefault()
                  const items: MenuItem[] = []
                  if (RADIAL_TYPES.includes(d.type)) {
                    items.push({
                      label: d.type === 'Radius' ? 'Convert to Diameter' : 'Convert to Radius',
                      onClick: () => void setDimensionType(d.id, d.type === 'Radius' ? 'Diameter' : 'Radius')
                    })
                  }
                  items.push({
                    label: 'Format…',
                    onClick: () => {
                      void (async () => {
                        const res = await promptForm('Dimension Format', [
                          { key: 'precision', label: 'Decimal places', value: String(fmt.precision ?? 2) },
                          {
                            key: 'leadingZero',
                            label: 'Leading zero (0.5 vs .5)',
                            value: fmt.leadingZero === false ? 'no' : 'yes',
                            options: ['yes', 'no']
                          },
                          {
                            key: 'trailingZeros',
                            label: 'Trailing zeros (1.20 vs 1.2)',
                            value: fmt.trailingZeros === false ? 'no' : 'yes',
                            options: ['yes', 'no']
                          }
                        ])
                        if (!res) return
                        const newFmt: DimensionFormat = {
                          precision: Number(res.precision) || 0,
                          leadingZero: res.leadingZero !== 'no',
                          trailingZeros: res.trailingZeros !== 'no'
                        }
                        await api.drawingSetDimensionFormat(d.id, newFmt)
                        void refreshDimFormats()
                      })()
                    }
                  })
                  items.push({ separator: true, label: '' })
                  items.push({ label: 'Delete Dimension', danger: true, onClick: () => void deleteDimension(d.id) })
                  setMenu(null)
                  setDimMenu({ x: e.clientX, y: e.clientY, items })
                }}
              >
                <text x={labelX} y={labelY} fontSize={3.4} textAnchor="middle" stroke="none">
                  {text}
                </text>
              </g>
            )
          })}

          {notes.map((n) => (
            <text
              key={n.id}
              data-note={n.id}
              x={n.x}
              y={n.y}
              fontSize={n.textSize ?? 3.4}
              fontFamily={n.font || undefined}
              fill={selNote === n.id || selMultiNotes.has(n.id) ? '#0696d7' : '#333'}
              style={{ cursor: 'move' }}
              onPointerDown={(e) => {
                e.stopPropagation()
                if (selMultiNotes.has(n.id) || selMultiViews.size > 0) {
                  const svg = sheetRef.current?.querySelector('svg') as SVGSVGElement | null
                  if (!svg) return
                  const pt = svg.createSVGPoint()
                  pt.x = e.clientX
                  pt.y = e.clientY
                  const p = pt.matrixTransform(svg.getScreenCTM()!.inverse())
                  const views = new Map<string, { x: number; y: number }>()
                  for (const p2 of placed) if (selMultiViews.has(p2.view.id)) views.set(p2.view.id, { x: p2.x, y: p2.y })
                  const notesMap = new Map<string, { x: number; y: number }>()
                  for (const n2 of notes) if (selMultiNotes.has(n2.id)) notesMap.set(n2.id, { x: n2.x, y: n2.y })
                  groupDrag.current = { startX: p.x, startY: p.y, views, notes: notesMap }
                  return
                }
                setSel(null)
                setSelNote(n.id)
                setSelMultiViews(new Set())
                setSelMultiNotes(new Set())
                const svg = sheetRef.current?.querySelector('svg') as SVGSVGElement | null
                if (!svg) return
                const pt = svg.createSVGPoint()
                pt.x = e.clientX
                pt.y = e.clientY
                const p = pt.matrixTransform(svg.getScreenCTM()!.inverse())
                noteDrag.current = { id: n.id, ox: p.x - n.x, oy: p.y - n.y, origX: n.x, origY: n.y }
              }}
              onDoubleClick={(e) => {
                e.stopPropagation()
                void editNoteText(n.id)
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setSelNote(n.id)
                setMenu(null)
                setDimMenu({
                  x: e.clientX,
                  y: e.clientY,
                  items: [
                    { label: 'Edit Text…', onClick: () => void editNoteText(n.id) },
                    {
                      label: 'Font Size…',
                      onClick: () => {
                        void (async () => {
                          const res = await promptForm('Note Style', [
                            { key: 'textSize', label: 'Font size (mm)', value: String(n.textSize ?? 3.4) }
                          ])
                          if (!res) return
                          void setNoteStyle(n.id, { textSize: Number(res.textSize) || 3.4 })
                        })()
                      }
                    },
                    { separator: true, label: '' },
                    { label: 'Delete Note', danger: true, onClick: () => void deleteNote(n.id) }
                  ]
                })
              }}
            >
              {n.text}
            </text>
          ))}

          {table &&
            (() => {
              const rowH = table.rowHeight
              const colW = Math.max(20, 130 / table.columns.length)
              const tableW = colW * table.columns.length
              const tableH = rowH * (table.rows.length + 1)
              return (
                <g
                  transform={`translate(${MARGIN + 4} ${MARGIN + 4})`}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setMenu(null)
                    setDimMenu({
                      x: e.clientX,
                      y: e.clientY,
                      items: [
                        {
                          label: table.showGrid ? 'Hide Grid Lines' : 'Show Grid Lines',
                          onClick: () => setTableGridStyle({ showGrid: !table.showGrid })
                        },
                        {
                          label: 'Grid Color…',
                          onClick: () => {
                            void (async () => {
                              const res = await promptForm('Table Grid', [
                                { key: 'color', label: 'Grid line color (hex)', value: table.gridColor }
                              ])
                              if (res) setTableGridStyle({ gridColor: res.color || '#111' })
                            })()
                          }
                        },
                        {
                          label: 'Row Height…',
                          onClick: () => {
                            void (async () => {
                              const res = await promptForm('Table Grid', [
                                { key: 'h', label: 'Row height (mm)', value: String(table.rowHeight) }
                              ])
                              if (res) setTableGridStyle({ rowHeight: Number(res.h) || 5 })
                            })()
                          }
                        }
                      ]
                    })
                  }}
                >
                  {table.showGrid && (
                    <g stroke={table.gridColor} strokeWidth={0.25} fill="none">
                      <rect x={0} y={0} width={tableW} height={tableH} />
                      {table.columns.slice(1).map((c, i) => (
                        <line key={c.key} x1={colW * (i + 1)} y1={0} x2={colW * (i + 1)} y2={tableH} />
                      ))}
                      {table.rows.map((_row, i) => (
                        <line key={`r${i}`} x1={0} y1={rowH * (i + 1)} x2={tableW} y2={rowH * (i + 1)} />
                      ))}
                    </g>
                  )}
                  {table.columns.map((c, ci) => (
                    <text key={c.key} x={colW * ci + 1.5} y={rowH - 1.5} fontSize={3.2} fontWeight="bold">
                      {c.header}
                    </text>
                  ))}
                  {table.rows.map((row, ri) =>
                    table.columns.map((c, ci) => {
                      const isEditing = editingCell && editingCell.row === ri && editingCell.col === ci
                      const value = String((row as unknown as Record<string, unknown>)[c.source] ?? '')
                      return (
                        <g key={`${ri}-${c.key}`}>
                          <rect
                            x={colW * ci}
                            y={rowH * (ri + 1)}
                            width={colW}
                            height={rowH}
                            fill={isEditing ? '#0696d71a' : 'transparent'}
                            style={{ cursor: 'text' }}
                            onDoubleClick={(e) => {
                              e.stopPropagation()
                              setEditingCell({ row: ri, col: ci, value })
                            }}
                          />
                          {isEditing ? (
                            <foreignObject x={colW * ci} y={rowH * (ri + 1)} width={colW} height={rowH}>
                              <input
                                autoFocus
                                defaultValue={value}
                                style={{ width: '100%', height: '100%', fontSize: '3.2px', border: 'none', outline: '1px solid #0696d7', boxSizing: 'border-box' }}
                                onBlur={(e) => {
                                  void setTableCell(ri, c.source, e.currentTarget.value)
                                  setEditingCell(null)
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') e.currentTarget.blur()
                                  if (e.key === 'Escape') {
                                    e.currentTarget.value = value
                                    setEditingCell(null)
                                  }
                                }}
                              />
                            </foreignObject>
                          ) : (
                            <text
                              x={colW * ci + 1.5}
                              y={rowH * (ri + 1) + rowH - 1.5}
                              fontSize={3.2}
                              style={{ cursor: 'text' }}
                              onDoubleClick={(e) => {
                                e.stopPropagation()
                                setEditingCell({ row: ri, col: ci, value })
                              }}
                            >
                              {value}
                            </text>
                          )}
                        </g>
                      )
                    })
                  )}
                </g>
              )
            })()}

          {showTitleBlock && (
            <g transform={`translate(${SHEET_W - MARGIN - 90} ${SHEET_H - MARGIN - 26})`}>
              <rect width={90} height={26} fill="#fff" stroke="#111" strokeWidth={0.5} />
              <line x1={0} y1={13} x2={90} y2={13} stroke="#111" strokeWidth={0.3} />
              <line x1={45} y1={0} x2={45} y2={13} stroke="#111" strokeWidth={0.3} />
              <text x={3} y={9} fontSize={4} fontWeight="bold">
                {name}
              </text>
              <text x={48} y={9} fontSize={3}>
                {today}
              </text>
              <text x={3} y={21} fontSize={3}>
                mm · 1:1 · Sheet 1/1
              </text>
            </g>
          )}
          {band && (
            <rect
              x={Math.min(band.x0, band.x1)}
              y={Math.min(band.y0, band.y1)}
              width={Math.abs(band.x1 - band.x0)}
              height={Math.abs(band.y1 - band.y0)}
              fill={band.x1 < band.x0 ? '#0696d71a' : '#0696d70d'}
              stroke="#0696d7"
              strokeWidth={0.3}
              strokeDasharray={band.x1 < band.x0 ? '1.5 1' : undefined}
            />
          )}
        </svg>
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: 'Section View…', onClick: () => void sectionTool() },
            { label: 'Detail View…', onClick: () => void detailTool() },
            { label: 'Broken View…', onClick: () => void brokenTool() },
            { separator: true, label: '' },
            { label: 'Convert to Normal', onClick: () => void convertView(menu.viewId, 'part') },
            { separator: true, label: '' },
            { label: 'Delete View', danger: true, onClick: () => void deleteView(menu.viewId) }
          ]}
        />
      )}
      {dimMenu && (
        <ContextMenu
          x={dimMenu.x}
          y={dimMenu.y}
          onClose={() => setDimMenu(null)}
          items={dimMenu.items}
        />
      )}
    </div>
  )
})
