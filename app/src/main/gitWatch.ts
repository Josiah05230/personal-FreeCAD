/** Periodic "did this file change upstream" check for two soft cases that
 *  deliberately do NOT take the blocking lock (lockfile.ts):
 *
 *  1. A part referenced as a LIVE (unpinned) component inside a currently
 *     open assembly - assemblyPin.ts already tracks drift for PINNED
 *     components (a ref explicitly locked to a commit/branch); this covers
 *     the common unpinned case, which today has no drift detection at all.
 *  2. The currently-open document itself, in case someone else force-took
 *     a lock and pushed past it (rare, but real once the lock exists at
 *     all - the watch is what turns "your next push gets silently
 *     rejected" into "you're told about it before that happens").
 *
 *  Every check here is read-only (fetch, never pull/merge) so it can run
 *  constantly in the background without any risk to a file that might not
 *  even be open. Resolving what to DO about a detected change (sync,
 *  review, force-push) is the caller's job (App.tsx) - this module only
 *  detects and reports.
 */
import { fetch, changedUpstream, status, type GitCommit } from './git'
import { resolvePinnedFile } from './assemblyPin'

export interface UpstreamChange {
  /** absolute path to the affected file */
  filePath: string
  commits: GitCommit[]
}

/** Check one file for upstream changes: fetch, then diff local HEAD
 *  against origin/<branch> for that exact path. Returns null for anything
 *  not worth reporting (not a repo, no upstream, unreachable, or simply
 *  nothing changed) - the caller doesn't need to distinguish those cases,
 *  only "is there something to tell the user about." */
export async function checkOne(filePath: string): Promise<UpstreamChange | null> {
  const st = await status(filePath)
  if (!st.isRepo || !st.hasUpstream) return null
  try {
    await fetch(filePath)
  } catch {
    return null // unreachable - the offline indicator already covers this; don't also spam per-file watch failures
  }
  const commits = await changedUpstream(filePath)
  if (commits.length === 0) return null
  return { filePath, commits }
}

/** Check a whole set of paths (an assembly's linked component files, plus
 *  optionally the assembly document itself) in one pass. Independent
 *  failures don't affect each other - one unreachable/broken repo among
 *  several components should never hide a real change in another. */
export async function checkMany(filePaths: string[]): Promise<UpstreamChange[]> {
  const results = await Promise.all(filePaths.map((p) => checkOne(p).catch(() => null)))
  return results.filter((r): r is UpstreamChange => r !== null)
}

/** Fetch the upstream (origin/<branch>) version of `filePath` to a local
 *  cache file, for the "Review" action's side-by-side comparison - reuses
 *  assemblyPin.ts's resolvePinnedFile (already does exactly this: `git
 *  show <ref>:<relpath>` written to a stable content-addressed cache path,
 *  read-only against the source repo's working tree/index). */
export async function fetchUpstreamVersion(filePath: string): Promise<{ path: string; commit: string }> {
  const st = await status(filePath)
  if (!st.isRepo || !st.branch) throw new Error(`${filePath} is not in a git repo with a resolvable branch`)
  return resolvePinnedFile({ sourcePath: filePath, ref: `origin/${st.branch}` })
}
