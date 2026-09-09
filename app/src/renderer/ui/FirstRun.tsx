import { useState } from 'react'
import { loadMeshPrefs, saveMeshPrefs } from '../meshPrefs'
import type { RenderSettings } from '../rpc'
import logo from '../logo.png'

const FIRST_RUN_KEY = 'gwtcad.firstRun.done'

/** Has the first-run wizard already been completed on this machine? */
export function firstRunDone(): boolean {
  try {
    return localStorage.getItem(FIRST_RUN_KEY) === '1'
  } catch {
    return true // storage disabled -> don't nag every launch
  }
}

function markDone(): void {
  try {
    localStorage.setItem(FIRST_RUN_KEY, '1')
  } catch {
    /* ignore */
  }
}

/**
 * Shown once, on the very first launch of a freshly installed GWT-CAD. Keeps to
 * choices that have a real home already: viewport background, and the mesh
 * import fidelity cap. Everything else uses sensible defaults the user can
 * revisit under Settings / Appearance later.
 */
export function FirstRun({
  onDone
}: {
  onDone: (initialRender: RenderSettings) => void
}): JSX.Element {
  const [step, setStep] = useState(0)
  const [bg, setBg] = useState<RenderSettings['background']>('gradient')
  const [shading, setShading] = useState<RenderSettings['shading']>('shaded-edges')
  const [cap, setCap] = useState(loadMeshPrefs().importFacetCap)

  const finish = (): void => {
    const mp = loadMeshPrefs()
    saveMeshPrefs({ ...mp, importFacetCap: Math.max(1000, cap) })
    markDone()
    onDone({ background: bg, shading })
  }

  return (
    <div className="firstrun-backdrop">
      <div className="firstrun">
        <div className="firstrun-brand">
          <img src={logo} alt="" width={44} height={44} />
          <div>
            <h2>Welcome to GWT-CAD</h2>
            <p>A Fusion 360-style CAD app. The geometry engine is built in - nothing else to install.</p>
          </div>
        </div>

        {step === 0 && (
          <div className="firstrun-step">
            <h3>Viewport look</h3>
            <label>
              <span>Background</span>
              <select value={bg} onChange={(e) => setBg(e.target.value as RenderSettings['background'])}>
                <option value="gradient">Gradient (default)</option>
                <option value="gray">Gray</option>
                <option value="white">White</option>
                <option value="black">Black</option>
              </select>
            </label>
            <label>
              <span>Shading</span>
              <select
                value={shading}
                onChange={(e) => setShading(e.target.value as RenderSettings['shading'])}
              >
                <option value="shaded-edges">Shaded + edges (default)</option>
                <option value="shaded">Shaded</option>
                <option value="flat">Flat</option>
              </select>
            </label>
            <p className="firstrun-hint">You can change these any time from the Appearance tab.</p>
          </div>
        )}

        {step === 1 && (
          <div className="firstrun-step">
            <h3>Imported meshes</h3>
            <label>
              <span>Simplify above</span>
              <input
                type="number"
                min={1000}
                step={50000}
                value={cap}
                onChange={(e) => setCap(Number(e.target.value) || 0)}
              />
              <span>triangles</span>
            </label>
            <p className="firstrun-hint">
              A big 3D scan can be tens of millions of triangles. Anything over
              this is thinned right after import so the viewport stays smooth.
              Raise it later under Settings if you need more detail.
            </p>
          </div>
        )}

        <div className="firstrun-actions">
          {step > 0 && <button onClick={() => setStep((s) => s - 1)}>Back</button>}
          <span style={{ flex: 1 }} />
          {step < 1 ? (
            <button className="firstrun-primary" onClick={() => setStep((s) => s + 1)}>
              Next
            </button>
          ) : (
            <button className="firstrun-primary" onClick={finish}>
              Start using GWT-CAD
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
