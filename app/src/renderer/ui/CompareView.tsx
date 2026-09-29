import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { CadControls } from '../viewport/CadControls'
import { buildScene } from '../viewport/sceneBuilder'
import type { RenderMesh } from '../rpc'

export interface CompareSide {
  /** e.g. "a1b2c3d - Countersunk lid screws" or "Current" */
  label: string
  /** e.g. "3 hours ago - Josiah Holder" */
  sub?: string
  meshes: RenderMesh[] | null
  error?: string
}

type Diff = 'same' | 'changed' | 'added' | 'removed'
const DIFF_COLOR: Record<Diff, [number, number, number]> = {
  same: [0.62, 0.64, 0.68],
  changed: [0.96, 0.66, 0.16],
  added: [0.3, 0.8, 0.42],
  removed: [0.92, 0.32, 0.3]
}

/** body id -> how it differs between the two versions (by shape signature) */
function diffBodies(a: RenderMesh[], b: RenderMesh[]): Map<string, Diff> {
  const out = new Map<string, Diff>()
  const bm = new Map(b.map((m) => [m.id, m]))
  for (const m of a) {
    const o = bm.get(m.id)
    out.set(m.id, !o ? 'removed' : m.sig && o.sig && m.sig === o.sig ? 'same' : 'changed')
  }
  for (const m of b) if (!out.has(m.id)) out.set(m.id, 'added')
  return out
}

function tint(ms: RenderMesh[], diff: Map<string, Diff>, on: boolean): RenderMesh[] {
  if (!on) return ms
  return ms.map((m) => ({ ...m, color: DIFF_COLOR[diff.get(m.id) ?? 'same'], appearance: undefined }))
}

function lit(scene: THREE.Scene): void {
  scene.add(new THREE.HemisphereLight(0xffffff, 0x30343c, 2.4))
  const key = new THREE.DirectionalLight(0xffffff, 2.0)
  key.position.set(0.6, -1, 1.4)
  scene.add(key)
  const fill = new THREE.DirectionalLight(0xffffff, 0.8)
  fill.position.set(-1.2, 0.8, 0.4)
  scene.add(fill)
}

function disposeTree(o: THREE.Object3D): void {
  o.traverse((c) => {
    const m = c as THREE.Mesh
    m.geometry?.dispose?.()
    const mat = m.material as THREE.Material | THREE.Material[] | undefined
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose())
    else mat?.dispose?.()
  })
}

/**
 * Two versions of a design side by side in the main view (the History
 * panel's compare), one camera for both so orbit/zoom/pan stay in sync.
 * Bodies are coloured by what changed between the versions - or, in
 * overlay mode, the older version is a translucent red ghost over the newer.
 */
