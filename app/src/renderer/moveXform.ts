/**
 * Move/Copy (F360 "Move/Copy" on bodies) - the pure maths shared by the live
 * client-side preview and the commit, so what you see while the dialog is open
 * is exactly what body.moveCopy does on OK.
 *
 * The preview never touches the engine: the Viewport transforms the selected
 * bodies' three.js nodes by `moveMatrix(params)` (a world-space delta, the
 * same one the sidecar left-multiplies onto each object's Placement), and
 * restores them exactly on Cancel.
 */
import * as THREE from 'three'
import type { RenderMesh, Selection } from './rpc'
import type { OpValues } from './ui/OperationDialog'

export type Vec3 = [number, number, number]
export type MoveMode = 'translate' | 'rotate' | 'pointToPoint'

/** body.moveCopy params (see sidecar/gwtcad/xform.py move_copy) */
export interface MoveParams {
  ids: string[]
  mode: MoveMode
  dx: number
  dy: number
  dz: number
  axisBase: Vec3
  axisDir: Vec3
  /** degrees, right-handed about axisDir */
  angle: number
  fromPoint: Vec3
  toPoint: Vec3
  createCopy: boolean
  copies: number
}

/** what the Viewport needs to draw the preview + the on-canvas manipulator */
export interface BodyXformView {
  ids: string[]
  /** world delta, column-major (THREE.Matrix4.elements) */
  matrix: number[]
  /** 0 = move the bodies in place; n = n ghost copies (delta^1..delta^n),
   *  originals stay put - mirrors createCopy/copies */
  copies: number
  gizmo: MoveGizmoSpec | null
}

export interface MoveGizmoSpec {
  /** where the triad sits (world) */
  origin: Vec3
  mode: 'translate' | 'rotate'
  /** rotate mode: one ring per axis. `continues` = dragging it adds to the
   *  current angle (it IS the dialog's axis); otherwise a drag starts that
   *  axis from 0, the old rotation is dropped */
  rings?: Array<{ id: string; axis: Vec3; continues: boolean }>
}

export const MOVE_MODES: Record<string, MoveMode> = {
  Translate: 'translate',
  Rotate: 'rotate',
  'Point to Point': 'pointToPoint'
}

const WORLD_AXES: Record<string, Vec3> = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] }

const v3 = (p: Vec3): THREE.Vector3 => new THREE.Vector3(p[0], p[1], p[2])
const arr = (v: THREE.Vector3): Vec3 => [v.x, v.y, v.z]

/** centre of the target bodies' combined bounding box (committed geometry) -
 *  the manipulator's home and the pivot for an X / Y / Z rotation */
export function movePivot(meshes: RenderMesh[], ids: string[]): Vec3 | null {
  const box = new THREE.Box3()
  let any = false
  for (const m of meshes) {
    if (!ids.includes(m.id) || !m.bbox) continue
    box.expandByPoint(v3(m.bbox.min))
    box.expandByPoint(v3(m.bbox.max))
    any = true
  }
  return any ? arr(box.getCenter(new THREE.Vector3())) : null
}

function edgePoints(sel: Selection, meshes: RenderMesh[]): THREE.Vector3[] | null {
  if (sel.kind !== 'edge') return null
  const m = meshes.find((x) => x.id === sel.bodyId)
  const e = m?.edges.find((x) => `Edge${x.edge + 1}` === sel.sub)
  if (!e || e.points.length < 6) return null
  const out: THREE.Vector3[] = []
  for (let i = 0; i + 2 < e.points.length; i += 3)
    out.push(new THREE.Vector3(e.points[i], e.points[i + 1], e.points[i + 2]))
  return out
}

/** circumcentre of three points, or null when they are (nearly) collinear */
function circumcentre(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): THREE.Vector3 | null {
  const ab = b.clone().sub(a)
  const ac = c.clone().sub(a)
  const n = ab.clone().cross(ac)
  const n2 = n.lengthSq()
  if (n2 < 1e-12 * Math.max(ab.lengthSq() * ac.lengthSq(), 1e-12)) return null
  // a + ((|ac|^2 (n x ab)) + (|ab|^2 (ac x n))) / (2 |n|^2)
  const t1 = n.clone().cross(ab).multiplyScalar(ac.lengthSq())
  const t2 = ac.clone().cross(n).multiplyScalar(ab.lengthSq())
  return a.clone().add(t1.add(t2).multiplyScalar(1 / (2 * n2)))
}

type EdgeShape =
  | { kind: 'line'; a: THREE.Vector3; b: THREE.Vector3 }
  | { kind: 'arc'; centre: THREE.Vector3; normal: THREE.Vector3 }
  | { kind: 'other' }

