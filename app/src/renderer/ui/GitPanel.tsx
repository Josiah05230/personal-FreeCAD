import { useCallback, useEffect, useState } from 'react'

/**
 * History (Git) panel - a right-side banner. Every saved design lives in git;
 * this shows the branch, working state, and the commit history of the active
 * design file. Read-only for now (checkout / diff / restore are next).
 */
export function GitPanel({
  open,
  filePath
}: {
  open: boolean
  filePath: string | null
}): JSX.Element {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [log, setLog] = useState<GitCommit[]>([])
  const [branches, setBranches] = useState<GitBranch[]>([])

  const refresh = useCallback(async () => {
    if (!filePath) {
      setStatus(null)
      setLog([])
      setBranches([])
      return
    }
    const s = await window.cad.gitStatus(filePath)
    setStatus(s)
    if (s.isRepo) {
      setLog(await window.cad.gitLog(filePath, 60))
      setBranches(await window.cad.gitBranches(filePath))
    } else {
      setLog([])
      setBranches([])
    }
  }, [filePath])

  useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])

  return (
    <div className={open ? 'gitpanel open' : 'gitpanel'}>
      <div className="gitpanel-head">
        <span className="gitpanel-title">HISTORY</span>
        <button className="gitpanel-refresh" title="Refresh" onClick={() => void refresh()}>
          ⟳
        </button>
      </div>

      {!filePath && <div className="git-hint">Save the design to start tracking history.</div>}

      {filePath && status && !status.isRepo && (
        <div className="git-hint">
          <div>Not in a git repository.</div>
          <div className="git-sub">{status.root ?? filePath}</div>
        </div>
      )}

      {status?.isRepo && (
        <>
          <div className="git-branchbar">
            <span className="git-branchname">⎇ {status.branch}</span>
            <span className={status.dirty ? 'git-dot dirty' : 'git-dot clean'}>
              {status.dirty ? 'uncommitted changes' : 'clean'}
            </span>
          </div>
          {!status.tracked && (
            <div className="git-hint git-warn">This file is not tracked yet.</div>
          )}
          {branches.length > 1 && (
            <div className="git-branches">
              {branches.map((b) => (
                <span key={b.name} className={b.current ? 'git-branch cur' : 'git-branch'}>
                  {b.name}
                </span>
              ))}
            </div>
          )}
          <div className="git-log">
            {log.map((c) => (
              <div key={c.hash} className="git-commit" title={`${c.hash}\n${c.author}\n${c.isoDate}`}>
                <div className="git-commit-top">
                  <span className="git-hash">{c.short}</span>
                  <span className="git-rel">{c.relDate}</span>
                </div>
                <div className="git-subject">{c.subject}</div>
              </div>
            ))}
            {!log.length && <div className="git-hint">No commits touch this file yet.</div>}
          </div>
        </>
      )}
    </div>
  )
}
