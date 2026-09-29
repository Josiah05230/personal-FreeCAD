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
import { dirname, join, sep } from 'path'
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

// --------------------------------------------------------------------------- //
// search index
// --------------------------------------------------------------------------- //

interface IndexEntry {
  name: string
  lname: string
  path: string
  isDir: boolean
  /** folder depth below the index root (0 = directly in it) */
  depth: number
}

interface RootIndex {
  root: string
  at: number
  entries: IndexEntry[]
  /** folders known to hold a usable file (or nothing at all) somewhere beneath */
  relevant: Set<string>
  /** folders the walk read - anything else is "unknown" (show it) */
  complete: Set<string>
  /** the walk ran out of budget: "nothing usable here" answers can't be trusted */
  truncated: boolean
  /** false while the walk is still filling this in */
  done: boolean
}

function emptyIndex(root: string): RootIndex {
  return { root, at: 0, entries: [], relevant: new Set(), complete: new Set(), truncated: false, done: false }
}

export interface IndexBudget {
  timeMs: number
  maxDirs: number
  maxDepth: number
}

const INDEX_BUDGET: IndexBudget = { timeMs: 15_000, maxDirs: 200_000, maxDepth: 16 }
const INDEX_CONCURRENCY = 64

/** One concurrent breadth-first walk of `root` into a flat list of every
 *  folder and usable file beneath it (junk trees and `skip`ped folders never
 *  entered). Fills `into` as it goes, so a search can read it mid-walk. */
export async function buildIndex(
  root: string,
  budget: IndexBudget = INDEX_BUDGET,
  into: RootIndex = emptyIndex(root),
  skip: ReadonlySet<string> = new Set()
): Promise<RootIndex> {
  const deadline = Date.now() + budget.timeMs
  const { entries, relevant, complete } = into
  const finish = (truncated: boolean): RootIndex => {
    into.truncated = truncated
    into.at = Date.now()
    into.done = true
    return into
  }
  const seenInodes = new Set<string>()
  const markUp = (dir: string): void => {
    for (let d = dir; d.length >= root.length && !relevant.has(d); d = dirname(d)) {
      relevant.add(d)
      if (d === root) break
    }
  }
  let level: string[] = [root]
  let dirsRead = 0
  for (let depth = 0; level.length > 0 && depth <= budget.maxDepth; depth++) {
    const next: string[] = []
    for (let i = 0; i < level.length; i += INDEX_CONCURRENCY) {
      if (Date.now() > deadline || dirsRead >= budget.maxDirs) {
        return finish(true)
      }
      const chunk = level.slice(i, i + INDEX_CONCURRENCY)
      dirsRead += chunk.length
      const read = await Promise.all(
        chunk.map(async (dir) => {
          try {
            const st = await stat(dir)
            const key = `${st.dev}:${st.ino}`
            if (seenInodes.has(key)) return null
            seenInodes.add(key)
            return { dir, entries: await readdir(dir, { withFileTypes: true }) }
          } catch {
            return null
          }
        })
      )
      for (const r of read) {
        if (!r) continue
        complete.add(r.dir)
        if (r.entries.every((e) => e.name.startsWith('.'))) markUp(r.dir) // empty folder stays reachable
        for (const e of r.entries) {
          if (e.name.startsWith('.')) continue
          const p = join(r.dir, e.name)
          let isDir = e.isDirectory()
          let isFile = e.isFile()
          if (e.isSymbolicLink()) {
            try {
              const st = await stat(p)
              isDir = st.isDirectory()
              isFile = st.isFile()
            } catch {
              continue // dangling link
            }
          }
          if (isDir) {
            if (isSkippedDir(e.name) || skip.has(p)) continue
            next.push(p)
            entries.push({ name: e.name, lname: e.name.toLowerCase(), path: p, isDir: true, depth })
          } else if (isFile && isAllowedFile(e.name)) {
            entries.push({ name: e.name, lname: e.name.toLowerCase(), path: p, isDir: false, depth })
            markUp(r.dir)
          }
        }
      }
    }
    level = next
  }
  return finish(level.length > 0)
}

/** In-memory file search. A root is walked once (concurrently - ~250ms for a
 *  15k-folder home directory) and every search in it, or in any folder
 *  beneath it, filters that list instead of walking the disk per keystroke.
 *  An index older than `staleMs` still answers at once and is rebuilt in the
 *  background, so the next search sees files added meanwhile. */
export class FileIndex {
  private roots = new Map<string, RootIndex>()
  private building = new Map<string, { ix: RootIndex; p: Promise<RootIndex> }>()
  private skip: ReadonlySet<string> = new Set()

  constructor(
    private readonly staleMs = 15_000,
    private readonly budget: IndexBudget = INDEX_BUDGET,
    private readonly maxRoots = 8
  ) {}

  private covering(dir: string): RootIndex | undefined {
    let best: RootIndex | undefined
    for (const ix of this.roots.values()) {
      if (dir === ix.root || dir.startsWith(ix.root.endsWith(sep) ? ix.root : ix.root + sep)) {
        // a subfolder of a walk that ran out of budget may be only partly
        // indexed - it gets its own walk instead
        if (dir !== ix.root && (ix.truncated || !ix.complete.has(dir))) continue
        if (!best || ix.root.length > best.root.length) best = ix
      }
    }
    return best
  }

