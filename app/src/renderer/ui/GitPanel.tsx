import { useCallback, useEffect, useState } from 'react'

/**
 * History (Git) panel - a right-side banner. Every saved design lives in git;
 * this shows the branch, working state, commit history, and lets you stage +
 * commit, create/switch/merge branches, and push/pull. Auth for push/pull is
 * whatever the system `git` is already configured with (e.g. `gh auth
 * git-credential`) - this panel never asks for a token itself; an auth
 * failure surfaces as git's own error text.
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
  const [changed, setChanged] = useState<GitFileChange[]>([])
  const [remotes, setRemotes] = useState<GitRemote[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState('')
  const [newBranchOpen, setNewBranchOpen] = useState(false)
  const [newBranchName, setNewBranchName] = useState('')
  const [mergeOpen, setMergeOpen] = useState(false)
  const [mergeTarget, setMergeTarget] = useState('')
  const [remoteUrl, setRemoteUrl] = useState('')

  const refresh = useCallback(async () => {
    if (!filePath) {
      setStatus(null)
      setLog([])
      setBranches([])
      setChanged([])
      setRemotes([])
      return
    }
    const s = await window.cad.gitStatus(filePath)
    setStatus(s)
    if (s.isRepo) {
      // full repo history, not just this file's own touches - once branches
      // and merges are in play, a merged-in commit that never happened to
      // touch THIS file (e.g. a README change) should still show up
      setLog(await window.cad.gitLogAll(filePath, 60))
      setBranches(await window.cad.gitBranches(filePath))
      setChanged(await window.cad.gitChangedFiles(filePath))
      setRemotes(await window.cad.gitRemotes(filePath))
    } else {
      setLog([])
      setBranches([])
      setChanged([])
      setRemotes([])
    }
  }, [filePath])

  useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])

  // every write action follows the same shape: run it, surface git's own
  // error text verbatim on failure, refresh state either way
  const act = useCallback(
    async (fn: () => Promise<void>) => {
      setBusy(true)
      setErr(null)
      try {
        await fn()
      } catch (e) {
        setErr((e as Error).message || String(e))
      } finally {
        setBusy(false)
        await refresh()
      }
    },
    [refresh]
  )

  const doInit = (): void => {
    if (!filePath) return
    void act(async () => {
      await window.cad.gitInit(filePath)
    })
  }

  const doCommit = (): void => {
    if (!filePath || !msg.trim()) return
    void act(async () => {
      await window.cad.gitCommitAll(filePath, msg.trim())
      setMsg('')
    })
  }

  const doCreateBranch = (): void => {
    if (!filePath || !newBranchName.trim()) return
    void act(async () => {
      await window.cad.gitCreateBranch(filePath, newBranchName.trim())
      setNewBranchName('')
      setNewBranchOpen(false)
    })
  }

  const doCheckout = (name: string): void => {
    if (!filePath) return
    void act(async () => {
      await window.cad.gitCheckout(filePath, name)
    })
  }

  const doMerge = (): void => {
    if (!filePath || !mergeTarget) return
    void act(async () => {
      const r = await window.cad.gitMerge(filePath, mergeTarget)
      if (r.conflict) {
        setErr(
          `Merge of "${mergeTarget}" hit conflicts - resolve the marked files, then Commit, or Abort Merge below.`
        )
      } else {
        setMergeOpen(false)
        setMergeTarget('')
      }
    })
  }

  const doAbortMerge = (): void => {
    if (!filePath) return
    void act(async () => {
      await window.cad.gitAbortMerge(filePath)
    })
  }

  const doPush = (): void => {
    if (!filePath) return
    void act(async () => {
      await window.cad.gitPush(filePath)
    })
  }

  const doPull = (): void => {
    if (!filePath) return
    void act(async () => {
      const r = await window.cad.gitPull(filePath)
      if (r.conflict) {
        setErr('Pull hit conflicts - resolve the marked files, then Commit, or Abort Merge below.')
      }
    })
  }

  const doFetch = (): void => {
    if (!filePath) return
    void act(async () => {
      await window.cad.gitFetch(filePath)
    })
  }

  const doDiscardAll = (): void => {
    if (!filePath) return
    if (!window.confirm('Discard ALL uncommitted changes? This cannot be undone.')) return
    void act(async () => {
      await window.cad.gitDiscardAll(filePath)
    })
  }

  const doAddRemote = (): void => {
    if (!filePath || !remoteUrl.trim()) return
    void act(async () => {
      await window.cad.gitAddRemote(filePath, 'origin', remoteUrl.trim())
      setRemoteUrl('')
    })
  }

  const inMerge = err?.toLowerCase().includes('conflict')

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
          <button className="git-btn git-btn-primary" disabled={busy} onClick={doInit}>
            Initialize git repository here
          </button>
        </div>
      )}

      {err && (
        <div className="git-hint git-warn git-error">
          {err}
          {inMerge && (
            <button className="git-btn" disabled={busy} onClick={doAbortMerge}>
              Abort Merge
            </button>
          )}
        </div>
      )}

      {status?.isRepo && (
        <>
          <div className="git-branchbar">
            <span className="git-branchname">
              {status.detached ? '⚠ detached HEAD' : `⎇ ${status.branch}`}
            </span>
            <span className={status.dirty ? 'git-dot dirty' : 'git-dot clean'}>
              {status.dirty ? 'uncommitted changes' : 'clean'}
            </span>
          </div>
          {!status.tracked && <div className="git-hint git-warn">This file is not tracked yet.</div>}

          {status.hasUpstream && (status.ahead ?? 0) + (status.behind ?? 0) > 0 && (
            <div className="git-hint git-sub">
              {(status.ahead ?? 0) > 0 ? `${status.ahead} ahead` : ''}
              {(status.ahead ?? 0) > 0 && (status.behind ?? 0) > 0 ? ', ' : ''}
              {(status.behind ?? 0) > 0 ? `${status.behind} behind` : ''} of the remote
            </div>
          )}

          <div className="git-actions">
            <button className="git-btn" disabled={busy} onClick={doFetch} title="Fetch">
              Fetch
            </button>
            <button className="git-btn" disabled={busy} onClick={doPull} title="Pull">
              Pull
            </button>
            <button
              className="git-btn git-btn-primary"
              disabled={busy}
              onClick={doPush}
              title={remotes.length ? 'Push' : 'No remote configured'}
            >
              Push
            </button>
          </div>

          {remotes.length === 0 && (
            <div className="git-remote-add">
              <input
                className="git-input"
                placeholder="https://github.com/you/repo.git"
                value={remoteUrl}
                onChange={(e) => setRemoteUrl(e.target.value)}
              />
              <button className="git-btn" disabled={busy || !remoteUrl.trim()} onClick={doAddRemote}>
                Add remote "origin"
              </button>
            </div>
          )}

          <div className="git-commitbox">
            <textarea
              className="git-msg"
              placeholder="Commit message"
              value={msg}
              onChange={(e) => setMsg(e.target.value)}
              rows={2}
            />
            <button
              className="git-btn git-btn-primary"
              disabled={busy || !msg.trim() || !status.dirty}
              onClick={doCommit}
            >
              Commit All Changes
            </button>
            {status.dirty && (
              <button className="git-btn git-btn-danger" disabled={busy} onClick={doDiscardAll}>
                Discard All
              </button>
            )}
          </div>

          {changed.length > 0 && (
            <div className="git-changed">
              {changed.map((c) => (
                <div key={c.path} className="git-changed-row" title={`${c.index}${c.worktree} ${c.path}`}>
                  <span className="git-changed-code">
                    {c.index !== ' ' ? c.index : ''}
                    {c.worktree !== ' ' ? c.worktree : ''}
                  </span>
                  <span className="git-changed-path">{c.path}</span>
                </div>
              ))}
            </div>
          )}

          <div className="git-branch-actions">
            <button className="git-btn" disabled={busy} onClick={() => setNewBranchOpen((v) => !v)}>
              + Branch
            </button>
            <button
              className="git-btn"
              disabled={busy || branches.length < 2}
              onClick={() => setMergeOpen((v) => !v)}
            >
              Merge…
            </button>
          </div>

          {newBranchOpen && (
            <div className="git-branch-new">
              <input
                className="git-input"
                placeholder="new-branch-name"
                value={newBranchName}
                onChange={(e) => setNewBranchName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && doCreateBranch()}
                autoFocus
              />
              <button className="git-btn git-btn-primary" disabled={busy || !newBranchName.trim()} onClick={doCreateBranch}>
                Create + switch
              </button>
            </div>
          )}

          {mergeOpen && (
            <div className="git-branch-new">
              <select
                className="git-input"
                value={mergeTarget}
                onChange={(e) => setMergeTarget(e.target.value)}
              >
                <option value="">Merge which branch into {status.branch}?</option>
                {branches.filter((b) => !b.current).map((b) => (
                  <option key={b.name} value={b.name}>
                    {b.name}
                  </option>
                ))}
              </select>
              <button className="git-btn git-btn-primary" disabled={busy || !mergeTarget} onClick={doMerge}>
                Merge
              </button>
            </div>
          )}

          {branches.length > 1 && (
            <div className="git-branches">
              {branches.map((b) => (
                <span
                  key={b.name}
                  className={b.current ? 'git-branch cur' : 'git-branch'}
                  onClick={() => !b.current && doCheckout(b.name)}
                  title={b.current ? undefined : `Switch to ${b.name}`}
                >
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
