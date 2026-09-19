import { useEffect, useMemo, useState } from 'react'
import { api, type PartRecord } from '../rpc'

/**
 * "Part Number Manager": browse every PN in the company registry (across all
 * projects + hardware) and open one's current-rev file. This is genuinely
 * separate from the per-document Browser tree - it reads the shared registry,
 * not the currently-open FreeCAD document.
 */
export function PNBrowserPanel({
  onClose,
  onOpen
}: {
  onClose: () => void
  onOpen: (path: string) => void
}): JSX.Element {
  const [parts, setParts] = useState<PartRecord[]>([])
  const [filter, setFilter] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busyPn, setBusyPn] = useState<string | null>(null)

  const load = (): void => {
    void api
      .pnListAll()
      .then((r) => setParts(r.parts))
      .catch((e) => setErr((e as Error).message))
  }
  useEffect(load, [])

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return parts
    return parts.filter((p) =>
      [p.pn_seq, p.name, p.description, p.project, p.type].some((v) =>
        v.toLowerCase().includes(q)
      )
    )
  }, [parts, filter])

  const open = async (p: PartRecord): Promise<void> => {
    setBusyPn(p.pn_seq)
    setErr(null)
    try {
      const r = await api.pnResolve(p.pn_seq)
      onOpen(r.path)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusyPn(null)
    }
  }

  return (
    <div className="mcmaster-panel" style={{ left: '10%', right: '10%', top: '8%', bottom: '8%' }}>
      <div className="mcmaster-head">
        <span style={{ padding: '0 6px', fontWeight: 600 }}>PART NUMBER MANAGER</span>
        <input
          className="mcmaster-url-input"
          style={{ flex: 1, maxWidth: '360px' }}
          placeholder="Filter by PN, name, description, project..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button onClick={load} title="Refresh from registry">
          &#8635;
        </button>
        <button onClick={onClose} title="Close">
          &times;
        </button>
      </div>

      {err && <div className="mcmaster-status"><span className="mcmaster-err">{err}</span></div>}

      <div style={{ overflow: 'auto', flex: 1 }}>
        <table className="pn-browser-table">
          <thead>
            <tr>
              <th>PN</th>
              <th>Rev</th>
              <th>Project</th>
              <th>Type</th>
              <th>Name</th>
              <th>Description</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {filtered.map((p) => (
              <tr key={p.pn_seq}>
                <td>{p.pn_seq}</td>
                <td>{p.current_rev}</td>
                <td>{p.project}</td>
                <td>{p.type}</td>
                <td>{p.name}</td>
                <td>{p.description}</td>
                <td>{p.status}</td>
                <td>
                  <button disabled={busyPn === p.pn_seq} onClick={() => void open(p)}>
                    {busyPn === p.pn_seq ? 'Opening…' : 'Open'}
                  </button>
                </td>
              </tr>
            ))}
            {!filtered.length && (
              <tr>
                <td colSpan={8} style={{ textAlign: 'center', color: 'var(--text-dim)' }}>
                  {parts.length ? 'No parts match that filter.' : 'No parts in the registry yet.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
