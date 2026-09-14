/** Git wrapper for the History panel: read-only status/log/branches, plus
 *  real write operations (init, stage, commit, branch, checkout, merge,
 *  push, pull, fetch, discard). Auth for push/pull/fetch/clone over HTTPS
 *  relies entirely on the system git's own credential helper (this app
 *  never handles a token or password itself) - on this machine that's
 *  `gh auth git-credential`, already configured globally, so any git
 *  process this wrapper spawns authenticates exactly like a terminal
 *  `git push` would. If the user has not run `gh auth login` (or set up
 *  some other credential helper), these calls fail with git's own auth
 *  error, surfaced verbatim to the UI - never a custom login flow here.
 *
 *  Every function below (except `clone`, which has no repo yet) takes a
 *  FILE PATH inside the repo, never the repo root itself - it runs `git`
 *  with `cwd: dirname(filePath)`. Passing a directory path where a file is
 *  expected resolves to that directory's PARENT and fails with git's own
 *  "not a git repository" error. This matches every existing caller (the
 *  UI always has the open design's own .FCStd path handy), but is an easy
 *  trap for a new caller that only has a repo/clone directory - use
 *  `<dir>/anything` (the file need not exist) to get the right cwd. */
import { execFile } from 'child_process'
import { dirname } from 'path'
import { promisify } from 'util'

const run = promisify(execFile)

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 })
  return stdout
}

/** git's own stderr/stdout on failure, verbatim - never swallowed, since a
 *  write operation's failure reason (merge conflict, auth, rejected push,
 *  dirty working tree) is exactly what the user needs to see and act on. */
export class GitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GitError'
  }
}

async function gitOrThrow(cwd: string, args: string[]): Promise<string> {
  try {
    return await git(cwd, args)
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message?: string }
    const msg = (err.stderr || err.stdout || err.message || String(e)).trim()
    throw new GitError(msg)
  }
}

export interface GitStatus {
  isRepo: boolean
  root?: string
  branch?: string
  dirty?: boolean
  tracked?: boolean // is the given file tracked
  ahead?: number
  behind?: number
  hasUpstream?: boolean
  detached?: boolean
}

export async function status(filePath: string): Promise<GitStatus> {
  const cwd = dirname(filePath)
  try {
    const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim()
    // `rev-parse --abbrev-ref HEAD` fails outright on a brand-new repo with
    // no commits yet (HEAD does not resolve to anything) - `symbolic-ref`
    // reads the branch name HEAD POINTS AT regardless of whether it has any
    // commits, so a freshly `git init`-ed repo (the exact state right after
    // this panel's own Initialize button) is correctly reported as a real,
    // just-empty repo instead of silently falling through to isRepo: false.
    let branch: string
    let detached = false
    try {
      branch = (await git(cwd, ['symbolic-ref', '--short', 'HEAD'])).trim()
    } catch {
      // HEAD is genuinely detached (checked out a commit directly) - this
      // DOES have at least one commit, so rev-parse works here
      branch = (await git(cwd, ['rev-parse', '--short', 'HEAD'])).trim()
      detached = true
    }
    const porcelain = await git(cwd, ['status', '--porcelain'])
    let tracked = true
    try {
      await git(cwd, ['ls-files', '--error-unmatch', filePath])
    } catch {
      tracked = false
    }
    let ahead = 0
    let behind = 0
    let hasUpstream = false
    if (!detached) {
      try {
        const counts = (
          await git(cwd, ['rev-list', '--left-right', '--count', `${branch}...${branch}@{u}`])
        ).trim()
        hasUpstream = true
        const [a, b] = counts.split(/\s+/).map(Number)
        ahead = a || 0
        behind = b || 0
      } catch {
        hasUpstream = false
      }
    }
    return {
      isRepo: true,
      root,
      branch,
      detached,
      dirty: porcelain.trim().length > 0,
      tracked,
      ahead,
      behind,
      hasUpstream
    }
  } catch {
    return { isRepo: false }
  }
}

export interface GitCommit {
  hash: string
  short: string
  subject: string
  author: string
  isoDate: string
  relDate: string
}

export async function log(filePath: string, limit = 50): Promise<GitCommit[]> {
  const cwd = dirname(filePath)
  const SEP = '\x1f'
  const fmt = ['%H', '%h', '%s', '%an', '%aI', '%ar'].join(SEP)
  try {
    const out = await git(cwd, [
      'log',
      `--max-count=${limit}`,
      `--pretty=format:${fmt}`,
      '--follow',
      '--',
      filePath
    ])
    if (!out.trim()) return []
    return out
      .trim()
      .split('\n')
      .map((line) => {
        const [hash, short, subject, author, isoDate, relDate] = line.split(SEP)
        return { hash, short, subject, author, isoDate, relDate }
      })
  } catch {
    return []
  }
}