/** classify a tessellated edge: straight line, circle / arc, or other */
function edgeShape(pts: THREE.Vector3[]): EdgeShape {
  const a = pts[0]
  const b = pts[pts.length - 1]
  const len = pts.reduce((s, p, i) => (i ? s + p.distanceTo(pts[i - 1]) : 0), 0)
  if (len < 1e-9) return { kind: 'other' }
  const chord = b.clone().sub(a)
  if (chord.length() > 1e-9) {
    const dir = chord.clone().normalize()
    let dev = 0
    for (const p of pts) {
      const d = p.clone().sub(a)
      dev = Math.max(dev, d.sub(dir.clone().multiplyScalar(d.dot(dir))).length())
    }
    if (dev < Math.max(1e-4, len * 1e-4)) return { kind: 'line', a, b }
  }
  if (pts.length < 4) return { kind: 'other' }
  // closed circle: first == last, so sample around it instead of the ends
  const n = pts.length
  const p0 = pts[0]
  const p1 = pts[Math.floor(n / 3)]
  const p2 = pts[Math.floor((2 * n) / 3)]
  const c = circumcentre(p0, p1, p2)
  if (!c) return { kind: 'other' }
  const r = c.distanceTo(p0)
  if (!(r > 1e-9) || pts.some((p) => Math.abs(p.distanceTo(c) - r) > r * 0.02)) return { kind: 'other' }
  const normal = p1.clone().sub(c).cross(p2.clone().sub(c)).normalize()
  return { kind: 'arc', centre: c, normal }
}

/** A picked point snapped the way F360's point-to-point does: a vertex is
 *  exact; a straight edge snaps to its nearer end or its midpoint; a circle /
 *  arc snaps to its centre; a face (or anything else) keeps the click point.
 *  Coordinates are model space (the Picker reports them un-previewed). */
export function snapPickPoint(sel: Selection, meshes: RenderMesh[]): Vec3 | null {
  if (sel.kind === 'vertex' || sel.kind === 'face') return sel.point
  if (sel.kind !== 'edge') return null
  const pts = edgePoints(sel, meshes)
  if (!pts) return sel.point
  const s = edgeShape(pts)
  if (s.kind === 'arc') return arr(s.centre)
  if (s.kind === 'line') {
    const click = v3(sel.point)
    const cands = [s.a, s.b, s.a.clone().add(s.b).multiplyScalar(0.5)]
    cands.sort((p, q) => p.distanceTo(click) - q.distanceTo(click))
    return arr(cands[0])
  }
  return sel.point
}

/** rotation axis from a picked edge: a line through its two ends, or a
 *  circle / arc's centre + plane normal */
export function edgeAxis(sel: Selection, meshes: RenderMesh[]): { base: Vec3; dir: Vec3 } | null {
  const pts = edgePoints(sel, meshes)
  if (!pts) return null
  const s = edgeShape(pts)
  if (s.kind === 'line') return { base: arr(s.a), dir: arr(s.b.clone().sub(s.a).normalize()) }
  if (s.kind === 'arc') return { base: arr(s.centre), dir: arr(s.normal) }
  return null
}

/** the target bodies: the dialog's Objects box, else (bridge / older callers
 *  without slot info) any body - or owner of a picked face - in the selection */
export function moveTargets(
  slotSel: Record<string, Selection[]> | null | undefined,
  selection: Selection[]
): string[] {
  const src = slotSel?.objects ?? selection
  const ids: string[] = []
  for (const s of src) {
    const id =
      s.kind === 'body' || (!slotSel?.objects && s.kind === 'face') ? (s as { bodyId: string }).bodyId : null
    if (id && !ids.includes(id)) ids.push(id)
  }
  return ids
}

/**
 * Dialog values + picks -> body.moveCopy params. `strict` (the commit) throws a
 * user-facing message for a missing pick; the preview gets null instead.
 * Returns undefined when a number field holds something that is not (yet) a
 * plain number - the preview keeps its last good state while you type.
 */
