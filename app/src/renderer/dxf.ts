/**
 * A small DXF reader for viewing: turns the common 2D entities into
 * polylines + text in world XY. Covers LINE, LWPOLYLINE / POLYLINE (with
 * bulge arcs), CIRCLE, ARC, ELLIPSE, SPLINE (evaluated), 3DFACE / SOLID /
 * TRACE outlines, TEXT / MTEXT / ATTRIB,
 * INSERT (block references, nested) and DIMENSION (its anonymous block).
 * Z is ignored; an OCS extrusion pointing down (a mirrored entity, common in
 * CAD exports) is flipped back into world X.
 */
export type Pt = [number, number]
export interface DxfText {
  x: number
  y: number
  h: number
  text: string
}
export interface DxfDrawing {
  polylines: Pt[][]
  texts: DxfText[]
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
}

type Pair = [number, string]
interface Entity {
  type: string
  g: Pair[]
}
interface Block {
  base: Pt
  ents: Entity[]
}
type Xf = (p: Pt) => Pt

const SEGS_PER_TURN = 96

function pairsOf(text: string): Pair[] {
  const lines = text.split(/\r?\n/)
  const out: Pair[] = []
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10)
    if (Number.isNaN(code)) continue
    out.push([code, lines[i + 1].trim()])
  }
  return out
}

const num = (e: Entity, code: number, dflt = 0): number => {
  const p = e.g.find((x) => x[0] === code)
  const v = p ? parseFloat(p[1]) : NaN
  return Number.isFinite(v) ? v : dflt
}
const str = (e: Entity, code: number): string => e.g.find((x) => x[0] === code)?.[1] ?? ''
const all = (e: Entity, code: number): number[] =>
  e.g.filter((x) => x[0] === code).map((x) => parseFloat(x[1]))

function arcPts(cx: number, cy: number, r: number, a0: number, a1: number): Pt[] {
  let sweep = a1 - a0
  while (sweep <= 0) sweep += Math.PI * 2
  const n = Math.max(4, Math.ceil((sweep / (Math.PI * 2)) * SEGS_PER_TURN))
  const out: Pt[] = []
  for (let i = 0; i <= n; i++) {
    const a = a0 + (sweep * i) / n
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)])
  }
  return out
}

/** points along a polyline segment with a DXF bulge (tan of a quarter of the arc angle) */
function bulgeSeg(p0: Pt, p1: Pt, bulge: number): Pt[] {
  if (!bulge) return [p1]
  const theta = 4 * Math.atan(bulge)
  const dx = p1[0] - p0[0]
  const dy = p1[1] - p0[1]
  const chord = Math.hypot(dx, dy)
  if (chord < 1e-12) return [p1]
  const r = chord / (2 * Math.sin(theta / 2))
  const mx = (p0[0] + p1[0]) / 2
  const my = (p0[1] + p1[1]) / 2
  const h = r * Math.cos(theta / 2)
  // centre sits to the left of p0->p1 for a positive (CCW) bulge
  const cx = mx - (dy / chord) * h
  const cy = my + (dx / chord) * h
  const a0 = Math.atan2(p0[1] - cy, p0[0] - cx)
  const n = Math.max(2, Math.ceil((Math.abs(theta) / (Math.PI * 2)) * SEGS_PER_TURN))
  const out: Pt[] = []
  for (let i = 1; i <= n; i++) {
    const a = a0 + (theta * i) / n
    out.push([cx + Math.abs(r) * Math.cos(a), cy + Math.abs(r) * Math.sin(a)])
  }
  out[out.length - 1] = p1
  return out
}

function polyWithBulges(verts: Pt[], bulges: number[], closed: boolean): Pt[] {
  if (!verts.length) return []
  const out: Pt[] = [verts[0]]
  const n = verts.length
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    out.push(...bulgeSeg(verts[i], verts[(i + 1) % n], bulges[i] ?? 0))
  }
  return out
}

