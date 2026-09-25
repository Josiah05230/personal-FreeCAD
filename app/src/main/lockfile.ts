/** Git-based "someone else has this part open" lock for a STANDALONE part
 *  opened directly (not merely referenced as a live/pinned component inside
 *  an open assembly - that softer case is handled by the upstream-change
 *  watch instead, see gitWatch.ts).
 *
 *  One lock file per part, committed to the SAME shared repo the part
 *  lives in (`<partDir>/.gwtcad-lock.json`) - visible to every clone via a
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
import { dirname, join } from 'path'
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
}

function lockPath(partFilePath: string): string {
  return join(dirname(partFilePath), '.gwtcad-lock.json')
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

/** Attempt to acquire the lock for `partFilePath`'s part folder. Caller
 *  should have already pulled the repo (see gitSync.ts) so this sees the
 *  freshest known state before deciding - a stale local pull could show a
 *  lock as absent when someone just took it a moment ago. */
export async function acquireLock(partFilePath: string): Promise<AcquireResult> {
  const cwd = dirname(partFilePath)
  const existing = readLock(partFilePath)
  if (existing && !isStale(existing)) {
    return { status: 'held', lock: existing }
  }
  const reclaiming = existing && isStale(existing)

  const lock: LockInfo = {
    holder: userInfo().username || 'unknown',
    machine: hostname(),
    pid: process.pid,
    openedAt: new Date().toISOString()
  }
  writeFileSync(lockPath(partFilePath), JSON.stringify(lock, null, 2), 'utf8')

  try {
    await git(cwd, ['add', lockPath(partFilePath)])
    await git(cwd, ['commit', '-m', `lock: ${lock.holder} opened ${dirname(partFilePath).split('/').pop()}`])
    await git(cwd, ['push'], NETWORK_TIMEOUT_MS)
  } catch {
    // push rejected or unreachable - pull and re-check whether someone
    // else's lock-commit actually won the race, rather than assuming
    try {
      await git(cwd, ['pull', '--rebase'], NETWORK_TIMEOUT_MS)
    } catch {
      // truly unreachable - degrade to a warning rather than block; the
      // lock file we wrote stays local-only until connectivity returns
      return { status: 'unreachable' }
    }
    const afterPull = readLock(partFilePath)
    if (afterPull && afterPull.holder !== lock.holder && !isStale(afterPull)) {
      return { status: 'held', lock: afterPull }
    }
    // our lock (or an equally-abandoned one) is still what's there after
    // rebasing onto the latest - try the push once more
    try {
      await git(cwd, ['push'], NETWORK_TIMEOUT_MS)
    } catch {
      return { status: 'unreachable' }
    }
  }

  return reclaiming
    ? { status: 'reclaimed', previousHolder: existing!.holder, previousOpenedAt: existing!.openedAt }
    : { status: 'acquired' }
}

/** Release a lock this process holds (best-effort - offline just leaves the
 *  removal local until the next successful sync; the staleness fallback in
 *  acquireLock is what actually protects against a lock surviving a failed
 *  release, e.g. a crash that skips this entirely). Safe to call even if no
 *  lock is held (no-ops). */
export async function releaseLock(partFilePath: string): Promise<void> {
  const existing = readLock(partFilePath)
  if (!existing) return
  if (existing.pid !== process.pid || existing.machine !== hostname()) return // not ours to release
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