export function CompareView({
  left,
  right,
  onClose,
  onSwap
}: {
  left: CompareSide
  right: CompareSide
  onClose: () => void
  onSwap?: () => void
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const [highlight, setHighlight] = useState(true)
  const [overlay, setOverlay] = useState(false)
  const st = useRef<{
    renderer: THREE.WebGLRenderer
    camera: THREE.PerspectiveCamera
    controls: CadControls
    sceneL: THREE.Scene
    sceneR: THREE.Scene
    groupL: THREE.Group | null
    groupR: THREE.Group | null
    framed: boolean
  } | null>(null)
  const overlayRef = useRef(overlay)
  overlayRef.current = overlay

  const diff = useMemo(
    () => (left.meshes && right.meshes ? diffBodies(left.meshes, right.meshes) : new Map<string, Diff>()),
    [left.meshes, right.meshes]
  )
  const counts = useMemo(() => {
    const c: Record<Diff, number> = { same: 0, changed: 0, added: 0, removed: 0 }
    for (const d of diff.values()) c[d]++
    return c
  }, [diff])

  // renderer + shared camera, once
  useEffect(() => {
    const host = hostRef.current!
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.setScissorTest(true)
    host.appendChild(renderer.domElement)
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100000)
    camera.up.set(0, 0, 1)
    camera.position.set(220, -260, 180)
    const controls = new CadControls(camera, renderer.domElement)
    const sceneL = new THREE.Scene()
    const sceneR = new THREE.Scene()
    lit(sceneL)
    lit(sceneR)
    st.current = { renderer, camera, controls, sceneL, sceneR, groupL: null, groupR: null, framed: false }
    let raf = 0
    const bg = new THREE.Color(0x2a2c31)
    const frame = (): void => {
      raf = requestAnimationFrame(frame)
      const w = host.clientWidth
      const h = host.clientHeight
      if (!w || !h) return
      const size = renderer.getSize(new THREE.Vector2())
      if (size.x !== w || size.y !== h) renderer.setSize(w, h)
      controls.update()
      const cam = controls.camera
      renderer.setClearColor(bg)
      if (overlayRef.current) {
        controls.setAspect(w / h)
        renderer.setViewport(0, 0, w, h)
        renderer.setScissor(0, 0, w, h)
        renderer.autoClear = true
        renderer.render(sceneR, cam)
      } else {
        const half = Math.floor(w / 2)
        controls.setAspect(half / h)
        renderer.autoClear = true
        renderer.setViewport(0, 0, half, h)
        renderer.setScissor(0, 0, half, h)
        renderer.render(sceneL, cam)
        renderer.setViewport(half, 0, w - half, h)
        renderer.setScissor(half, 0, w - half, h)
        renderer.render(sceneR, cam)
      }
    }
    frame()
    return () => {
      cancelAnimationFrame(raf)
      controls.dispose()
      for (const g of [st.current?.groupL, st.current?.groupR]) if (g) disposeTree(g)
      renderer.dispose()
      renderer.domElement.remove()
      st.current = null
    }
  }, [])

  // (re)build both sides whenever the versions, colouring or mode change
  useEffect(() => {
    const s = st.current
    if (!s) return
    for (const [key, scene] of [
      ['groupL', s.sceneL],
      ['groupR', s.sceneR]
    ] as const) {
      const g = s[key]
      if (g) {
        scene.remove(g)
        disposeTree(g)
        s[key] = null
      }
    }
    // overlay draws the newer version plus a translucent red ghost of the older
    // in the right-hand scene; the left scene is unused then
    const box = new THREE.Box3()
    if (right.meshes) {
      const built = buildScene(tint(right.meshes, diff, highlight && !overlay))
      s.groupR = built.group
      s.sceneR.add(built.group)
      box.expandByObject(built.group)
    }
    if (left.meshes) {
      const built = buildScene(overlay ? left.meshes : tint(left.meshes, diff, highlight))
      if (overlay) {
        built.group.traverse((c) => {
          const m = c as THREE.Mesh
          const mats = (Array.isArray(m.material) ? m.material : [m.material]).filter(Boolean) as THREE.Material[]
          for (const mat of mats) {
            mat.transparent = true
            mat.opacity = 0.28
            mat.depthWrite = false
            const withColor = mat as THREE.Material & { color?: THREE.Color }
            withColor.color?.setRGB(0.95, 0.3, 0.28)
          }
          c.renderOrder = 20
        })
        s.groupL = built.group
        s.sceneR.add(built.group)
      } else {
        s.groupL = built.group
        s.sceneL.add(built.group)
      }
      box.expandByObject(built.group)
    }
    if (!s.framed && !box.isEmpty()) {
      s.controls.frame(box.getCenter(new THREE.Vector3()), Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1))
      s.framed = true
    }
  }, [left.meshes, right.meshes, diff, highlight, overlay])

  const side = (x: CompareSide, where: 'left' | 'right'): JSX.Element => (
    <div className={`cmp-label cmp-${where}`}>
      <div className="cmp-title">{x.label}</div>
      {x.sub && <div className="cmp-sub">{x.sub}</div>}
      {!x.meshes && !x.error && <div className="cmp-sub">Loading this version…</div>}
      {x.error && <div className="cmp-err">{x.error}</div>}
    </div>
  )

  return (
    <div className="compare-host">
      <div className="cmp-bar">
        <span className="cmp-bar-title">Compare versions</span>
        <span className="cmp-legend">
          <i className="cmp-sw cmp-changed" /> {counts.changed} changed
          <i className="cmp-sw cmp-added" /> {counts.added} added
          <i className="cmp-sw cmp-removed" /> {counts.removed} removed
          <i className="cmp-sw cmp-same" /> {counts.same} same
        </span>
        <span className="cmp-spacer" />
        <label className="cmp-toggle">
          <input type="checkbox" checked={highlight} onChange={(e) => setHighlight(e.target.checked)} /> Highlight changes
        </label>
        <label className="cmp-toggle">
          <input type="checkbox" checked={overlay} onChange={(e) => setOverlay(e.target.checked)} /> Overlay
        </label>
        {onSwap && (
          <button className="git-btn" onClick={onSwap} title="Swap sides">
            ⇄
          </button>
        )}
        <button className="git-btn git-btn-primary" onClick={onClose}>
          Done
        </button>
      </div>
      <div className="cmp-stage" ref={hostRef}>
        {overlay ? (
          <div className="cmp-label cmp-left">
            <div className="cmp-title">
              <span className="cmp-ghost-key" /> {left.label} <span className="cmp-sub">(ghost)</span>
            </div>
            <div className="cmp-title">{right.label}</div>
          </div>
        ) : (
          <>
            {side(left, 'left')}
            {side(right, 'right')}
            <div className="cmp-divider" />
          </>
        )}
      </div>
    </div>
  )
}