/** de Boor evaluation of a (possibly rational) B-spline */
function splinePts(ctrl: Pt[], knots: number[], degree: number, weights: number[]): Pt[] {
  const n = ctrl.length
  if (n < 2 || knots.length !== n + degree + 1) return ctrl
  const lo = knots[degree]
  const hi = knots[n]
  const steps = Math.max(16, n * 12)
  const out: Pt[] = []
  for (let s = 0; s <= steps; s++) {
    const u = s === steps ? hi - 1e-9 * (hi - lo) : lo + ((hi - lo) * s) / steps
    let k = degree
    while (k < n - 1 && u >= knots[k + 1]) k++
    const d: [number, number, number][] = []
    for (let j = 0; j <= degree; j++) {
      const i = k - degree + j
      const w = weights[i] ?? 1
      d.push([ctrl[i][0] * w, ctrl[i][1] * w, w])
    }
    for (let r = 1; r <= degree; r++) {
      for (let j = degree; j >= r; j--) {
        const i = k - degree + j
        const den = knots[i + degree - r + 1] - knots[i]
        const a = den ? (u - knots[i]) / den : 0
        d[j] = [
          (1 - a) * d[j - 1][0] + a * d[j][0],
          (1 - a) * d[j - 1][1] + a * d[j][1],
          (1 - a) * d[j - 1][2] + a * d[j][2]
        ]
      }
    }
    const p = d[degree]
    out.push([p[0] / p[2], p[1] / p[2]])
  }
  return out
}

function cleanMText(s: string): string {
  return s
    .replace(/\\P/g, ' ')
    .replace(/\\[A-Za-z][^;\\{}]*;/g, '')
    .replace(/\\[~]/g, ' ')
    .replace(/[{}]/g, '')
    .replace(/%%[cC]/g, '⌀')
    .replace(/%%[dD]/g, '°')
    .replace(/%%[pP]/g, '±')
}

