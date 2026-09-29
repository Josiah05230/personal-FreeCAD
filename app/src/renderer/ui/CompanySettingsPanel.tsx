import { useEffect, useState } from 'react'
import { api, type CompanyConfig } from '../rpc'
import { pushAppAction } from '../appHistory'

/**
 * Where the company's PN registry and per-project git repos live on THIS
 * machine. Every path here is local and independently configurable - each
 * project (including a reusable-hardware library, which is just a project
 * like any other, e.g. code "HW") is its own git repo; only the shared
 * registry repo's PN rows need to stay globally consistent across all of
 * them.
 */
export function CompanySettingsPanel({ onClose }: { onClose: () => void }): JSX.Element {
  const [cfg, setCfg] = useState<CompanyConfig | null>(null)
  const [newCode, setNewCode] = useState('')
  const [newName, setNewName] = useState('')
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    void api.pnGetCompanyConfig().then(setCfg)
    // an undo/redo of an edit made here (appHistory) - show the restored config
    const onChange = (): void => void api.pnGetCompanyConfig().then(setCfg)
    window.addEventListener('gwtcad-company-changed', onChange)
    return () => window.removeEventListener('gwtcad-company-changed', onChange)
  }, [])

  /** write the whole config, recorded for Ctrl+Z (restores the previous one;
   *  an unset path is sent as "" to clear it again) */
  const save = (next: CompanyConfig, label = 'Edit company directories'): void => {
    const prev = cfg
    setCfg(next)
    void api.pnSetCompanyConfig(next).catch((e) => setErr((e as Error).message))
    if (!prev) return
    const apply = async (c: CompanyConfig): Promise<void> => {
      await api.pnSetCompanyConfig({ ...c, registryPath: c.registryPath ?? '', ecadRepoPath: c.ecadRepoPath ?? '' })
      window.dispatchEvent(new Event('gwtcad-company-changed'))
    }
    pushAppAction({ label, undo: () => apply(prev), redo: () => apply(next) })
  }

  const pickDir = async (): Promise<string | null> => window.cad.openDirectoryDialog()

  const setRegistryPath = async (): Promise<void> => {
    const p = await pickDir()
    if (!p || !cfg) return
    save({ ...cfg, registryPath: p })
  }

  const setEcadRepoPath = async (): Promise<void> => {
    const p = await pickDir()
    if (!p || !cfg) return
    save({ ...cfg, ecadRepoPath: p })
  }

  const setProjectPath = async (code: string): Promise<void> => {
    const p = await pickDir()
    if (!p || !cfg) return
    save({
      ...cfg,
      projects: { ...cfg.projects, [code]: { ...cfg.projects[code], repoPath: p } }
    })
  }

  const removeProject = (code: string): void => {
    if (!cfg) return
    const { [code]: _dropped, ...rest } = cfg.projects
    save({ ...cfg, projects: rest }, `Remove project ${code}`)
    window.dispatchEvent(new CustomEvent('gwtcad-notice', { detail: `Removed project ${code} - Ctrl+Z to undo` }))
  }

  const addProject = async (): Promise<void> => {
    const code = newCode.trim().toUpperCase()
    if (!code || !newName.trim() || !cfg) return
    if (cfg.projects[code]) {
      setErr(`Project code "${code}" already exists`)
      return
    }
    const p = await pickDir()
    if (!p) return
    save({ ...cfg, projects: { ...cfg.projects, [code]: { name: newName.trim(), repoPath: p } } }, `Add project ${code}`)
    setNewCode('')
    setNewName('')
  }

  if (!cfg) return <div className="settings-panel" />

  return (
    <div className="settings-panel">
      <div className="settings-head">
        <span>COMPANY DIRECTORIES</span>
        <button onClick={onClose} title="Close">
          &times;
        </button>
      </div>

      <div className="settings-body">
        <div className="settings-section">PN registry</div>
        <div className="settings-row">
          <span title={cfg.registryPath ?? ''}>{cfg.registryPath ?? 'Not set'}</span>
          <button onClick={() => void setRegistryPath()}>Choose…</button>
        </div>
        <div className="settings-hint">
          A single shared git repo holding registry.csv (every company PN) and
          types.yaml (the project-defined type-letter map). All project repos
          read/write the same registry repo, so PNs stay unique company-wide.
        </div>

        <div className="settings-section">ECAD (KiCad) repo</div>
        <div className="settings-row">
          <span title={cfg.ecadRepoPath ?? ''}>{cfg.ecadRepoPath ?? 'Not set'}</span>
          <button onClick={() => void setEcadRepoPath()}>Choose…</button>
        </div>
        <div className="settings-hint">
          One shared repo for every PCB-assembly (type F) project - the whole
          KiCad project (.kicad_pro/.kicad_pcb/.kicad_sch) plus any exports,
          organized the same way as mechanical parts (project/type/PN). Only
          one repo company-wide, not one per project - a PCB design is far
          more likely to get reused across projects than a mechanical part is.
        </div>

        <div className="settings-section">Projects</div>
        <div className="settings-hint">
          A reusable-hardware library (bolts, magnets, MMC connectors, ...) is
          just a project like any other - give it its own code (e.g. HW) below.
        </div>
        {Object.entries(cfg.projects).map(([code, p]) => (
          <div key={code} className="settings-row">
            <span>
              <strong>{code}</strong> - {p.name}
              <br />
              <span style={{ color: 'var(--text-dim)' }} title={p.repoPath}>
                {p.repoPath}
              </span>
            </span>
            <span>
              <button onClick={() => void setProjectPath(code)}>Change…</button>
              <button onClick={() => removeProject(code)}>Remove</button>
            </span>
          </div>
        ))}

        <div className="settings-row">
          <input
            placeholder="Code (e.g. PS)"
            value={newCode}
            maxLength={2}
            onChange={(e) => setNewCode(e.target.value)}
            style={{ width: '60px' }}
          />
          <input
            placeholder="Project name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <button onClick={() => void addProject()}>Add project…</button>
        </div>
        {err && <div className="settings-hint" style={{ color: 'var(--danger, #e05555)' }}>{err}</div>}
      </div>
    </div>
  )
}
