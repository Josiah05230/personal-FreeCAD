/// <reference lib="webworker" />
// Parses a DXF off the UI thread (a 100 MB spline-heavy file takes seconds)
// and hands the points back packed in transferable typed arrays - posting
// millions of [x, y] arrays froze the UI for seconds just deserializing them.
import { parseDxf } from './dxf'

export interface PackedDxf {
  /** x0,y0,x1,y1,... for every polyline back to back */
  coords: Float64Array
  /** index (in points) where each polyline starts, plus a final end marker */
  starts: Int32Array
  texts: { x: number; y: number; h: number; text: string }[]
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
}

self.onmessage = (e: MessageEvent<Uint8Array>): void => {
  try {
    const d = parseDxf(new TextDecoder().decode(e.data))
    let n = 0
    for (const p of d.polylines) n += p.length
    const coords = new Float64Array(n * 2)
    const starts = new Int32Array(d.polylines.length + 1)
    let k = 0
    d.polylines.forEach((p, i) => {
      starts[i] = k
      for (const [x, y] of p) {
        coords[k * 2] = x
        coords[k * 2 + 1] = y
        k++
      }
    })
    starts[d.polylines.length] = k
    const packed: PackedDxf = { coords, starts, texts: d.texts, bounds: d.bounds }
    ;(self as unknown as Worker).postMessage({ ok: true, d: packed }, [coords.buffer, starts.buffer])
  } catch (err) {
    ;(self as unknown as Worker).postMessage({ ok: false, error: String((err as Error)?.message ?? err) })
  }
}
