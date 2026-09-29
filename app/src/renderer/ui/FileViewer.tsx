import { useCallback, useEffect, useRef, useState } from 'react'
import { extOf } from '../../shared/fileTypes'
import type { PackedDxf } from '../dxfWorker'

/**
 * Opens a picture, SVG, PDF or DXF in the main view as its own tab - just
 * to look at, nothing is inserted into the design. Images, SVGs and DXFs
 * zoom toward the cursor with the wheel and pan by dragging (double-click
 * fits); PDFs use Chromium's own viewer (pages, zoom, search).
 */
export function FileViewer({ path }: { path: string }): JSX.Element {
  const ext = extOf(path)
  const [err, setErr] = useState<string | null>(null)
  const [src, setSrc] = useState<string | null>(null)
  const [dxf, setDxf] = useState<PackedDxf | null>(null)

  useEffect(() => {
    let url: string | null = null
    let live = true
    setErr(null)
    setSrc(null)
    setDxf(null)
    void (async () => {
      try {
        if (ext === 'pdf') {
          const bytes = await window.cad.readBytes(path)
          url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }))
          if (live) setSrc(url)
        } else if (ext === 'dxf') {
          const bytes = await window.cad.readBytes(path)
          const d = await new Promise<PackedDxf>((resolve, reject) => {
            const w = new Worker(new URL('../dxfWorker.ts', import.meta.url), { type: 'module' })
            w.onmessage = (m: MessageEvent<{ ok: boolean; d?: PackedDxf; error?: string }>) => {
              w.terminate()
              if (m.data.ok && m.data.d) resolve(m.data.d)
              else reject(new Error(m.data.error || 'could not read this DXF'))
            }
            w.onerror = (ev) => {
              w.terminate()
              reject(new Error(ev.message || 'could not read this DXF'))
            }
            w.postMessage(bytes)
          })
          if (live) setDxf(d)
        } else {
          const data = await window.cad.readImage(path)
          if (live) setSrc(data)
        }
      } catch (e) {
        if (live) setErr((e as Error).message)
      }
    })()
    return () => {
      live = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [path, ext])

  if (err) return <div className="fileviewer"><div className="fv-msg">Couldn't open this file: {err}</div></div>
  if (ext === 'pdf') {
    return (
      <div className="fileviewer">
        {src ? <iframe className="fv-pdf" src={src} title={path} /> : <div className="fv-msg">Loading…</div>}
      </div>
    )
  }
  if (ext === 'dxf') {
    return (
      <div className="fileviewer">
        {dxf ? <DxfView d={dxf} /> : <div className="fv-msg">Loading…</div>}
      </div>
    )
  }
  return (
    <div className="fileviewer">
      {src ? <ImageView src={src} /> : <div className="fv-msg">Loading…</div>}
    </div>
  )
}

/** wheel-zoom toward the cursor + drag-pan over a CSS-transformed child */
function usePanZoom(natural: { w: number; h: number } | null) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [t, setT] = useState({ x: 0, y: 0, s: 1 })
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null)

  const fit = useCallback(() => {
    const el = hostRef.current
    if (!el || !natural || !natural.w || !natural.h) return
    const s = Math.min(el.clientWidth / natural.w, el.clientHeight / natural.h) * 0.94
    setT({ s, x: (el.clientWidth - natural.w * s) / 2, y: (el.clientHeight - natural.h * s) / 2 })
  }, [natural])
  useEffect(fit, [fit])

  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const px = e.clientX - r.left
      const py = e.clientY - r.top
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1
      const d = Math.max(-240, Math.min(240, e.deltaY * unit))
      const f = Math.exp(-d * (e.ctrlKey ? 0.01 : 0.0018))
      setT((c) => {
        const s = Math.min(Math.max(c.s * f, 0.01), 200)
        const k = s / c.s
        return { s, x: px - (px - c.x) * k, y: py - (py - c.y) * k }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const handlers = {
    onPointerDown: (e: React.PointerEvent) => {
      drag.current = { x: e.clientX, y: e.clientY, tx: t.x, ty: t.y }
      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {
        /* synthetic pointer */
      }
    },
    onPointerMove: (e: React.PointerEvent) => {
      const d = drag.current
      if (d) setT((c) => ({ ...c, x: d.tx + e.clientX - d.x, y: d.ty + e.clientY - d.y }))
    },
    onPointerUp: () => {
      drag.current = null
    },
    onLostPointerCapture: () => {
      drag.current = null
    },
    onDoubleClick: fit
  }
  return { hostRef, t, handlers, fit }
}

function ImageView({ src }: { src: string }): JSX.Element {
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null)
  const { hostRef, t, handlers } = usePanZoom(nat)
  return (
    <div className="fv-stage" ref={hostRef} {...handlers}>
      <img
        className="fv-img"
        src={src}
        alt=""
        draggable={false}
        onLoad={(e) => setNat({ w: e.currentTarget.naturalWidth || 800, h: e.currentTarget.naturalHeight || 600 })}
        style={{ transform: `translate(${t.x}px, ${t.y}px) scale(${t.s})` }}
      />
    </div>
  )
}

