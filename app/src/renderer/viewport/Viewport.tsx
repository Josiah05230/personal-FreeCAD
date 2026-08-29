import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import type { RenderMesh, SketchRender, Selection, DatumDTO } from '../rpc'
import type { ViewportApi } from './types'
import { CadControls } from './CadControls'
import { ViewCube } from './ViewCube'
import { Picker } from './Picker'
import { SketchController, type SketchFrame, type SketchTool } from './SketchController'
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
  sketchFrame = null,
  sketchTool = 'line',
  onSketchChange,
  apiRef
}: {
  meshes: RenderMesh[]
  sketches?: SketchRender[]
  datums?: DatumDTO[]
  selection?: Selection[]
  onSelect?: (sel: Selection | null, additive: boolean) => void
  sketchFrame?: SketchFrame | null
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

  const stateRef = useRef<{
    renderer: THREE.WebGLRenderer
    scene: THREE.Scene
    camera: THREE.PerspectiveCamera
    controls: CadControls
    cube: ViewCube
    picker: Picker
    content: THREE.Group | null
    overlay: THREE.Group
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
    scene.add(overlay)

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
        sketchUndo: () => stateRef.current?.sketch?.undo()
      }
    }

    // click-to-select (left button, negligible drag)
    let downX = 0
    let downY = 0
    let downBtn = -1
    const onDown = (e: PointerEvent): void => {
      downX = e.clientX
      downY = e.clientY
      downBtn = e.button
    }
    const onUp = (e: PointerEvent): void => {
      const st = stateRef.current
      if (!st || st.sketch) return // sketch mode owns clicks
      if (downBtn !== 0 || e.button !== 0) return
      if (Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 4) return
      if (!st.content) return
      const sel = st.picker.pick(e, st.content)
      onSelectRef.current?.(sel, e.shiftKey || e.ctrlKey)
    }
    const onMove = (e: PointerEvent): void => {
      const st = stateRef.current
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
    if (!meshes.length && !sketches.length && !datums.length) {
      st.content = null
      return
    }
    const { group, center, radius } = buildScene(meshes, sketches, datums)
    st.scene.add(group)
    st.content = group
    st.lastCenter = center
    st.lastRadius = radius
    if (!st.framedOnce) {
      st.controls.frame(center, radius)
      st.framedOnce = true
    }
  }, [meshes, sketches, datums])

  // reflect selection
  useEffect(() => {
    const st = stateRef.current
    if (st?.content) st.picker.setSelection(selection, st.content)
  }, [selection, meshes])

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
        () => onSketchChangeRef.current?.()
      )
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

  return (
    <div className="viewport" ref={hostRef}>
      <div className="viewcube" ref={cubeRef} />
    </div>
  )
}
