import { useState } from 'react'
import { DEFAULT_MESH_PREFS, loadMeshPrefs, saveMeshPrefs, type MeshPrefs } from '../meshPrefs'
import {
  AUTOSAVE_MAX_INTERVAL,
  AUTOSAVE_MIN_INTERVAL,
  DEFAULT_AUTOSAVE_PREFS,
  loadAutosavePrefs,
  saveAutosavePrefs,
  type AutosavePrefs
} from '../autosavePrefs'

/**
 * App settings. Mesh import fidelity lives here: a raw STL/OBJ scan can be
 * tens of millions of triangles, and importing one at full density freezes
 * the viewport and every mesh tool run on it - this is the one place to cap
 * that up front instead of discovering it the hard way mid-import.
 */
export function SettingsPanel({ onClose }: { onClose: () => void }): JSX.Element {
  const [prefs, setPrefs] = useState<MeshPrefs>(loadMeshPrefs)

  const update = (patch: Partial<MeshPrefs>): void => {
    const next = { ...prefs, ...patch }
    setPrefs(next)
    saveMeshPrefs(next)
  }

  const [autosave, setAutosave] = useState<AutosavePrefs>(loadAutosavePrefs)
  const updateAutosave = (patch: Partial<AutosavePrefs>): void => {
    const next = { ...autosave, ...patch }
    setAutosave(next)
    saveAutosavePrefs(next)
  }

  const reset = (): void => {
    setPrefs({ ...DEFAULT_MESH_PREFS })
    saveMeshPrefs({ ...DEFAULT_MESH_PREFS })
    setAutosave({ ...DEFAULT_AUTOSAVE_PREFS })
    saveAutosavePrefs({ ...DEFAULT_AUTOSAVE_PREFS })
  }

  return (
    <div className="settings-panel">
      <div className="settings-head">
        <span>SETTINGS</span>
        <button onClick={onClose} title="Close">
          &times;
        </button>
      </div>

      <div className="settings-body">
        <div className="settings-section">Autosave</div>

        <label className="settings-row settings-check">
          <input
            type="checkbox"
            checked={autosave.enabled}
            onChange={(e) => updateAutosave({ enabled: e.target.checked })}
          />
          Save unsaved changes in the background
        </label>

        <div className="settings-row">
          <span>Every (minutes)</span>
          <input
            type="number"
            min={AUTOSAVE_MIN_INTERVAL}
            max={AUTOSAVE_MAX_INTERVAL}
            step={1}
            disabled={!autosave.enabled}
            value={autosave.intervalMin}
            onChange={(e) =>
              updateAutosave({
                intervalMin: Math.min(
                  AUTOSAVE_MAX_INTERVAL,
                  Math.max(AUTOSAVE_MIN_INTERVAL, Number(e.target.value) || AUTOSAVE_MIN_INTERVAL)
                )
              })
            }
          />
        </div>
        <div className="settings-hint">
          Saves the open file once it has had unsaved changes this long,
          waiting for a pause so it never interrupts you (including drawings,
          which live inside the part file). Only in-work company parts and
          files outside the company repos are saved this way - a released
          revision still needs a real Save, which makes its next revision.
          Everything keeps a crash-recovery copy either way.
        </div>

        <div className="settings-section">Mesh import</div>

        <label className="settings-row settings-check">
          <input
            type="checkbox"
            checked={prefs.autoSimplifyOnImport}
            onChange={(e) => update({ autoSimplifyOnImport: e.target.checked })}
          />
          Auto-simplify large meshes on import
        </label>

        <div className="settings-row">
          <span>Max triangles</span>
          <input
            type="number"
            min={1000}
            step={10000}
            disabled={!prefs.autoSimplifyOnImport}
            value={prefs.importFacetCap}
            onChange={(e) => update({ importFacetCap: Math.max(1000, Number(e.target.value) || 0) })}
          />
        </div>
        <div className="settings-hint">
          A mesh over this many triangles is decimated down to it right after
          import, before it ever hits the viewport. Editing / repair tools on
          an oversized mesh can still be slow - lower this if imports feel
          sluggish, raise it if you need more detail preserved.
        </div>

        <div className="settings-section">Mesh to BRep</div>
        <div className="settings-hint">
          Convert Mesh's "Flats" result recognizes planar regions (machined
          faces, panel faces, flat sides) and rebuilds them as real flat BRep
          faces instead of hundreds of tiny triangles - only genuinely curved
          or freeform area stays faceted. Curved-surface recognition (fitting
          real cylinders/cones) is not available in this build yet.
        </div>

        <button className="settings-reset" onClick={reset}>
          Reset to defaults
        </button>
      </div>
    </div>
  )
}
