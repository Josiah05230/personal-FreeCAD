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
  type NoteTextStyle,
  type SnapTarget,
  type TableColumn,
  type TableMerge,
  type TableTemplate
} from '../rpc'
import { basename } from '../util'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { promptText, promptForm, promptMultiline } from './PromptDialog'
import { formatDimension, formatDimensionTolerance, DEFAULT_DIM_FORMAT } from '../dimensionFormat'
import { resolveFitClass } from '../iso286'

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

interface TableState {
  id: string
  rows: Array<BomRow | Record<string, string | number>>
  /** rows before "=NAME" parameter resolution - what an edit box seeds
   *  from (see rpc.ts's DrawingTable.rawRows). Defaults to rows itself
   *  right after a plain (non-reload) edit, since make_table's own
   *  response is always already the raw input. */
  rawRows: Array<BomRow | Record<string, string | number>>
  columns: TableColumn[]
  showGrid: boolean
  gridColor: string
  rowHeight: number
  x: number
  y: number
  /** per-column width overrides (mm) - empty/short means "use the shared
   *  derived colW for that index," same convention as the sidecar. */
  colWidths: number[]
  merges: TableMerge[]
}

/** A view's own nested <svg> uses viewBox="minX -maxY (maxX-minX) (maxY-minY)"
 *  (see ViewBox's render) so its local (0,0) is the geometry's top-left
 *  corner (minX, maxY), Y pointing down - the same origin the outer <g
 *  transform="translate(placed.x, placed.y)"> sits at. So a view-UV point
 *  (u, v) - what onViewPick's snap targets and dimPending are in - maps to
 *  ABSOLUTE sheet coordinates as (placed.x + (u-minX)*scale, placed.y +
 *  (maxY-v)*scale), not a bare `placed.x + u*scale` (which only happens to
 *  be right when minX is 0 and ignores the Y flip entirely) - the previous
 *  dimension-label code did exactly that bare multiply, which is why a
 *  dimension's text rendered near the view's corner instead of at the
 *  picked location (user report, 2026-09-19: "it was in the middle of the
 *  view... that seems way wrong"). */
function uvToLocal(pl: Placed, uv: [number, number]): [number, number] {
  const [minX, , , maxY] = pl.view.bbox
  return [(uv[0] - minX) * pl.scale, (maxY - uv[1]) * pl.scale]
}

/** Inverse of uvToLocal - a point in the placed view's own local sheet
 *  space (i.e. sheet-absolute minus the view's placed x/y, which callers
 *  already subtract via the drag point minus pl.x/pl.y) back to view-UV, so
 *  a dimension label's drag position (tracked in sheet coordinates like
 *  every other draggable element) can be sent to drawingMoveDimension,
 *  which persists labelUV in the same UV frame the sidecar computes p1/p2/
 *  center/etc in. */
function localToUV(pl: Placed, local: [number, number]): [number, number] {
  const [minX, , , maxY] = pl.view.bbox
  return [local[0] / pl.scale + minX, maxY - local[1] / pl.scale]
}

/** a placed view's on-sheet footprint, derived from its own bbox + scale -
 *  shared by every view-creation tool's overlap-avoidance placement. */
function footprint(p: Placed): { x: number; y: number; w: number; h: number } {
  const [minX, minY, maxX, maxY] = p.view.bbox
  return { x: p.x, y: p.y, w: (maxX - minX) * p.scale, h: (maxY - minY) * p.scale }
}

// ISO A3 landscape sheet in mm
const SHEET_W = 420
const SHEET_H = 297
const MARGIN = 10

const flip = (poly: number[][]): [number, number][] => poly.map((p) => [p[0], -p[1]])

/** Find the next sheet position for a newly-placed view (w x h mm, already
 *  scaled) that doesn't overlap any already-placed view's own footprint.
 *  Scans a coarse grid of candidate slots left-to-right, top-to-bottom and
 *  returns the first that clears every existing view by GAP mm on all
 *  sides - falls back to stacking past the bottom of the sheet (still
 *  non-overlapping, just off the visible page) rather than ever silently
 *  overlapping, since a hardcoded fixed offset can't account for how big
 *  the view actually is (a small nudge overlaps a large view; see the
 *  2026-09-19 bug report where Front+Top landed on top of each other). */
