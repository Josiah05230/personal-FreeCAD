import { useMemo, useRef, useState } from 'react'
import type { DrawingView, AssemblyTree } from '../rpc'
import { basename } from '../util'

interface Placed {
  view: DrawingView
  x: number // sheet mm, top-left of the view box
  y: number
  scale: number
}
interface Dim {
  viewId: string
  a: [number, number]
  b: [number, number]
  kind: 'h' | 'v' | 'aligned'
}

// ISO A3 landscape sheet in mm
const SHEET_W = 420
const SHEET_H = 297
const MARGIN = 10

const flip = (poly: number[][]): [number, number][] => poly.map((p) => [p[0], -p[1]])

function ViewBox({
  placed,
  selected,
  dimMode,
  onDown,
  onAddDim
}: {
  placed: Placed
  selected: boolean
  dimMode: boolean
  onDown: (e: React.PointerEvent) => void
  onAddDim: (d: Dim) => void
}): JSX.Element {
  const { view } = placed
  const [minX, minY, maxX, maxY] = view.bbox
  const w = (maxX - minX) * placed.scale
  const h = (maxY - minY) * placed.scale
  const pending = useRef<[number, number] | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  const toData = (e: React.MouseEvent): [number, number] => {
    const svg = svgRef.current!
    const pt = svg.createSVGPoint()
    pt.x = e.clientX
    pt.y = e.clientY
    const p = pt.matrixTransform(svg.getScreenCTM()!.inverse())
    return [p.x, -p.y]
  }

  return (
    <g transform={`translate(${placed.x} ${placed.y})`}>
      <rect
        width={w}
        height={h}
        fill="none"
        stroke={selected ? '#0696d7' : '#00000022'}
        strokeWidth={0.3}
        style={{ cursor: 'move' }}
        onPointerDown={onDown}
      />
      <svg
        ref={svgRef}
        x={0}
        y={0}
        width={w}
        height={h}
        viewBox={`${minX} ${-maxY} ${maxX - minX} ${maxY - minY}`}
        onClick={
          dimMode
            ? (e) => {
                const p = toData(e)
                if (!pending.current) pending.current = p
                else {
                  const a = pending.current
                  const dx = Math.abs(p[0] - a[0])
                  const dy = Math.abs(p[1] - a[1])
                  onAddDim({
                    viewId: view.id,
                    a,
                    b: p,
                    kind: dx > dy * 3 ? 'h' : dy > dx * 3 ? 'v' : 'aligned'
                  })
                  pending.current = null
                }
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

const DIRS = ['front', 'top', 'right', 'left', 'back', 'bottom', 'iso'] as const

/**
 * Drawing sheet - starts blank. Add views one at a time (pick an orientation),
 * drag them to place, or hit Auto-layout for a standard 3-view + iso. Dimension
 * tool, title block, BOM, PDF + DXF export.
 */
export function DrawingSheet({
  makeView,
  docPath,
  assembly,
  onBack
}: {
  makeView: (dir: string) => Promise<DrawingView | null>
  docPath: string | null
  assembly: AssemblyTree | null
  onBack: () => void
}): JSX.Element {
  const [placed, setPlaced] = useState<Placed[]>([])
  const [sel, setSel] = useState<number | null>(null)
  const [dims, setDims] = useState<Dim[]>([])
  const [dimMode, setDimMode] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const sheetRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ i: number; ox: number; oy: number } | null>(null)

  const name = docPath ? basename(docPath).replace(/\.FCStd$/i, '') : 'Untitled'
  const today = useMemo(() => new Date().toISOString().slice(0, 10), [])

  const addView = async (dir: string): Promise<void> => {
    setAddOpen(false)
    const v = await makeView(dir)
    if (!v) return
    const [minX, minY, maxX, maxY] = v.bbox
    const fit = Math.min(120 / Math.max(maxX - minX, 1), 90 / Math.max(maxY - minY, 1), 2)
    setPlaced((cur) => [
      ...cur,
      { view: v, x: MARGIN + 6 + cur.length * 12, y: MARGIN + 20 + cur.length * 12, scale: fit }
    ])
  }

  const autoLayout = async (): Promise<void> => {
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
    }
  }

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

  const exportPdf = async (): Promise<void> => {
    const p = await window.cad.saveDialog(docPath ? docPath.replace(/\.FCStd$/i, '.pdf') : undefined)
    if (!p || !sheetRef.current) return
    const html = `<!doctype html><meta charset="utf-8"><style>
      html,body{margin:0;background:#fff}svg{width:100%;height:auto}
      polyline{vector-effect:non-scaling-stroke}</style>${sheetRef.current.innerHTML}`
    await window.cad.exportPdf(html, p)
  }
  const exportDxf = async (): Promise<void> => {
    const p = await window.cad.saveDialog(docPath ? docPath.replace(/\.FCStd$/i, '.dxf') : undefined)
    if (!p) return
    await window.cad.writeText(viewsToDxf(placed), p)
  }

  const bom = assembly?.components.length
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
        <span className="drawing-title">Drawing — blank sheet</span>
        <div className="drawing-add">
          <button className="drawing-adddir" onClick={() => setAddOpen((v) => !v)}>
            + Add View ▾
          </button>
          {addOpen && (
            <div className="drawing-addmenu">
              {DIRS.map((d) => (
                <div key={d} onClick={() => void addView(d)}>
                  {d}
                </div>
              ))}
            </div>
          )}
        </div>
        <button className="drawing-adddir" onClick={() => void autoLayout()}>
          Auto-layout
        </button>
        <button
          className={dimMode ? 'drawing-adddir on' : 'drawing-adddir'}
          onClick={() => setDimMode((v) => !v)}
        >
          Dimension
        </button>
        {(dims.length > 0 || placed.length > 0) && (
          <button
            className="drawing-adddir"
            onClick={() => {
              setPlaced([])
              setDims([])
            }}
          >
            Clear
          </button>
        )}
        <span className="drawing-spacer" />
        <button className="drawing-export" onClick={() => void exportPdf()}>
          PDF
        </button>
        <button className="drawing-export" onClick={() => void exportDxf()}>
          DXF
        </button>
      </div>

      <div className="drawing-sheet" ref={sheetRef}>
        <svg
          className="drawing-page-svg"
          viewBox={`0 0 ${SHEET_W} ${SHEET_H}`}
          onPointerMove={onPointerMove}
          onPointerUp={() => (drag.current = null)}
          onClick={(e) => {
            if (e.target === e.currentTarget) setSel(null)
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
              key={pl.view.id + i}
              placed={pl}
              selected={sel === i}
              dimMode={dimMode}
              onDown={(e) => {
                setSel(i)
                const svg = (e.currentTarget as SVGElement).ownerSVGElement!
                const pt = svg.createSVGPoint()
                pt.x = e.clientX
                pt.y = e.clientY
                const p = pt.matrixTransform(svg.getScreenCTM()!.inverse())
                drag.current = { i, ox: p.x - pl.x, oy: p.y - pl.y }
              }}
              onAddDim={(d) => setDims((cur) => [...cur, d])}
            />
          ))}

          {dims.map((d, i) => {
            const pl = placed.find((p) => p.view.id === d.viewId)
            if (!pl) return null
            const A: [number, number] = [pl.x + d.a[0], pl.y - d.a[1]]
            const B: [number, number] = [pl.x + d.b[0], pl.y - d.b[1]]
            const val =
              d.kind === 'h'
                ? Math.abs(d.b[0] - d.a[0])
                : d.kind === 'v'
                  ? Math.abs(d.b[1] - d.a[1])
                  : Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1])
            return (
              <g key={i} stroke="#c47f16" fill="#c47f16" strokeWidth={0.3}>
                <line x1={A[0]} y1={A[1]} x2={B[0]} y2={B[1]} />
                <text
                  x={(A[0] + B[0]) / 2}
                  y={(A[1] + B[1]) / 2 - 1.5}
                  fontSize={3.4}
                  textAnchor="middle"
                  stroke="none"
                >
                  {val.toFixed(1)}
                </text>
              </g>
            )
          })}

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

          {/* BOM */}
          {bom.length > 0 && (
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
        </svg>
      </div>
    </div>
  )
}