/** full repo history (every commit reachable from HEAD), not filtered to
 *  one file's own touches like `log` above - for a merge/branch-aware view
 *  where a change to a DIFFERENT file (e.g. a merged-in branch's own
 *  commits) should still show up. */
export async function logAll(filePath: string, limit = 100): Promise<GitCommit[]> {
  const cwd = dirname(filePath)
  const SEP = '\x1f'
  const fmt = ['%H', '%h', '%s', '%an', '%aI', '%ar'].join(SEP)
  try {
    const out = await git(cwd, ['log', `--max-count=${limit}`, `--pretty=format:${fmt}`])
    if (!out.trim()) return []
    return out
      .trim()
      .split('\n')
      .map((line) => {
        const [hash, short, subject, author, isoDate, relDate] = line.split(SEP)
        return { hash, short, subject, author, isoDate, relDate }
      })
  } catch {
    return []
  }
}

export interface GitBranch {
  name: string
  current: boolean
}

export async function branches(filePath: string): Promise<GitBranch[]> {
  const cwd = dirname(filePath)
  try {
    const out = await git(cwd, ['branch', '--list', '--no-color'])
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => ({ name: l.replace(/^\*\s+/, ''), current: l.startsWith('* ') }))
  } catch {
    return []
  }
}

/** every changed path (staged + unstaged + untracked), for a "changed files"
 *  list in the UI before committing */
export interface GitFileChange {
  path: string
  index: string // porcelain index-column code (staged state)
  worktree: string // porcelain worktree-column code (unstaged state)
}

export async function changedFiles(filePath: string): Promise<GitFileChange[]> {
  const cwd = dirname(filePath)
  try {
    const out = await git(cwd, ['status', '--porcelain'])
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => ({
        index: line[0],
        worktree: line[1],
        // porcelain paths are quoted/escaped if they contain odd chars;
        // a plain slice is fine for the common case this UI needs
        path: line.slice(3).replace(/^"|"$/g, '')
      }))
  } catch {
    return []
  }
}

/** `git init` in the folder holding filePath. Safe to call on an existing
 *  repo (git itself no-ops). Returns the new repo root. */
export async function init(filePath: string): Promise<{ root: string }> {
  const cwd = dirname(filePath)
  await gitOrThrow(cwd, ['init'])
  const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim()
  return { root }
}

/** clone a remote (any URL git accepts - a GitHub HTTPS URL authenticates
 *  via the same system credential helper as push/pull) into `destDir`,
 *  which must not already exist. Returns the cloned repo's root. */
export async function clone(url: string, destDir: string): Promise<{ root: string }> {
  await gitOrThrow(dirname(destDir), ['clone', url, destDir])
  const root = (await git(destDir, ['rev-parse', '--show-toplevel'])).trim()
  return { root }
}

/** stage the given paths (relative to repo root or absolute), or everything
 *  changed if `paths` is omitted/empty. */
export async function add(filePath: string, paths?: string[]): Promise<void> {
  const cwd = dirname(filePath)
  await gitOrThrow(cwd, ['add', ...(paths && paths.length ? paths : ['-A'])])
}

/** unstage the given paths (or everything staged if omitted). */
export async function unstage(filePath: string, paths?: string[]): Promise<void> {
  const cwd = dirname(filePath)
  await gitOrThrow(cwd, ['restore', '--staged', ...(paths && paths.length ? paths : ['.'])])
}

/** commit whatever is currently staged. Fails (GitError) if nothing is
 *  staged - the caller should check status.dirty / changedFiles first and
 *  offer to stage-all, rather than silently no-op an empty commit. */
export async function commit(
  filePath: string,
  message: string,
  authorName?: string,
  authorEmail?: string
): Promise<{ hash: string }> {
  const cwd = dirname(filePath)
  if (!message.trim()) throw new GitError('Commit message is empty.')
  const args = ['commit', '-m', message]
  if (authorName && authorEmail) args.push('--author', `${authorName} <${authorEmail}>`)
  await gitOrThrow(cwd, args)
  const hash = (await git(cwd, ['rev-parse', 'HEAD'])).trim()
  return { hash }
}

