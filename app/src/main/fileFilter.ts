/**
 * Data Panel folder filtering: is there ANY file GWT-CAD can use (see
 * shared/fileTypes.ts) somewhere beneath a folder? A folder that only holds
 * dlls / python / build output is hidden from the panel.
 *
 * Pure filesystem logic, no Electron import, so it can be unit-tested with
 * plain node (test/unit/fileFilter.test.mjs).
 *
 * Speed: the user's trees include node_modules and multi-GB folders, so
 *  - junk trees (node_modules, .git, .venv, __pycache__, .pio, ...) are
 *    never entered at all,
 *  - each walk is breadth-first (a part right near the top is found after
 *    one or two readdirs) and bounded by time, folder count and depth -
 *    running out of budget answers `null` ("unknown"), which callers treat
 *    as SHOW: a slow or huge folder is never hidden by mistake,
 *  - results are cached and revalidated cheaply instead of re-walked: a
 *    positive answer remembers WHICH file proved it (still there -> still
 *    relevant), a negative one remembers every folder it read and that
 *    folder's mtime (adding/removing a file anywhere in the tree changes the
 *    mtime of the folder directly holding it, so an unchanged set of mtimes
 *    means the answer is still "nothing here").
 */
import { readdir, stat } from 'fs/promises'
import { dirname, join } from 'path'
import { extOf, isAllowedFile, isSkippedDir } from '../shared/fileTypes'

/** true = holds a usable file, false = definitely nothing, null = gave up */
export type Relevance = boolean | null

export interface WalkBudget {
  timeMs: number
  maxDirs: number
  maxDepth: number
}

export const DEFAULT_BUDGET: WalkBudget = { timeMs: 1500, maxDirs: 5000, maxDepth: 16 }

interface CacheEntry {
  at: number
  result: Relevance
  /** result === true: the file that proved it (or the folder itself for an
   *  empty folder, see walk()) */
  proof?: string
  proofMtime?: number
  /** result === false: every folder read, with its mtime at the time */
  dirMtimes?: Map<string, number>
}

interface WalkResult {
  result: Relevance
  proof?: string
  proofMtime?: number
  dirMtimes?: Map<string, number>
}

const READ_CONCURRENCY = 16

async function mtimeOf(p: string): Promise<number | null> {
  try {
    return (await stat(p)).mtimeMs
  } catch {
    return null
  }
}

/** One bounded breadth-first walk of `root`. A completely empty folder
 *  counts as relevant (a freshly made project/type folder must stay
 *  reachable so a design can be created in it). */
export async function walkForAllowedFile(root: string, budget: WalkBudget = DEFAULT_BUDGET): Promise<WalkResult> {
  const deadline = Date.now() + budget.timeMs
  const dirMtimes = new Map<string, number>()
  const seenInodes = new Set<string>()
  let level: string[] = [root]
  let dirsRead = 0
  for (let depth = 0; level.length > 0; depth++) {
    if (depth > budget.maxDepth) return { result: null }
    const next: string[] = []
    for (let i = 0; i < level.length; i += READ_CONCURRENCY) {
      if (Date.now() > deadline || dirsRead >= budget.maxDirs) return { result: null }
      const chunk = level.slice(i, i + READ_CONCURRENCY)
      const read = await Promise.all(
        chunk.map(async (dir) => {
          try {
            const st = await stat(dir)
            const key = `${st.dev}:${st.ino}`
            if (seenInodes.has(key)) return null // symlink loop / second route to the same folder
            seenInodes.add(key)
            dirMtimes.set(dir, st.mtimeMs)
            return { dir, mtime: st.mtimeMs, entries: await readdir(dir, { withFileTypes: true }) }
          } catch {
            return null // unreadable (permissions, vanished) - contributes nothing
          }
        })
      )
      dirsRead += chunk.length
      for (const r of read) {
        if (!r) continue
        if (depth === 0 && r.dir === root && r.entries.every((e) => e.name.startsWith('.'))) {
          return { result: true, proof: root, proofMtime: r.mtime }
        }
        for (const e of r.entries) {
          const p = join(r.dir, e.name)
          if (e.isDirectory()) {
            if (!isSkippedDir(e.name)) next.push(p)
            continue
          }
          if (e.isSymbolicLink()) {
            if (isSkippedDir(e.name)) continue
            try {
              const st = await stat(p)
              if (st.isDirectory()) {
                next.push(p)
                continue
              }
              if (!st.isFile()) continue
            } catch {
              continue // dangling link
            }
          } else if (!e.isFile()) {
            continue
          }
          if (isAllowedFile(e.name)) return { result: true, proof: p }
        }
      }
    }
    level = next
  }
  return { result: false, dirMtimes }
}

export interface SearchHit {
  name: string
  path: string
  isDir: boolean
  ext: string
  depth: number
}

/** Search `root` for usable files and folders whose name contains `query` -
 *  the HIGHEST level first, then each deeper level in turn (breadth-first),
 *  so a match right where the user is looking always surfaces before
 *  something buried three folders down, even though both get found. Never
 *  enters junk trees (node_modules, .git, ...). Bounded (maxResults, a
 *  generous but finite level count, and a time budget) so a huge tree can't
 *  hang the UI. Folder hits come back unfiltered - pass `relevance` to drop
 *  the ones with nothing usable beneath them. */
