export function basename(p: string): string {
  const parts = p.split(/[/\\]/)
  return parts[parts.length - 1] || p
}

interface SketchFrameLike {
  origin: [number, number, number]
  x: [number, number, number]
  y: [number, number, number]
}
type Ent = {
  type: 'line' | 'rect' | 'circle' | 'arc'
  a?: [number, number]
  b?: [number, number]
  c?: [number, number]
  r?: number
  a0?: number
  a1?: number
}

/**
 * Project 2D sketch editor entities to world-space polylines (flat [x,y,z,...]),
 * so the shell can paint a finished sketch instantly without waiting for the
 * engine to re-derive it.
 */
export function sketchEntitiesToPolys(ents: Ent[], fr: SketchFrameLike): number[][] {
  const [ox, oy, oz] = fr.origin
  const [xx, xy, xz] = fr.x
  const [yx, yy, yz] = fr.y
  const w = (u: number, v: number): [number, number, number] => [
    ox + xx * u + yx * v,
    oy + xy * u + yy * v,
    oz + xz * u + yz * v
  ]
  const flat = (uv: [number, number][]): number[] => uv.flatMap(([u, v]) => w(u, v))
  const circ = (c: [number, number], r: number, a0 = 0, a1 = Math.PI * 2): [number, number][] => {
    let span = a1 - a0
    if (span <= 0) span += Math.PI * 2
    const n = Math.max(16, Math.round((span / (Math.PI * 2)) * 72))
    const out: [number, number][] = []
    for (let i = 0; i <= n; i++) {
      const t = a0 + (span * i) / n
      out.push([c[0] + Math.cos(t) * r, c[1] + Math.sin(t) * r])
    }
    return out
  }
  const out: number[][] = []
  for (const e of ents) {
    if (e.type === 'line' && e.a && e.b) out.push(flat([e.a, e.b]))
    else if (e.type === 'rect' && e.a && e.b)
      out.push(flat([e.a, [e.b[0], e.a[1]], e.b, [e.a[0], e.b[1]], e.a]))
    else if (e.type === 'circle' && e.c && e.r != null) out.push(flat(circ(e.c, e.r)))
    else if (e.type === 'arc' && e.c && e.r != null)
      out.push(flat(circ(e.c, e.r, e.a0 ?? 0, e.a1 ?? Math.PI * 2)))
  }
  return out
}
