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
}

// ISO A3 landscape sheet in mm
const SHEET_W = 420
const SHEET_H = 297
const MARGIN = 10

const flip = (poly: number[][]): [number, number][] => poly.map((p) => [p[0], -p[1]])

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
  exportPdf: () => Promise<void>
  exportDxf: () => Promise<void>
}

function ViewBox({
  placed,
  selected,
  tool,
  snapTargets,
  onDown,
  onContextMenu,
  onPick
}: {
  placed: Placed
  selected: boolean
  tool: DrawingTool
  snapTargets: SnapTarget[]
  onDown: (e: React.PointerEvent) => void
  onContextMenu: (e: React.MouseEvent) => void
  onPick: (sub: string, p: [number, number]) => void
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

  return (
    <g transform={`translate(${placed.x} ${placed.y})`}>
      <rect
        width={w}
        height={h}
        fill="none"
        stroke={selected ? '#0696d7' : '#00000022'}
        strokeWidth={0.3}
        style={{
          cursor: tool === 'select' ? 'move' : 'crosshair',
          // in select mode the whole box should drag; in a picking tool
          // (dimension/note/cleanup) only the visible border should
          // intercept clicks (for right-click / drag-select) so clicks
          // through the middle reach the nested view <svg> beneath it for
          // edge/vertex snapping - `fill="none"` alone still hit-tests the
          // whole rect in this Chromium build, confirmed live (a click dead
          // center landed on this rect, never reaching the view svg).
          pointerEvents: tool === 'select' ? 'visiblePainted' : 'stroke'
        }}
        onPointerDown={tool === 'select' ? onDown : undefined}
        onContextMenu={onContextMenu}
      />
      <svg
        ref={svgRef}
        x={0}
        y={0}
        width={w}
        height={h}
        viewBox={`${minX} ${-maxY} ${maxX - minX} ${maxY - minY}`}
        onClick={
          tool === 'dimension' || tool === 'cleanup'
            ? (e) => {
                const p = toData(e)
                const target = nearestTarget(p)
                onPick(target?.sub ?? '', target ? (target.p ?? target.p1 ?? p) : p)
              }
            : undefined
        }
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
      </svg>
      <text x={0} y={h + 4} fontSize={3.4} fill="#333">
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
  const [dims, setDims] = useState<DrawingDimension[]>([])
  const [notes, setNotes] = useState<DrawingNote[]>([])
  const [cleanupLines, setCleanupLines] = useState<Record<string, CleanupLine[]>>({})
  const [snapTargets, setSnapTargets] = useState<Record<string, SnapTarget[]>>({})
  const [table, setTable] = useState<{ id: string; rows: BomRow[]; columns: TableColumn[] } | null>(null)
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
          setTable({ id: c.tables[0].id, rows: c.tables[0].rows, columns: c.tables[0].columns })
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
      setPlaced((cur) => [
        ...cur,
        { view: v, x: MARGIN + 6 + cur.length * 12, y: MARGIN + 20 + cur.length * 12, scale: fit }
      ])
      void refreshSnapTargets(v.id)
    },
    [makeView, refreshSnapTargets]
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

  const onPointerMove = (e: React.PointerEvent): void => {
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
      } catch (e) {
        window.alert((e as Error).message)
      }
    },
    [pageId]
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
              .then((cl) => setCleanupLines((cur) => ({ ...cur, [viewId]: [...(cur[viewId] ?? []), cl] })))
              .catch((e: Error) => window.alert(e.message))
            setCleanupPending(null)
          } else {
            setCleanupPending({ viewId, p })
          }
          return
        }
        onViewPick(viewId)(sub, p)
      },
    [tool, cleanupPending, onViewPick]
  )

  const sectionTool = useCallback(async () => {
    if (sel === null) {
      window.alert('Select a view first, then choose Section View.')
      return
    }
    const base = placed[sel]
    const res = await promptForm('Section View', [
      { key: 'plane', label: 'Cut plane (XY / XZ / YZ)', value: 'XY' },
      { key: 'offset', label: 'Offset (mm)', value: '0' }
    ])
    if (!res) return
    try {
      const v = await api.drawingAddSectionView(
        pageId,
        base.view.id,
        (res.plane.toUpperCase() as 'XY' | 'XZ' | 'YZ') || 'XY',
        Number(res.offset) || 0
      )
      setPlaced((cur) => [
        ...cur,
        { view: v, x: base.x + 60, y: base.y, scale: base.scale }
      ])
      void refreshSnapTargets(v.id)
    } catch (e) {
      window.alert((e as Error).message)
    }
  }, [sel, placed, pageId, refreshSnapTargets])

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
    try {
      const v = await api.drawingAddDetailView(
        pageId,
        base.view.id,
        Number(res.x) || 0,
        Number(res.y) || 0,
        Number(res.radius) || 5
      )
      setPlaced((cur) => [
        ...cur,
        { view: v, x: base.x + 60, y: base.y, scale: Math.max(base.scale, 0.5) }
      ])
      void refreshSnapTargets(v.id)
    } catch (e) {
      window.alert((e as Error).message)
    }
  }, [sel, placed, pageId, refreshSnapTargets])

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
    try {
      const v = await api.drawingAddBrokenView(pageId, base.view.id, [
        { axis: (res.axis as 'x' | 'y') || 'x', pos: Number(res.pos) || 0, gap: Number(res.gap) || 10 }
      ])
      setPlaced((cur) => [...cur, { view: v, x: base.x, y: base.y + 80, scale: base.scale }])
      void refreshSnapTargets(v.id)
    } catch (e) {
      window.alert((e as Error).message)
    }
  }, [sel, placed, pageId, refreshSnapTargets])

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

  const insertBom = useCallback(
    async (template?: TableTemplate) => {
      try {
        const { rows } = await api.drawingBomRows(assembly?.assembly ?? undefined)
        if (rows.length === 0) {
          window.alert('No assembly components found for a BOM.')
          return
        }
        const t = await api.drawingMakeTable(
          pageId,
          rows,
          template?.spec.columns,
          template?.spec,
          table?.id
        )
        setTable({ id: t.id, rows: t.rows, columns: t.columns })
      } catch (e) {
        window.alert((e as Error).message)
      }
    },
    [assembly, pageId, table]
  )

  const insertTable = useCallback(
    async (template?: TableTemplate) => {
      await insertBom(template)
    },
    [insertBom]
  )

  const saveAsTemplate = useCallback(async () => {
    if (!table) {
      window.alert('Insert a table first, then save it as a template.')
      return
    }
    const name2 = await promptText('Template name', '')
    if (!name2 || !name2.trim()) return
    try {
      await api.drawingSaveTableTemplate(name2.trim(), { columns: table.columns })
    } catch (e) {
      window.alert((e as Error).message)
    }
  }, [table])

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
      } catch (e) {
        window.alert((e as Error).message)
      }
    },
    [pageId]
  )

  const setDimensionType = useCallback(async (dimId: string, kind: DimensionType) => {
    try {
      const d = await api.drawingSetDimensionType(dimId, kind)
      setDims((cur) => cur.map((x) => (x.id === dimId ? d : x)))
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
      exportPdf,
      exportDxf
    }),
    [addView, autoLayout, setTool, sectionTool, detailTool, brokenTool, insertBom, insertTable, saveAsTemplate, exportPdf, exportDxf]
  )

  const bom = table
    ? []
    : assembly?.components.length
      ? Object.entries(
          assembly.components.reduce<Record<string, number>>((m, c) => {
            m[c.label] = (m[c.label] ?? 0) + 1
            return m
          }, {})
        )
      : []

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
      </div>

      <div className="drawing-sheet" ref={sheetRef}>
        <svg
          className="drawing-page-svg"
          viewBox={`0 0 ${SHEET_W} ${SHEET_H}`}
          onPointerMove={onPointerMove}
          onPointerUp={() => (drag.current = null)}
          onClick={(e) => {
            // the sheet's own white background <rect> sits directly under
            // the root <svg> and should count as "empty sheet," same as the
            // root itself - only a click landing inside a nested per-view
            // <svg> (which has its own onClick for the dimension/cleanup
            // tools) should be excluded here.
            const target = e.target as Element
            const nestedViewSvg = target.closest('svg[viewBox]')
            const clickedInsideView = nestedViewSvg !== null && nestedViewSvg !== e.currentTarget
            if (!clickedInsideView) {
              setSel(null)
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
              selected={sel === i}
              tool={tool}
              snapTargets={snapTargets[pl.view.id] ?? []}
              onDown={(e) => {
                setSel(i)
                const svg = (e.currentTarget as SVGElement).ownerSVGElement!
                const pt = svg.createSVGPoint()
                pt.x = e.clientX
                pt.y = e.clientY
                const p = pt.matrixTransform(svg.getScreenCTM()!.inverse())
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
            <text key={n.id} x={n.x} y={n.y} fontSize={3.4} fill="#333">
              {n.text}
            </text>
          ))}

          {/* legacy client-only BOM block, shown only until a real table is inserted */}
          {!table && bom.length > 0 && (
            <g transform={`translate(${MARGIN + 4} ${MARGIN + 4})`}>
              <text fontSize={3.6} fontWeight="bold">
                BOM
              </text>
              {bom.map(([label, qty], i) => (
                <text key={label} y={6 + i * 5} fontSize={3.2}>
                  {i + 1}. {label} × {qty}
                </text>
              ))}
            </g>
          )}

          {table && (
            <g transform={`translate(${MARGIN + 4} ${MARGIN + 4})`}>
              <text fontSize={3.6} fontWeight="bold">
                {table.columns.map((c) => c.header).join('   ')}
              </text>
              {table.rows.map((row, i) => (
                <text key={row.index} y={6 + i * 5} fontSize={3.2}>
                  {table.columns.map((c) => (row as unknown as Record<string, unknown>)[c.source] ?? '').join('   ')}
                </text>
              ))}
            </g>
          )}

          {/* title block */}
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
            { label: 'Convert to Normal', onClick: () => void convertView(menu.viewId, 'part') }
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
