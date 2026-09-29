import { useCallback, useEffect, useState } from 'react'
import { pushAppAction } from '../appHistory'

/** a commit body for reading: hard-wrapped lines joined into paragraphs,
 *  list items kept on their own lines, trailers (Co-Authored-By: ...) dropped */
function readableNotes(body: string): string {
  const lines = body.split('\n').filter((l) => !/^[A-Za-z-]+-By: /.test(l.trim()))
  const out: string[] = []
  for (const raw of lines) {
    const l = raw.trimEnd()
    const prev = out.length ? out[out.length - 1] : null
    const item = /^\s*([-*•]|\d+[.)])\s/.test(l)
    if (!l.trim()) out.push('')
    else if (prev && prev.trim() && !item) out[out.length - 1] = `${prev} ${l.trim()}`
    else out.push(l.trim())
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** one side of a version compare: a commit of the file, or the working copy */
export type VersionRef = { kind: 'commit'; commit: FileCommit } | { kind: 'current' }

/**
 * History panel (right side) - the open part's own story in git: every
 * version that touched it (followed across renames) with its notes,
 * compare any two versions side by side in the main view, and commit this
 * part with a note. Everything here is scoped to THIS part's files; the
 * company repo is one shared monorepo, so whole-repo actions (branches,
 * remotes) live under "Whole repository". Auth for push/pull is whatever
 * the system `git` is configured with.
 */
export function GitPanel({
  open,
  filePath,
  isOpenDoc,
  docDirty,
  onCompare,
  onFileRestored
}: {
  open: boolean
  filePath: string | null
  /** filePath is the document open in the editor */
  isOpenDoc?: boolean
  /** ...and it has unsaved edits */
  docDirty?: boolean
  onCompare?: (filePath: string, a: VersionRef, b: VersionRef) => void
  /** the file on disk changed under the editor (discard / its undo) */
  onFileRestored?: (filePath: string) => void
}): JSX.Element {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [log, setLog] = useState<FileCommit[]>([])
  const [changes, setChanges] = useState<{ path: string; status: string }[]>([])
  const [branches, setBranches] = useState<GitBranch[]>([])
  const [remotes, setRemotes] = useState<GitRemote[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState('')
  const [notes, setNotes] = useState('')
  const [showAuto, setShowAuto] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [picked, setPicked] = useState<string[]>([]) // up to two commit hashes to compare
  const [newBranchName, setNewBranchName] = useState('')
  const [newBranchOpen, setNewBranchOpen] = useState(false)
  const [mergeOpen, setMergeOpen] = useState(false)
  const [mergeTarget, setMergeTarget] = useState('')
  const [remoteUrl, setRemoteUrl] = useState('')

  const refresh = useCallback(async () => {
    if (!filePath) {
      setStatus(null)
      setLog([])
      setChanges([])
      return
    }
    const s = await window.cad.gitStatus(filePath)
    setStatus(s)
    if (s.isRepo) {
      const [l, c, b, r] = await Promise.all([
        window.cad.gitFileLog(filePath),
        window.cad.gitFileChanges(filePath),
        window.cad.gitBranches(filePath),
        window.cad.gitRemotes(filePath)
      ])
      setLog(l)
      setChanges(c)
      setBranches(b)
      setRemotes(r)
    } else {
      setLog([])
      setChanges([])
    }
  }, [filePath])

  useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])
  useEffect(() => {
    setPicked([])
    setExpanded(new Set())
  }, [filePath])

  // run a git action, show git's own error text on failure, refresh either way
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

  const message = (): string => (notes.trim() ? `${msg.trim()}\n\n${notes.trim()}` : msg.trim())

  const doCommit = (push: boolean): void => {
    if (!filePath || !msg.trim()) return
    void act(async () => {
      await window.cad.gitCommitFile(filePath, message())
      setMsg('')
      setNotes('')
      if (push) await window.cad.gitPush(filePath)
    })
  }

  // undoable: the current files are backed up first (Ctrl+Z puts them back)
  const doDiscard = (): void => {
    if (!filePath) return
    const name = filePath.split(/[\\/]/).pop()
    void act(async () => {
      const { backup } = await window.cad.gitDiscardFile(filePath)
      onFileRestored?.(filePath)
      window.dispatchEvent(new CustomEvent('gwtcad-notice', { detail: `Discarded changes to ${name} - Ctrl+Z to undo` }))
      pushAppAction({
        label: `Discard changes to ${name}`,
        undo: async () => {
          await window.cad.gitUndoDiscard(backup)
          onFileRestored?.(filePath)
          void refresh()
        },
        redo: async () => {
          await window.cad.gitDiscardFile(filePath)
          onFileRestored?.(filePath)
          void refresh()
        }
      })
    })
  }

  const doPush = (): void => {
    if (filePath) void act(async () => void (await window.cad.gitPush(filePath)))
  }
  const doPull = (): void => {
    if (!filePath) return
    void act(async () => {
      const r = await window.cad.gitPull(filePath)
      if (r.conflict) setErr('Pull hit conflicts - resolve the marked files, then commit, or Abort Merge.')
    })
  }
  const doFetch = (): void => {
    if (filePath) void act(async () => void (await window.cad.gitFetch(filePath)))
  }
  const doAbortMerge = (): void => {
    if (filePath) void act(async () => void (await window.cad.gitAbortMerge(filePath)))
  }
  const doInit = (): void => {
    if (filePath) void act(async () => void (await window.cad.gitInit(filePath)))
  }
  const doCreateBranch = (): void => {
    if (!filePath || !newBranchName.trim()) return
    void act(async () => {
      await window.cad.gitCreateBranch(filePath, newBranchName.trim())
      setNewBranchName('')
      setNewBranchOpen(false)
    })
  }
  const doMerge = (): void => {
    if (!filePath || !mergeTarget) return
    void act(async () => {
      const r = await window.cad.gitMerge(filePath, mergeTarget)
      if (r.conflict) {
        setErr(`Merge of "${mergeTarget}" hit conflicts - resolve the marked files, then commit, or Abort Merge.`)
      } else {
        setMergeOpen(false)
        setMergeTarget('')
      }
    })
  }
  const doCheckout = (name: string): void => {
    if (!filePath) return
    if (!window.confirm(`Switch the WHOLE repository to branch "${name}"? This changes every part's files on disk.`)) return
    void act(async () => void (await window.cad.gitCheckout(filePath, name)))
  }
  const doAddRemote = (): void => {
    if (!filePath || !remoteUrl.trim()) return
    void act(async () => {
      await window.cad.gitAddRemote(filePath, 'origin', remoteUrl.trim())
      setRemoteUrl('')
    })
  }

  const togglePick = (hash: string): void =>
    setPicked((p) => (p.includes(hash) ? p.filter((h) => h !== hash) : [...p.slice(-1), hash]))

  const shown = showAuto ? log : log.filter((c) => !c.auto)
  const autoCount = log.filter((c) => c.auto).length
  const byHash = new Map(log.map((c) => [c.hash, c]))
  const inMerge = err?.toLowerCase().includes('conflict')
  const dirtyHere = changes.length > 0
  const name = filePath?.split(/[\\/]/).pop()

  const compareTwo = (): void => {
    if (!filePath || picked.length !== 2 || !onCompare) return
    // older on the left
    const [x, y] = picked.map((h) => byHash.get(h)!).sort((a, b) => a.isoDate.localeCompare(b.isoDate))
    onCompare(filePath, { kind: 'commit', commit: x }, { kind: 'commit', commit: y })
  }

  return (
    <div className={open ? 'gitpanel open' : 'gitpanel'}>
      <div className="gitpanel-head">
        <span className="gitpanel-title">HISTORY</span>
        <span className="hp-file" title={filePath ?? ''}>
          {name}
        </span>
        <button className="gitpanel-refresh" title="Refresh" onClick={() => void refresh()}>
          ⟳
        </button>
      </div>

      {!filePath && <div className="git-hint">Save the design to start tracking its history.</div>}

      {filePath && status && !status.isRepo && (
        <div className="git-hint">
          <div>This file isn't in a git repository.</div>
          <button className="git-btn git-btn-primary" disabled={busy} onClick={doInit}>
            Start tracking history here
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
            <span className="git-branchname">{status.detached ? '⚠ detached HEAD' : `⎇ ${status.branch}`}</span>
            <span className={dirtyHere ? 'git-dot dirty' : 'git-dot clean'}>
              {dirtyHere ? 'uncommitted changes' : 'up to date'}
            </span>
            {status.hasUpstream && (status.ahead ?? 0) > 0 && <span className="hp-pill">{status.ahead} to push</span>}
            {status.hasUpstream && (status.behind ?? 0) > 0 && <span className="hp-pill">{status.behind} to pull</span>}
            <span className="cmp-spacer" />
            <button className="git-btn" disabled={busy} onClick={doPull} title="Pull">
              Pull
            </button>
            <button className="git-btn" disabled={busy || !remotes.length} onClick={doPush} title="Push">
              Push
            </button>
          </div>
          {!status.tracked && <div className="git-hint git-warn">This file isn't committed yet.</div>}

          <div className="hp-section">
            <div className="hp-section-title">Commit this part</div>
            {changes.length > 0 ? (
              <div className="git-changed">
                {changes.map((c) => (
                  <div key={c.path} className="git-changed-row">
                    <span className="git-changed-code">{c.status}</span>
                    <span className="git-changed-path">{c.path.split('/').pop()}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="git-sub">
                {isOpenDoc && docDirty ? 'Unsaved edits - save to commit them.' : 'No uncommitted changes to this part.'}
              </div>
            )}
            <textarea
              className="git-msg"
              placeholder="What changed? (one line)"
              value={msg}
              onChange={(e) => setMsg(e.target.value)}
              rows={1}
            />
            <textarea
              className="hp-notes"
              placeholder="Notes for this version (optional) - why, what to check, part numbers…"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
            />
            <div className="git-actions">
              <button
                className="git-btn git-btn-primary"
                disabled={busy || !msg.trim() || !dirtyHere}
                onClick={() => doCommit(false)}
              >
                Commit this part
              </button>
              <button
                className="git-btn"
                disabled={busy || !msg.trim() || !dirtyHere || !remotes.length}
                onClick={() => doCommit(true)}
              >
                Commit &amp; push
              </button>
              <span className="cmp-spacer" />
              {dirtyHere && (
                <button className="git-btn git-btn-danger" disabled={busy} onClick={doDiscard} title="Ctrl+Z undoes this">
                  Discard changes
                </button>
              )}
            </div>
          </div>

          <div className="hp-section">
            <div className="hp-section-title">
              Versions <span className="git-sub">({shown.length})</span>
              <span className="cmp-spacer" />
              {autoCount > 0 && (
                <label className="hp-auto-toggle" title="lock / auto-generated drawing / supplier reference commits">
                  <input type="checkbox" checked={showAuto} onChange={(e) => setShowAuto(e.target.checked)} /> automatic ({autoCount})
                </label>
              )}
            </div>
            {picked.length > 0 && (
              <div className="hp-pickbar">
                {picked.length === 1 ? 'Pick one more version to compare…' : 'Two versions picked'}
                <span className="cmp-spacer" />
                <button className="git-btn git-btn-primary" disabled={picked.length !== 2} onClick={compareTwo}>
                  Compare side by side
                </button>
                <button className="git-btn" onClick={() => setPicked([])}>
                  Clear
                </button>
              </div>
            )}
            <div className="git-log">
              <div className="git-commit hp-current">
                <div className="git-commit-top">
                  <span className="git-hash">now</span>
                  <span className="git-subject">Current{dirtyHere || docDirty ? ' (with changes)' : ''}</span>
                </div>
              </div>
              {shown.map((c) => {
                const open = expanded.has(c.hash)
                const isPicked = picked.includes(c.hash)
                return (
                  <div
                    key={c.hash}
                    className={'git-commit' + (c.auto ? ' hp-auto' : '') + (isPicked ? ' hp-picked' : '')}
                    title={`${c.hash}\n${c.author}\n${c.isoDate}`}
                  >
                    <div className="git-commit-top">
                      <input
                        type="checkbox"
                        className="hp-pick"
                        checked={isPicked}
                        onChange={() => togglePick(c.hash)}
                        title="Pick to compare"
                      />
                      <span className="git-hash">{c.short}</span>
                      <span className="git-rel">
                        {c.relDate} · {c.author.split(' ')[0]}
                      </span>
                    </div>
                    <div
                      className={c.body ? 'git-subject hp-has-notes' : 'git-subject'}
                      onClick={() =>
                        c.body &&
                        setExpanded((s) => {
                          const n = new Set(s)
                          if (n.has(c.hash)) n.delete(c.hash)
                          else n.add(c.hash)
                          return n
                        })
                      }
                    >
                      {c.subject}
                      {c.body && !open && <span className="hp-notes-more"> ▸ notes</span>}
                    </div>
                    {c.body && open && <div className="hp-notes-body">{readableNotes(c.body)}</div>}
                    {onCompare && filePath && (
                      <div className="hp-row-actions">
                        <button
                          className="git-btn hp-mini"
                          onClick={() => onCompare(filePath, { kind: 'commit', commit: c }, { kind: 'current' })}
                        >
                          Compare with current
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
              {!shown.length && <div className="git-hint">No commits touch this file yet.</div>}
            </div>
          </div>

          <details className="hp-section hp-advanced">
            <summary className="hp-section-title">Whole repository</summary>
            <div className="git-sub">
              {status.root} - shared by every part in it. These act on the whole repository.
            </div>
            <div className="git-actions">
              <button className="git-btn" disabled={busy} onClick={doFetch}>
                Fetch
              </button>
              <button className="git-btn" disabled={busy} onClick={() => setNewBranchOpen((v) => !v)}>
                + Branch
              </button>
              <button className="git-btn" disabled={busy || branches.length < 2} onClick={() => setMergeOpen((v) => !v)}>
                Merge…
              </button>
            </div>
            {mergeOpen && (
              <div className="git-branch-new">
                <select className="git-input" value={mergeTarget} onChange={(e) => setMergeTarget(e.target.value)}>
                  <option value="">Merge which branch into {status.branch}?</option>
                  {branches
                    .filter((b) => !b.current)
                    .map((b) => (
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
            {branches.length > 0 && (
              <div className="git-branches">
                {branches.map((b) => (
                  <span
                    key={b.name}
                    className={b.current ? 'git-branch cur' : 'git-branch'}
                    onClick={() => !b.current && doCheckout(b.name)}
                    title={b.current ? 'current branch' : `Switch to ${b.name}`}
                  >
                    {b.name}
                  </span>
                ))}
              </div>
            )}
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
          </details>
        </>
      )}
    </div>
  )
}
