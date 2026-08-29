import { useCallback, useEffect, useState } from 'react'
import { api, type BodyTree, type RenderMesh } from './rpc'
import { Viewport } from './viewport/Viewport'
import { Ribbon } from './ui/Ribbon'
import { Browser } from './ui/Browser'
import { Timeline } from './ui/Timeline'

type Status =
  | { phase: 'boot' }
  | { phase: 'ready'; freecad: string }
  | { phase: 'error'; message: string }

export function App(): JSX.Element {
  const [status, setStatus] = useState<Status>({ phase: 'boot' })
  const [meshes, setMeshes] = useState<RenderMesh[]>([])
  const [bodies, setBodies] = useState<BodyTree[]>([])

  const refreshScene = useCallback(async () => {
    const [{ meshes }, { bodies }] = await Promise.all([api.sceneGet(), api.treeGet()])
    setMeshes(meshes)
    setBodies(bodies)
  }, [])

  const buildDemoPad = useCallback(async () => {
    await api.demoPad(60, 40, 15)
    await refreshScene()
  }, [refreshScene])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const p = await api.ping()
        if (cancelled) return
        setStatus({ phase: 'ready', freecad: `${p.freecad} ${p.build}` })
        await api.demoPad(60, 40, 15)
        if (cancelled) return
        await refreshScene()
      } catch (e) {
        if (!cancelled) setStatus({ phase: 'error', message: (e as Error).message })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [refreshScene])

  return (
    <div className="app">
      <Ribbon onDemoPad={buildDemoPad} />
      <div className="workspace">
        <Browser bodies={bodies} />
        <div className="viewport-host">
          {status.phase === 'error' && (
            <div className="overlay error">
              <b>Sidecar error</b>
              <div>{status.message}</div>
              <div className="hint">
                Check that <code>config.local.json</code> points at a valid{' '}
                <code>freecadcmd</code>.
              </div>
            </div>
          )}
          {status.phase === 'boot' && <div className="overlay">Starting FreeCAD engine…</div>}
          <Viewport meshes={meshes} />
          <Timeline bodies={bodies} />
        </div>
      </div>
      <div className="statusbar">
        <span>
          {status.phase === 'ready'
            ? `FreeCAD ${status.freecad}`
            : status.phase === 'error'
              ? 'engine offline'
              : 'connecting…'}
        </span>
        <span className="sb-spacer" />
        <span>mm</span>
        <span>Middle-drag: pan · Shift+middle: orbit · Wheel: zoom</span>
      </div>
    </div>
  )
}
