/** Git-based version pinning for assembly sub-components.
 *
 *  An assembly component can be linked either "live" (today's default -
 *  the assembly always reads whatever is currently on disk at the source
 *  path, per the App::Link mechanism in assembly.py) or "pinned" to a git
 *  ref: a specific commit (hard pin, never moves) or a branch name
 *  (tracks that branch's tip - moves only when re-resolved, e.g. on
 *  reopen or an explicit "update pin" action).
 *
 *  No new git plumbing is invented here - a commit hash already IS an
 *  immutable version pin and a branch name already IS a live-tracking
 *  pointer, so resolving a pin is just `git show <ref>:<relpath>`. That
 *  is read-only: it never touches the sub-part repo's working tree or
 *  index, so it can never collide with whatever a collaborator has
 *  checked out there. The resolved content is written to a stable local
 *  cache file, and THAT file (not the live source path) is what gets
 *  handed to assembly.addComponent - the sidecar and FreeCAD's App::Link
 *  need no changes at all.
 *
 *  Pin metadata itself (which ref each component is pinned to) lives in a
 *  companion JSON next to the assembly .FCStd, `<name>.gwtcad-asm.json` -
 *  this is the first real use of that "companion file" pattern in the
 *  app; nothing else has needed one yet.
 */
import { execFile } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, basename, join, relative } from 'path'
import { promisify } from 'util'
import { app } from 'electron'
import { GitError } from './git'

const run = promisify(execFile)

export type PinMode = 'commit' | 'branch'

export interface ComponentPin {
  /** absolute path to the source .FCStd, exactly as passed to addComponentFile */
  sourcePath: string
  mode?: PinMode
  /** a commit hash (mode 'commit') or branch name (mode 'branch'); absent = live, unpinned */
  ref?: string
  /** the commit hash the pin last resolved to - for drift display even under mode 'branch' */
  resolvedCommit?: string
  /** does the source repo's current tracked commit for this file differ from
   *  resolvedCommit, as of the last resolve? Persisted so the UI can render
   *  the last-known drift state without an extra round trip on every paint. */
  drift?: boolean
}

export interface AsmPinFile {
  // keyed by the App::Link component name (Assembly tree "id")
  [componentId: string]: ComponentPin
}

function companionPath(asmPath: string): string {
  return join(dirname(asmPath), basename(asmPath).replace(/\.FCStd$/i, '') + '.gwtcad-asm.json')
}

export function readPins(asmPath: string): AsmPinFile {
  const p = companionPath(asmPath)
  if (!existsSync(p)) return {}
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as AsmPinFile
  } catch {
    return {}
  }
}

export function writePins(asmPath: string, pins: AsmPinFile): void {
  writeFileSync(companionPath(asmPath), JSON.stringify(pins, null, 2), 'utf8')
}

export function setPin(asmPath: string, componentId: string, pin: ComponentPin | null): void {
  const pins = readPins(asmPath)
  if (pin === null) delete pins[componentId]
  else pins[componentId] = pin
  writePins(asmPath, pins)
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' as never })
    return stdout as unknown as string
  } catch (e) {
    const err = e as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string }
    const msg = (err.stderr || err.stdout || err.message || String(e)).toString().trim()
    throw new GitError(msg)
  }
}

/** Resolve `ref` (a commit hash or branch name) to the commit hash it currently
 *  points at, inside the repo containing `filePath`. */
export async function resolveRefToCommit(filePath: string, ref: string): Promise<string> {
  const cwd = dirname(filePath)
  const out = await git(cwd, ['rev-parse', ref])
  return out.toString().trim()
}

/** The commit that last touched `filePath` in its repo, per `git log -1`
 *  (walking whatever ref is currently checked out) - i.e. "what commit is
 *  the source's tracked content at right now." Used to compare against a
 *  pin's resolvedCommit for drift detection. */
export async function currentCommitFor(filePath: string): Promise<string | null> {
  const cwd = dirname(filePath)
  try {
    const out = await git(cwd, ['log', '-1', '--format=%H', '--', basename(filePath)])
    const s = out.toString().trim()
    return s || null
  } catch {
    return null
  }
}

const CACHE_DIR = () => join(app.getPath('userData'), 'pinned-components')

/** Resolve a pin to a real file on disk: `git show <ref>:<relpath>` written to
 *  a content-addressed cache file, returned as the path to link instead of
 *  the live source path. Read-only against the source repo - never checks
 *  out or mutates its working tree, so it can't collide with a collaborator's
 *  own checkout of that same repo. */
export async function resolvePinnedFile(pin: ComponentPin): Promise<{ path: string; commit: string }> {
  if (!pin.ref) throw new GitError('pin has no ref set')
  const srcPath = pin.sourcePath
  const cwd = dirname(srcPath)
  const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).toString().trim()
  const rel = relative(root, srcPath).split('\\').join('/')

  const commit = (await git(cwd, ['rev-parse', pin.ref])).toString().trim()
  if (!commit) throw new GitError(`could not resolve ref ${pin.ref}`)

  const dir = CACHE_DIR()
  mkdirSync(dir, { recursive: true })
  const key = createHash('sha1').update(`${root}:${rel}:${commit}`).digest('hex').slice(0, 16)
  const cachedPath = join(dir, `${basename(srcPath, '.FCStd')}-${key}.FCStd`)

  if (!existsSync(cachedPath)) {
    const { stdout } = await run('git', ['show', `${commit}:${rel}`], {
      cwd,
      maxBuffer: 256 * 1024 * 1024,
      encoding: 'buffer' as never
    })
    writeFileSync(cachedPath, stdout as unknown as Buffer)
  }
  return { path: cachedPath, commit }
}

/** Convenience: given the componentId and its stored pin, resolve the pin
 *  (if any) to the path that should actually be linked, and report drift
 *  (does the pinned/tracked commit differ from the source repo's current
 *  HEAD for that file right now). */
export async function resolveComponentSource(
  pin: ComponentPin
): Promise<{ linkPath: string; pinned: boolean; commit?: string; drift?: boolean }> {
  if (!pin.ref) {
    return { linkPath: pin.sourcePath, pinned: false }
  }
  const { path, commit } = await resolvePinnedFile(pin)
  let drift: boolean | undefined
  try {
    const live = await currentCommitFor(pin.sourcePath)
    if (live) drift = live !== commit
  } catch {
    drift = undefined
  }
  return { linkPath: path, pinned: true, commit, drift }
}