/** A DXF drawn on a canvas from one prebuilt Path2D: wheel zooms toward the
 *  cursor, drag pans, double-click fits; only a redraw per change, never a
 *  DOM node per entity (a 100 MB file has tens of thousands of splines). */
function DxfView({ d }: { d: PackedDxf }): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // view: screen px = (world - origin) * s, with Y flipped
  const [v, setV] = useState<{ ox: number; oy: number; s: number } | null>(null)
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)
  const path = useRef<Path2D | null>(null)
  if (!path.current) {
    const p = new Path2D()
    for (let i = 0; i + 1 < d.starts.length; i++) {
      const a = d.starts[i]
      const b = d.starts[i + 1]
      if (b - a < 2) continue
      p.moveTo(d.coords[a * 2], d.coords[a * 2 + 1])
      for (let k = a + 1; k < b; k++) p.lineTo(d.coords[k * 2], d.coords[k * 2 + 1])
    }
    path.current = p
  }
  const fit = useCallback(() => {
    const el = hostRef.current
    if (!el) return
    const w = Math.max(d.bounds.maxX - d.bounds.minX, 1e-9)
    const h = Math.max(d.bounds.maxY - d.bounds.minY, 1e-9)
    const s = Math.min(el.clientWidth / w, el.clientHeight / h) * 0.94
    setV({
      s,
      ox: d.bounds.minX - (el.clientWidth / s - w) / 2,
      oy: d.bounds.maxY + (el.clientHeight / s - h) / 2
    })
  }, [d])
  useEffect(fit, [fit])

  // draw
  useEffect(() => {
    const el = hostRef.current
    const cv = canvasRef.current
    if (!el || !cv || !v || !path.current) return
    const dpr = window.devicePixelRatio || 1
    const W = el.clientWidth
    const H = el.clientHeight
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr)
      cv.height = Math.round(H * dpr)
    }
    const ctx = cv.getContext('2d')
    if (!ctx) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = '#1b1d21'
    ctx.fillRect(0, 0, cv.width, cv.height)
    ctx.setTransform(v.s * dpr, 0, 0, -v.s * dpr, -v.ox * v.s * dpr, v.oy * v.s * dpr)
    ctx.lineWidth = 1 / v.s
    ctx.strokeStyle = '#e6e6e6'
    ctx.stroke(path.current)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = '#e6e6e6'
    for (const t of d.texts) {
      const px = (t.x - v.ox) * v.s
      const py = (v.oy - t.y) * v.s
      const fs = t.h * v.s
      if (fs < 3 || px < -2000 || py < -200 || px > W + 200 || py > H + 200) continue
      ctx.font = `${fs}px sans-serif`
      ctx.fillText(t.text, px, py)
    }
  }, [v, d])

  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const px = e.clientX - r.left
      const py = e.clientY - r.top
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1
      const dd = Math.max(-240, Math.min(240, e.deltaY * unit))
      const f = Math.exp(-dd * (e.ctrlKey ? 0.01 : 0.0018))
      setV((c) => {
        if (!c) return c
        const s = c.s * f
        // keep the world point under the cursor fixed
        const wx = c.ox + px / c.s
        const wy = c.oy - py / c.s
        return { s, ox: wx - px / s, oy: wy + py / s }
      })
    }
    const ro = new ResizeObserver(() => setV((c) => (c ? { ...c } : c)))
    ro.observe(el)
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      el.removeEventListener('wheel', onWheel)
      ro.disconnect()
    }
  }, [])

  return (
    <div
      className="fv-stage fv-dxf"
      ref={hostRef}
      onPointerDown={(e) => {
        if (!v) return
        drag.current = { x: e.clientX, y: e.clientY, ox: v.ox, oy: v.oy }
        try {
          e.currentTarget.setPointerCapture(e.pointerId)
        } catch {
          /* synthetic pointer */
        }
      }}
      onPointerMove={(e) => {
        const g = drag.current
        if (g) setV((c) => (c ? { ...c, ox: g.ox - (e.clientX - g.x) / c.s, oy: g.oy + (e.clientY - g.y) / c.s } : c))
      }}
      onPointerUp={() => (drag.current = null)}
      onLostPointerCapture={() => (drag.current = null)}
      onDoubleClick={fit}
    >
      <canvas ref={canvasRef} className="fv-canvas" data-polylines={d.starts.length - 1} />
      {d.starts.length <= 1 && !d.texts.length && <div className="fv-msg">Nothing drawable found in this DXF.</div>}
    </div>
  )
}
