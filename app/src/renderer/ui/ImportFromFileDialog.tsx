import { useState } from 'react'
import type { ImportInspection, ImportRole } from '../rpc'

export interface ImportPlan {
  extractDir: string
  sourceName: string
  /** absolute paths of standalone 3D models -> ONE mechanical PN */
  mechanical: string[]
  /** relpaths (inside extractDir) of everything that goes into the F PN's
   *  ECAD folder, or null if there's no KiCad project in the upload */
  ecad: string[] | null
}

const ROLE_LABEL: Record<ImportRole, string> = {
  kicad: 'KiCad project',
  footprint: 'Part of the board (footprint model)',
  mechanical: 'Separate mechanical part',
  attachment: 'Attachment'
}

/**
 * Import from File, step 2: shows what the upload was classified as BEFORE
 * any PN is reserved or anything is written to a company repo. The
 * auto-classification (a STEP counts as "part of the board" only if a
 * footprint's (model ...) reference in the .kicad_pcb names it) is a
 * starting guess - every 3D model row can be flipped between "part of the
 * board" and "separate mechanical part" here, since a wrong guess would
 * otherwise mean a wrong PN in the wrong repo.
 */
export function ImportFromFileDialog({
  inspection,
  onCancel,
  onConfirm
}: {
  inspection: ImportInspection
  onCancel: () => void
  onConfirm: (plan: ImportPlan) => void
}): JSX.Element {
  const [roles, setRoles] = useState<Record<string, ImportRole>>(() =>
    Object.fromEntries(inspection.files.map((f) => [f.relpath, f.role]))
  )
  const hasKicad = inspection.hasKicad
  const togglable = (rel: string): boolean =>
    hasKicad && (roles[rel] === 'footprint' || roles[rel] === 'mechanical')

  const mech = inspection.files.filter((f) => roles[f.relpath] === 'mechanical')
  const ecad = hasKicad ? inspection.files.filter((f) => roles[f.relpath] !== 'mechanical') : []
  const nothing = !mech.length && !hasKicad

  const confirm = (): void => {
    const sep = inspection.extractDir.includes('\\') ? '\\' : '/'
    onConfirm({
      extractDir: inspection.extractDir,
      sourceName: inspection.sourceName,
      mechanical: mech.map((f) => inspection.extractDir + sep + f.relpath),
      ecad: hasKicad ? ecad.map((f) => f.relpath) : null
    })
  }

  return (
    <div className="mcmaster-panel import-dialog" style={{ left: '15%', right: '15%', top: '10%', bottom: '10%' }}>
      <div className="mcmaster-head">
        <span style={{ padding: '0 6px', fontWeight: 600 }}>IMPORT FROM FILE - {inspection.sourceName}</span>
        <div style={{ flex: 1 }} />
        <button onClick={onCancel} title="Cancel">
          &times;
        </button>
      </div>
      <div className="settings-body">
        <div className="settings-hint">
          Nothing has been saved yet. Check how each file was classified - flip any 3D model that
          landed in the wrong bucket - then continue to assign part number(s).
        </div>

        <div className="settings-section">Will create</div>
        <div className="settings-hint import-summary">
          {nothing && 'Nothing importable found (no 3D models or KiCad project in this file).'}
          {mech.length > 0 && (
            <div>
              <strong>1 mechanical part</strong> ({mech.length} model{mech.length === 1 ? '' : 's'})
            </div>
          )}
          {hasKicad && (
            <div>
              <strong>1 PCB assembly (type F)</strong> - KiCad project
              {ecad.some((f) => roles[f.relpath] === 'footprint') &&
                ` + ${ecad.filter((f) => roles[f.relpath] === 'footprint').length} footprint model(s)`}
            </div>
          )}
          {mech.length > 0 && hasKicad && (
            <div>You'll be asked for the mechanical part's PN first, then the PCB assembly's.</div>
          )}
        </div>

        <div className="settings-section">Files</div>
        <table className="pn-browser-table import-files">
          <tbody>
            {inspection.files.map((f) => (
              <tr key={f.relpath}>
                <td title={f.relpath}>{f.relpath}</td>
                <td>
                  {togglable(f.relpath) ? (
                    <select
                      value={roles[f.relpath]}
                      onChange={(e) =>
                        setRoles((r) => ({ ...r, [f.relpath]: e.target.value as ImportRole }))
                      }
                    >
                      <option value="footprint">{ROLE_LABEL.footprint}</option>
                      <option value="mechanical">{ROLE_LABEL.mechanical}</option>
                    </select>
                  ) : (
                    <span>
                      {!hasKicad && roles[f.relpath] === 'attachment'
                        ? 'Ignored (no KiCad project to attach to)'
                        : ROLE_LABEL[roles[f.relpath]]}
                    </span>
                  )}
                  {f.matchedModel && roles[f.relpath] === 'footprint' && (
                    <span className="settings-hint" title={f.matchedModel}>
                      {' '}
                      - referenced by the board
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <button className="mcmaster-import" disabled={nothing} onClick={confirm}>
          Continue
        </button>
      </div>
    </div>
  )
}
