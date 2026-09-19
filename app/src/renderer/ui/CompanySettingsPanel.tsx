import { useEffect, useState } from 'react'
import { api, type CompanyConfig } from '../rpc'

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
