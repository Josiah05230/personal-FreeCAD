import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import type {
  RenderMesh,
  SketchRender,
  Selection,
  DatumDTO,
  PickPlane,
  SketchRef,
  CanvasDTO
} from '../rpc'
import type { ViewportApi } from './types'
import { CadControls } from './CadControls'
import { ViewCube } from './ViewCube'
import { Picker } from './Picker'
import {
  SketchController,
  type SketchFrame,
  type SketchTool,
  type SketchRefGeom
} from './SketchController'
import { buildScene } from './sceneBuilder'

function gradientBackground(): THREE.Texture {
  const c = document.createElement('canvas')
  c.width = 2
  c.height = 256
  const ctx = c.getContext('2d')!
  const g = ctx.createLinearGradient(0, 0, 0, 256)
  g.addColorStop(0, '#20242b')
  g.addColorStop(0.55, '#2b3038')
  g.addColorStop(1, '#3a4048')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 2, 256)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

export function Viewport({
  meshes,
  sketches = [],
  datums = [],
  selection = [],
  onSelect,
  section = null,
  planePickMode = false,
  pickPlanes = [],
  onPickPlane,
  selectMode = 'paint',
  onWindowSelect,
  canvases = [],
  calibrateCanvas = null,
  onCalibrate,
  sketchFrame = null,
  sketchRefGeom = null,
  sketchInitialEntities,
  sketchTool = 'line',
  onSketchChange,
  apiRef
}: {
  meshes: RenderMesh[]
  sketches?: SketchRender[]
  datums?: DatumDTO[]
  selection?: Selection[]
  section?: { plane: 'XY' | 'XZ' | 'YZ'; offset: number; flip: boolean } | null
  onSelect?: (sel: Selection | null, additive: boolean) => void
  planePickMode?: boolean
  pickPlanes?: PickPlane[]
  onPickPlane?: (ref: SketchRef) => void
  selectMode?: 'paint' | 'window'
  onWindowSelect?: (sels: Selection[]) => void
  canvases?: CanvasDTO[]
  calibrateCanvas?: CanvasDTO | null
  onCalibrate?: (measuredMm: number) => void
  sketchFrame?: SketchFrame | null
  sketchRefGeom?: SketchRefGeom | null
  sketchInitialEntities?: unknown[]
  sketchTool?: SketchTool
  onSketchChange?: () => void
  apiRef?: { current: ViewportApi | null }
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const cubeRef = useRef<HTMLDivElement>(null)
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect
  const onSketchChangeRef = useRef(onSketchChange)
  onSketchChangeRef.current = onSketchChange
  const planePickRef = useRef<{ mode: boolean; cb?: (r: SketchRef) => void }>({ mode: false })
  planePickRef.current = { mode: planePickMode, cb: onPickPlane }
  const pickPlanesRef = useRef<PickPlane[]>([])
  pickPlanesRef.current = pickPlanes
  const winSelRef = useRef<{ mode: string; cb?: (s: Selection[]) => void }>({ mode: 'paint' })
  winSelRef.current = { mode: selectMode, cb: onWindowSelect }
  const bandRef = useRef<HTMLDivElement>(null)
  const calibRef = useRef<{
    canvas: CanvasDTO | null
    cb?: (mm: number) => void
    pts: THREE.Vector3[]
    line: THREE.Line | null
  }>({ canvas: null, pts: [], line: null })
  calibRef.current.canvas = calibrateCanvas
  calibRef.current.cb = onCalibrate

  const stateRef = useRef<{
    renderer: THREE.WebGLRenderer
    scene: THREE.Scene
    camera: THREE.PerspectiveCamera
    controls: CadControls
    cube: ViewCube
    picker: Picker
    content: THREE.Group | null
    overlay: THREE.Group
    ghosts: THREE.Group
    sketch: SketchController | null
    framedOnce: boolean
    lastCenter: THREE.Vector3
    lastRadius: number
  } | null>(null)

  useEffect(() => {
    const host = hostRef.current!
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(host.clientWidth, host.clientHeight)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.localClippingEnabled = true
    host.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    scene.background = gradientBackground()

    const camera = new THREE.PerspectiveCamera(35, host.clientWidth / host.clientHeight, 0.1, 100000)
    camera.up.set(0, 0, 1)
    camera.position.set(220, -260, 180)

    scene.add(new THREE.HemisphereLight(0xffffff, 0x30343c, 2.4))
    const key = new THREE.DirectionalLight(0xffffff, 2.0)
    key.position.set(0.6, -1, 1.4)
    scene.add(key)
    const fill = new THREE.DirectionalLight(0xffffff, 0.8)
    fill.position.set(-1.2, 0.8, 0.4)
    scene.add(fill)

    const overlay = new THREE.Group()
    const ghosts = new THREE.Group()
    scene.add(overlay)
    scene.add(ghosts)

    const controls = new CadControls(camera, renderer.domElement)
    const cube = new ViewCube(cubeRef.current!, camera, controls)
    const picker = new Picker(camera, renderer.domElement, overlay)

    stateRef.current = {
      renderer,
      scene,
      camera,
      controls,
      cube,
      picker,
      content: null,
      overlay,
      ghosts,
      sketch: null,
      framedOnce: false,
      lastCenter: new THREE.Vector3(),
      lastRadius: 60
    }

    if (apiRef) {
      apiRef.current = {
        fit: () => {
          const s = stateRef.current
          if (s) s.controls.frame(s.lastCenter, s.lastRadius)
        },
        setView: (dir) => stateRef.current?.cube.goToView(new THREE.Vector3(...dir)),
        getSketchEntities: () => stateRef.current?.sketch?.getEntities() ?? [],
        getNewSketchEntities: () => stateRef.current?.sketch?.getNewEntities() ?? [],
        loadSketchEntities: (ents) => stateRef.current?.sketch?.loadExisting(ents),
        sketchUndo: () => stateRef.current?.sketch?.undo(),
        getSketchConstraints: () => stateRef.current?.sketch?.getConstraints() ?? [],
        applySketchConstraint: (t) => stateRef.current?.sketch?.applyConstraint(t) ?? false,
        availableSketchConstraints: () =>
          stateRef.current?.sketch?.availableConstraints() ?? [],
        sketchSelectedCount: () => stateRef.current?.sketch?.selectedCount ?? 0,
        setSketchConstruction: (on) => stateRef.current?.sketch?.setConstruction(on),
        toggleSketchConstruction: () =>
          stateRef.current?.sketch?.toggleConstruction() ?? false
      }
    }

    // click-to-select (left button, negligible drag)
    let downX = 0
    let downY = 0
    let downBtn = -1
    let banding = false
    const onDown = (e: PointerEvent): void => {
      downX = e.clientX
      downY = e.clientY
      downBtn = e.button
      const st = stateRef.current
      if (
        e.button === 0 &&
        winSelRef.current.mode === 'window' &&
        !st?.sketch &&
        !planePickRef.current.mode
      ) {
        banding = true
        const b = bandRef.current
        if (b) {
          const r = host.getBoundingClientRect()
          b.style.display = 'block'
          b.style.left = `${e.clientX - r.left}px`
          b.style.top = `${e.clientY - r.top}px`
          b.style.width = '0px'
          b.style.height = '0px'
        }
      }
    }
    const onUp = (e: PointerEvent): void => {
      const st = stateRef.current
      if (banding) {
        banding = false
        const b = bandRef.current
        if (b) b.style.display = 'none'
        if (st?.content) {
          const r = host.getBoundingClientRect()
          const sels = st.picker.windowSelect(
            st.content,
            { x0: downX - r.left, y0: downY - r.top, x1: e.clientX - r.left, y1: e.clientY - r.top },
            host.clientWidth,
            host.clientHeight
          )
          winSelRef.current.cb?.(sels)
        }
        return
      }
      if (!st || st.sketch) return // sketch mode owns clicks
      if (downBtn !== 0 || e.button !== 0) return
      if (Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 4) return

      // canvas calibration: click two points on the canvas plane
      const cal = calibRef.current
      if (cal.canvas) {
        const fr = cal.canvas.frame
        const O = new THREE.Vector3(fr.origin[0], fr.origin[1], fr.origin[2])
        const X = new THREE.Vector3(fr.x[0], fr.x[1], fr.x[2]).normalize()
        const Y = new THREE.Vector3(fr.y[0], fr.y[1], fr.y[2]).normalize()
        const n = new THREE.Vector3().crossVectors(X, Y).normalize()
        const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, O)
        const r = host.getBoundingClientRect()
        const ndc = new THREE.Vector2(
          ((e.clientX - r.left) / r.width) * 2 - 1,
          -((e.clientY - r.top) / r.height) * 2 + 1
        )
        const rc = new THREE.Raycaster()
        rc.setFromCamera(ndc, st.camera)
        const hit = new THREE.Vector3()
        if (!rc.ray.intersectPlane(plane, hit)) return
        cal.pts.push(hit)
        if (cal.line) {
          st.overlay.remove(cal.line)
          cal.line.geometry.dispose()
          cal.line = null
        }
        if (cal.pts.length === 2) {
          const mm = cal.pts[0].distanceTo(cal.pts[1])
          cal.pts = []
          cal.cb?.(mm)
        } else {
          const g = new THREE.BufferGeometry().setFromPoints([cal.pts[0], cal.pts[0]])
          cal.line = new THREE.Line(
            g,
            new THREE.LineBasicMaterial({ color: 0xffb020 })
          )
          cal.line.renderOrder = 30
          st.overlay.add(cal.line)
        }
        return
      }

      // sketch-plane pick mode: ghosts first, then a body face
      if (planePickRef.current.mode) {
        const gp = st.picker.pick(e, st.ghosts)
        if (gp && gp.kind === 'sketch') {
          const pp = pickPlanesRef.current.find((p) => p.id === (gp as { sketchId: string }).sketchId)
          if (pp) {
            planePickRef.current.cb?.(
              pp.ptype === 'origin' && pp.role
                ? { kind: 'origin', role: pp.role }
                : { kind: 'plane', id: pp.id }
            )
            return
          }
        }
        if (st.content) {
          const fp = st.picker.pick(e, st.content)
          if (fp && fp.kind === 'face') {
            planePickRef.current.cb?.({ kind: 'face', bodyId: fp.bodyId, sub: fp.sub })
            return
          }
        }
        return
      }

      if (!st.content) return
      const sel = st.picker.pick(e, st.content)
      onSelectRef.current?.(sel, e.shiftKey || e.ctrlKey)
    }
    const onMove = (e: PointerEvent): void => {
      const st = stateRef.current
      if (banding) {
        const b = bandRef.current
        const r = host.getBoundingClientRect()
        if (b) {
          const x = Math.min(e.clientX, downX) - r.left
          const y = Math.min(e.clientY, downY) - r.top
          b.style.left = `${x}px`
          b.style.top = `${y}px`
          b.style.width = `${Math.abs(e.clientX - downX)}px`
          b.style.height = `${Math.abs(e.clientY - downY)}px`
        }
        return
      }
      const cal = calibRef.current
      if (cal.canvas && cal.pts.length === 1 && cal.line && st) {
        const fr = cal.canvas.frame
        const O = new THREE.Vector3(fr.origin[0], fr.origin[1], fr.origin[2])
        const X = new THREE.Vector3(fr.x[0], fr.x[1], fr.x[2]).normalize()
        const Y = new THREE.Vector3(fr.y[0], fr.y[1], fr.y[2]).normalize()
        const n = new THREE.Vector3().crossVectors(X, Y).normalize()
        const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, O)
        const r = host.getBoundingClientRect()
        const ndc = new THREE.Vector2(
          ((e.clientX - r.left) / r.width) * 2 - 1,
          -((e.clientY - r.top) / r.height) * 2 + 1
        )
        const rc = new THREE.Raycaster()
        rc.setFromCamera(ndc, st.camera)
        const hit = new THREE.Vector3()
        if (rc.ray.intersectPlane(plane, hit)) {
          cal.line.geometry.setFromPoints([cal.pts[0], hit])
        }
        return
      }
      if (!st || st.sketch || !st.content || e.buttons !== 0) return
      st.picker.setHover(st.picker.pick(e, st.content), st.content)
    }
    renderer.domElement.addEventListener('pointerdown', onDown)
    renderer.domElement.addEventListener('pointerup', onUp)
    renderer.domElement.addEventListener('pointermove', onMove)

    let raf = 0
    let prev = performance.now()
    const loop = (): void => {
      raf = requestAnimationFrame(loop)
      const now = performance.now()
      const dt = Math.min((now - prev) / 1000, 0.05)
      prev = now
      controls.update()
      cube.update(dt)
      renderer.render(scene, camera)
    }
    loop()

    const ro = new ResizeObserver(() => {
      const w = host.clientWidth
      const h = host.clientHeight
      renderer.setSize(w, h)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    })
    ro.observe(host)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      renderer.domElement.removeEventListener('pointerdown', onDown)
      renderer.domElement.removeEventListener('pointerup', onUp)
      renderer.domElement.removeEventListener('pointermove', onMove)
      cube.dispose()
      controls.dispose()
      renderer.dispose()
      host.removeChild(renderer.domElement)
      if (apiRef) apiRef.current = null
      stateRef.current = null
    }
  }, [apiRef])

  // rebuild content
  useEffect(() => {
    const st = stateRef.current
    if (!st) return
    st.picker.clear()
    if (st.content) {
      st.scene.remove(st.content)
      st.content.traverse((o) => {
        const any = o as THREE.Mesh
        any.geometry?.dispose?.()
        const mat = any.material as THREE.Material | THREE.Material[] | undefined
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose())
        else mat?.dispose()
      })
    }
    if (!meshes.length && !sketches.length && !datums.length && !canvases.length) {
      st.content = null
      return
    }
    const { group, center, radius } = buildScene(meshes, sketches, datums, canvases)
    st.scene.add(group)
    st.content = group
    st.lastCenter = center
    st.lastRadius = radius
    if (!st.framedOnce) {
      st.controls.frame(center, radius)
      st.framedOnce = true
    }
  }, [meshes, sketches, datums, canvases])

  // reflect selection
  useEffect(() => {
    const st = stateRef.current
    if (st?.content) st.picker.setSelection(selection, st.content)
  }, [selection, meshes])

  // section clipping plane
  useEffect(() => {
    const st = stateRef.current
    if (!st) return
    const planes: THREE.Plane[] = []
    if (section) {
      const n = new THREE.Vector3(
        section.plane === 'YZ' ? 1 : 0,
        section.plane === 'XZ' ? 1 : 0,
        section.plane === 'XY' ? 1 : 0
      )
      if (section.flip) n.negate()
      planes.push(new THREE.Plane(n, -section.offset * (section.flip ? -1 : 1)))
    }
    st.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined
      if (!m) return
      for (const mat of Array.isArray(m) ? m : [m]) {
        mat.clippingPlanes = planes
        mat.clipShadows = true
        mat.needsUpdate = true
      }
    })
  }, [section, meshes, datums])

  // enter / leave sketch mode
  useEffect(() => {
    const st = stateRef.current
    if (!st) return
    if (sketchFrame && !st.sketch) {
      st.picker.clear()
      st.sketch = new SketchController(
        st.camera,
        st.renderer.domElement,
        sketchFrame,
        st.overlay,
        () => onSketchChangeRef.current?.(),
        sketchRefGeom
      )
      if (sketchInitialEntities && sketchInitialEntities.length) {
        st.sketch.loadExisting(sketchInitialEntities as never[])
      }
      st.sketch.setTool(sketchTool)
      // look straight at the plane
      const O = new THREE.Vector3(...sketchFrame.origin)
      const N = new THREE.Vector3(...sketchFrame.z).normalize()
      const up = new THREE.Vector3(...sketchFrame.y).normalize()
      const dist = Math.max(st.lastRadius * 2.4, 160)
      st.camera.up.copy(up)
      st.camera.position.copy(O).addScaledVector(N, dist)
      st.controls.pivot.copy(O)
      st.camera.lookAt(O)
    } else if (!sketchFrame && st.sketch) {
      st.sketch.dispose()
      st.sketch = null
      st.camera.up.set(0, 0, 1)
    }
  }, [sketchFrame])

  useEffect(() => {
    stateRef.current?.sketch?.setTool(sketchTool)
  }, [sketchTool])

  // tidy the calibration rubber line when leaving calibrate mode
  useEffect(() => {
    const cal = calibRef.current
    const st = stateRef.current
    if (!calibrateCanvas) {
      cal.pts = []
      if (cal.line && st) {
        st.overlay.remove(cal.line)
        cal.line.geometry.dispose()
        cal.line = null
      }
    }
  }, [calibrateCanvas])

  // ghost planes for the sketch-plane picker
  useEffect(() => {
    const st = stateRef.current
    if (!st) return
    for (const c of [...st.ghosts.children]) {
      st.ghosts.remove(c)
      const mm = (c as THREE.Mesh).material as THREE.Material | undefined
      ;(c as THREE.Mesh).geometry?.dispose?.()
      mm?.dispose?.()
    }
    if (!planePickMode) return
    for (const p of pickPlanes) {
      const O = new THREE.Vector3(...p.origin)
      const X = new THREE.Vector3(...p.x).normalize()
      const Y = new THREE.Vector3(...p.y).normalize()
      const s = (p.size ?? 40) * 1.4
      const c = [
        O.clone().addScaledVector(X, -s).addScaledVector(Y, -s),
        O.clone().addScaledVector(X, s).addScaledVector(Y, -s),
        O.clone().addScaledVector(X, s).addScaledVector(Y, s),
        O.clone().addScaledVector(X, -s).addScaledVector(Y, s)
      ]
      const g = new THREE.BufferGeometry().setFromPoints([c[0], c[1], c[2], c[0], c[2], c[3]])
      const isOrigin = p.ptype === 'origin'
      const mesh = new THREE.Mesh(
        g,
        new THREE.MeshBasicMaterial({
          color: isOrigin ? 0x4a90d9 : 0xd8a24a,
          transparent: true,
          opacity: 0.16,
          side: THREE.DoubleSide,
          depthWrite: false
        })
      )
      mesh.userData = { pick: 'sketch', sketchId: p.id }
      st.ghosts.add(mesh)
      const border = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(c),
        new THREE.LineBasicMaterial({ color: isOrigin ? 0x6aa9dd : 0xe0b877 })
      )
      st.ghosts.add(border)
    }
  }, [planePickMode, pickPlanes])

  return (
    <div className="viewport" ref={hostRef}>
      <div className="rubber-band" ref={bandRef} style={{ display: 'none' }} />
      <div className="viewcube-wrap">
        <div className="viewcube" ref={cubeRef} />
        <button
          className="viewcube-home"
          title="Home view"
          onClick={() => stateRef.current?.cube.home()}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
            <path d="M2 7 L7 2.5 L12 7" />
            <path d="M3.4 6 v5.5 h7.2 V6" />
          </svg>
        </button>
      </div>
    </div>
  )
}
