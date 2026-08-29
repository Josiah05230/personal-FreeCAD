import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import type { RenderMesh } from '../rpc'
import { CadControls } from './CadControls'
import { buildScene } from './sceneBuilder'

function gradientBackground(): THREE.Texture {
  const c = document.createElement('canvas')
  c.width = 2
  c.height = 256
  const ctx = c.getContext('2d')!
  const g = ctx.createLinearGradient(0, 0, 0, 256)
  g.addColorStop(0, '#5b6470')
  g.addColorStop(0.55, '#3a3f47')
  g.addColorStop(1, '#2b2e34')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 2, 256)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

export function Viewport({ meshes }: { meshes: RenderMesh[] }): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const stateRef = useRef<{
    renderer: THREE.WebGLRenderer
    scene: THREE.Scene
    camera: THREE.PerspectiveCamera
    controls: CadControls
    content: THREE.Group | null
    framedOnce: boolean
  } | null>(null)

  // one-time setup
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
    camera.position.set(200, -200, 150)

    scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3f47, 2.2))
    const key = new THREE.DirectionalLight(0xffffff, 2.0)
    key.position.set(1, -1.4, 2)
    scene.add(key)
    const fill = new THREE.DirectionalLight(0xffffff, 0.7)
    fill.position.set(-1.5, 1, 0.5)
    scene.add(fill)

    const grid = new THREE.GridHelper(2000, 100, 0x4a4f57, 0x3b3f46)
    grid.rotation.x = Math.PI / 2 // GridHelper is XZ by default; put it on XY (Z-up)
    ;(grid.material as THREE.Material).transparent = true
    ;(grid.material as THREE.Material).opacity = 0.5
    scene.add(grid)

    const controls = new CadControls(camera, renderer.domElement)

    stateRef.current = { renderer, scene, camera, controls, content: null, framedOnce: false }

    let raf = 0
    const loop = () => {
      raf = requestAnimationFrame(loop)
      controls.update()
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
      controls.dispose()
      renderer.dispose()
      host.removeChild(renderer.domElement)
      stateRef.current = null
    }
  }, [])

  // rebuild content when meshes change
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

  return <div className="viewport" ref={hostRef} />
}
