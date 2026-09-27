/** Git-based "someone else has this part open" lock for a STANDALONE part
 *  opened directly (not merely referenced as a live/pinned component inside
 *  an open assembly - that softer case is handled by the upstream-change
 *  watch instead, see gitWatch.ts).
 *
 *  One lock file per part, committed to the SAME shared repo the part
 *  lives in (`<dir>/.<file>.gwtcad-lock.json`, per FILE since parts share
 *  a folder in the flat <project>/<type>/ layout) - visible to every clone via a
 *  normal pull/fetch, no separate server or daemon needed. This mirrors
 *  assemblyPin.ts's companion-file convention (a plain JSON file next to
 *  the thing it describes) rather than inventing a new persistence
 *  mechanism.
 *
 *  A lock older than STALE_MS is treated as abandoned (a crash skips any
 *  graceful release) and silently reclaimed - there is no server to detect
 *  a crash directly, so staleness is the only signal available; see
 *  index.ts's `before-quit` handler for the graceful-release path this
 *  exists as a fallback for. */
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { hostname, userInfo } from 'os'
import { basename, dirname, join } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { GitError } from './git'

const run = promisify(execFile)
const NETWORK_TIMEOUT_MS = 8000

async function git(cwd: string, args: string[], timeout?: number): Promise<string> {
  try {
    const { stdout } = await run('git', args, { cwd, maxBuffer: 4 * 1024 * 1024, ...(timeout ? { timeout } : {}) })
    return stdout
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message?: string; killed?: boolean }
    const msg = err.killed
      ? `git ${args[0]} timed out (unreachable remote?)`
      : (err.stderr || err.stdout || err.message || String(e)).trim()
    throw new GitError(msg)
  }
}

/** 4 hours - generous enough that a normal lunch break or a long meeting
 *  never falsely reclaims someone's active lock, short enough that a
 *  crashed/forgotten session doesn't block a part for days. */
const STALE_MS = 4 * 60 * 60 * 1000

export interface LockInfo {
  holder: string
  machine: string
  pid: number
  openedAt: string
  /** absolute path of the file in the clone that took the lock - one user
   *  on one machine with two clones is still two different openers */
  path?: string
}

function isMine(lock: LockInfo, partFilePath: string): boolean {
  return (
    lock.holder === (userInfo().username || 'unknown') &&
    lock.machine === hostname() &&
    (lock.path === undefined || lock.path === partFilePath)
  )
}

function lockPath(partFilePath: string): string {
  return join(dirname(partFilePath), `.${basename(partFilePath)}.gwtcad-lock.json`)
}

function readLock(partFilePath: string): LockInfo | null {
  const p = lockPath(partFilePath)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as LockInfo
  } catch {
    return null
  }
}

function isStale(lock: LockInfo): boolean {
  const age = Date.now() - new Date(lock.openedAt).getTime()
  return !Number.isFinite(age) || age > STALE_MS
}

export type AcquireResult =
  | { status: 'acquired' }
  | { status: 'reclaimed'; previousHolder: string; previousOpenedAt: string }
  | { status: 'held'; lock: LockInfo }
  | { status: 'unreachable' } // couldn't confirm/deny - degrade to a warning, never block

/** Attempt to acquire the lock for the part at `partFilePath`. Caller
 *  should have already pulled the repo (see gitSync.ts) so this sees the
 *  freshest known state before deciding - a stale local pull could show a
 *  lock as absent when someone just took it a moment ago. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM = alive but not ours to signal; ESRCH = gone
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// Lock git operations run one at a time. A lock's push finishes in the
// background, and a release (or another acquire) starting before it lands
// used to interleave commits/resets in the same repo.
let lockQueue: Promise<unknown> = Promise.resolve()
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = lockQueue.then(fn)
  lockQueue = run.catch(() => undefined)
  return run
}

export async function acquireLock(
  partFilePath: string,
  onPublished?: (r: PublishResult) => void
): Promise<AcquireResult> {
  const local = await serialized(() => acquireLocally(partFilePath))
  if (!('lock' in local && 'commit' in local)) return local
  // the decision was made against a freshly pulled repo, so the file can
  // open now; publishing the lock (a ~1s push) finishes in the background
  // and reports back only if someone else won the race
  const publish = serialized(() => publishLock(partFilePath, local.lock, local.commit))
  if (onPublished) void publish.then(onPublished)
  else {
    const r = await publish
    if (r.status !== 'published') return r
  }
  return local.result
}

async function acquireLocally(
  partFilePath: string
): Promise<AcquireResult | { result: AcquireResult; lock: LockInfo; commit: string }> {
  const existing = readLock(partFilePath)
  const mine = !!existing && isMine(existing, partFilePath)
  // This exact process already holds it (switching back to a tab, or an
  // open racing a second open of the same file) - nothing to do. Before
  // this, re-opening a file you already had open reported that YOU had it
  // open "elsewhere".
  if (mine && existing!.pid === process.pid) return { status: 'acquired' }
  // Held by one of MY earlier GWT-CAD processes that's gone (closed or
  // crashed without releasing): it's still me - re-stamp it quietly
  // instead of blocking or waiting out the staleness window.
  const mineButDead = mine && !pidAlive(existing!.pid)
  if (existing && !isStale(existing) && !mineButDead) {
    return { status: 'held', lock: existing }
  }
  const reclaiming = existing && isStale(existing) && !mine

  const lock: LockInfo = {
    holder: userInfo().username || 'unknown',
    machine: hostname(),
    pid: process.pid,
    openedAt: new Date().toISOString(),
    path: partFilePath
  }
  let commit: string
  try {
    commit = await commitLock(partFilePath, lock)
  } catch {
    return { status: 'unreachable' }
  }
  const result: AcquireResult = reclaiming
    ? { status: 'reclaimed', previousHolder: existing!.holder, previousOpenedAt: existing!.openedAt }
    : { status: 'acquired' }
  return { result, lock, commit }
}

async function commitLock(partFilePath: string, lock: LockInfo): Promise<string> {
  const cwd = dirname(partFilePath)
  writeFileSync(lockPath(partFilePath), JSON.stringify(lock, null, 2), 'utf8')
  await git(cwd, ['add', lockPath(partFilePath)])
  await git(cwd, ['commit', '-m', `lock: ${lock.holder} opened ${basename(partFilePath).replace(/\.fcstd$/i, '')}`])
  return (await git(cwd, ['rev-parse', 'HEAD'])).trim()
}

export type PublishResult =
  | { status: 'published' }
  | { status: 'held'; lock: LockInfo } // someone else's lock landed first
  | { status: 'unreachable' } // committed locally, not confirmed remotely

/** Push the lock commit. On a rejected push, drop our lock commit, pull,
 *  and look again: someone else's fresh lock wins; otherwise re-commit and
 *  push once more. (Rebasing our commit onto theirs would conflict, since
 *  both sides add the same lock file.) */
