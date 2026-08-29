import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import type { RenderMesh } from '../rpc'
import { CadControls } from './CadControls'
import { ViewCube } from './ViewCube'
import { buildScene } from './sceneBuilder'

function gradientBackground(): THREE.Texture {
  // Fusion's viewport ground is a light cool gradient, not a dark room.
  const c = document.createElement('canvas')
  c.width = 2
  c.height = 256
  const ctx = c.getContext('2d')!
  const g = ctx.createLinearGradient(0, 0, 0, 256)
  g.addColorStop(0, '#dfe4ea')
  g.addColorStop(0.5, '#c4ccd4')
  g.addColorStop(1, '#aab4bf')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 2, 256)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

export function Viewport({ meshes }: { meshes: RenderMesh[] }): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const cubeRef = useRef<HTMLDivElement>(null)
  const stateRef = useRef<{
    renderer: THREE.WebGLRenderer
    scene: THREE.Scene
    camera: THREE.PerspectiveCamera
    controls: CadControls
    cube: ViewCube
    content: THREE.Group | null
    framedOnce: boolean
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

    const camera = new THREE.PerspectiveCamera(
      35,
      host.clientWidth / host.clientHeight,
      0.1,
      100000
    )
    camera.up.set(0, 0, 1)
    camera.position.set(220, -260, 180)

    scene.add(new THREE.HemisphereLight(0xffffff, 0x9099a3, 2.6))
    const key = new THREE.DirectionalLight(0xffffff, 2.1)
    key.position.set(0.6, -1, 1.4)
    scene.add(key)
    const fill = new THREE.DirectionalLight(0xffffff, 0.9)
    fill.position.set(-1.2, 0.8, 0.4)
    scene.add(fill)

    const controls = new CadControls(camera, renderer.domElement)
    const cube = new ViewCube(cubeRef.current!, camera, controls)

    stateRef.current = {
      renderer,
      scene,
      camera,
      controls,
      cube,
      content: null,
      framedOnce: false
    }

    let raf = 0
    let prev = performance.now()
    const loop = () => {
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
      cube.dispose()
      controls.dispose()
      renderer.dispose()
      host.removeChild(renderer.domElement)
      stateRef.current = null
    }
  }, [])

  useEffect(() => {
    const st = stateRef.current
    if (!st) return
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
    if (!meshes.length) {
      st.content = null
      return
    }
    const { group, center, radius } = buildScene(meshes)
    st.scene.add(group)
    st.content = group
    if (!st.framedOnce) {
      st.controls.frame(center, radius)
      st.framedOnce = true
    }
  }, [meshes])

  return (
    <div className="viewport" ref={hostRef}>
      <div className="viewcube" ref={cubeRef} />
    </div>
  )
}