export function parseDxf(text: string): DxfDrawing {
  const pairs = pairsOf(text)
  const blocks = new Map<string, Block>()
  const top: Entity[] = []
  let section = ''
  let i = 0
  let curBlock: { name: string; b: Block } | null = null
  const readEntity = (): Entity => {
    const e: Entity = { type: pairs[i][1], g: [] }
    i++
    while (i < pairs.length && pairs[i][0] !== 0) e.g.push(pairs[i++])
    return e
  }
  while (i < pairs.length) {
    const [c, v] = pairs[i]
    if (c === 0 && v === 'SECTION') {
      section = pairs[i + 1]?.[0] === 2 ? pairs[i + 1][1] : ''
      i += 2
      continue
    }
    if (c === 0 && v === 'ENDSEC') {
      section = ''
      i++
      continue
    }
    if (c !== 0) {
      i++
      continue
    }
    if (section === 'BLOCKS') {
      if (v === 'BLOCK') {
        const e = readEntity()
        const b: Block = { base: [num(e, 10), num(e, 20)], ents: [] }
        curBlock = { name: str(e, 2), b }
        blocks.set(curBlock.name, b)
      } else if (v === 'ENDBLK') {
        readEntity()
        curBlock = null
      } else {
        const e = readEntity()
        if (curBlock) curBlock.b.ents.push(e)
      }
    } else if (section === 'ENTITIES') {
      top.push(readEntity())
    } else {
      i++
    }
  }

  // POLYLINE ... VERTEX ... SEQEND come as separate entities: group them
  const group = (ents: Entity[]): Entity[] => {
    const out: Entity[] = []
    for (let k = 0; k < ents.length; k++) {
      const e = ents[k]
      if (e.type !== 'POLYLINE') {
        out.push(e)
        continue
      }
      const verts: Entity[] = []
      while (k + 1 < ents.length && ents[k + 1].type === 'VERTEX') verts.push(ents[++k])
      if (k + 1 < ents.length && ents[k + 1].type === 'SEQEND') k++
      out.push({ type: 'POLYLINE', g: [...e.g, [-1, JSON.stringify(verts.map((vx) => [num(vx, 10), num(vx, 20), num(vx, 42)]))]] })
    }
    return out
  }
  for (const b of blocks.values()) b.ents = group(b.ents)

  const polylines: Pt[][] = []
  const texts: DxfText[] = []
  const emit = (e: Entity, xf: Xf, scale: number, depth: number): void => {
    // an OCS extrusion pointing down mirrors the entity's X
    const flip = num(e, 230, 1) < 0
    const oc: Xf = flip ? (p) => xf([-p[0], p[1]]) : xf
    const line = (pts: Pt[]): void => {
      if (pts.length >= 2) polylines.push(pts.map(oc))
    }
    switch (e.type) {
      case 'LINE':
        polylines.push([xf([num(e, 10), num(e, 20)]), xf([num(e, 11), num(e, 21)])])
        break
      case 'LWPOLYLINE': {
        const xs = all(e, 10)
        const ys = all(e, 20)
        const verts: Pt[] = xs.map((x, k) => [x, ys[k] ?? 0])
        // bulges belong to the vertex they follow in the group list
        const bulges: number[] = new Array(verts.length).fill(0)
        let vi = -1
        for (const [c, v] of e.g) {
          if (c === 10) vi++
          else if (c === 42 && vi >= 0) bulges[vi] = parseFloat(v)
        }
        line(polyWithBulges(verts, bulges, (num(e, 70) & 1) === 1))
        break
      }
      case 'POLYLINE': {
        const raw = JSON.parse(str(e, -1) || '[]') as number[][]
        line(polyWithBulges(raw.map((r) => [r[0], r[1]] as Pt), raw.map((r) => r[2]), (num(e, 70) & 1) === 1))
        break
      }
      case 'CIRCLE':
        line(arcPts(num(e, 10), num(e, 20), num(e, 40), 0, Math.PI * 2))
        break
      case 'ARC':
        line(arcPts(num(e, 10), num(e, 20), num(e, 40), (num(e, 50) * Math.PI) / 180, (num(e, 51) * Math.PI) / 180))
        break
      case 'ELLIPSE': {
        const cx = num(e, 10)
        const cy = num(e, 20)
        const mx = num(e, 11)
        const my = num(e, 21)
        const ratio = num(e, 40, 1)
        const t0 = num(e, 41, 0)
        let t1 = num(e, 42, Math.PI * 2)
        if (t1 <= t0) t1 += Math.PI * 2
        const n = Math.max(8, Math.ceil(((t1 - t0) / (Math.PI * 2)) * SEGS_PER_TURN))
        const pts: Pt[] = []
        for (let k = 0; k <= n; k++) {
          const t = t0 + ((t1 - t0) * k) / n
          const c = Math.cos(t)
          const s = Math.sin(t)
          pts.push([cx + mx * c - my * ratio * s, cy + my * c + mx * ratio * s])
        }
        line(pts)
        break
      }
      case 'SPLINE': {
        const cxs = all(e, 10)
        const cys = all(e, 20)
        const ctrl: Pt[] = cxs.map((x, k) => [x, cys[k] ?? 0])
        const fx = all(e, 11)
        const fy = all(e, 21)
        const pts = ctrl.length >= 2 ? splinePts(ctrl, all(e, 40), num(e, 71, 3), all(e, 41)) : fx.map((x, k) => [x, fy[k] ?? 0] as Pt)
        line(pts)
        break
      }
      case '3DFACE':
      case 'SOLID':
      case 'TRACE': {
        // outline of the (3D) face / filled quad; SOLID/TRACE store corners 1,2,4,3
        const c: Pt[] = [
          [num(e, 10), num(e, 20)],
          [num(e, 11), num(e, 21)],
          [num(e, 12), num(e, 22)],
          [num(e, 13, num(e, 12)), num(e, 23, num(e, 22))]
        ]
        const ring = e.type === '3DFACE' ? [c[0], c[1], c[2], c[3], c[0]] : [c[0], c[1], c[3], c[2], c[0]]
        line(ring)
        break
      }
      case 'ATTRIB':
      case 'TEXT':
      case 'MTEXT': {
        const t = e.type === 'MTEXT' ? cleanMText(e.g.filter((x) => x[0] === 3 || x[0] === 1).map((x) => x[1]).join('')) : str(e, 1)
        if (t.trim()) {
          const [x, y] = oc([num(e, 10), num(e, 20)])
          texts.push({ x, y, h: num(e, 40, 2.5) * scale, text: t })
        }
        break
      }
      case 'INSERT':
      case 'DIMENSION': {
        if (depth > 8) break
        const b = blocks.get(str(e, 2))
        if (!b) break
        if (e.type === 'DIMENSION') {
          // the anonymous dimension block is already in world coordinates
          for (const be of b.ents) emit(be, xf, scale, depth + 1)
          break
        }
        const ix = num(e, 10)
        const iy = num(e, 20)
        const sx = num(e, 41, 1)
        const sy = num(e, 42, 1)
        const rot = (num(e, 50) * Math.PI) / 180
        const cr = Math.cos(rot)
        const sr = Math.sin(rot)
        const inner: Xf = (p) => {
          const x = (p[0] - b.base[0]) * sx
          const y = (p[1] - b.base[1]) * sy
          return oc([ix + x * cr - y * sr, iy + x * sr + y * cr])
        }
        for (const be of b.ents) emit(be, inner, scale * Math.abs(sy), depth + 1)
        break
      }
      default:
        break
    }
  }
  const id: Xf = (p) => p
  for (const e of group(top)) emit(e, id, 1, 0)

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const grow = (x: number, y: number): void => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  for (const p of polylines) for (const [x, y] of p) grow(x, y)
  for (const t of texts) grow(t.x, t.y)
  if (minX === Infinity) {
    minX = minY = 0
    maxX = maxY = 1
  }
  return { polylines, texts, bounds: { minX, minY, maxX, maxY } }
}
