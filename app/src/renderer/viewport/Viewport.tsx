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
import { syncScene, type SceneNode } from './sceneBuilder'
import { perfProfile } from '../perfProfile'

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

/** 45-degree section hatching, one 14mm tile, tiled by the caller. */
function hatchTexture(): THREE.Texture {
  const c = document.createElement('canvas')
  c.width = 32
  c.height = 32
  const ctx = c.getContext('2d')!
  ctx.clearRect(0, 0, 32, 32)
  ctx.strokeStyle = 'rgba(70,80,92,0.85)'
  ctx.lineWidth = 2
  for (let i = -32; i < 64; i += 8) {
    ctx.beginPath()
    ctx.moveTo(i, 0)
    ctx.lineTo(i + 32, 32)
    ctx.stroke()
  }
  const tex = new THREE.CanvasTexture(c)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
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
  selFilter,
  previewPlane = null,
  onPreviewHandleDrag,
  onWindowSelect,
  canvases = [],
  hiddenIds,
  calibrateCanvas = null,
  onCalibrate,
  sketchFrame = null,
  sketchRefGeom = null,
  sketchInitialEntities,
  sketchInitialConstraints,
  sketchTool = 'line',
  onSketchChange,
  onSketchDimensionRequest,
  onSketchSolve,
  onSketchNotice,
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
  /** which entity kinds are currently selectable - hover pre-highlight honours it */
  selFilter?: string[]
  /** live ghost for the Offset Plane dialog */
  previewPlane?: {
    origin: [number, number, number]
    x: [number, number, number]
    y: [number, number, number]
    size: number
  } | null
  /** dragging the ghost's handle: delta mm along the normal, and phase */
  onPreviewHandleDrag?: (deltaMm: number, phase: 'move' | 'end') => void
  onWindowSelect?: (sels: Selection[]) => void
  canvases?: CanvasDTO[]
  hiddenIds?: Set<string>
  calibrateCanvas?: CanvasDTO | null
  onCalibrate?: (measuredMm: number) => void
  sketchFrame?: SketchFrame | null
  sketchRefGeom?: SketchRefGeom | null
  sketchInitialEntities?: unknown[]
  sketchInitialConstraints?: unknown[]
  sketchTool?: SketchTool
  onSketchChange?: () => void
  onSketchDimensionRequest?: (entityIndex: number, kind: 'linear' | 'radius') => void
  onSketchSolve?: import('./SketchController').SketchSolveFn
  onSketchNotice?: (msg: string) => void
  apiRef?: { current: ViewportApi | null }
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const cubeRef = useRef<HTMLDivElement>(null)
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect
  const onSketchChangeRef = useRef(onSketchChange)
  onSketchChangeRef.current = onSketchChange
  const onDimReqRef = useRef(onSketchDimensionRequest)
  onDimReqRef.current = onSketchDimensionRequest
  const onSketchSolveRef = useRef(onSketchSolve)
  onSketchSolveRef.current = onSketchSolve
  const onSketchNoticeRef = useRef(onSketchNotice)
  onSketchNoticeRef.current = onSketchNotice
  const planePickRef = useRef<{ mode: boolean; cb?: (r: SketchRef) => void }>({ mode: false })
  planePickRef.current = { mode: planePickMode, cb: onPickPlane }
  void pickPlanes // retained as a prop for compatibility; planes are real datums now
  const winSelRef = useRef<{ mode: string; cb?: (s: Selection[]) => void }>({ mode: 'paint' })
  winSelRef.current = { mode: selectMode, cb: onWindowSelect }
  const selFilterRef = useRef<string[] | undefined>(selFilter)
  selFilterRef.current = selFilter
  const bandRef = useRef<HTMLDivElement>(null)
  const onPreviewDragRef = useRef(onPreviewHandleDrag)
  onPreviewDragRef.current = onPreviewHandleDrag
  const previewDragRef = useRef<{
    handle: THREE.Mesh | null
    paint: THREE.Mesh[]
    hovering: boolean
    O0: THREE.Vector3
    N0: THREE.Vector3
    t0: number
    active: boolean
  }>({
    handle: null,
    paint: [],
    hovering: false,
    O0: new THREE.Vector3(),
    N0: new THREE.Vector3(),
    t0: 0,
    active: false
  })
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
    preview: THREE.Group
    sketch: SketchController | null
    framedOnce: boolean
    lastCenter: THREE.Vector3
    lastRadius: number
    preSketchCam: { pos: THREE.Vector3; up: THREE.Vector3; pivot: THREE.Vector3 } | null
    sectionCap: THREE.Mesh | null
  } | null>(null)

  useEffect(() => {
    const host = hostRef.current!
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, perfProfile().pixelRatioCap))
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
    const preview = new THREE.Group()
    scene.add(overlay)
    scene.add(ghosts)
    scene.add(preview)

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
      preview,
      sketch: null,
      framedOnce: false,
      lastCenter: new THREE.Vector3(),
      lastRadius: 60,
      preSketchCam: null,
      sectionCap: null
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
        loadSketchEntities: (ents, cons) =>
          stateRef.current?.sketch?.loadExisting(ents, (cons ?? []) as never[]),
        sketchUndo: () => stateRef.current?.sketch?.undo(),
        getSketchConstraints: () => stateRef.current?.sketch?.getConstraints() ?? [],
        getNewSketchConstraints: () => stateRef.current?.sketch?.getNewConstraints() ?? [],
        getRemovedSketchConstraints: () =>
          stateRef.current?.sketch?.getRemovedConstraints() ?? [],
        applySketchConstraint: (t) => stateRef.current?.sketch?.applyConstraint(t) ?? false,
        startSketchConstraint: (t) => stateRef.current?.sketch?.beginConstraint(t),
        pendingSketchConstraint: () =>
          stateRef.current?.sketch?.pendingConstraint ?? null,
        availableSketchConstraints: () =>
          stateRef.current?.sketch?.availableConstraints() ?? [],
        setSketchDimension: (i, v) => stateRef.current?.sketch?.setDimension(i, v) ?? false,
        checkSketchDimension: (i) =>
          stateRef.current?.sketch?.dimensionPrecheck(i) ?? Promise.resolve(null),
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

    // closest point on the ghost's normal line to the cursor ray, as mm along N0
    const normalParam = (e: PointerEvent): number => {
      const pv = previewDragRef.current
      const st = stateRef.current
      if (!st) return 0
      const r = host.getBoundingClientRect()
      const ndc = new THREE.Vector2(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        -((e.clientY - r.top) / r.height) * 2 + 1
      )
      const rc = new THREE.Raycaster()
      rc.setFromCamera(ndc, st.camera)
      const ro = rc.ray.origin
      const rd = rc.ray.direction
      const w0 = new THREE.Vector3().subVectors(pv.O0, ro)
      const a = pv.N0.dot(pv.N0)
      const b = pv.N0.dot(rd)
      const c = rd.dot(rd)
      const d = pv.N0.dot(w0)
      const eD = rd.dot(w0)
      const denom = a * c - b * b
      return Math.abs(denom) < 1e-9 ? 0 : (b * eD - c * d) / denom
    }

    const onDown = (e: PointerEvent): void => {
      downX = e.clientX
      downY = e.clientY
      downBtn = e.button
      const st = stateRef.current
      // Offset-Plane handle drag takes priority (grab the arrow OR the plane)
      const pv = previewDragRef.current
      if (e.button === 0 && pv.handle && st) {
        const r = host.getBoundingClientRect()
        const ndc = new THREE.Vector2(
          ((e.clientX - r.left) / r.width) * 2 - 1,
          -((e.clientY - r.top) / r.height) * 2 + 1
        )
        const rc = new THREE.Raycaster()
        rc.setFromCamera(ndc, st.camera)
        const grabHit = rc
          .intersectObjects(st.preview.children, false)
          .some((h) => h.object.userData?.previewHandle)
        if (grabHit) {
          pv.active = true
          pv.t0 = normalParam(e)
          try {
            renderer.domElement.setPointerCapture(e.pointerId)
          } catch {
            /* ignore */
          }
          e.stopPropagation()
          return
        }
      }
      // orbit / pan around whatever geometry is under the cursor (Fusion feel);
      // fall back to the model centre when the cursor is over empty space
      if ((e.button === 1 || e.button === 2) && st && !st.sketch) {
        const r = host.getBoundingClientRect()
        const ndc = new THREE.Vector2(
          ((e.clientX - r.left) / r.width) * 2 - 1,
          -((e.clientY - r.top) / r.height) * 2 + 1
        )
        const rc = new THREE.Raycaster()
        rc.setFromCamera(ndc, st.camera)
        const hit = st.content
          ? rc.intersectObjects(st.content.children, true).find((h) => {
              let o: THREE.Object3D | null = h.object
              while (o && o !== st.content) {
                if (o.visible === false) return false
                o = o.parent
              }
              return true
            })
          : undefined
        st.controls.pivot.copy(hit ? hit.point : st.lastCenter)
      }
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
      const pv = previewDragRef.current
      if (pv.active) {
        pv.active = false
        onPreviewDragRef.current?.(normalParam(e) - pv.t0, 'end')
        try {
          renderer.domElement.releasePointerCapture(e.pointerId)
        } catch {
          /* ignore */
        }
        return
      }
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

      // sketch-plane pick mode: hit the real origin / construction planes (shown
      // for the duration), else a flat body face
      if (planePickRef.current.mode) {
        if (st.content) {
          const hit = st.picker.pick(e, st.content)
          if (hit && hit.kind === 'plane') {
            planePickRef.current.cb?.(
              hit.role
                ? { kind: 'origin', role: hit.role }
                : { kind: 'plane', id: hit.planeId }
            )
            return
          }
          if (hit && hit.kind === 'face') {
            planePickRef.current.cb?.({ kind: 'face', bodyId: hit.bodyId, sub: hit.sub })
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
      const pv = previewDragRef.current
      if (pv.active && pv.handle) {
        const t = normalParam(e)
        pv.handle.position.copy(pv.O0).addScaledVector(pv.N0, t - pv.t0)
        onPreviewDragRef.current?.(t - pv.t0, 'move')
        return
      }
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
      if (!st || st.sketch || e.buttons !== 0) return

      // Offset-Plane dialog: the arrow / ghost handle owns hover. Light it up
      // and DO NOT let planes behind it highlight through.
      if (pv.handle) {
        const r = host.getBoundingClientRect()
        const ndc = new THREE.Vector2(
          ((e.clientX - r.left) / r.width) * 2 - 1,
          -((e.clientY - r.top) / r.height) * 2 + 1
        )
        const rc = new THREE.Raycaster()
        rc.setFromCamera(ndc, st.camera)
        const over = rc
          .intersectObjects(st.preview.children, false)
          .some((h) => h.object.userData?.previewHandle)
        if (over !== pv.hovering) {
          pv.hovering = over
          for (const m of pv.paint) {
            ;(m.material as THREE.MeshBasicMaterial).color.setHex(over ? 0xffe9b8 : 0xffcf7a)
            m.scale.setScalar(over ? 1.25 : 1)
          }
          renderer.domElement.style.cursor = over ? 'grab' : ''
        }
        if (st.content) st.picker.setHover(null, st.content)
        return
      }

      if (!st.content) return
      // sketch-plane pick: highlight the plane / face under the cursor
      if (planePickRef.current.mode) {
        const ph = st.picker.pick(e, st.content)
        st.picker.setHover(ph && (ph.kind === 'plane' || ph.kind === 'face') ? ph : null, st.content)
        renderer.domElement.style.cursor = ph ? 'pointer' : ''
        return
      }
      const hit = st.picker.pick(e, st.content)
      const allow = selFilterRef.current
      st.picker.setHover(hit && (!allow || allow.includes(hit.kind)) ? hit : null, st.content)
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

  // reconcile scene content INCREMENTALLY - only nodes whose signature changed
  // are rebuilt, so a live-preview update touches one body's geometry instead of
  // disposing and re-triangulating the entire scene every keystroke.
  const nodesRef = useRef<Map<string, SceneNode>>(new Map())
  const prevSolidCountRef = useRef(0)
  useEffect(() => {
    const st = stateRef.current
    if (!st) return

    if (!meshes.length && !sketches.length && !datums.length && !canvases.length) {
      if (st.content) {
        st.picker.clear()
        st.scene.remove(st.content)
        st.content.traverse((o) => {
          const any = o as THREE.Mesh
          any.geometry?.dispose?.()
          const mat = any.material as THREE.Material | THREE.Material[] | undefined
          if (Array.isArray(mat)) mat.forEach((m) => m.dispose())
          else mat?.dispose()
        })
      }
      nodesRef.current = new Map()
      st.content = null
      return
    }

    // make sure there is a content group to reconcile into
    if (!st.content) {
      st.content = new THREE.Group()
      st.scene.add(st.content)
      nodesRef.current = new Map()
    }

    let res
    try {
      res = syncScene(st.content, nodesRef.current, meshes, sketches, datums, canvases)
    } catch (e) {
      // never let a scene-build failure wedge the viewport
      console.error('syncScene failed', e)
      return
    }
    nodesRef.current = res.nodes
    st.lastCenter = res.center
    st.lastRadius = res.radius
    // hover highlights can dangle over geometry that was just rebuilt
    st.picker.setHover(null, st.content)

    // frame on first content, and again the first time a solid appears (an
    // extrude / primitive / import) so the new body is actually on screen
    const solidsAppeared = meshes.length > 0 && prevSolidCountRef.current === 0
    prevSolidCountRef.current = meshes.length
    if (!st.framedOnce || solidsAppeared) {
      st.controls.frame(res.center, res.radius)
      st.framedOnce = true
    }
  }, [meshes, sketches, datums, canvases])

  // visibility: just flip .visible on the built objects - no geometry work
  useEffect(() => {
    const st = stateRef.current
    if (!st?.content) return
    const hidden = hiddenIds ?? new Set<string>()
    for (const c of st.content.children) {
      const ud = c.userData
      const id = ud.bodyId ?? ud.sketchId ?? ud.datumId ?? ud.canvasId
      if (id != null) c.visible = !hidden.has(id)
    }
  }, [hiddenIds, meshes, sketches, datums, canvases])

  // reflect selection
  useEffect(() => {
    const st = stateRef.current
    if (st?.content) st.picker.setSelection(selection, st.content)
  }, [selection, meshes])

  // section clipping plane + hatched cut indicator
  useEffect(() => {
    const st = stateRef.current
    if (!st) return
    const planes: THREE.Plane[] = []
    let n: THREE.Vector3 | null = null
    let constant = 0
    if (section) {
      n = new THREE.Vector3(
        section.plane === 'YZ' ? 1 : 0,
        section.plane === 'XZ' ? 1 : 0,
        section.plane === 'XY' ? 1 : 0
      )
      if (section.flip) n.negate()
      constant = -section.offset * (section.flip ? -1 : 1)
      planes.push(new THREE.Plane(n.clone(), constant))
    }
    st.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined
      if (!m || o === st.sectionCap) return
      for (const mat of Array.isArray(m) ? m : [m]) {
        mat.clippingPlanes = planes
        mat.clipShadows = true
        mat.needsUpdate = true
      }
    })

    if (st.sectionCap) {
      st.scene.remove(st.sectionCap)
      st.sectionCap.geometry.dispose()
      const cm = st.sectionCap.material as THREE.MeshBasicMaterial
      cm.map?.dispose()
      cm.dispose()
      st.sectionCap = null
    }
    if (section && n && st.content) {
      // a hatched quad sitting in the cut plane, sized to the model, so the
      // section reads as a real cut face rather than just a clipped-away void
      const box = new THREE.Box3().setFromObject(st.content)
      if (!box.isEmpty()) {
        const size = box.getSize(new THREE.Vector3())
        const center = box.getCenter(new THREE.Vector3())
        const diag = Math.max(size.length(), 1)
        const tex = hatchTexture()
        tex.repeat.set(diag / 14, diag / 14)
        const cap = new THREE.Mesh(
          new THREE.PlaneGeometry(diag, diag),
          new THREE.MeshBasicMaterial({
            map: tex,
            transparent: true,
            opacity: 0.9,
            side: THREE.DoubleSide,
            depthWrite: false,
            polygonOffset: true,
            polygonOffsetFactor: -1
          })
        )
        cap.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n)
        // centre the quad on the model's cross-section: project the model centre
        // onto the cut plane (n·x + constant = 0)
        cap.position.copy(
          center.clone().sub(n.clone().multiplyScalar(center.dot(n) + constant))
        )
        cap.renderOrder = 5
        st.scene.add(cap)
        st.sectionCap = cap
      }
    }
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
        sketchRefGeom,
        (idx, kind) => onDimReqRef.current?.(idx, kind),
        (ents, cons) =>
          onSketchSolveRef.current
            ? onSketchSolveRef.current(ents, cons)
            : Promise.resolve(null),
        (msg) => onSketchNoticeRef.current?.(msg)
      )
      if (sketchInitialEntities && sketchInitialEntities.length) {
        st.sketch.loadExisting(
          sketchInitialEntities as never[],
          (sketchInitialConstraints ?? []) as never[]
        )
      }
      st.sketch.setTool(sketchTool)
      // remember the view so we can drop the user right back into it on exit
      st.preSketchCam = {
        pos: st.camera.position.clone(),
        up: st.camera.up.clone(),
        pivot: st.controls.pivot.clone()
      }
      // look straight at the plane
      const O = new THREE.Vector3(...sketchFrame.origin)
      const N = new THREE.Vector3(...sketchFrame.z).normalize()
      const up = new THREE.Vector3(...sketchFrame.y).normalize()
      const dist = Math.max(st.lastRadius * 2.4, 120)
      st.camera.up.copy(up)
      st.camera.position.copy(O).addScaledVector(N, dist)
      st.controls.pivot.copy(O)
      st.camera.lookAt(O)
    } else if (!sketchFrame && st.sketch) {
      st.sketch.dispose()
      st.sketch = null
      // restore the pre-sketch view rather than leaving the camera on the plane
      const pc = st.preSketchCam
      if (pc) {
        st.camera.up.copy(pc.up)
        st.camera.position.copy(pc.pos)
        st.controls.pivot.copy(pc.pivot)
        st.camera.lookAt(pc.pivot)
        st.preSketchCam = null
      } else {
        st.camera.up.set(0, 0, 1)
        st.controls.frame(st.lastCenter, st.lastRadius)
      }
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

  // the sketch-plane picker now toggles the real origin / construction planes
  // (App drives their visibility); nothing to render here. Keep the ghosts group
  // clear in case an older build left something in it.
  useEffect(() => {
    const st = stateRef.current
    if (!st) return
    for (const c of [...st.ghosts.children]) {
      st.ghosts.remove(c)
      const mm = (c as THREE.Mesh).material as THREE.Material | undefined
      ;(c as THREE.Mesh).geometry?.dispose?.()
      mm?.dispose?.()
    }
  }, [planePickMode])

  // live Offset-Plane ghost
  useEffect(() => {
    const st = stateRef.current
    if (!st) return
    // while the handle is being dragged, leave the ghost + basis alone so the
    // drag math stays in one coordinate frame; it settles on release
    if (previewDragRef.current.active) return
    for (const c of [...st.preview.children]) {
      st.preview.remove(c)
      const m = c as THREE.Mesh
      m.geometry?.dispose?.()
      const mm = m.material as THREE.Material | undefined
      mm?.dispose?.()
    }
    previewDragRef.current.handle = null
    previewDragRef.current.paint = []
    previewDragRef.current.hovering = false
    if (!previewPlane) return
    const O = new THREE.Vector3(...previewPlane.origin)
    const X = new THREE.Vector3(...previewPlane.x).normalize()
    const Y = new THREE.Vector3(...previewPlane.y).normalize()
    const N = new THREE.Vector3().crossVectors(X, Y).normalize()
    const s = previewPlane.size
    const c = [
      O.clone().addScaledVector(X, -s).addScaledVector(Y, -s),
      O.clone().addScaledVector(X, s).addScaledVector(Y, -s),
      O.clone().addScaledVector(X, s).addScaledVector(Y, s),
      O.clone().addScaledVector(X, -s).addScaledVector(Y, s)
    ]
    const quad = new THREE.Mesh(
      new THREE.BufferGeometry().setFromPoints([c[0], c[1], c[2], c[0], c[2], c[3]]),
      new THREE.MeshBasicMaterial({
        color: 0x4a90d9,
        transparent: true,
        opacity: 0.18,
        side: THREE.DoubleSide,
        depthWrite: false
      })
    )
    quad.renderOrder = 8
    quad.userData = { previewHandle: true } // the whole plane is grabbable
    st.preview.add(quad)
    st.preview.add(
      new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(c),
        new THREE.LineBasicMaterial({ color: 0x6aa9dd })
      )
    )
    // draggable handle - an arrow on the normal; drag it (or the plane) to set
    // the distance. Sized from camera distance so it stays a usable target.
    if (onPreviewDragRef.current) {
      const camDist = st.camera.position.distanceTo(O)
      const hl = Math.max(camDist * 0.06, s * 0.12) // arrow length
      const hr = hl * 0.28
      const shaft = O.clone().addScaledVector(N, hl * 0.7)
      st.preview.add(
        new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([O, shaft]),
          new THREE.LineBasicMaterial({ color: 0xffcf7a, depthTest: false })
        )
      )
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(hr, hl * 0.5, 20),
        new THREE.MeshBasicMaterial({ color: 0xffcf7a, depthTest: false })
      )
      cone.position.copy(O).addScaledVector(N, hl * 0.85)
      cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), N)
      cone.renderOrder = 22
      cone.userData = { previewHandle: true }
      st.preview.add(cone)
      previewDragRef.current.paint = [cone]
      previewDragRef.current.hovering = false
      // an invisible fat sphere makes the grab target forgiving
      const grab = new THREE.Mesh(
        new THREE.SphereGeometry(hl * 0.6, 8, 6),
        new THREE.MeshBasicMaterial({ visible: false })
      )
      grab.position.copy(cone.position)
      grab.userData = { previewHandle: true }
      st.preview.add(grab)
      previewDragRef.current.handle = grab
      previewDragRef.current.O0 = O.clone()
      previewDragRef.current.N0 = N.clone()
    }
  }, [previewPlane])

  return (
    <div className="viewport" ref={hostRef}>
      <div className="rubber-band" ref={bandRef} style={{ display: 'none' }} />
      <div className="viewcube-wrap">
        <div className="viewcube-roll">
          <button
            className="viewcube-rollbtn"
            title="Rotate view 90° counter-clockwise"
            onClick={() => stateRef.current?.controls.roll(-1)}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M4 4.5 A5 5 0 1 0 8 3" />
              <path d="M8 0.7 L8 3 L10.2 3" />
            </svg>
          </button>
          <button
            className="viewcube-rollbtn"
            title="Rotate view 90° clockwise"
            onClick={() => stateRef.current?.controls.roll(1)}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M12 4.5 A5 5 0 1 1 8 3" />
              <path d="M8 0.7 L8 3 L5.8 3" />
            </svg>
          </button>
        </div>
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
