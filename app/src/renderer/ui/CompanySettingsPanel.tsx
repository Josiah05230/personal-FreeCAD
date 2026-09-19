import { useEffect, useState } from 'react'
import { api, type CompanyConfig } from '../rpc'

/**
 * Where the company's PN registry and per-project/hardware git repos live on
 * THIS machine. Every path here is local and independently configurable -
 * project repos, the hardware repo, and the shared registry repo are all
 * separate git repos (only the registry's PN rows need to be globally
 * consistent, so it's the one shared source of truth; project/hardware repos
 * are otherwise independent).
 */
export function CompanySettingsPanel({ onClose }: { onClose: () => void }): JSX.Element {
  const [cfg, setCfg] = useState<CompanyConfig | null>(null)
  const [newCode, setNewCode] = useState('')
  const [newName, setNewName] = useState('')
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    void api.pnGetCompanyConfig().then(setCfg)
  }, [])

  const save = (next: CompanyConfig): void => {
    setCfg(next)
    void api.pnSetCompanyConfig(next).catch((e) => setErr((e as Error).message))
  }

  const pickDir = async (): Promise<string | null> => window.cad.openDirectoryDialog()

  const setRegistryPath = async (): Promise<void> => {
    const p = await pickDir()
    if (!p || !cfg) return
    save({ ...cfg, registryPath: p })
  }

  const setHardwarePath = async (): Promise<void> => {
    const p = await pickDir()
    if (!p || !cfg) return
    save({ ...cfg, hardware: { repoPath: p } })
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
    save({ ...cfg, projects: rest })
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
    save({ ...cfg, projects: { ...cfg.projects, [code]: { name: newName.trim(), repoPath: p } } })
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

        <div className="settings-section">Hardware library</div>
        <div className="settings-row">
          <span title={cfg.hardware?.repoPath ?? ''}>{cfg.hardware?.repoPath ?? 'Not set'}</span>
          <button onClick={() => void setHardwarePath()}>Choose…</button>
        </div>
        <div className="settings-hint">
          One repo for reusable off-the-shelf parts (bolts, magnets, MMC
          connectors, ...). Uses the same PN reserve/browse/open flow as any
          project - just pick "hardware" instead of a project when assigning
          a PN.
        </div>

        <div className="settings-section">Projects</div>
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
