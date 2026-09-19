import { useEffect, useState } from 'react'
import { api, type CompanyConfig } from '../rpc'

/**
 * "New Part": assigns a real company PN (project + type + an available
 * sequence number, rev always starts at 0) before a new document is created,
 * instead of letting the user save an untracked file. Submitting calls
 * pn.reserve (which commits the new row to the shared registry repo) and
 * hands the caller back the assigned PN + the absolute path the new .FCStd
 * should be saved to - this component does not touch the FreeCAD document
 * itself, that's the caller's job (session reset + saveAs + pn.tagDocument).
 */
export function NewPartDialog({
  onClose,
  onCreated,
  initialProject
}: {
  onClose: () => void
  onCreated: (info: { pn: string; path: string; name: string; description: string }) => void
  initialProject?: string
}): JSX.Element {
  const [cfg, setCfg] = useState<CompanyConfig | null>(null)
  const [types, setTypes] = useState<Record<string, string>>({})
  const [project, setProject] = useState<string>(initialProject ?? '')
  const [type, setType] = useState<string>('')
  const [available, setAvailable] = useState<number[]>([])
  const [seq, setSeq] = useState<number | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [mfg, setMfg] = useState('')
  const [mfgPn, setMfgPn] = useState('')
  const [purchasingLink, setPurchasingLink] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    void Promise.all([api.pnGetCompanyConfig(), api.pnListTypes()]).then(([c, t]) => {
      setCfg(c)
      setTypes(t.types)
      if (initialProject) {
        setProject(initialProject)
        return
      }
      const codes = Object.keys(c.projects)
      if (codes.length) setProject(codes[0])
    })
  }, [])

  useEffect(() => {
    setSeq(null)
    setAvailable([])
    if (!project || !type) return
    void api
      .pnListAvailableSeq(project, type)
      .then((r) => setAvailable(r.available))
      .catch((e) => setErr((e as Error).message))
  }, [project, type])

  const projectChoices = cfg
    ? Object.entries(cfg.projects).map(([code, p]) => ({ code, label: `${code} - ${p.name}` }))
    : []

  const notConfigured = cfg !== null && projectChoices.length === 0

  const canSubmit = project && type && seq !== null && name.trim() && description.trim() && !busy

  const submit = async (): Promise<void> => {
    if (!canSubmit || seq === null) return
    setBusy(true)
    setErr(null)
    try {
      const res = await api.pnReserve(
        project,
        type,
        seq,
        name.trim(),
        description.trim(),
        mfg.trim() || undefined,
        mfgPn.trim() || undefined,
        purchasingLink.trim() || undefined
      )
      const repoPath = cfg?.projects[project]?.repoPath
      if (!repoPath) throw new Error('project has no repo path configured')
      const path = `${repoPath}/${res.repoRelpath}`
      onCreated({ pn: res.pn, path, name: res.name, description: res.description })
    } catch (e) {
      setErr((e as Error).message)
      // the seq we tried may already be taken by someone else - refresh the
      // available list so the user picks a different one instead of retrying
      // the same seq blind.
      if (project && type) {
        void api.pnListAvailableSeq(project, type).then((r) => setAvailable(r.available))
      }
      setBusy(false)
    }
  }

  return (
    <div className="mcmaster-panel" style={{ left: '20%', right: '20%', top: '10%', bottom: '10%' }}>
      <div className="mcmaster-head">
        <span style={{ padding: '0 6px', fontWeight: 600 }}>NEW PART</span>
        <div style={{ flex: 1 }} />
        <button onClick={onClose} title="Close">
          &times;
        </button>
      </div>

      <div className="settings-body">
        {notConfigured && (
          <div className="settings-hint">
            No project repos are configured yet. Open Company Directories
            (File menu) to set them up first.
          </div>
        )}

        <div className="settings-section">Project</div>
        <div className="settings-row">
          <select value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="" disabled>
              Choose a project
            </option>
            {projectChoices.map((p) => (
              <option key={p.code} value={p.code}>
                {p.label}
              </option>
            ))}
          </select>
        </div>

        <div className="settings-section">Type</div>
        <div className="settings-row">
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="" disabled>
              Choose a type
            </option>
            {Object.entries(types).map(([letter, label]) => (
              <option key={letter} value={letter}>
                {letter} - {label}
              </option>
            ))}
          </select>
          {!Object.keys(types).length && (
            <span className="settings-hint">
              No types defined yet - add them to types.yaml in the registry repo.
            </span>
          )}
        </div>

        <div className="settings-section">Sequence number</div>
        <div className="settings-row" style={{ flexWrap: 'wrap', gap: '4px' }}>
          {!project || !type ? (
            <span className="settings-hint">Pick a project and type first.</span>
          ) : (
            available.slice(0, 60).map((n) => (
              <button
                key={n}
                className={n === seq ? 'materials-fam active' : 'materials-fam'}
                onClick={() => setSeq(n)}
              >
                {String(n).padStart(3, '0')}
              </button>
            ))
          )}
        </div>

        <div className="settings-section">Name &amp; description</div>
        <div className="settings-row">
          <input
            placeholder="Name (e.g. bolt, bracket, enclosure)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="settings-row">
          <input
            placeholder='Description (e.g. 1/2" x 2" Hex Head Grade 8 Bolt)'
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        <div className="settings-section">Manufacturer info (optional)</div>
        <div className="settings-hint">
          For purchased/off-the-shelf hardware - leave blank for parts you design yourself.
        </div>
        <div className="settings-row">
          <input placeholder="MFG (e.g. DigiKey, McMaster-Carr)" value={mfg} onChange={(e) => setMfg(e.target.value)} />
          <input placeholder="MFG part number" value={mfgPn} onChange={(e) => setMfgPn(e.target.value)} />
        </div>
        <div className="settings-row">
          <input
            placeholder="Purchasing link"
            value={purchasingLink}
            onChange={(e) => setPurchasingLink(e.target.value)}
          />
        </div>

        {project && type && seq !== null && (
          <div className="settings-hint">
            Will assign: <strong>{project}{type}{String(seq).padStart(3, '0')}0</strong>
          </div>
        )}

        {err && <div className="settings-hint" style={{ color: 'var(--danger, #e05555)' }}>{err}</div>}

        <button className="mcmaster-import" disabled={!canSubmit} onClick={() => void submit()}>
          {busy ? 'Assigning…' : 'Create Part'}
        </button>
      </div>
    </div>
  )
}
