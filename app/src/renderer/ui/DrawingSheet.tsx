import { useMemo, useRef, useState } from 'react'
import type { DrawingView, AssemblyTree } from '../rpc'
import { basename } from '../util'

interface Dim {
  view: string
  a: [number, number]
  b: [number, number]
  kind: 'h' | 'v' | 'aligned'
}

const flip = (poly: number[][]): [number, number][] => poly.map((p) => [p[0], -p[1]])

function viewBox(view: DrawingView, pad: number): string {
  const [minX, minY, maxX, maxY] = view.bbox
  return `${minX - pad} ${-(maxY + pad)} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}`
}

function nearestEndpoint(view: DrawingView, x: number, y: number): [number, number] {
  let best: [number, number] = [x, y]
  let bd = Infinity
  for (const poly of [...view.visible, ...view.hidden]) {
    for (const p of poly) {
      const d = Math.hypot(p[0] - x, p[1] - y)
      if (d < bd) {
        bd = d
        best = [p[0], p[1]]
      }
    }
  }
  return bd < 6 ? best : [x, y]
}

function DimLine({ a, b, kind }: { a: [number, number]; b: [number, number]; kind: Dim['kind'] }): JSX.Element {
  const A: [number, number] = [a[0], -a[1]]
  const B: [number, number] = [b[0], -b[1]]
  let text: string
  let mid: [number, number]
  if (kind === 'h') {
    text = Math.abs(b[0] - a[0]).toFixed(1)
    mid = [(A[0] + B[0]) / 2, Math.min(A[1], B[1]) - 6]
  } else if (kind === 'v') {
    text = Math.abs(b[1] - a[1]).toFixed(1)
    mid = [Math.min(A[0], B[0]) - 6, (A[1] + B[1]) / 2]
  } else {
    text = Math.hypot(b[0] - a[0], b[1] - a[1]).toFixed(1)
    mid = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2 - 4]
  }
  return (
    <g stroke="#e8b34a" fill="#e8b34a" strokeWidth={0.4}>
      <line x1={A[0]} y1={A[1]} x2={B[0]} y2={B[1]} />
      <circle cx={A[0]} cy={A[1]} r={0.9} />
      <circle cx={B[0]} cy={B[1]} r={0.9} />
      <text x={mid[0]} y={mid[1]} fontSize={4} textAnchor="middle" stroke="none">
        {text}
      </text>
    </g>
  )
}