  /** Folders never to index or search (the Data Panel's hidden folders).
   *  Changing the set drops every index so none still holds them. */
  setSkip(paths: string[]): void {
    const next = new Set(paths)
    if (next.size === this.skip.size && [...next].every((p) => this.skip.has(p))) return
    this.skip = next
    this.roots.clear()
  }

  private rebuild(root: string): Promise<RootIndex> {
    const running = this.building.get(root)
    if (running) return running.p
    const into = emptyIndex(root)
    const p = buildIndex(root, this.budget, into, this.skip)
      .then((ix) => {
        this.roots.delete(root)
        this.roots.set(root, ix)
        while (this.roots.size > this.maxRoots) {
          const oldest = this.roots.keys().next().value
          if (oldest === undefined) break
          this.roots.delete(oldest)
        }
        return ix
      })
      .finally(() => this.building.delete(root))
    this.building.set(root, { ix: into, p })
    return p
  }

  /** A first walk still running for `dir` or an ancestor of it. */
  private partialFor(dir: string): RootIndex | undefined {
    for (const { ix } of this.building.values()) {
      if (this.roots.has(ix.root)) continue // a rebuild: the finished copy answers
      if (dir === ix.root || dir.startsWith(ix.root.endsWith(sep) ? ix.root : ix.root + sep)) return ix
    }
    return undefined
  }

  /** The index answering for `dir`: a fresh or stale covering one (stale ones
   *  refresh in the background), else a new walk of `dir` itself - waited on
   *  for up to `waitMs`, after which the partly filled index answers. */
  async indexFor(dir: string, waitMs = Infinity): Promise<RootIndex> {
    const ix = this.covering(dir)
    if (ix) {
      if (Date.now() - ix.at >= this.staleMs) void this.rebuild(ix.root).catch(() => undefined)
      return ix
    }
    const partial = this.partialFor(dir)
    const p = partial ? this.building.get(partial.root)!.p : this.rebuild(dir)
    const live = partial ?? this.building.get(dir)?.ix
    if (!live || waitMs === Infinity) return p
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<RootIndex>((r) => (timer = setTimeout(() => r(live), waitMs)))
    try {
      return await Promise.race([p, late])
    } finally {
      clearTimeout(timer)
    }
  }

  /** Start indexing `dir` now (the Data Panel opening), so the first search is instant. */
  warm(dir: string): void {
    void this.indexFor(dir).catch(() => undefined)
  }

  /** Files/folders beneath `root` whose name contains `query`, plus files
   *  whose name contains any of `alsoMatch` (the renderer's registry
   *  name/description hits). Shallowest first, like searchDir. */
  async search(root: string, query: string, alsoMatch: string[] = [], maxResults = 200): Promise<SearchHit[]> {
    return (await this.searchProgressive(root, query, alsoMatch, maxResults, Infinity)).hits
  }

  /** search(), but a first walk of a big tree answers with what it has
   *  after `waitMs` (`partial: true` - ask again for more). */
  async searchProgressive(
    root: string,
    query: string,
    alsoMatch: string[] = [],
    maxResults = 200,
    waitMs = 250
  ): Promise<{ hits: SearchHit[]; partial: boolean }> {
    const ix = await this.indexFor(root, waitMs)
    return { hits: this.match(ix, root, query, alsoMatch, maxResults), partial: !ix.done }
  }

  private match(ix: RootIndex, root: string, query: string, alsoMatch: string[], maxResults: number): SearchHit[] {
    const q = query.toLowerCase()
    const extra = alsoMatch.map((s) => s.toLowerCase()).filter(Boolean)
    const prefix = root === ix.root ? '' : root.endsWith(sep) ? root : root + sep
    const base = prefix ? root.replace(/[\\/]+$/, '').split(sep).length - ix.root.split(sep).length : 0
    const hits: SearchHit[] = []
    for (const e of ix.entries) {
      if (prefix && !e.path.startsWith(prefix)) continue
      const depth = e.depth - base
      if (e.isDir) {
        if (depth <= 0 || !e.lname.includes(q)) continue
        // a folder with nothing usable beneath it isn't a useful hit; one
        // the walk never finished reading stays (unknown = show)
        if (ix.done && !ix.truncated && ix.complete.has(e.path) && !ix.relevant.has(e.path)) continue
        hits.push({ name: e.name, path: e.path, isDir: true, ext: '', depth })
      } else if (e.lname.includes(q) || extra.some((x) => e.lname.includes(x))) {
        hits.push({ name: e.name, path: e.path, isDir: false, ext: extOf(e.name), depth })
      }
    }
    hits.sort((a, b) => a.depth - b.depth)
    return hits.slice(0, maxResults)
  }

  /** Relevance answers straight from a covering index (undefined = no index
   *  covers `dir` yet, or its walk didn't finish that folder). */
  relevance(dir: string): Relevance | undefined {
    const ix = this.covering(dir)
    if (!ix || !ix.complete.has(dir)) return undefined
    if (ix.relevant.has(dir)) return true
    return ix.truncated ? undefined : false
  }
}