/** stage everything then commit in one step - the common "Commit All" UI
 *  action. */
export async function commitAll(
  filePath: string,
  message: string,
  authorName?: string,
  authorEmail?: string
): Promise<{ hash: string }> {
  await add(filePath)
  return commit(filePath, message, authorName, authorEmail)
}

/** create a new branch (optionally from a given start point) and switch to
 *  it, matching `git checkout -b`. */
export async function createBranch(
  filePath: string,
  name: string,
  from?: string
): Promise<void> {
  const cwd = dirname(filePath)
  const args = ['checkout', '-b', name]
  if (from) args.push(from)
  await gitOrThrow(cwd, args)
}

/** switch to an existing branch. Refuses (via git's own error) if the
 *  working tree has conflicting uncommitted changes - surfaced as-is. */
export async function checkout(filePath: string, name: string): Promise<void> {
  const cwd = dirname(filePath)
  await gitOrThrow(cwd, ['checkout', name])
}

export async function deleteBranch(filePath: string, name: string, force = false): Promise<void> {
  const cwd = dirname(filePath)
  await gitOrThrow(cwd, ['branch', force ? '-D' : '-d', name])
}

/** merge `from` into the current branch. On conflict, git leaves the
 *  working tree mid-merge and this throws GitError with git's own conflict
 *  summary - the caller should re-run status()/changedFiles() to show what
 *  needs resolving (conflicted paths appear as unmerged, code "UU" etc in
 *  changedFiles' porcelain columns) rather than this wrapper attempting any
 *  conflict resolution itself. */
export async function merge(filePath: string, from: string): Promise<{ conflict: boolean }> {
  const cwd = dirname(filePath)
  try {
    await git(cwd, ['merge', '--no-edit', from])
    return { conflict: false }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string }
    const text = `${err.stdout || ''}\n${err.stderr || ''}`
    if (/conflict/i.test(text)) return { conflict: true }
    const msg = (err.stderr || err.stdout || String(e)).trim()
    throw new GitError(msg)
  }
}

export async function abortMerge(filePath: string): Promise<void> {
  const cwd = dirname(filePath)
  await gitOrThrow(cwd, ['merge', '--abort'])
}

/** push the current branch. Sets upstream automatically on first push
 *  (`-u origin <branch>`) so the caller does not need to special-case it. */
export async function push(filePath: string, remote = 'origin'): Promise<void> {
  const cwd = dirname(filePath)
  const branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  let hasUpstream = true
  try {
    await git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  } catch {
    hasUpstream = false
  }
  const args = hasUpstream ? ['push', remote, branch] : ['push', '-u', remote, branch]
  await gitOrThrow(cwd, args)
}

export async function pull(filePath: string, remote = 'origin'): Promise<{ conflict: boolean }> {
  const cwd = dirname(filePath)
  try {
    await git(cwd, ['pull', remote])
    return { conflict: false }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string }
    const text = `${err.stdout || ''}\n${err.stderr || ''}`
    if (/conflict/i.test(text)) return { conflict: true }
    const msg = (err.stderr || err.stdout || String(e)).trim()
    throw new GitError(msg)
  }
}

export async function fetch(filePath: string, remote = 'origin'): Promise<void> {
  const cwd = dirname(filePath)
  await gitOrThrow(cwd, ['fetch', remote])
}

/** discard ALL uncommitted changes (tracked file edits + untracked files).
 *  Destructive and irreversible - the caller must confirm with the user
 *  before calling this (matches the app-wide "never delete without
 *  confirmation" rule; this file only implements the mechanism). */
export async function discardAll(filePath: string): Promise<void> {
  const cwd = dirname(filePath)
  await gitOrThrow(cwd, ['reset', '--hard', 'HEAD'])
  await gitOrThrow(cwd, ['clean', '-fd'])
}

export interface GitRemote {
  name: string
  url: string
}

export async function remotes(filePath: string): Promise<GitRemote[]> {
  const cwd = dirname(filePath)
  try {
    const out = await git(cwd, ['remote', '-v'])
    const seen = new Map<string, string>()
    for (const line of out.split('\n')) {
      const m = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)/)
      if (m) seen.set(m[1], m[2])
    }
    return [...seen.entries()].map(([name, url]) => ({ name, url }))
  } catch {
    return []
  }
}

export async function addRemote(filePath: string, name: string, url: string): Promise<void> {
  const cwd = dirname(filePath)
  await gitOrThrow(cwd, ['remote', 'add', name, url])
}