function ViewSvg({
  view,
  dims,
  dimMode,
  onAddDim
}: {
  view: DrawingView
  dims: Dim[]
  dimMode: boolean
  onAddDim: (d: Dim) => void
}): JSX.Element {
  const [minX, minY, maxX, maxY] = view.bbox
  const pad = Math.max((maxX - minX) * 0.16, 10)
  const pending = useRef<[number, number] | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  const toData = (e: React.MouseEvent): [number, number] => {
    const svg = svgRef.current!
    const pt = svg.createSVGPoint()
    pt.x = e.clientX
    pt.y = e.clientY
    const m = svg.getScreenCTM()!.inverse()
    const p = pt.matrixTransform(m)
    return nearestEndpoint(view, p.x, -p.y)
  }

  const W = (maxX - minX).toFixed(1)
  const H = (maxY - minY).toFixed(1)

  return (
    <div className="dw-view">
      <div className="dw-view-head">
        {view.label} · {view.direction} · 1:{Math.round(1 / view.scale)}
      </div>
      <svg
        ref={svgRef}
        className="dw-view-svg"
        viewBox={viewBox(view, pad)}
        preserveAspectRatio="xMidYMid meet"
        onClick={
          dimMode
            ? (e) => {
                const p = toData(e)
                if (!pending.current) {
                  pending.current = p
                } else {
                  const a = pending.current
                  const dx = Math.abs(p[0] - a[0])
                  const dy = Math.abs(p[1] - a[1])
                  onAddDim({
                    view: view.id,
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
            stroke="#7f8792"
            strokeWidth={0.35}
            strokeDasharray="1.6 1.2"
          />
        ))}
        {view.visible.map((poly, i) => (
          <polyline
            key={`v${i}`}
            points={flip(poly).map((p) => p.join(',')).join(' ')}
            fill="none"
            stroke="#e9e9ec"
            strokeWidth={0.6}
          />
        ))}
        {/* overall dims */}
        <g stroke="#8a929c" fill="#8a929c" strokeWidth={0.3}>
          <line x1={minX} y1={-(minY - pad * 0.5)} x2={maxX} y2={-(minY - pad * 0.5)} />
          <text x={(minX + maxX) / 2} y={-(minY - pad * 0.5) + 4} fontSize={4} textAnchor="middle" stroke="none">
            {W}
          </text>
          <line x1={minX - pad * 0.5} y1={-minY} x2={minX - pad * 0.5} y2={-maxY} />
          <text
            x={minX - pad * 0.5 - 2}
            y={-(minY + maxY) / 2}
            fontSize={4}
            textAnchor="end"
            stroke="none"
          >
            {H}
          </text>
        </g>
        {dims.filter((d) => d.view === view.id).map((d, i) => (
          <DimLine key={i} a={d.a} b={d.b} kind={d.kind} />
        ))}
      </svg>
    </div>
  )
}

function viewsToDxf(views: DrawingView[]): string {
  const seg: string[] = ['0', 'SECTION', '2', 'ENTITIES']
  let ox = 0
  for (const v of views) {
    const [minX, , maxX] = v.bbox
    for (const poly of v.visible) {
      for (let i = 0; i + 1 < poly.length; i++) {
        const [x1, y1] = poly[i]
        const [x2, y2] = poly[i + 1]
        seg.push(
          '0', 'LINE', '8', v.label,
          '10', String(x1 + ox), '20', String(y1),
          '11', String(x2 + ox), '21', String(y2)
        )
      }
    }
    ox += maxX - minX + 30
  }
  seg.push('0', 'ENDSEC', '0', 'EOF')
  return seg.join('\n')
}

/** A drawing sheet: projected views, title block, dimensions, BOM, PDF/DXF export. */
export function DrawingSheet({
  views,
  docPath,
  assembly,
  onBack,
  onAddView
}: {
  views: DrawingView[]
  docPath: string | null
  assembly: AssemblyTree | null
  onBack: () => void
  onAddView: (dir: string) => void
}): JSX.Element {
  const [dims, setDims] = useState<Dim[]>([])
  const [dimMode, setDimMode] = useState(false)
  const sheetRef = useRef<HTMLDivElement>(null)
  const name = docPath ? basename(docPath).replace(/\.FCStd$/i, '') : 'Untitled'
  const today = useMemo(() => new Date().toISOString().slice(0, 10), [])

  const exportPdf = async (): Promise<void> => {
    const p = await window.cad.saveDialog(
      docPath ? docPath.replace(/\.FCStd$/i, '.pdf') : undefined
    )
    if (!p || !sheetRef.current) return
    const html = `<!doctype html><meta charset="utf-8"><style>
      body{margin:0;background:#fff;color:#111;font:12px system-ui}
      .dw-view-svg{width:46%;height:280px;display:inline-block;margin:1%}
      polyline{vector-effect:non-scaling-stroke}
      .tb{margin:12px;border:1px solid #333;padding:8px;font-size:12px}
    </style>${sheetRef.current.innerHTML}`
    await window.cad.exportPdf(html, p)
  }

  const exportDxf = async (): Promise<void> => {
    const p = await window.cad.saveDialog(
      docPath ? docPath.replace(/\.FCStd$/i, '.dxf') : undefined
    )
    if (!p) return
    await window.cad.writeText(viewsToDxf(views), p)
  }

  return (
    <div className="drawing">
      <div className="drawing-bar">
        <button className="drawing-back" onClick={onBack}>
          ← Model
        </button>
        <span className="drawing-title">Drawing</span>
        <button
          className={dimMode ? 'drawing-adddir on' : 'drawing-adddir'}
          onClick={() => setDimMode((v) => !v)}
        >
          Dimension
        </button>
        <button className="drawing-adddir" onClick={() => setDims([])}>
          Clear dims
        </button>
        <span className="drawing-spacer" />
        {['front', 'top', 'right', 'left', 'back', 'bottom', 'iso'].map((d) => (
          <button key={d} className="drawing-adddir" onClick={() => onAddView(d)}>
            + {d}
          </button>
        ))}
        <button className="drawing-export" onClick={() => void exportPdf()}>
          PDF
        </button>
        <button className="drawing-export" onClick={() => void exportDxf()}>
          DXF
        </button>
      </div>

      <div className="drawing-sheet">
        <div className="drawing-page" ref={sheetRef}>
          {views.length === 0 && <div className="drawing-empty">Add a view.</div>}
          <div className="drawing-grid">
            {views.map((v) => (
              <ViewSvg
                key={v.id}
                view={v}
                dims={dims}
                dimMode={dimMode}
                onAddDim={(d) => setDims((cur) => [...cur, d])}
              />
            ))}
          </div>

          {assembly && assembly.components.length > 0 && (
            <table className="drawing-bom">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Component</th>
                  <th>Qty</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(
                  assembly.components.reduce<Record<string, number>>((m, c) => {
                    m[c.label] = (m[c.label] ?? 0) + 1
                    return m
                  }, {})
                ).map(([label, qty], i) => (
                  <tr key={label}>
                    <td>{i + 1}</td>
                    <td>{label}</td>
                    <td>{qty}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div className="tb drawing-titleblock">
            <div>
              <b>{name}</b>
            </div>
            <div>Date {today}</div>
            <div>Units mm</div>
            <div>Sheet 1 / 1</div>
            <div>GrainWave Technologies</div>
          </div>
        </div>
      </div>
    </div>
  )
}