export async function searchDir(
  root: string,
  query: string,
  opts: { maxResults?: number; timeMs?: number; relevance?: FolderRelevance } = {}
): Promise<SearchHit[]> {
  const maxResults = opts.maxResults ?? 200
  const deadline = Date.now() + (opts.timeMs ?? 4000)
  const q = query.toLowerCase()
  const results: SearchHit[] = []
  let level: string[] = [root]
  let depth = 0
  const MAX_DEPTH = 12 // generous - a real company repo is a handful of levels deep at most
  while (level.length > 0 && depth <= MAX_DEPTH && results.length < maxResults && Date.now() < deadline) {
    const nextLevel: string[] = []
    for (const dir of level) {
      if (Date.now() > deadline) break
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue
        const p = join(dir, e.name)
        let isDir = e.isDirectory()
        if (!isDir && e.isSymbolicLink()) {
          isDir = await stat(p).then((s) => s.isDirectory()).catch(() => false)
        }
        if (isDir) {
          if (isSkippedDir(e.name)) continue
          nextLevel.push(p)
          if (depth > 0 && e.name.toLowerCase().includes(q)) {
            results.push({ name: e.name, path: p, isDir: true, ext: '', depth })
          }
        } else if (isAllowedFile(e.name) && e.name.toLowerCase().includes(q)) {
          results.push({ name: e.name, path: p, isDir: false, ext: extOf(e.name), depth })
        }
        if (results.length >= maxResults) break
      }
      if (results.length >= maxResults) break
    }
    level = nextLevel
    depth += 1
  }
  const rel = opts.relevance
  if (!rel) return results
  // a short per-folder budget: unknown (null) still shows, like the listing
  const quick: WalkBudget = { timeMs: 400, maxDirs: 1000, maxDepth: 12 }
  const keep = await Promise.all(results.map((r) => (r.isDir ? rel.isRelevant(r.path, quick) : true)))
  return results.filter((_r, i) => keep[i] !== false)
}

export class FolderRelevance {
  private cache = new Map<string, CacheEntry>()
  private inflight = new Map<string, Promise<Relevance>>()

  constructor(
    private readonly budget: WalkBudget = DEFAULT_BUDGET,
    /** how long an "unknown" (budget ran out) answer is reused before
     *  trying again - re-walking a huge tree on every listing would be the
     *  exact slowness this avoids */
    private readonly unknownTtlMs = 60_000,
    private readonly maxEntries = 20_000
  ) {}

  /** Cached answer if one exists AND is still valid, else undefined. Never
   *  walks - cheap enough to call for every folder of a listing. */
  async cached(dir: string): Promise<Relevance | undefined> {
    const c = this.cache.get(dir)
    if (!c) return undefined
    if (c.result === null) {
      if (Date.now() - c.at < this.unknownTtlMs) return null
    } else if (c.result === true && c.proof) {
      if (c.proofMtime !== undefined) {
        // proven by being empty: still empty only if nothing changed
        if ((await mtimeOf(c.proof)) === c.proofMtime) return true
      } else if ((await mtimeOf(c.proof)) !== null) {
        return true
      }
    } else if (c.result === false && c.dirMtimes) {
      const checks = await Promise.all(
        [...c.dirMtimes].map(async ([d, m]) => (await mtimeOf(d)) === m)
      )
      if (checks.every(Boolean)) return false
    }
    this.cache.delete(dir)
    return undefined
  }

  /** Cached answer, or a fresh bounded walk. Concurrent asks for the same
   *  folder share one walk. */
  async isRelevant(dir: string, budget: WalkBudget = this.budget): Promise<Relevance> {
    const hit = await this.cached(dir)
    if (hit !== undefined) return hit
    const running = this.inflight.get(dir)
    if (running) return running
    const p = walkForAllowedFile(dir, budget)
      .then((w) => {
        this.store(dir, w)
        return w.result
      })
      .finally(() => this.inflight.delete(dir))
    this.inflight.set(dir, p)
    return p
  }

  private put(dir: string, e: CacheEntry): void {
    this.cache.delete(dir)
    this.cache.set(dir, e)
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
  }

  private store(dir: string, w: WalkResult): void {
    const at = Date.now()
    if (w.result === true && w.proof) {
      this.put(dir, { at, result: true, proof: w.proof, proofMtime: w.proofMtime })
      // every folder between `dir` and the proving file is relevant for the
      // same reason - free answers for the user's next click down
      if (w.proofMtime === undefined) {
        for (let d = dirname(w.proof); d.length > dir.length && d.startsWith(dir); d = dirname(d)) {
          this.put(d, { at, result: true, proof: w.proof })
        }
      }
    } else if (w.result === false) {
      this.put(dir, { at, result: false, dirMtimes: w.dirMtimes })
    } else {
      this.put(dir, { at, result: null })
    }
  }
}
