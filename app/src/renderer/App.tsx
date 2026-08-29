import { useCallback, useEffect, useState } from 'react'
import { api, type BodyTree, type RenderMesh } from './rpc'
import { Viewport } from './viewport/Viewport'
import { AppBar } from './ui/AppBar'
import { Ribbon } from './ui/Ribbon'
import { DocTabs, type DocTab } from './ui/DocTabs'
import { DataPanel } from './ui/DataPanel'
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
  const [dataOpen, setDataOpen] = useState(false)
  const [tabs, setTabs] = useState<DocTab[]>([{ id: 'd1', name: 'Untitled', dirty: false }])
  const [activeTab, setActiveTab] = useState('d1')

  const refreshScene = useCallback(async () => {
    const [scene, tree] = await Promise.all([api.sceneGet(), api.treeGet()])
    setMeshes(scene.meshes)
    setBodies(tree.bodies)
  }, [])

  const runExtrude = useCallback(async () => {
    await api.demoPad(60, 40, 15)
    await refreshScene()
    setTabs((t) => t.map((x) => (x.id === activeTab ? { ...x, dirty: true } : x)))
  }, [refreshScene, activeTab])

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

  const activeName = tabs.find((t) => t.id === activeTab)?.name ?? 'Untitled'

  return (
    <div className="app">
      <AppBar
        dataOpen={dataOpen}
        onToggleData={() => setDataOpen((v) => !v)}
        docName={activeName}
      />
      <Ribbon onExtrude={runExtrude} />
      <DocTabs
        tabs={tabs}
        activeId={activeTab}
        onActivate={setActiveTab}
        onClose={(id) => setTabs((t) => (t.length > 1 ? t.filter((x) => x.id !== id) : t))}
        onNew={() => {
          const id = `d${Date.now()}`
          setTabs((t) => [...t, { id, name: 'Untitled', dirty: false }])
          setActiveTab(id)
        }}
      />
      <div className="workspace">
        <DataPanel open={dataOpen} onOpenFile={(p) => console.info('open design (M1):', p)} />
        <div className="viewport-host">
          {status.phase === 'error' && (
            <div className="overlay error">
              <b>Engine error</b>
              <div>{status.message}</div>
              <div className="hint">
                Check that <code>config.local.json</code> points at a valid{' '}
                <code>freecadcmd</code>.
              </div>
            </div>
          )}
          {status.phase === 'boot' && <div className="overlay">Starting FreeCAD engine…</div>}
          <Viewport meshes={meshes} />
          <Browser bodies={bodies} />
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
        <span>Middle: pan · Shift+Middle: orbit · Wheel: zoom</span>
      </div>
    </div>
  )
}