function findOpenSlot(
  existing: { x: number; y: number; w: number; h: number }[],
  w: number,
  h: number
): { x: number; y: number } {
  const GAP = 8
  const STEP = 10
  const overlaps = (x: number, y: number): boolean =>
    existing.some(
      (p) =>
        x < p.x + p.w + GAP &&
        x + w + GAP > p.x &&
        y < p.y + p.h + GAP &&
        y + h + GAP > p.y
    )
  for (let y = MARGIN + 20; y <= SHEET_H - h - MARGIN; y += STEP) {
    for (let x = MARGIN + 6; x <= SHEET_W - w - MARGIN; x += STEP) {
      if (!overlaps(x, y)) return { x, y }
    }
  }
  // sheet is full - stack below the last row rather than overlap
  const maxBottom = existing.reduce((m, p) => Math.max(m, p.y + p.h), MARGIN + 20)
  return { x: MARGIN + 6, y: maxBottom + GAP }
}

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
  toggleTitleBlock: () => void
  saveSheetTemplate: () => Promise<void>
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
const ANGLE_TYPES: DimensionType[] = ['Angle', 'Angle3Pt']

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
  const tableDrag = useRef<{ id: string; ox: number; oy: number; origX: number; origY: number } | null>(null)
  // dimension label/leader/arc drag - like noteDrag/tableDrag, but the
  // dropped point is stored as view-UV (via localToUV) since that's the
  // frame drawingMoveDimension persists in, not raw sheet coordinates.
  const dimDrag = useRef<{
    id: string
    viewId: string
    ox: number
    oy: number
    origUV: [number, number]
    /** live drag position in view-UV, updated every pointermove - kept on
     *  the ref (not dimGeom, which for an Angle dimension has no labelUV
     *  field to hold it) so pointerup always has the final drop point. */
    liveUV: [number, number]
  } | null>(null)
  const [cleanupLines, setCleanupLines] = useState<Record<string, CleanupLine[]>>({})
  const [snapTargets, setSnapTargets] = useState<Record<string, SnapTarget[]>>({})
  const [tables, setTables] = useState<TableState[]>([])
  // multiple tables can coexist on one sheet (a BOM plus any number of plain
  // tables) - Insert BOM used to unconditionally replace whatever single
  // table already existed (user report, 2026-09-19: "When I hit insert BOM,
  // it replaced my table. I should be able to have a BOM and other tables
  // all over the place. Not just a single one"). selTableId (rather than a
  // plain boolean) tracks WHICH one is selected now that there can be more
  // than one.
  const [selTableId, setSelTableId] = useState<string | null>(null)
  const [editingCell, setEditingCell] = useState<{ tableId: string; row: number; col: number; value: string } | null>(null)
  // per-table column-width override (mm) - colW is otherwise always derived
  // from column count (130 / columns.length); "Column Width…" in the
  // table's right-click menu lets the user pin an explicit width instead
  // (user report, 2026-09-19: "in your little right click menu for the
  // table, there is no row width" - row HEIGHT was already editable;
  // column WIDTH, which is what was actually missing, is this).
  const [columnWidthOverride, setColumnWidthOverride] = useState<Record<string, number>>({})
  // a rectangular block of data cells (0-based, header row excluded) the
  // user has selected via click + shift-click, for "right-click -> Merge
  // Cells" - the only cell-merge entry point (user question, 2026-09-20:
  // "Can I merge cells ... of tables?" - previously there was no merge
  // concept anywhere in the table model at all).
  const [selCells, setSelCells] = useState<{ tableId: string; r0: number; c0: number; r1: number; c1: number } | null>(
    null
  )
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
  // p1/p2 are the two picked points (view-UV space) a dimension measures
  // between, and labelUV is where its value text sits (also view-UV) - all
  // three needed to draw real witness/extension lines, not just floating
  // text (see uvToLocal below for the UV -> sheet-local conversion).
  const [dimGeom, setDimGeom] = useState<
    Record<
      string,
      | { p1: [number, number]; p2: [number, number]; labelUV: [number, number] }
      | { center: [number, number]; rim: [number, number]; labelUV: [number, number] }
      | { center: [number, number]; dir1: [number, number]; dir2: [number, number]; arcRadius: number }
    >
  >({})
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
        // position/rowHeight/showGrid/gridColor round-trip through the
        // sidecar now (view.X/Y + a _gwt_style tag - fixed 2026-09-20: a
        // table's position and style used to be pure client React state,
        // so any dragged table or edited row height silently reset to this
        // same hardcoded corner-cascade default every time the drawing was
        // reopened). style is only absent for a table from before this
        // fix existed on disk - the same defaults as before cover that.
        setTables(
          c.tables.map((t, i) => ({
            id: t.id,
            rows: t.rows,
            rawRows: t.rawRows ?? t.rows,
            columns: t.columns,
            showGrid: t.style?.showGrid ?? true,
            gridColor: t.style?.gridColor ?? '#111',
            rowHeight: t.style?.rowHeight ?? 5,
            x: t.style?.x ?? MARGIN + 4 + i * 8,
            y: t.style?.y ?? MARGIN + 4 + i * 8,
            colWidths: t.style?.colWidths ?? [],
            merges: t.style?.merges ?? []
          }))
        )
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
      const { x, y } = findOpenSlot(placed.map(footprint), (maxX - minX) * fit, (maxY - minY) * fit)
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

  // direct on/off, independent of templates - "Load Template" was the ONLY
  // way to ever turn a title block on, which meant a brand-new drawing (no
  // template saved yet, since nothing ever called drawing.saveSheetTemplate
  // either) had no title block and no way to add one at all (user feedback,
  // 2026-09-19).
  const toggleTitleBlock = useCallback(() => {
    setShowTitleBlock((v) => !v)
  }, [])

  // persists the CURRENT sheet's title-block on/off + its placed view
  // directions as a reusable named template via drawing.saveSheetTemplate -
  // previously defined on the RPC surface (rpc.ts) but never called from
  // anywhere, so "Load Template" could never offer more than the built-in
  // "Blank" entry.
  const saveSheetTemplate = useCallback(async (): Promise<void> => {
    const res = await promptForm('Save as Sheet Template', [
      { key: 'name', label: 'Template name', value: '' }
    ])
    if (!res?.name.trim()) return
    try {
      await api.drawingSaveSheetTemplate(res.name.trim(), {
        titleBlock: showTitleBlock,
        views: placed.map((p) => p.view.direction).filter((d): d is string => !!d)
      })
    } catch (e) {
      window.alert((e as Error).message)
    }
  }, [showTitleBlock, placed])

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
    if (dimDrag.current && sheetRef.current) {
      const svg = sheetRef.current.querySelector('svg') as SVGSVGElement
      const pt = svg.createSVGPoint()
      pt.x = e.clientX
      pt.y = e.clientY
      const p = pt.matrixTransform(svg.getScreenCTM()!.inverse())
      const { id, viewId, ox, oy } = dimDrag.current
      const pl = placed.find((p2) => p2.view.id === viewId)
      if (pl) {
        const labelUV = localToUV(pl, [p.x - pl.x - ox, p.y - pl.y - oy])
        dimDrag.current.liveUV = labelUV
        setDimGeom((cur) => {
          const g = cur[id]
          if (!g) return cur
          if ('arcRadius' in g) {
            // Angle: the live degree of freedom is how far the arc sits
            // from the vertex, not a raw labelUV (Angle geometry has no
            // such field) - re-derive it from the drag point's distance to
            // centre, same formula set_dimension_geom uses server-side.
            const arcRadius = Math.hypot(labelUV[0] - g.center[0], labelUV[1] - g.center[1])
            return { ...cur, [id]: { ...g, arcRadius } }
          }
          return { ...cur, [id]: { ...g, labelUV } }
        })
      }
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
    if (tableDrag.current && sheetRef.current) {
      const svg = sheetRef.current.querySelector('svg') as SVGSVGElement
      const pt = svg.createSVGPoint()
      pt.x = e.clientX
      pt.y = e.clientY
      const p = pt.matrixTransform(svg.getScreenCTM()!.inverse())
      const { id: dragId, ox, oy } = tableDrag.current
      setTables((cur) => cur.map((t) => (t.id === dragId ? { ...t, x: p.x - ox, y: p.y - oy } : t)))
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
      geom?: { p1: [number, number]; p2: [number, number] }
    ) => {
      try {
        const d = await api.drawingAddDimension(pageId, viewId, refs, kind)
        setDims((cur) => [...cur, d])
        if (geom) {
          const labelUV: [number, number] = [(geom.p1[0] + geom.p2[0]) / 2, (geom.p1[1] + geom.p2[1]) / 2]
          setDimGeom((cur) => ({ ...cur, [d.id]: { ...geom, labelUV } }))
        }
        pushUndo({
          undo: async () => {
            await api.drawingRemoveDimension(d.id)
            setDims((cur) => cur.filter((x) => x.id !== d.id))
          },
          redo: async () => {
            const d2 = await api.drawingAddDimension(pageId, viewId, refs, kind)
            setDims((cur) => [...cur, d2])
            if (geom) {
              const labelUV: [number, number] = [(geom.p1[0] + geom.p2[0]) / 2, (geom.p1[1] + geom.p2[1]) / 2]
              setDimGeom((cur) => ({ ...cur, [d2.id]: { ...geom, labelUV } }))
            }
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
            // guard against the same point picked twice (two clicks that
            // both snapped to the identical vertex/edge-end) - that used to
            // silently create a genuine but useless 0-value dimension with
            // no warning at all (user report, 2026-09-19: "I got one to
            // show up and it said 0"). A real distinct pick is required.
            const samePoint =
              sub === dimPending.sub &&
              Math.hypot(p[0] - dimPending.p[0], p[1] - dimPending.p[1]) < 1e-6
            if (samePoint) {
              window.alert('Pick a different point for the second end of the dimension.')
              return
            }
            void addDimension(viewId, [{ sub: dimPending.sub }, { sub }], 'Distance', {
              p1: dimPending.p,
              p2: p
            })
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
      const [minX, minY, maxX, maxY] = v.bbox
      const { x, y } = findOpenSlot(placed.map(footprint), (maxX - minX) * base.scale, (maxY - minY) * base.scale)
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
      const scale = Math.max(base.scale, 0.5)
      const [minX, minY, maxX, maxY] = v.bbox
      const { x, y } = findOpenSlot(placed.map(footprint), (maxX - minX) * scale, (maxY - minY) * scale)
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
      const [minX, minY, maxX, maxY] = v.bbox
      const { x, y } = findOpenSlot(placed.map(footprint), (maxX - minX) * base.scale, (maxY - minY) * base.scale)
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

  // Escape always backs out of whatever's active, one layer at a time - the
  // current tool first (same effect as clicking "Done"), then any selection
  // if already in the select tool. User report (2026-09-19): "anytime I hit
  // 'esc' it should exit whatever tool I am currently in" - previously
  // Escape did nothing at all in the drawing editor (no handler existed).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      if (tool !== 'select') {
        setTool('select')
        setDimPending(null)
        setCleanupPending(null)
        return
      }
      setSel(null)
      setSelNote(null)
      setSelMultiViews(new Set())
      setSelMultiNotes(new Set())
      setSelTableId(null)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [tool])

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

  // rough on-sheet footprint for a not-yet-placed table, so a new one lands
  // in an open spot instead of stacking exactly on top of an existing one
  const tableFootprint = (t: { columns: TableColumn[]; rows: unknown[]; rowHeight: number }): { w: number; h: number } => ({
    w: Math.max(20, 130 / Math.max(t.columns.length, 1)) * t.columns.length,
    h: t.rowHeight * (t.rows.length + 1)
  })

  const insertBom = useCallback(
    async (template?: TableTemplate) => {
      try {
        const { rows } = await api.drawingBomRows(assembly?.assembly ?? undefined)
        if (rows.length === 0) {
          window.alert('Nothing to list yet - add a body or component to the model first.')
          return
        }
        // always create a NEW table - Insert BOM used to reuse whatever
        // single table already existed (passing its id here), silently
        // replacing it; a BOM and any number of plain tables can now coexist
        // side by side (user report, 2026-09-19).
        const t = await api.drawingMakeTable(pageId, rows, template?.spec.columns, template?.spec)
        const fp = tableFootprint({ columns: t.columns, rows: t.rows, rowHeight: template?.spec.rowHeight ?? 5 })
        const { x, y } = findOpenSlot(
          tables.map((tb) => ({ x: tb.x, y: tb.y, ...tableFootprint(tb) })),
          fp.w,
          fp.h
        )
        const next: TableState = {
          id: t.id,
          rows: t.rows,
          rawRows: t.rawRows ?? t.rows,
          columns: t.columns,
          showGrid: template?.spec.showGrid ?? true,
          gridColor: template?.spec.gridColor ?? '#111',
          rowHeight: template?.spec.rowHeight ?? 5,
          x,
          y,
          colWidths: [],
          merges: []
        }
        setTables((cur) => [...cur, next])
        void api.drawingUpdateTableStyle(t.id, {
          x, y, showGrid: next.showGrid, gridColor: next.gridColor, rowHeight: next.rowHeight
        })
        pushUndo({
          undo: async () => {
            await api.drawingRemoveTable(t.id)
            setTables((cur) => cur.filter((tb) => tb.id !== t.id))
          },
          redo: async () => {
            const t2 = await api.drawingMakeTable(pageId, rows, template?.spec.columns, template?.spec, t.id, {
              x, y, showGrid: next.showGrid, gridColor: next.gridColor, rowHeight: next.rowHeight
            })
            setTables((cur) => [...cur, { ...next, id: t2.id, rows: t2.rows, columns: t2.columns }])
          }
        })
      } catch (e) {
        window.alert((e as Error).message)
      }
    },
    [assembly, pageId, tables, pushUndo]
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
      try {
        // always create a NEW table, same reasoning as insertBom - Insert
        // Table used to replace whatever single table already existed.
        const t = await api.drawingMakeTable(pageId, rows, columns, template?.spec)
        const fp = tableFootprint({ columns: t.columns, rows: t.rows, rowHeight: template?.spec.rowHeight ?? 5 })
        const { x, y } = findOpenSlot(
          tables.map((tb) => ({ x: tb.x, y: tb.y, ...tableFootprint(tb) })),
          fp.w,
          fp.h
        )
        const next: TableState = {
          id: t.id,
          rows: t.rows,
          rawRows: t.rawRows ?? t.rows,
          columns: t.columns,
          showGrid: template?.spec.showGrid ?? true,
          gridColor: template?.spec.gridColor ?? '#111',
          rowHeight: template?.spec.rowHeight ?? 5,
          x,
          y,
          colWidths: [],
          merges: []
        }
        setTables((cur) => [...cur, next])
        void api.drawingUpdateTableStyle(t.id, {
          x, y, showGrid: next.showGrid, gridColor: next.gridColor, rowHeight: next.rowHeight
        })
        pushUndo({
          undo: async () => {
            await api.drawingRemoveTable(t.id)
            setTables((cur) => cur.filter((tb) => tb.id !== t.id))
          },
          redo: async () => {
            const t2 = await api.drawingMakeTable(pageId, rows, columns, template?.spec, t.id, {
              x, y, showGrid: next.showGrid, gridColor: next.gridColor, rowHeight: next.rowHeight
            })
            setTables((cur) => [...cur, { ...next, id: t2.id, rows: t2.rows, columns: t2.columns }])
          }
        })
      } catch (e) {
        window.alert((e as Error).message)
      }
    },
    [pageId, tables, pushUndo]
  )

  const updateTable = useCallback((id: string, patch: Partial<TableState> | ((t: TableState) => Partial<TableState>)) => {
    setTables((cur) => cur.map((t) => (t.id === id ? { ...t, ...(typeof patch === 'function' ? patch(t) : patch) } : t)))
  }, [])

  const saveTableAsTemplate = useCallback(
    async (tableId: string) => {
      const t = tables.find((x) => x.id === tableId)
      if (!t) {
        window.alert('Insert a table first, then save it as a template.')
        return
      }
      const name2 = await promptText('Template name', '')
      if (!name2 || !name2.trim()) return
      try {
        await api.drawingSaveTableTemplate(name2.trim(), {
          columns: t.columns,
          showGrid: t.showGrid,
          gridColor: t.gridColor,
          rowHeight: t.rowHeight
        })
      } catch (e) {
        window.alert((e as Error).message)
      }
    },
    [tables]
  )

  // ribbon-level "Save as Template…" (no specific table in mind) - acts on
  // whichever table is currently selected, or the most recently added one
  // when nothing is selected, now that multiple tables can coexist.
  const saveAsTemplate = useCallback(async () => {
    const id = selTableId ?? tables[tables.length - 1]?.id
    if (!id) {
      window.alert('Insert a table first, then save it as a template.')
      return
    }
    await saveTableAsTemplate(id)
  }, [selTableId, tables, saveTableAsTemplate])

  const setTableCell = useCallback(
    async (tableId: string, rowIdx: number, source: string, value: string) => {
      const t = tables.find((x) => x.id === tableId)
      if (!t) return
      // build off rawRows (the unresolved "=NAME" text), not the resolved
      // display rows - editing one cell must not silently bake every OTHER
      // cell's live parameter reference into a frozen literal (user
      // question, 2026-09-20: part name/description/hole size "driven/
      // grabbed in drawing tables with some sort of '=PARAMETER_NAME'").
      const oldValue = String((t.rawRows[rowIdx] as unknown as Record<string, unknown>)?.[source] ?? '')
      const rows = t.rawRows.map((row, i) => (i === rowIdx ? { ...row, [source]: value } : row))
      const columns = t.columns
      updateTable(tableId, { rows, rawRows: rows })
      try {
        const res = await api.drawingMakeTable(pageId, rows, columns, undefined, tableId)
        updateTable(tableId, { rows: res.rows, rawRows: res.rows })
        if (String(oldValue) !== value) {
          pushUndo({
            undo: async () => {
              const revertRows = rows.map((row, i) => (i === rowIdx ? { ...row, [source]: oldValue } : row))
              const t2 = await api.drawingMakeTable(pageId, revertRows, columns, undefined, tableId)
              updateTable(tableId, { rows: t2.rows, rawRows: t2.rows })
            },
            redo: async () => {
              const t2 = await api.drawingMakeTable(pageId, rows, columns, undefined, tableId)
              updateTable(tableId, { rows: t2.rows, rawRows: t2.rows })
            }
          })
        }
      } catch (e) {
        window.alert((e as Error).message)
      }
    },
    [tables, pageId, pushUndo, updateTable]
  )

  const setTableGridStyle = useCallback(
    (tableId: string, style: Partial<{ showGrid: boolean; gridColor: string; rowHeight: number }>) => {
      // persisted server-side now (view.X/Y + a _gwt_style tag - previously
      // pure client state, silently reverting to defaults on every reopen).
      updateTable(tableId, style)
      void api.drawingUpdateTableStyle(tableId, style)
    },
    [updateTable]
  )

  const setTableColWidths = useCallback(
    (tableId: string, colWidths: number[]) => {
      updateTable(tableId, { colWidths })
      void api.drawingUpdateTableStyle(tableId, { colWidths })
    },
    [updateTable]
  )

  /** merge a rectangular block of DATA cells (0-based, header row excluded -
   *  same indexing addTableRow/addTableColumn already use) into one. Server-
   *  validated (rejects overlap with an existing merge) so a stale/optimistic
   *  local update never diverges from what actually got saved. */
  const mergeTableCells = useCallback(
    async (tableId: string, r: number, c: number, rs: number, cs: number) => {
      try {
        const style = await api.drawingMergeTableCells(tableId, r, c, rs, cs)
        updateTable(tableId, { merges: style.merges ?? [] })
      } catch (e) {
        window.alert((e as Error).message)
      }
    },
    [updateTable]
  )

  const unmergeTableCells = useCallback(
    async (tableId: string, r: number, c: number) => {
      try {
        const style = await api.drawingUnmergeTableCells(tableId, r, c)
        updateTable(tableId, { merges: style.merges ?? [] })
      } catch (e) {
        window.alert((e as Error).message)
      }
    },
    [updateTable]
  )

  const moveTable = useCallback(
    (tableId: string, x: number, y: number, orig?: { x: number; y: number }) => {
      updateTable(tableId, { x, y })
      void api.drawingUpdateTableStyle(tableId, { x, y })
      if (orig) {
        pushUndo({
          undo: async () => {
            updateTable(tableId, { x: orig.x, y: orig.y })
            void api.drawingUpdateTableStyle(tableId, { x: orig.x, y: orig.y })
          },
          redo: async () => {
            updateTable(tableId, { x, y })
            void api.drawingUpdateTableStyle(tableId, { x, y })
          }
        })
      }
    },
    [pushUndo, updateTable]
  )

  const deleteTable = useCallback(
    async (tableId: string) => {
      const doomed = tables.find((t) => t.id === tableId)
      if (!doomed) return
      try {
        await api.drawingRemoveTable(doomed.id)
        setTables((cur) => cur.filter((t) => t.id !== tableId))
        setSelTableId((cur) => (cur === tableId ? null : cur))
        pushUndo({
          undo: async () => {
            const t = await api.drawingMakeTable(pageId, doomed.rows, doomed.columns, undefined, doomed.id)
            setTables((cur) => [...cur, { ...doomed, rows: t.rows, columns: t.columns, id: t.id }])
          },
          redo: async () => {
            await api.drawingRemoveTable(doomed.id)
            setTables((cur) => cur.filter((t) => t.id !== doomed.id))
          }
        })
      } catch (e) {
        window.alert((e as Error).message)
      }
    },
    [tables, pageId, pushUndo]
  )

  const renameColumn = useCallback(
    async (tableId: string, colIdx: number) => {
      const t = tables.find((x) => x.id === tableId)
      if (!t) return
      const col = t.columns[colIdx]
      const name = await promptText('Column heading', col.header)
      if (name === null || name === undefined || name === col.header) return
      const columns = t.columns.map((c, i) => (i === colIdx ? { ...c, header: name } : c))
      const rows = t.rows
      try {
        const res = await api.drawingMakeTable(pageId, rows, columns, undefined, tableId)
        updateTable(tableId, { columns: res.columns })
        pushUndo({
          undo: async () => {
            const t2 = await api.drawingMakeTable(pageId, rows, t.columns, undefined, tableId)
            updateTable(tableId, { columns: t2.columns })
          },
          redo: async () => {
            const t2 = await api.drawingMakeTable(pageId, rows, columns, undefined, tableId)
            updateTable(tableId, { columns: t2.columns })
          }
        })
      } catch (e) {
        window.alert((e as Error).message)
      }
    },
    [tables, pageId, pushUndo, updateTable]
  )

  const addTableRow = useCallback(
    async (tableId: string) => {
      const t = tables.find((x) => x.id === tableId)
      if (!t) return
      const blank: Record<string, string | number> = { index: t.rawRows.length + 1 }
      for (const c of t.columns) blank[c.source] = ''
      // built off rawRows so any "=NAME" reference in an existing row
      // survives the round trip (see setTableCell's comment - t.rows here
      // would be already-resolved display values).
      const rows = [...t.rawRows, blank]
      const { columns } = t
      try {
        const res = await api.drawingMakeTable(pageId, rows, columns, undefined, tableId)
        updateTable(tableId, { rows: res.rows, rawRows: res.rows })
        pushUndo({
          undo: async () => {
            const t2 = await api.drawingMakeTable(pageId, t.rawRows, columns, undefined, tableId)
            updateTable(tableId, { rows: t2.rows, rawRows: t2.rows })
          },
          redo: async () => {
            const t2 = await api.drawingMakeTable(pageId, rows, columns, undefined, tableId)
            updateTable(tableId, { rows: t2.rows, rawRows: t2.rows })
          }
        })
      } catch (e) {
        window.alert((e as Error).message)
      }
    },
    [tables, pageId, pushUndo, updateTable]
  )

  const deleteTableRow = useCallback(
    async (tableId: string, rowIdx: number) => {
      const t = tables.find((x) => x.id === tableId)
      if (!t || t.rows.length <= 1) {
        window.alert('A table needs at least one row.')
        return
      }
      const rows = t.rawRows.filter((_, i) => i !== rowIdx)
      const { columns } = t
      const previousRows = t.rawRows
      try {
        const res = await api.drawingMakeTable(pageId, rows, columns, undefined, tableId)
        updateTable(tableId, { rows: res.rows, rawRows: res.rows })
        pushUndo({
          undo: async () => {
            const t2 = await api.drawingMakeTable(pageId, previousRows, columns, undefined, tableId)
            updateTable(tableId, { rows: t2.rows, rawRows: t2.rows })
          },
          redo: async () => {
            const t2 = await api.drawingMakeTable(pageId, rows, columns, undefined, tableId)
            updateTable(tableId, { rows: t2.rows, rawRows: t2.rows })
          }
        })
      } catch (e) {
        window.alert((e as Error).message)
      }
    },
    [tables, pageId, pushUndo, updateTable]
  )

  const addTableColumn = useCallback(
    async (tableId: string) => {
      const t = tables.find((x) => x.id === tableId)
      if (!t) return
      const n = t.columns.length
      const key = `col${n}`
      const columns = [...t.columns, { key, header: `Column ${n + 1}`, source: key }]
      const rows = t.rawRows.map(
        (r) => ({ ...(r as unknown as Record<string, string | number>), [key]: '' }) as Record<string, string | number>
      )
      const previousColumns = t.columns
      const previousRows = t.rawRows
      try {
        const res = await api.drawingMakeTable(pageId, rows, columns, undefined, tableId)
        updateTable(tableId, { rows: res.rows, rawRows: res.rows, columns: res.columns })
        pushUndo({
          undo: async () => {
            const t2 = await api.drawingMakeTable(pageId, previousRows, previousColumns, undefined, tableId)
            updateTable(tableId, { rows: t2.rows, rawRows: t2.rows, columns: t2.columns })
          },
          redo: async () => {
            const t2 = await api.drawingMakeTable(pageId, rows, columns, undefined, tableId)
            updateTable(tableId, { rows: t2.rows, rawRows: t2.rows, columns: t2.columns })
          }
        })
      } catch (e) {
        window.alert((e as Error).message)
      }
    },
    [tables, pageId, pushUndo, updateTable]
  )

  const deleteTableColumn = useCallback(
    async (tableId: string, colIdx: number) => {
      const t = tables.find((x) => x.id === tableId)
      if (!t || t.columns.length <= 1) {
        window.alert('A table needs at least one column.')
        return
      }
      const removed = t.columns[colIdx]
      const columns = t.columns.filter((_, i) => i !== colIdx)
      const rows = t.rawRows.map((r) => {
        const row = { ...(r as unknown as Record<string, string | number>) }
        delete row[removed.source]
        return row
      })
      const previousColumns = t.columns
      const previousRows = t.rawRows
      try {
        const res = await api.drawingMakeTable(pageId, rows, columns, undefined, tableId)
        updateTable(tableId, { rows: res.rows, rawRows: res.rows, columns: res.columns })
        pushUndo({
          undo: async () => {
            const t2 = await api.drawingMakeTable(pageId, previousRows, previousColumns, undefined, tableId)
            updateTable(tableId, { rows: t2.rows, rawRows: t2.rows, columns: t2.columns })
          },
          redo: async () => {
            const t2 = await api.drawingMakeTable(pageId, rows, columns, undefined, tableId)
            updateTable(tableId, { rows: t2.rows, rawRows: t2.rows, columns: t2.columns })
          }
        })
      } catch (e) {
        window.alert((e as Error).message)
      }
    },
    [tables, pageId, pushUndo, updateTable]
  )

  // Delete/Backspace also removes the table when it's the current selection
  // - a separate effect from the view/note one above since deleteTable is
  // declared after that point in this component. Same input-guard so typing
  // in a cell editor or a promptForm field isn't intercepted.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      if (!selTableId) return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      e.preventDefault()
      void deleteTable(selTableId)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [selTableId, deleteTable])

  const addNote = useCallback(
    async (viewId: string | null, p: [number, number]) => {
      const text = await promptMultiline('Note text', '')
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

  const applyNoteText = useCallback(
    async (noteId: string, oldText: string, text: string) => {
      if (text === oldText) return
      try {
        const n = await api.drawingSetNoteText(noteId, text)
        setNotes((cur) => cur.map((x) => (x.id === noteId ? { ...x, ...n } : x)))
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
      } catch (e) {
        window.alert((e as Error).message)
      }
    },
    [pushUndo]
  )

  const editNoteText = useCallback(
    async (noteId: string) => {
      const current = notes.find((n) => n.id === noteId)
      if (!current) return
      const text = await promptMultiline('Note text', current.text)
      if (text === null || text === undefined) return
      void applyNoteText(noteId, current.text, text)
    },
    [notes, applyNoteText]
  )

  // symbol buttons in the Text toolbar append directly to the note's
  // current text instead of opening the edit-text prompt - a real F360-style
  // "insert this symbol at the end" convenience (per-cursor-position
  // insertion isn't possible without owning the text field's own cursor,
  // which the toolbar button doesn't have access to; appending is still far
  // better than the prompt-per-symbol dialog this would otherwise need)
  const insertNoteSymbol = useCallback(
    (noteId: string, sym: string) => {
      const current = notes.find((n) => n.id === noteId)
      if (!current) return
      void applyNoteText(noteId, current.text, current.text + sym)
    },
    [notes, applyNoteText]
  )

  const applyDimGeomResponse = useCallback(
    (dimId: string, res: Awaited<ReturnType<typeof api.drawingMoveDimension>>) => {
      if (!res) return
      if ('p1' in res && res.p1 && res.p2 && res.labelUV) {
        setDimGeom((cur) => ({ ...cur, [dimId]: { p1: res.p1!, p2: res.p2!, labelUV: res.labelUV! } }))
      } else if ('rim' in res && res.center && res.rim && res.labelUV) {
        setDimGeom((cur) => ({ ...cur, [dimId]: { center: res.center!, rim: res.rim!, labelUV: res.labelUV! } }))
      } else if ('arcRadius' in res && res.center && res.dir1 && res.dir2 && res.arcRadius !== undefined) {
        setDimGeom((cur) => ({
          ...cur,
          [dimId]: { center: res.center!, dir1: res.dir1!, dir2: res.dir2!, arcRadius: res.arcRadius! }
        }))
      }
    },
    []
  )

  const moveDimension = useCallback(
    async (dimId: string, labelUV: [number, number], from?: [number, number]) => {
      // optimistic local move, same pattern as moveNote/moveTable - dimGeom
      // is what the render code actually reads (falling back to the DTO's
      // own geometry fields only when there's no local override), so this
      // takes effect immediately without waiting on the round trip. Only the
      // labelUV-shaped fields are optimistically nudged here; the RPC
      // response (whichever of the three geometry shapes this dimension
      // actually has) reconciles the rest right after.
      setDimGeom((cur) => {
        const g = cur[dimId]
        return g ? { ...cur, [dimId]: { ...g, labelUV } } : cur
      })
      try {
        const res = await api.drawingMoveDimension(dimId, labelUV)
        applyDimGeomResponse(dimId, res)
        if (from && (from[0] !== labelUV[0] || from[1] !== labelUV[1])) {
          pushUndo({
            undo: async () => applyDimGeomResponse(dimId, await api.drawingMoveDimension(dimId, from)),
            redo: async () => applyDimGeomResponse(dimId, await api.drawingMoveDimension(dimId, labelUV))
          })
        }
      } catch (e) {
        window.alert((e as Error).message)
      }
    },
    [pushUndo, applyDimGeomResponse]
  )

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
    async (
      noteId: string,
      style: { font?: string; textSize?: number; textStyle?: NoteTextStyle; color?: string }
    ) => {
      const current = notes.find((n) => n.id === noteId)
      const oldStyle = current
        ? { font: current.font, textSize: current.textSize, textStyle: current.textStyle, color: current.color }
        : undefined
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
      toggleTitleBlock,
      saveSheetTemplate,
      exportPdf,
      exportDxf
    }),
    [
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
      toggleTitleBlock,
      saveSheetTemplate,
      exportPdf,
      exportDxf
    ]
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
        {(dims.length > 0 || placed.length > 0 || notes.length > 0 || tables.length > 0) && (
          <button
            className="drawing-adddir"
            onClick={() => {
              setPlaced([])
              setDims([])
              setDimGeom({})
              setNotes([])
              setTables([])
            }}
          >
            Clear
          </button>
        )}
        {selNote &&
          (() => {
            const n = notes.find((x) => x.id === selNote)
            if (!n) return null
            const style = n.textStyle ?? 'Normal'
            const bold = style === 'Bold' || style === 'Bold-Italic'
            const italic = style === 'Italic' || style === 'Bold-Italic'
            const toggleStyle = (which: 'bold' | 'italic'): void => {
              const nextBold = which === 'bold' ? !bold : bold
              const nextItalic = which === 'italic' ? !italic : italic
              const next: NoteTextStyle =
                nextBold && nextItalic ? 'Bold-Italic' : nextBold ? 'Bold' : nextItalic ? 'Italic' : 'Normal'
              void setNoteStyle(n.id, { textStyle: next })
            }
            return (
              <span className="drawing-text-toolbar">
                <select
                  title="Font"
                  value={n.font ?? 'osifont'}
                  onChange={(e) => void setNoteStyle(n.id, { font: e.target.value })}
                >
                  {['osifont', 'sans-serif', 'serif', 'monospace'].map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
                <input
                  title="Font size (mm)"
                  type="number"
                  min={1}
                  step={0.5}
                  value={n.textSize ?? 3.4}
                  onChange={(e) => void setNoteStyle(n.id, { textSize: Number(e.target.value) || 3.4 })}
                  style={{ width: '3.5em' }}
                />
                <button
                  title="Bold"
                  aria-pressed={bold}
                  className={bold ? 'active' : undefined}
                  onClick={() => toggleStyle('bold')}
                  style={{ fontWeight: 'bold' }}
                >
                  B
                </button>
                <button
                  title="Italic"
                  aria-pressed={italic}
                  className={italic ? 'active' : undefined}
                  onClick={() => toggleStyle('italic')}
                  style={{ fontStyle: 'italic' }}
                >
                  I
                </button>
                <input
                  title="Text color"
                  type="color"
                  value={n.color ?? '#333333'}
                  onChange={(e) => void setNoteStyle(n.id, { color: e.target.value })}
                />
                {['Ø', '°', '±', '⌀', '△'].map((sym) => (
                  <button key={sym} title={`Insert ${sym}`} onClick={() => insertNoteSymbol(n.id, sym)}>
                    {sym}
                  </button>
                ))}
              </span>
            )
          })()}
        {selTableId &&
          (() => {
            const t = tables.find((x) => x.id === selTableId)
            if (!t) return null
            return (
              <span className="drawing-text-toolbar">
                <button title={t.showGrid ? 'Hide Grid Lines' : 'Show Grid Lines'} onClick={() => setTableGridStyle(t.id, { showGrid: !t.showGrid })}>
                  Grid
                </button>
                <input
                  title="Grid line color"
                  type="color"
                  value={t.gridColor}
                  onChange={(e) => setTableGridStyle(t.id, { gridColor: e.target.value || '#111' })}
                />
                <input
                  title="Row height (mm)"
                  type="number"
                  min={1}
                  step={0.5}
                  value={t.rowHeight}
                  onChange={(e) => setTableGridStyle(t.id, { rowHeight: Number(e.target.value) || 5 })}
                  style={{ width: '3.5em' }}
                />
                <input
                  title="Column width (mm)"
                  type="number"
                  min={5}
                  step={1}
                  value={columnWidthOverride[t.id] ?? Math.max(20, 130 / t.columns.length)}
                  onChange={(e) => {
                    const w = Number(e.target.value)
                    if (w > 0) setColumnWidthOverride((cur) => ({ ...cur, [t.id]: w }))
                  }}
                  style={{ width: '3.5em' }}
                />
                <button title="Add Row" onClick={() => void addTableRow(t.id)}>
                  +Row
                </button>
                <button title="Add Column" onClick={() => void addTableColumn(t.id)}>
                  +Col
                </button>
                <button title="Delete Table" onClick={() => void deleteTable(t.id)}>
                  Delete
                </button>
              </span>
            )
          })()}
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
            if (
              tool === 'select' &&
              !target.closest('[data-view-box]') &&
              !target.closest('[data-note]') &&
              !target.closest('[data-table]')
            ) {
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
                setSelTableId(null)
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
            if (dimDrag.current) {
              const { id, origUV, liveUV } = dimDrag.current
              dimDrag.current = null
              if (liveUV[0] !== origUV[0] || liveUV[1] !== origUV[1]) {
                void moveDimension(id, liveUV, origUV)
              }
            }
            if (noteDrag.current) {
              const { id, origX, origY } = noteDrag.current
              noteDrag.current = null
              const n = notes.find((x) => x.id === id)
              if (n) void moveNote(id, n.x, n.y, { x: origX, y: origY })
            }
            if (tableDrag.current) {
              const { id: dragId, origX, origY } = tableDrag.current
              tableDrag.current = null
              const t = tables.find((x) => x.id === dragId)
              if (t && (t.x !== origX || t.y !== origY)) {
                moveTable(dragId, t.x, t.y, { x: origX, y: origY })
              }
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
            // an existing note under the note tool must NOT also trigger
            // "place a new note here" - previously data-note wasn't excluded
            // here, so clicking an EXISTING note while the Note tool was
            // still active (it never auto-exits after placing one) opened a
            // brand-new note's text prompt right on top of it, which read as
            // "clicking a note edits it" (user report, 2026-09-19).
            const clickedInsideView =
              target.closest('[data-view-box]') !== null ||
              target.closest('[data-table]') !== null ||
              target.closest('[data-note]') !== null
            if (justBandSelected.current) {
              justBandSelected.current = false
              return
            }
            if (!clickedInsideView) {
              setSel(null)
              setSelNote(null)
              setSelMultiViews(new Set())
              setSelMultiNotes(new Set())
              setSelTableId(null)
              setSelCells(null)
              if (tool === 'note') {
                const svg = e.currentTarget as SVGSVGElement
                const pt = svg.createSVGPoint()
                pt.x = e.clientX
                pt.y = e.clientY
                const p = pt.matrixTransform(svg.getScreenCTM()!.inverse())
                void addNote(null, [p.x, p.y])
                // one-shot tool: return to Select after placing, matching
                // Dimension/Cleanup Line's own "Done" affordance instead of
                // silently staying armed for every future click
                setTool('select')
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
                setSelTableId(null)
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
            const tol = formatDimensionTolerance(fmt)
            // Rendered as a standalone <text> block, offset from the main
            // value's own (x, y) by a fixed local-space amount - simpler and
            // more robust than chaining <tspan dx> off a parent whose x/
            // textAnchor already vary per dimension type. Single line for
            // symmetric "±0.05"; two vertically-stacked lines ("+0.10" over
            // "-0.05") for a deviation band, the standard drawing convention.
            // Only rendered when toleranceMode is actually set (user
            // question, 2026-09-20: "add various tolerances to them").
            const renderTolerance = (
              anchorX: number,
              anchorY: number,
              textAnchor: 'start' | 'middle' | 'end'
            ): React.ReactNode => {
              if (!tol) return null
              const tx = anchorX + (textAnchor === 'end' ? -8 : 8)
              return (
                <text x={tx} y={anchorY} fontSize={2.2} textAnchor={textAnchor === 'middle' ? 'start' : textAnchor} stroke="none">
                  {tol.lines.map((line, i) => (
                    <tspan key={i} x={tx} dy={i === 0 ? (tol.lines.length > 1 ? '-0.35em' : 0) : '1.1em'}>
                      {line}
                    </tspan>
                  ))}
                </text>
              )
            }
            // dimGeom (an in-session drag not yet saved) wins; otherwise the
            // server-persisted p1/p2/labelUV on the DTO itself - computed by
            // the sidecar from the dimension's own References2D, so real
            // witness/dimension lines survive a reopen instead of degrading
            // to a corner label the way a client-only cache would (fixed
            // 2026-09-20: every dimension used to lose its lines/arrows the
            // moment the drawing was closed and reopened, even one placed
            // through the normal two-click UI flow - the geometry only ever
            // lived in this React state, never round-tripped through the
            // sidecar).
            const localGeom = dimGeom[d.id]
            const geom = (localGeom && 'p1' in localGeom ? localGeom : undefined) ??
              (d.p1 && d.p2 && d.labelUV ? { p1: d.p1, p2: d.p2, labelUV: d.labelUV } : undefined)
            const radialGeom = (localGeom && 'rim' in localGeom ? localGeom : undefined) ??
              (RADIAL_TYPES.includes(d.type) && d.center && d.rim && d.labelUV
                ? { center: d.center, rim: d.rim, labelUV: d.labelUV }
                : undefined)
            const angleGeom = (localGeom && 'arcRadius' in localGeom ? localGeom : undefined) ??
              (ANGLE_TYPES.includes(d.type) && d.center && d.dir1 && d.dir2 && d.arcRadius
                ? { center: d.center, dir1: d.dir1, dir2: d.dir2, arcRadius: d.arcRadius }
                : undefined)
            const dimContextMenu = (e: React.MouseEvent): void => {
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
                      },
                      {
                        key: 'toleranceMode',
                        label: 'Tolerance',
                        value: fmt.toleranceMode ?? 'off',
                        options: ['off', 'symmetric', 'deviation']
                      },
                      {
                        key: 'fitClass',
                        label: 'ISO fit class (e.g. H7, g6) - fills +/- below',
                        value: '',
                        placeholder: 'leave blank to enter +/- manually'
                      },
                      {
                        key: 'tolerancePlus',
                        label: 'Upper deviation, mm (symmetric mode: the ± value)',
                        value: fmt.tolerancePlus !== undefined && fmt.tolerancePlus !== null ? String(fmt.tolerancePlus) : ''
                      },
                      {
                        key: 'toleranceMinus',
                        label: 'Lower deviation, mm - signed (deviation mode only, e.g. -0.05)',
                        value: fmt.toleranceMinus !== undefined && fmt.toleranceMinus !== null ? String(fmt.toleranceMinus) : ''
                      }
                    ])
                    if (!res) return
                    const toleranceMode = (res.toleranceMode as DimensionFormat['toleranceMode']) ?? 'off'
                    let tolerancePlus = res.tolerancePlus.trim() === '' ? undefined : Number(res.tolerancePlus)
                    let toleranceMinus = res.toleranceMinus.trim() === '' ? undefined : Number(res.toleranceMinus)
                    // a fit class (e.g. "H7") resolves against this
                    // dimension's own nominal value and overrides whatever
                    // was typed in the +/- fields - ISO 286 gives an upper
                    // and lower LIMIT DEVIATION, not a symmetric +/- band,
                    // so picking one always produces deviation-mode numbers
                    // (a fit's tolerance is essentially never symmetric).
                    // Both fields are the genuinely signed limit deviations
                    // (see formatDimensionTolerance's comment) - e.g. f7
                    // resolves to tolerancePlus=-0.025, toleranceMinus=-0.050,
                    // both negative, which a "+X/-Y" magnitude convention
                    // could never represent correctly.
                    if (res.fitClass.trim() && d.value !== null) {
                      const limits = resolveFitClass(res.fitClass.trim(), d.value)
                      if (!limits) {
                        window.alert(
                          `Unrecognized or unsupported fit class "${res.fitClass.trim()}". ` +
                            `Supported: H7/H8/H9/H11 (holes), g6/f7/e8/e9/d9/d10/h6/h7/h9/k6/n6/p6/s6 (shafts).`
                        )
                        return
                      }
                      tolerancePlus = limits.upper
                      toleranceMinus = limits.lower
                    }
                    const newFmt: DimensionFormat = {
                      precision: Number(res.precision) || 0,
                      leadingZero: res.leadingZero !== 'no',
                      trailingZeros: res.trailingZeros !== 'no',
                      toleranceMode,
                      tolerancePlus,
                      toleranceMinus
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
            }
            const arrow = (x: number, y: number, dirx: number, diry: number): string => {
              const s = 1.6
              const backx = x - dirx * s
              const backy = y - diry * s
              const nx = -diry * s * 0.35
              const ny = dirx * s * 0.35
              return `${x},${y} ${backx + nx},${backy + ny} ${backx - nx},${backy - ny}`
            }
            // drag the label/leader/arc to reposition the whole dimension -
            // there was previously no way to move a placed dimension at all
            // (user report, 2026-09-20: "it doesn't look like I can drag
            // dimensions after they are placed"). origUV is read from
            // whatever geom is already showing (local override if mid-drag-
            // undo, else the DTO) so a drag started right after load still
            // has a correct starting point to diff against.
            const currentLabelUV: [number, number] | null =
              geom?.labelUV ?? radialGeom?.labelUV ??
              (angleGeom
                ? [
                    angleGeom.center[0] +
                      (angleGeom.dir1[0] + angleGeom.dir2[0]) * angleGeom.arcRadius * 0.5,
                    angleGeom.center[1] +
                      (angleGeom.dir1[1] + angleGeom.dir2[1]) * angleGeom.arcRadius * 0.5
                  ]
                : null)
            const onDimPointerDown = (e: React.PointerEvent): void => {
              e.stopPropagation()
              if (!currentLabelUV) return
              setMenu(null)
              setDimMenu(null)
              // seed dimGeom with whatever geometry is already showing (DTO
              // or a prior local override) so the pointermove handler always
              // has a full shape to spread {...g, labelUV} onto, even for a
              // dimension that has never been dragged before.
              if (geom) setDimGeom((cur) => ({ ...cur, [d.id]: cur[d.id] ?? geom }))
              else if (radialGeom) setDimGeom((cur) => ({ ...cur, [d.id]: cur[d.id] ?? radialGeom }))
              else if (angleGeom) setDimGeom((cur) => ({ ...cur, [d.id]: cur[d.id] ?? angleGeom }))
              const svg = sheetRef.current?.querySelector('svg') as SVGSVGElement | null
              if (!svg) return
              const pt = svg.createSVGPoint()
              pt.x = e.clientX
              pt.y = e.clientY
              const p = pt.matrixTransform(svg.getScreenCTM()!.inverse())
              const [lx, ly] = uvToLocal(pl, currentLabelUV)
              dimDrag.current = {
                id: d.id,
                viewId: pl.view.id,
                ox: p.x - pl.x - lx,
                oy: p.y - pl.y - ly,
                origUV: currentLabelUV,
                liveUV: currentLabelUV
              }
            }
            if (radialGeom) {
              const [cx, cy] = uvToLocal(pl, radialGeom.center)
              const [rx, ry] = uvToLocal(pl, radialGeom.rim)
              const [lx, ly] = uvToLocal(pl, radialGeom.labelUV)
              const dirx0 = rx - cx
              const diry0 = ry - cy
              const rlen = Math.hypot(dirx0, diry0) || 1
              const dirx = dirx0 / rlen
              const diry = diry0 / rlen
              const labelAnchor: 'start' | 'end' = lx >= cx ? 'start' : 'end'
              const labelDx = lx >= cx ? 1.5 : -1.5
              if (d.type === 'Diameter') {
                // a real diameter dimension is a single line straight through
                // the centre, rim to opposite rim, with an arrowhead at BOTH
                // ends - not a one-sided leader like Radius (user report,
                // 2026-09-20: "radius dimensions should only have a leader to
                // the outer circle but ... diameter ... should have a leader
                // to a line going all the way through the center ... arrows
                // on both sides").
                const farx = cx - dirx0
                const fary = cy - diry0
                return (
                  <g
                    key={d.id}
                    transform={`translate(${pl.x} ${pl.y})`}
                    stroke="#c47f16"
                    fill="#c47f16"
                    strokeWidth={0.25}
                    style={{ cursor: 'move' }}
                    onPointerDown={onDimPointerDown}
                    onContextMenu={dimContextMenu}
                  >
                    <line x1={farx} y1={fary} x2={rx} y2={ry} />
                    <polygon points={arrow(rx, ry, dirx, diry)} stroke="none" />
                    <polygon points={arrow(farx, fary, -dirx, -diry)} stroke="none" />
                    {/* label sits on an extension of the same line, past the near rim */}
                    <line x1={rx} y1={ry} x2={lx} y2={ly} strokeWidth={0.2} />
                    <text
                      x={lx + labelDx}
                      y={ly}
                      fontSize={3.4}
                      textAnchor={labelAnchor}
                      dominantBaseline="middle"
                      stroke="none"
                    >
                      {text}
                    </text>
                    {renderTolerance(lx + labelDx, ly, labelAnchor)}
                  </g>
                )
              }
              // Radius: a one-sided leader from the centre out through the
              // rim to the label - only ever touches the outer circle once.
              return (
                <g
                  key={d.id}
                  transform={`translate(${pl.x} ${pl.y})`}
                  stroke="#c47f16"
                  fill="#c47f16"
                  strokeWidth={0.25}
                  style={{ cursor: 'move' }}
                  onPointerDown={onDimPointerDown}
                  onContextMenu={dimContextMenu}
                >
                  <line x1={cx} y1={cy} x2={lx} y2={ly} />
                  <circle cx={cx} cy={cy} r={0.5} stroke="none" />
                  <polygon points={arrow(rx, ry, dirx, diry)} stroke="none" />
                  <text
                    x={lx + labelDx}
                    y={ly}
                    fontSize={3.4}
                    textAnchor={labelAnchor}
                    dominantBaseline="middle"
                    stroke="none"
                  >
                    {text}
                  </text>
                  {renderTolerance(lx + labelDx, ly, labelAnchor)}
                </g>
              )
            }
            if (angleGeom) {
              // real arc sweep between the two referenced edges, not a
              // straight line - angle in screen space (Y flips sign vs the
              // model-space angle already computed for the label text).
              const [cx, cy] = uvToLocal(pl, angleGeom.center)
              const r = angleGeom.arcRadius
              const a1 = Math.atan2(-angleGeom.dir1[1], angleGeom.dir1[0])
              const a2 = Math.atan2(-angleGeom.dir2[1], angleGeom.dir2[0])
              let sweep = a2 - a1
              while (sweep <= -Math.PI) sweep += 2 * Math.PI
              while (sweep > Math.PI) sweep -= 2 * Math.PI
              const large = Math.abs(sweep) > Math.PI ? 1 : 0
              const sweepFlag = sweep >= 0 ? 1 : 0
              const startx = cx + Math.cos(a1) * r
              const starty = cy + Math.sin(a1) * r
              const endx = cx + Math.cos(a2) * r
              const endy = cy + Math.sin(a2) * r
              const midAngle = a1 + sweep / 2
              const labelx = cx + Math.cos(midAngle) * (r + 3)
              const labely = cy + Math.sin(midAngle) * (r + 3)
              // arrow direction = tangent to the arc at each end
              const tanSign = sweepFlag ? 1 : -1
              const startTan = [-Math.sin(a1) * tanSign, Math.cos(a1) * tanSign]
              const endTan = [Math.sin(a2) * tanSign, -Math.cos(a2) * tanSign]
              return (
                <g
                  key={d.id}
                  transform={`translate(${pl.x} ${pl.y})`}
                  stroke="#c47f16"
                  fill="#c47f16"
                  strokeWidth={0.25}
                  style={{ cursor: 'move' }}
                  onPointerDown={onDimPointerDown}
                  onContextMenu={dimContextMenu}
                >
                  {/* extension lines from the vertex out along each edge direction to the arc */}
                  <line x1={cx} y1={cy} x2={startx} y2={starty} strokeWidth={0.2} strokeDasharray="0.8,0.6" />
                  <line x1={cx} y1={cy} x2={endx} y2={endy} strokeWidth={0.2} strokeDasharray="0.8,0.6" />
                  <path
                    d={`M ${startx} ${starty} A ${r} ${r} 0 ${large} ${sweepFlag} ${endx} ${endy}`}
                    fill="none"
                  />
                  <polygon points={arrow(startx, starty, startTan[0], startTan[1])} stroke="none" />
                  <polygon points={arrow(endx, endy, endTan[0], endTan[1])} stroke="none" />
                  <text x={labelx} y={labely} fontSize={3.4} textAnchor="middle" stroke="none">
                    {text}
                  </text>
                  {renderTolerance(labelx, labely + 4, 'middle')}
                </g>
              )
            }
            // fall back to a corner label (no witness lines) only for a
            // dimension whose geometry genuinely can't be resolved.
            if (!geom) {
              return (
                <g key={d.id}>
                  <text
                    x={pl.x + 2}
                    y={pl.y - 2}
                    fontSize={3.4}
                    textAnchor="middle"
                    fill="#c47f16"
                    onContextMenu={dimContextMenu}
                  >
                    {text}
                  </text>
                  {renderTolerance(pl.x + 2, pl.y - 2, 'middle')}
                </g>
              )
            }
            const [p1x, p1y] = uvToLocal(pl, geom.p1)
            const [p2x, p2y] = uvToLocal(pl, geom.p2)
            const [labelX, labelY] = uvToLocal(pl, geom.labelUV)
            // the dimension line runs through the label, parallel to p1->p2;
            // each witness (extension) line runs from its measured point out
            // to that dimension line, standard technical-drawing convention.
            const dx = p2x - p1x
            const dy = p2y - p1y
            const len = Math.hypot(dx, dy) || 1
            const ux = dx / len
            const uy = dy / len
            // perpendicular offset of the dimension line from the p1-p2 axis,
            // i.e. how far the label was dragged off that axis
            const midx = (p1x + p2x) / 2
            const midy = (p1y + p2y) / 2
            const offX = labelX - midx
            const offY = labelY - midy
            const perpOff = offX * -uy + offY * ux // signed distance along the perpendicular
            const dlx1 = p1x - uy * perpOff
            const dly1 = p1y + ux * perpOff
            const dlx2 = p2x - uy * perpOff
            const dly2 = p2y + ux * perpOff
            return (
              <g
                key={d.id}
                transform={`translate(${pl.x} ${pl.y})`}
                stroke="#c47f16"
                fill="#c47f16"
                strokeWidth={0.25}
                style={{ cursor: 'move' }}
                onPointerDown={onDimPointerDown}
                onContextMenu={dimContextMenu}
              >
                {/* extension (witness) lines: from each measured point out to the dimension line */}
                <line x1={p1x} y1={p1y} x2={dlx1} y2={dly1} strokeWidth={0.2} />
                <line x1={p2x} y1={p2y} x2={dlx2} y2={dly2} strokeWidth={0.2} />
                {/* dimension line, split around the label */}
                <line x1={dlx1} y1={dly1} x2={labelX - ux * 6} y2={labelY - uy * 6} />
                <line x1={labelX + ux * 6} y1={labelY + uy * 6} x2={dlx2} y2={dly2} />
                <polygon points={arrow(dlx1, dly1, -ux, -uy)} stroke="none" />
                <polygon points={arrow(dlx2, dly2, ux, uy)} stroke="none" />
                <text x={labelX} y={labelY} fontSize={3.4} textAnchor="middle" stroke="none">
                  {text}
                </text>
                {renderTolerance(labelX, labelY + 4, 'middle')}
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
              fontWeight={n.textStyle === 'Bold' || n.textStyle === 'Bold-Italic' ? 'bold' : undefined}
              fontStyle={n.textStyle === 'Italic' || n.textStyle === 'Bold-Italic' ? 'italic' : undefined}
              fill={selNote === n.id || selMultiNotes.has(n.id) ? '#0696d7' : n.color || '#333'}
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
                setSelTableId(null)
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
              {/* split on real newlines into separate lines - plain SVG
                  <text> collapses \n like any other whitespace, so a
                  multi-line note used to render as one run-on line (user
                  report, 2026-09-19: "I also can't seem to make multi-line
                  notes"). dy="1.2em" on every line after the first spaces
                  them at a normal line-height below the previous one. */}
              {n.text.split('\n').map((line, i) => (
                <tspan key={i} x={n.x} dy={i === 0 ? 0 : '1.2em'}>
                  {line || ' '}
                </tspan>
              ))}
            </text>
          ))}

          {tables.map((table) => {
            const rowH = table.rowHeight
            // per-column width, falling back to the shared derived width for
            // any column with no explicit override (table.colWidths[i]) or
            // the legacy single-value override map (columnWidthOverride,
            // still read for a table where the user set one before per-
            // column widths existed but hasn't touched it since).
            const baseColW = columnWidthOverride[table.id] ?? Math.max(20, 130 / table.columns.length)
            const colWAt = (ci: number): number => table.colWidths[ci] ?? baseColW
            const colX = (ci: number): number => {
              let x = 0
              for (let i = 0; i < ci; i++) x += colWAt(i)
              return x
            }
            const tableW = table.columns.reduce((sum, _c, i) => sum + colWAt(i), 0)
            const tableH = rowH * (table.rows.length + 1)
            // which (r, c) data cells a merge covers, and the top-left cell
            // each merge is keyed by - a covered-but-not-top-left cell
            // renders nothing (its old value is kept underneath so unmerge
            // can restore it, per mergeTableCells' server-side contract).
            const mergeAt = (r: number, c: number): TableMerge | undefined =>
              table.merges.find((m) => r >= m.r && r < m.r + m.rs && c >= m.c && c < m.c + m.cs)
            const tableContextMenu = (e: React.MouseEvent): void => {
              e.preventDefault()
              setMenu(null)
              setDimMenu({
                x: e.clientX,
                y: e.clientY,
                items: [
                  { label: 'Add Row', onClick: () => void addTableRow(table.id) },
                  { label: 'Add Column', onClick: () => void addTableColumn(table.id) },
                  { separator: true, label: '' },
                  {
                    label: table.showGrid ? 'Hide Grid Lines' : 'Show Grid Lines',
                    onClick: () => setTableGridStyle(table.id, { showGrid: !table.showGrid })
                  },
                  {
                    label: 'Grid Color…',
                    onClick: () => {
                      void (async () => {
                        const res = await promptForm('Table Grid', [
                          { key: 'color', label: 'Grid line color (hex)', value: table.gridColor }
                        ])
                        if (res) setTableGridStyle(table.id, { gridColor: res.color || '#111' })
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
                        if (res) setTableGridStyle(table.id, { rowHeight: Number(res.h) || 5 })
                      })()
                    }
                  },
                  {
                    label: 'Column Width (all)…',
                    onClick: () => {
                      void (async () => {
                        const res = await promptForm('Table Grid', [
                          { key: 'w', label: 'Column width (mm), all columns', value: String(baseColW) }
                        ])
                        if (!res) return
                        const w = Number(res.w)
                        if (!(w > 0)) return
                        // sets every column to the same width, clearing any
                        // per-column overrides so the result is predictable -
                        // use each column's own "Column Width…" (its header's
                        // right-click menu) to size just one column instead.
                        setColumnWidthOverride((cur) => ({ ...cur, [table.id]: w }))
                        setTableColWidths(table.id, [])
                      })()
                    }
                  },
                  { separator: true, label: '' },
                  { label: 'Save as Template…', onClick: () => void saveTableAsTemplate(table.id) },
                  { label: 'Delete Table', danger: true, onClick: () => void deleteTable(table.id) }
                ]
              })
            }
            const selTable = selTableId === table.id
            return (
              <g
                key={table.id}
                data-table={table.id}
                transform={`translate(${table.x} ${table.y})`}
                // pointerdown on the WHOLE group (not just the background
                // rect below) so a drag started on a cell - which has its own
                // rect on top, for double-click-to-rename / right-click - still
                // bubbles up and moves the table. A per-cell rect only claims
                // double-click/context-menu, never plain click/drag, so this
                // is the sole place a drag can start from.
                onPointerDown={(e) => {
                  if (editingCell) return
                  // still let a cell's own right-click / double-click context
                  // menus win when the pointer is literally on the border
                  // padding, which has no cell rect of its own to bubble from
                  setSel(null)
                  setSelNote(null)
                  setSelMultiViews(new Set())
                  setSelMultiNotes(new Set())
                  setSelTableId(table.id)
                  // a cell's own pointerdown (below, marked data-cell) already
                  // sets selCells for a click that lands on a real cell rect,
                  // and fires before this bubbled handler (DOM bubble order) -
                  // so only clear it here when the click landed on the
                  // padding/border outside any cell (no data-cell to have set
                  // it), otherwise this would wipe out what that handler just set.
                  if (!(e.target as Element).hasAttribute('data-cell')) setSelCells(null)
                  if (!sheetRef.current) return
                  const svg = sheetRef.current.querySelector('svg') as SVGSVGElement
                  const pt = svg.createSVGPoint()
                  pt.x = e.clientX
                  pt.y = e.clientY
                  const p = pt.matrixTransform(svg.getScreenCTM()!.inverse())
                  tableDrag.current = { id: table.id, ox: p.x - table.x, oy: p.y - table.y, origX: table.x, origY: table.y }
                }}
              >
                {/* selection/drag hit area - covers the full table so it's
                    grabbable anywhere, same "whole bbox is live" fix already
                    applied to views (see ViewBox's own comment) rather than
                    needing pixel-perfect border clicks. The actual drag-start
                    lives on the parent <g> above so cell rects (rendered on
                    top, below) don't shadow it; this rect still supplies the
                    selection outline and the table-wide context menu. */}
                <rect
                  x={-1}
                  y={-1}
                  width={tableW + 2}
                  height={tableH + 2}
                  fill="#ffffff01"
                  stroke={selTable ? '#0696d7' : 'transparent'}
                  strokeWidth={0.6}
                  style={{ cursor: 'move' }}
                  onContextMenu={tableContextMenu}
                />
                {table.showGrid && (
                  <g stroke={table.gridColor} strokeWidth={0.25} fill="none">
                    <rect x={0} y={0} width={tableW} height={tableH} />
                    {table.columns.slice(1).map((c, i) => (
                      <line key={c.key} x1={colX(i + 1)} y1={0} x2={colX(i + 1)} y2={tableH} />
                    ))}
                    {table.rows.map((_row, i) => (
                      <line key={`r${i}`} x1={0} y1={rowH * (i + 1)} x2={tableW} y2={rowH * (i + 1)} />
                    ))}
                  </g>
                )}
                {table.columns.map((c, ci) => (
                  <g key={c.key}>
                    <rect
                      x={colX(ci)}
                      y={0}
                      width={colWAt(ci)}
                      height={rowH}
                      fill="transparent"
                      style={{ cursor: 'text' }}
                      onDoubleClick={(e) => {
                        e.stopPropagation()
                        void renameColumn(table.id, ci)
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        setMenu(null)
                        setDimMenu({
                          x: e.clientX,
                          y: e.clientY,
                          items: [
                            { label: 'Rename Column…', onClick: () => void renameColumn(table.id, ci) },
                            {
                              label: 'Column Width…',
                              onClick: () => {
                                void (async () => {
                                  const res = await promptForm('Column Width', [
                                    { key: 'w', label: 'Width (mm)', value: String(colWAt(ci)) }
                                  ])
                                  if (!res) return
                                  const w = Number(res.w)
                                  if (!(w > 0)) return
                                  const next = table.columns.map((_c2, i) => colWAt(i))
                                  next[ci] = w
                                  setTableColWidths(table.id, next)
                                })()
                              }
                            },
                            { label: 'Delete Column', danger: true, onClick: () => void deleteTableColumn(table.id, ci) }
                          ]
                        })
                      }}
                    />
                    <text x={colX(ci) + 1.5} y={rowH - 1.5} fontSize={3.2} fontWeight="bold" style={{ pointerEvents: 'none' }}>
                      {c.header}
                    </text>
                  </g>
                ))}
                {table.rows.map((row, ri) =>
                  table.columns.map((c, ci) => {
                    const m = mergeAt(ri, ci)
                    if (m && !(m.r === ri && m.c === ci)) return null // covered by a merge, not its top-left
                    const spanCols = m ? m.cs : 1
                    const spanRows = m ? m.rs : 1
                    const cellW = Array.from({ length: spanCols }, (_, k) => colWAt(ci + k)).reduce((a, b) => a + b, 0)
                    const cellH = rowH * spanRows
                    const isEditing = editingCell && editingCell.tableId === table.id && editingCell.row === ri && editingCell.col === ci
                    const value = String((row as unknown as Record<string, unknown>)[c.source] ?? '')
                    // the edit box seeds from the RAW row (pre "=NAME"
                    // resolution), not the resolved display value above -
                    // otherwise reopening a parameter-driven cell to edit it
                    // would show its frozen number instead of "=BoltHoleDia".
                    const rawRow = table.rawRows[ri]
                    const editValue = rawRow ? String((rawRow as unknown as Record<string, unknown>)[c.source] ?? '') : value
                    return (
                      <g key={`${ri}-${c.key}`}>
                        <rect
                          data-cell="1"
                          x={colX(ci)}
                          y={rowH * (ri + 1)}
                          width={cellW}
                          height={cellH}
                          fill={isEditing ? '#0696d71a' : 'transparent'}
                          style={{ cursor: 'text' }}
                          onDoubleClick={(e) => {
                            e.stopPropagation()
                            setEditingCell({ tableId: table.id, row: ri, col: ci, value: editValue })
                          }}
                          onContextMenu={(e) => {
                            e.preventDefault()
                            setMenu(null)
                            const items: MenuItem[] = []
                            if (m) {
                              items.push({
                                label: 'Unmerge Cells',
                                onClick: () => void unmergeTableCells(table.id, m.r, m.c)
                              })
                            } else if (selCells && selCells.tableId === table.id) {
                              const r0 = Math.min(selCells.r0, selCells.r1)
                              const r1 = Math.max(selCells.r0, selCells.r1)
                              const c0 = Math.min(selCells.c0, selCells.c1)
                              const c1 = Math.max(selCells.c0, selCells.c1)
                              if (r1 > r0 || c1 > c0) {
                                items.push({
                                  label: 'Merge Cells',
                                  onClick: () => void mergeTableCells(table.id, r0, c0, r1 - r0 + 1, c1 - c0 + 1)
                                })
                              }
                            }
                            items.push({ label: 'Delete Row', danger: true, onClick: () => void deleteTableRow(table.id, ri) })
                            items.push({ label: 'Delete Column', danger: true, onClick: () => void deleteTableColumn(table.id, ci) })
                            setDimMenu({ x: e.clientX, y: e.clientY, items })
                          }}
                          onPointerDown={(e) => {
                            // shift-click extends a rectangular selection
                            // anchored at the first click - the only UI this
                            // needs, since "select a range, right-click,
                            // Merge Cells" is the standard spreadsheet flow
                            // (no drag-select yet, but shift+click covers the
                            // common case without new drag-state plumbing).
                            if (e.shiftKey && selCells && selCells.tableId === table.id) {
                              e.stopPropagation()
                              setSelCells({ ...selCells, r1: ri, c1: ci })
                            } else {
                              setSelCells({ tableId: table.id, r0: ri, c0: ci, r1: ri, c1: ci })
                            }
                          }}
                        />
                        {selCells &&
                          selCells.tableId === table.id &&
                          ri >= Math.min(selCells.r0, selCells.r1) &&
                          ri <= Math.max(selCells.r0, selCells.r1) &&
                          ci >= Math.min(selCells.c0, selCells.c1) &&
                          ci <= Math.max(selCells.c0, selCells.c1) &&
                          !(selCells.r0 === selCells.r1 && selCells.c0 === selCells.c1) && (
                            <rect
                              x={colX(ci)}
                              y={rowH * (ri + 1)}
                              width={cellW}
                              height={cellH}
                              fill="#0696d71a"
                              stroke="none"
                              style={{ pointerEvents: 'none' }}
                            />
                          )}
                        {isEditing ? (
                          <foreignObject x={colX(ci)} y={rowH * (ri + 1)} width={cellW} height={cellH}>
                            <input
                              autoFocus
                              defaultValue={editingCell.value}
                              style={{ width: '100%', height: '100%', fontSize: '3.2px', border: 'none', outline: '1px solid #0696d7', boxSizing: 'border-box' }}
                              onBlur={(e) => {
                                void setTableCell(table.id, ri, c.source, e.currentTarget.value)
                                setEditingCell(null)
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') e.currentTarget.blur()
                                if (e.key === 'Escape') {
                                  e.currentTarget.value = editingCell.value
                                  setEditingCell(null)
                                }
                              }}
                            />
                          </foreignObject>
                        ) : (
                          <text
                            x={colX(ci) + 1.5}
                            y={rowH * (ri + 1) + rowH - 1.5}
                            fontSize={3.2}
                            style={{ cursor: 'text', pointerEvents: 'none' }}
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
          })}

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