export async function publishLock(
  partFilePath: string,
  lock: LockInfo,
  commit: string
): Promise<PublishResult> {
  const cwd = dirname(partFilePath)
  try {
    await git(cwd, ['push'], NETWORK_TIMEOUT_MS)
    return { status: 'published' }
  } catch {
    // fall through
  }
  try {
    // only undo our commit if nothing has been committed on top of it since
    if ((await git(cwd, ['rev-parse', 'HEAD'])).trim() === commit) {
      await git(cwd, ['reset', '--soft', 'HEAD~1'])
      await git(cwd, ['reset', '-q', '--', lockPath(partFilePath)])
      unlinkSync(lockPath(partFilePath))
    }
    await git(cwd, ['pull', '--no-rebase', '--no-edit'], NETWORK_TIMEOUT_MS)
  } catch {
    // truly unreachable - keep the lock local until connectivity returns
    if (!existsSync(lockPath(partFilePath))) {
      await commitLock(partFilePath, lock).catch(() => undefined)
    }
    return { status: 'unreachable' }
  }
  const afterPull = readLock(partFilePath)
  if (afterPull && !isMine(afterPull, partFilePath) && !isStale(afterPull)) {
    return { status: 'held', lock: afterPull }
  }
  try {
    await commitLock(partFilePath, lock)
    await git(cwd, ['push'], NETWORK_TIMEOUT_MS)
    return { status: 'published' }
  } catch {
    return { status: 'unreachable' }
  }
}

/** Release a lock this process holds (best-effort - offline just leaves the
 *  removal local until the next successful sync; the staleness fallback in
 *  acquireLock is what actually protects against a lock surviving a failed
 *  release, e.g. a crash that skips this entirely). Safe to call even if no
 *  lock is held (no-ops). */
export function releaseLock(partFilePath: string): Promise<void> {
  return serialized(() => releaseLockNow(partFilePath))
}

async function releaseLockNow(partFilePath: string): Promise<void> {
  const existing = readLock(partFilePath)
  if (!existing) return
  if (existing.pid !== process.pid || !isMine(existing, partFilePath)) return // not ours to release
  const cwd = dirname(partFilePath)
  try {
    unlinkSync(lockPath(partFilePath))
  } catch {
    return
  }
  try {
    await git(cwd, ['add', lockPath(partFilePath)])
    await git(cwd, ['commit', '-m', `lock: released`])
    await git(cwd, ['push'], NETWORK_TIMEOUT_MS)
  } catch {
    // offline or rejected - the local deletion still stands; a later
    // sync (or simply staleness) resolves it
  }
}

export function currentLock(partFilePath: string): LockInfo | null {
  return readLock(partFilePath)
}


/** Release several locks at once (quitting with several tabs open): one
 *  commit + one push per repo instead of one round-trip per file. Same
 *  "only locks THIS process holds" rule as releaseLock. */
export function releaseLocks(partFilePaths: string[]): Promise<void> {
  return serialized(() => releaseLocksNow(partFilePaths))
}

async function releaseLocksNow(partFilePaths: string[]): Promise<void> {
  const byRepo = new Map<string, string[]>()
  for (const p of partFilePaths) {
    const existing = readLock(p)
    if (!existing || existing.pid !== process.pid || !isMine(existing, p)) continue
    try {
      unlinkSync(lockPath(p))
    } catch {
      continue
    }
    let root = dirname(p)
    try {
      root = (await git(dirname(p), ['rev-parse', '--show-toplevel'])).trim()
    } catch {
      // not a repo - nothing to commit
      continue
    }
    byRepo.set(root, [...(byRepo.get(root) ?? []), lockPath(p)])
  }
  await Promise.all(
    [...byRepo.entries()].map(async ([root, locks]) => {
      try {
        await git(root, ['add', '--', ...locks])
        await git(root, ['commit', '-m', `lock: released ${locks.length} file(s)`])
        await git(root, ['push'], NETWORK_TIMEOUT_MS)
      } catch {
        // offline/rejected: local deletions stand; staleness covers the rest
      }
    })
  )
}