export function moveParams(
  v: OpValues,
  slotSel: Record<string, Selection[]> | null | undefined,
  selection: Selection[],
  meshes: RenderMesh[],
  strict = false
): MoveParams | null | undefined {
  const fail = (msg: string): null => {
    if (strict) throw new Error(msg)
    return null
  }
  const ids = moveTargets(slotSel, selection)
  if (!ids.length) return fail('Select the body (or bodies) to move.')
  const mode = MOVE_MODES[String(v.mode ?? 'Translate')] ?? 'translate'
  const num = (k: string, dflt: number): number | undefined => {
    const raw = v[k]
    if (raw === undefined || raw === '') return dflt
    const n = Number(raw)
    return Number.isFinite(n) ? n : undefined
  }
  const copies = Math.max(1, Math.round(num('copies', 1) ?? 1))
  const p: MoveParams = {
    ids,
    mode,
    dx: 0,
    dy: 0,
    dz: 0,
    axisBase: [0, 0, 0],
    axisDir: [0, 0, 1],
    angle: 0,
    fromPoint: [0, 0, 0],
    toPoint: [0, 0, 0],
    createCopy: Boolean(v.createCopy),
    copies
  }
  if (mode === 'translate') {
    const dx = num('dx', 0)
    const dy = num('dy', 0)
    const dz = num('dz', 0)
    if (dx === undefined || dy === undefined || dz === undefined) return undefined
    Object.assign(p, { dx, dy, dz })
  } else if (mode === 'rotate') {
    const angle = num('angle', 0)
    if (angle === undefined) return undefined
    p.angle = angle
    const axis = String(v.axis ?? 'Z')
    if (WORLD_AXES[axis]) {
      p.axisDir = WORLD_AXES[axis]
      p.axisBase = movePivot(meshes, ids) ?? [0, 0, 0]
    } else {
      const edge = (slotSel?.axis ?? selection).find((s) => s.kind === 'edge')
      const ax = edge ? edgeAxis(edge, meshes) : null
      if (!ax) return fail('Pick a straight or circular edge for the rotation axis.')
      p.axisBase = ax.base
      p.axisDir = ax.dir
    }
  } else {
    const from = slotSel?.from?.[0]
    const to = slotSel?.to?.[0]
    const fp = from ? snapPickPoint(from, meshes) : null
    const tp = to ? snapPickPoint(to, meshes) : null
    if (!fp || !tp) return fail('Pick the point to move FROM, then the point to move TO.')
    p.fromPoint = fp
    p.toPoint = tp
  }
  return p
}

/** the world delta body.moveCopy applies (left-multiplied onto Placement) */
export function moveMatrix(p: MoveParams): THREE.Matrix4 {
  if (p.mode === 'translate') return new THREE.Matrix4().makeTranslation(p.dx, p.dy, p.dz)
  if (p.mode === 'pointToPoint') {
    const d = v3(p.toPoint).sub(v3(p.fromPoint))
    return new THREE.Matrix4().makeTranslation(d.x, d.y, d.z)
  }
  // T(base) * R(axis, angle) * T(-base) - same composition as the sidecar
  const b = v3(p.axisBase)
  const axis = v3(p.axisDir).normalize()
  return new THREE.Matrix4()
    .makeTranslation(b.x, b.y, b.z)
    .multiply(new THREE.Matrix4().makeRotationAxis(axis, THREE.MathUtils.degToRad(p.angle)))
    .multiply(new THREE.Matrix4().makeTranslation(-b.x, -b.y, -b.z))
}

/** preview + manipulator for the current dialog state: null = nothing to
 *  preview (no targets / missing picks), undefined = a number is mid-edit */
export function movePreviewView(
  v: OpValues,
  slotSel: Record<string, Selection[]> | null | undefined,
  meshes: RenderMesh[]
): BodyXformView | null | undefined {
  const p = moveParams(v, slotSel, [], meshes)
  if (p === undefined) return undefined
  if (p === null) {
    // targets but no point picks yet: nothing moves, nothing to drag
    return null
  }
  const M = moveMatrix(p)
  const pivot = movePivot(meshes, p.ids)
  let gizmo: MoveGizmoSpec | null = null
  if (pivot && p.mode === 'translate') {
    // the triad rides along with the (first copy of the) bodies
    gizmo = { origin: [pivot[0] + p.dx, pivot[1] + p.dy, pivot[2] + p.dz], mode: 'translate' }
  } else if (pivot && p.mode === 'rotate') {
    const axis = String(v.axis ?? 'Z')
    if (WORLD_AXES[axis]) {
      gizmo = {
        origin: pivot,
        mode: 'rotate',
        rings: Object.entries(WORLD_AXES).map(([id, a]) => ({ id, axis: a, continues: id === axis }))
      }
    } else {
      // one ring about the picked edge, centred where the axis passes
      // closest to the bodies
      const b = v3(p.axisBase)
      const d = v3(p.axisDir).normalize()
      const o = b.clone().add(d.clone().multiplyScalar(v3(pivot).sub(b).dot(d)))
      gizmo = { origin: arr(o), mode: 'rotate', rings: [{ id: axis, axis: arr(d), continues: true }] }
    }
  }
  return {
    ids: p.ids,
    matrix: M.elements.slice(),
    copies: p.createCopy ? p.copies : 0,
    gizmo
  }
}
