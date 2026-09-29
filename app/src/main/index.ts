import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import { resolve, join, dirname, basename } from 'path'
import { readdir, writeFile, readFile, mkdir, rename, stat, realpath, copyFile } from 'fs/promises'
import { constants as fsConstants } from 'fs'
import { homedir, tmpdir } from 'os'
import { Sidecar, loadConfig } from './sidecar'
import * as gitw from './git'
import * as asmPin from './assemblyPin'
import * as mcmaster from './mcmaster'
import * as lockfile from './lockfile'
import * as gitWatch from './gitWatch'
import { FileIndex, FolderRelevance } from './fileFilter'
import * as dpPrefs from './dataPanelPrefs'
import * as softDel from './softDelete'
import { extOf, fileKind, isSkippedDir } from '../shared/fileTypes'

// repo root is one level above app/ in dev; in a packaged build this is
// remapped by the installer (Milestone 5).
const REPO_ROOT = resolve(app.getAppPath(), '..')

// --e2e runs must never touch the real user's state: a separate Electron
// profile (first-run flag, localStorage, window state) and a separate
// ~/.gwtcad for the sidecar (company.json, templates, recovery copies).
// Before this, test runs silently repointed a real company.json at /tmp
// test repos and marked the first-run wizard done on the real profile.
if (process.argv.includes('--e2e')) {
  const e2eHome = join(tmpdir(), 'gwtcad-e2e')
  app.setPath('userData', join(e2eHome, 'electron-profile'))
  process.env.GWTCAD_CONFIG_DIR = join(e2eHome, 'dot-gwtcad')
}

let win: BrowserWindow | null = null
let sidecar: Sidecar | null = null
/** the file path this process currently holds a standalone-open lock on
 *  (lockfile.ts), if any - tracked here so before-quit can release it
 *  synchronously without an IPC round-trip during teardown. A crash skips
 *  this entirely; lockfile.ts's staleness threshold is the real fallback
 *  for that case, this is only the graceful-exit path. */
const activeLockedPaths = new Set<string>()

/** Dirent.isDirectory() is false for a symlink even when it points at a
 *  real directory (Node doesn't follow the link for that check) - so a
 *  symlinked folder (e.g. a shared drive shortcut) would otherwise vanish
 *  from every listing/search below. Follow the link with stat() to get
 *  the real answer; a broken/dangling symlink just isn't a directory. */
async function isEffectivelyDirectory(e: import('fs').Dirent, fullPath: string): Promise<boolean> {
  if (e.isDirectory()) return true
  if (!e.isSymbolicLink()) return false
  try {
    return (await stat(fullPath)).isDirectory()
  } catch {
    return false
  }
}

function imageMime(path: string): string {
  const ext = extOf(path)
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'svg') return 'image/svg+xml'
  return ['png', 'webp', 'gif', 'bmp'].includes(ext) ? `image/${ext}` : 'image/jpeg'
}

/** one per process: folder-relevance answers are reused across listings,
 *  searches and panel reopenings (fileFilter.ts has the invalidation) */
const folderRelevance = new FolderRelevance()
// the Data Panel's search: one concurrent walk per root, searched in memory
const fileIndex = new FileIndex()
void dpPrefs.loadPrefs().then((p) => fileIndex.setSkip(p.hidden))
void softDel.purgeOld()

async function createWindow(): Promise<void> {
  win = new BrowserWindow({
    width: 1600,
    height: 1000,
    backgroundColor: '#1e1e1e',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: resolve(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      // Chromium's PDF viewer, for opening PDFs in a viewer tab
      plugins: true
    }
  })

  win.once('ready-to-show', () => win?.show())

  win.webContents.on('console-message', (_e, level, message, line, source) => {
    const tag = ['v', 'i', 'w', 'e'][level] ?? '?'
    // make renderer errors trivially greppable in the run log (dev watch / CI)
    const mark = level >= 3 || /error|uncaught|unhandled/i.test(message) ? '[GUI-ERR] ' : ''
    process.stdout.write(`${mark}[renderer:${tag}] ${message}  (${source}:${line})\n`)
  })
  win.webContents.on('render-process-gone', (_e, details) =>
    process.stderr.write(`[GUI-ERR] [renderer] gone: ${JSON.stringify(details)}\n`)
  )
  win.webContents.on('unresponsive', () =>
    process.stderr.write('[GUI-ERR] [renderer] unresponsive\n')
  )

  if (process.env.ELECTRON_RENDERER_URL) {
    await win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    await win.loadFile(resolve(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  const cfg = loadConfig(REPO_ROOT)
  sidecar = new Sidecar(REPO_ROOT, cfg)

  ipcMain.handle('cad:rpc', async (_e, method: string, params: Record<string, unknown>) => {
    if (!sidecar) throw new Error('sidecar unavailable')
    try {
      return await sidecar.rpc(method, params ?? {})
    } catch (err) {
      // greppable one-liner in the run log so a watcher / dev can react fast
      process.stderr.write(`[GUI-ERR] rpc ${method}: ${(err as Error).message}\n`)
      throw err
    }
  })
  ipcMain.handle('cad:sidecarStatus', () => ({ started: !!sidecar }))
  // app's own package.json version, shown in the status bar so the user can
  // always tell which build they're on at a glance (user request, 2026-09-12:
  // "I just want to always make sure/know I am using the newest one") -
  // app.getVersion() reads the packaged app's real version, not a
  // separately-maintained constant that could drift from what actually
  // shipped
  ipcMain.handle('app:version', () => app.getVersion())

  ipcMain.handle('fs:listDir', async (_e, dir?: string) => {
    const target = dir && dir.length ? resolve(dir) : await dpPrefs.startDir()
    const entries = await readdir(target, { withFileTypes: true })
    const raw = await Promise.all(
      entries
        .filter((e) => !e.name.startsWith('.'))
        .map(async (e) => {
          const p = join(target, e.name)
          const isDir = await isEffectivelyDirectory(e, p)
          return { name: e.name, path: p, isDir, ext: isDir ? '' : extOf(e.name) }
        })
    )

    // files: only what GWT-CAD can use (shared/fileTypes.ts - designs,
    // STEP/mesh, KiCad, zip, images, pdf, dxf/svg; never FCBak/companion
    // files). dirs: returned right away WITHOUT waiting on the recursive
    // "anything usable beneath?" walk - `relevant` is filled in only from
    // cache here (false = known to hold nothing usable; undefined = not
    // known yet), and the renderer hides the false ones and asks
    // fs:dirRelevance for the rest after painting the listing. Junk trees
    // (node_modules, __pycache__, ...) never show at all.
    const files = raw.filter((it) => !it.isDir && fileKind(it.name) !== null)
    const dirs = raw.filter((r) => r.isDir && !isSkippedDir(r.name))
    const known = await Promise.all(dirs.map((d) => folderRelevance.cached(d.path)))
    const hidden = new Set((await dpPrefs.loadPrefs()).hidden)
    const items = [
      ...dirs
        .map((d, i) => ({ ...d, relevant: known[i], hidden: hidden.has(d.path) || undefined }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      ...files.sort((a, b) => a.name.localeCompare(b.name))
    ]
    return { dir: target, parent: resolve(target, '..'), items }
  })

  // the slow half of fs:listDir: does each folder hold a usable file
  // anywhere beneath it? true / false / null (walk budget ran out - the
  // renderer keeps showing those). Folders are walked in parallel.
  ipcMain.handle('fs:dirRelevance', async (_e, dirs: string[]) => {
    const out: Record<string, boolean | null> = {}
    await Promise.all(
      (dirs ?? []).map(async (d) => {
        // a search index covering this folder already knows - no walk
        const known = fileIndex.relevance(d)
        out[d] = known !== undefined ? known : await folderRelevance.isRelevant(d)
      })
    )
    return out
  })

  ipcMain.handle('fs:searchDir', async (_e, root: string, query: string, alsoMatch?: string[]) => {
    if (!query.trim()) return { results: [] }
    const r = await fileIndex.searchProgressive(resolve(root), query.trim(), alsoMatch ?? [])
    return { results: r.hits, partial: r.partial }
  })

  // Data Panel right-click prefs: hidden folders (also skipped by search) + start folder
  ipcMain.handle('dp:getPrefs', () => dpPrefs.loadPrefs())
  ipcMain.handle('dp:setHidden', async (_e, dir: string, hidden: boolean) => {
    const p = await dpPrefs.setHidden(resolve(dir), hidden)
    fileIndex.setSkip(p.hidden)
    return p
  })
  ipcMain.handle('dp:setDefaultDir', (_e, dir: string | null) =>
    dpPrefs.setDefaultDir(dir ? resolve(dir) : null)
  )

  // the Data Panel shows a folder: index it now so a search there is instant
  ipcMain.handle('fs:warmIndex', (_e, dir: string) => {
    if (dir) fileIndex.warm(resolve(dir))
  })

  // Looks for a .kicad_pcb/.kicad_pro directly in `dir` - an F (PCB
  // Assembly) part's <pn_seq>-kicad/ folder (renderer's kicadDirFor) -
  // deliberately NOT fs:listDir, which backs the design-browsing DataPanel
  // and filters by file type. Non-recursive on purpose: the board is the
  // project at the top of that folder, never something deeper.
  ipcMain.handle('fs:findKicadProject', async (_e, dir: string) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    let pcbPath: string | null = null
    let proPath: string | null = null
    let schPath: string | null = null
    for (const e of entries) {
      if (e.isDirectory()) continue
      const lower = e.name.toLowerCase()
      if (lower.endsWith('.kicad_pcb')) pcbPath = join(dir, e.name)
      else if (lower.endsWith('.kicad_pro')) proPath = join(dir, e.name)
      else if (lower.endsWith('.kicad_sch')) schPath = join(dir, e.name)
    }
    return { pcbPath, proPath, schPath }
  })

  // --e2e / fuzz: never pop a native file dialog (it would block the run) -
  // behave as if the user hit Cancel.
  const E2E = process.argv.includes('--e2e')
  // GWTCAD_AUTO_SAVE_PATH: for interactive manual/agent driving only (the
  // run-desktop Playwright driver) - a native save/open dialog is outside the
  // Chromium render tree and can't be screenshotted or clicked through
  // Playwright's page API, which would otherwise dead-end any drive session
  // at the first Ctrl+S. Undocumented, dev-only, never set by a real user.
  const AUTO_SAVE_PATH = process.env.GWTCAD_AUTO_SAVE_PATH

  ipcMain.handle('dialog:save', async (_e, defaultPath?: string) => {
    if (E2E) return null
    if (AUTO_SAVE_PATH) return defaultPath ?? AUTO_SAVE_PATH
    const r = await dialog.showSaveDialog(win!, {
      defaultPath,
      filters: [{ name: 'FreeCAD Design', extensions: ['FCStd'] }]
    })
    return r.canceled ? null : r.filePath
  })

  ipcMain.handle('dialog:open', async (_e, filters?: { name: string; extensions: string[] }[]) => {
    if (E2E) return null
    if (AUTO_SAVE_PATH) return AUTO_SAVE_PATH
    const r = await dialog.showOpenDialog(win!, {
      properties: ['openFile'],
      filters: filters ?? [{ name: 'FreeCAD Design', extensions: ['FCStd'] }]
    })
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0]
  })

  ipcMain.handle('dialog:openDirectory', async () => {
    if (E2E) return null
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] })
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0]
  })

  ipcMain.handle('dialog:export', async (_e, defaultPath?: string) => {
    if (E2E) return null
    if (AUTO_SAVE_PATH) return defaultPath ?? AUTO_SAVE_PATH
    const r = await dialog.showSaveDialog(win!, {
      defaultPath,
      filters: [
        { name: 'STEP', extensions: ['step', 'stp'] },
        { name: 'IGES', extensions: ['iges', 'igs'] },
        { name: 'BREP', extensions: ['brep', 'brp'] },
        { name: 'STL', extensions: ['stl'] },
        { name: 'OBJ', extensions: ['obj'] },
        { name: '3MF', extensions: ['3mf'] },
        { name: 'PLY', extensions: ['ply'] },
        { name: 'OFF', extensions: ['off'] }
      ]
    })
    return r.canceled ? null : r.filePath
  })

  // save a rendered image (data URL from the viewport's offscreen capture)
  ipcMain.handle(
    'render:save',
    async (_e, dataUrl: string, defaultPath?: string, format?: 'png' | 'jpeg') => {
      if (E2E) return null
      const ext = format === 'jpeg' ? 'jpg' : 'png'
      const r = await dialog.showSaveDialog(win!, {
        defaultPath: defaultPath ?? `render.${ext}`,
        filters: [
          { name: 'PNG image', extensions: ['png'] },
          { name: 'JPEG image', extensions: ['jpg', 'jpeg'] }
        ]
      })
      if (r.canceled || !r.filePath) return null
      const b64 = dataUrl.replace(/^data:image\/\w+;base64,/, '')
      await writeFile(r.filePath, Buffer.from(b64, 'base64'))
      return r.filePath
    }
  )

  // save the renderer's interaction trace (window.__trace.dump()) to a text
  // file, so the user can attach it to a bug report - same pattern as
  // render:save
  ipcMain.handle('debug:saveLog', async (_e, text: string, defaultPath?: string) => {
    if (E2E) return null
    const r = await dialog.showSaveDialog(win!, {
      defaultPath: defaultPath ?? `gwtcad-trace-${Date.now()}.log`,
      filters: [{ name: 'Log file', extensions: ['log', 'txt'] }]
    })
    if (r.canceled || !r.filePath) return null
    await writeFile(r.filePath, text, 'utf-8')
    return r.filePath
  })

  ipcMain.handle('git:status', (_e, filePath: string) => gitw.status(filePath))
  ipcMain.handle('git:log', (_e, filePath: string, limit?: number) => gitw.log(filePath, limit))
  ipcMain.handle('git:logAll', (_e, filePath: string, limit?: number) => gitw.logAll(filePath, limit))
  ipcMain.handle('git:branches', (_e, filePath: string) => gitw.branches(filePath))
  ipcMain.handle('git:changedFiles', (_e, filePath: string) => gitw.changedFiles(filePath))
  ipcMain.handle('git:remotes', (_e, filePath: string) => gitw.remotes(filePath))
  ipcMain.handle('git:init', (_e, filePath: string) => gitw.init(filePath))
  ipcMain.handle('git:initBare', (_e, dirPath: string) => gitw.initBare(dirPath))
  ipcMain.handle('git:clone', (_e, url: string, destDir: string) => gitw.clone(url, destDir))
  ipcMain.handle('git:add', (_e, filePath: string, paths?: string[]) => gitw.add(filePath, paths))
  ipcMain.handle('git:unstage', (_e, filePath: string, paths?: string[]) => gitw.unstage(filePath, paths))
  ipcMain.handle(
    'git:commit',
    (_e, filePath: string, message: string, authorName?: string, authorEmail?: string) =>
      gitw.commit(filePath, message, authorName, authorEmail)
  )
  // per-file history (History panel)
  ipcMain.handle('git:fileLog', (_e, filePath: string, limit?: number) => gitw.fileLog(filePath, limit))
  ipcMain.handle('git:revisionFile', (_e, filePath: string, commit: string, pathAtCommit: string) =>
    gitw.revisionFile(filePath, commit, pathAtCommit)
  )
  ipcMain.handle('git:dropRevisionFile', (_e, path: string) => gitw.dropRevisionFile(path))
  ipcMain.handle('git:fileChanges', (_e, filePath: string) => gitw.fileChanges(filePath))
  // discard this part's changes - backed up first so Ctrl+Z can put them back
  ipcMain.handle('git:discardFile', async (_e, filePath: string) => {
    const backup = await softDel.backupCopies(await gitw.companionPaths(filePath))
    await gitw.discardFile(filePath)
    return { backup }
  })
  ipcMain.handle('git:undoDiscard', (_e, backup: { orig: string; copy: string }[]) => softDel.restoreCopies(backup))
  ipcMain.handle('git:commitFile', (_e, filePath: string, message: string, opts?: { wholeDir?: boolean }) =>
    gitw.commitFile(filePath, message, opts)
  )
  ipcMain.handle(
    'git:commitAll',
    (_e, filePath: string, message: string, authorName?: string, authorEmail?: string) =>
      gitw.commitAll(filePath, message, authorName, authorEmail)
  )
  ipcMain.handle('git:createBranch', (_e, filePath: string, name: string, from?: string) =>
    gitw.createBranch(filePath, name, from)
  )
  ipcMain.handle('git:checkout', (_e, filePath: string, name: string) => gitw.checkout(filePath, name))
  ipcMain.handle('git:deleteBranch', (_e, filePath: string, name: string, force?: boolean) =>
    gitw.deleteBranch(filePath, name, force)
  )
  ipcMain.handle('git:merge', (_e, filePath: string, from: string) => gitw.merge(filePath, from))
  ipcMain.handle('git:abortMerge', (_e, filePath: string) => gitw.abortMerge(filePath))
  ipcMain.handle('git:push', (_e, filePath: string, remote?: string) => gitw.push(filePath, remote))
  ipcMain.handle('git:pushForceWithLease', (_e, filePath: string, remote?: string) =>
    gitw.pushForceWithLease(filePath, remote)
  )
  ipcMain.handle('git:pull', (_e, filePath: string, remote?: string) => gitw.pull(filePath, remote))
  ipcMain.handle('git:fetch', (_e, filePath: string, remote?: string) => gitw.fetch(filePath, remote))
  ipcMain.handle('git:isReachable', (_e, filePath: string, remote?: string) =>
    gitw.isReachable(filePath, remote)
  )
  ipcMain.handle('git:changedUpstream', (_e, filePath: string, remote?: string) =>
    gitw.changedUpstream(filePath, remote)
  )
  ipcMain.handle('git:discardAll', (_e, filePath: string) => gitw.discardAll(filePath))
  ipcMain.handle('git:addRemote', (_e, filePath: string, name: string, url: string) =>
    gitw.addRemote(filePath, name, url)
  )

  // --- assembly component version pins (git-based lock/track) ---
  ipcMain.handle('asmPin:read', (_e, asmPath: string) => asmPin.readPins(asmPath))
  ipcMain.handle(
    'asmPin:set',
    (_e, asmPath: string, componentId: string, pin: asmPin.ComponentPin | null) =>
      asmPin.setPin(asmPath, componentId, pin)
  )
  ipcMain.handle('asmPin:resolve', async (_e, pin: asmPin.ComponentPin) =>
    asmPin.resolveComponentSource(pin)
  )
  ipcMain.handle('asmPin:resolveRefToCommit', (_e, filePath: string, ref: string) =>
    asmPin.resolveRefToCommit(filePath, ref)
  )
  ipcMain.handle('asmPin:currentCommit', (_e, filePath: string) => asmPin.currentCommitFor(filePath))

  // --- standalone-open lock (blocking - "X has this part open") ---
  // activeLockedPaths is tracked here (not just in the renderer's own state)
  // so before-quit below can release them all without a risky
  // round-trip IPC call while the app is already tearing down.
  ipcMain.handle('lock:acquire', async (_e, filePath: string) => {
    const result = await lockfile.acquireLock(filePath, (published) => {
      if (published.status === 'held') activeLockedPaths.delete(filePath)
      if (published.status !== 'published') win?.webContents.send('lock:published', filePath, published)
    })
    if (result.status === 'acquired' || result.status === 'reclaimed') activeLockedPaths.add(filePath)
    return result
  })
  ipcMain.handle('lock:release', async (_e, filePath: string) => {
    await lockfile.releaseLock(filePath)
    activeLockedPaths.delete(filePath)
  })
  ipcMain.handle('lock:current', (_e, filePath: string) => lockfile.currentLock(filePath))

  // --- upstream-change watch (soft - assembly components + already-open files) ---
  ipcMain.handle('gitWatch:checkOne', (_e, filePath: string) => gitWatch.checkOne(filePath))
  ipcMain.handle('gitWatch:checkMany', (_e, filePaths: string[]) => gitWatch.checkMany(filePaths))
  ipcMain.handle('gitWatch:fetchUpstreamVersion', (_e, filePath: string) =>
    gitWatch.fetchUpstreamVersion(filePath)
  )

  // --- McMaster-Carr embedded browser panel ---
  ipcMain.handle(
    'mcmaster:show',
    (_e, bounds: { x: number; y: number; width: number; height: number }) => {
      if (win) mcmaster.show(win, bounds)
    }
  )
  ipcMain.handle('mcmaster:setBounds', (_e, bounds: { x: number; y: number; width: number; height: number }) =>
    mcmaster.setBounds(bounds)
  )
  ipcMain.handle('mcmaster:hide', () => mcmaster.hide())
  ipcMain.handle('mcmaster:currentUrl', () => mcmaster.currentUrl())
  ipcMain.handle('mcmaster:goBack', () => mcmaster.goBack())
  ipcMain.handle('mcmaster:goForward', () => mcmaster.goForward())
  ipcMain.handle('mcmaster:goHome', () => mcmaster.goHome())
  ipcMain.handle('mcmaster:navigate', (_e, input: string) => mcmaster.navigate(input))
  ipcMain.handle('mcmaster:downloadCad', (_e, format?: 'STEP' | 'IGES') => mcmaster.downloadCad(format))
  ipcMain.handle('mcmaster:scrapeCurrentPart', () => mcmaster.scrapeCurrentPart())
  ipcMain.handle('mcmaster:fetchStepHeadless', (_e, mfgPn: string) => mcmaster.fetchStepHeadless(mfgPn))

  ipcMain.handle('drawing:exportPdf', async (_e, html: string, outPath: string) => {
    const w = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
    try {
      await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
      const pdf = await w.webContents.printToPDF({
        landscape: true,
        printBackground: true,
        pageSize: 'A3'
      })
      await writeFile(outPath, pdf)
      return { path: outPath }
    } finally {
      w.destroy()
    }
  })

  ipcMain.handle('drawing:writeText', async (_e, text: string, outPath: string) => {
    await writeFile(outPath, text, 'utf-8')
    return { path: outPath }
  })

  // raw bytes for the in-app file viewer (PDF, DXF)
  ipcMain.handle('fs:readBytes', async (_e, path: string) => {
    const st = await stat(path)
    if (st.size > 300 * 1024 * 1024) throw new Error('file is too large to view (over 300 MB)')
    return new Uint8Array(await readFile(path))
  })
  ipcMain.handle('fs:readImage', async (_e, path: string) => {
    const buf = await readFile(path)
    return `data:${imageMime(path)};base64,${buf.toString('base64')}`
  })

  // absolute, symlink-resolved path (null if it doesn't exist) - the
  // copy-into-company-repo gate compares these, so a repo reached through a
  // symlink still counts as "inside"
  ipcMain.handle('fs:realpath', async (_e, path: string) => {
    try {
      return await realpath(resolve(path))
    } catch {
      return null
    }
  })

  // copy `src` into `destDir` as `name`, never overwriting: "x.png" becomes
  // "x-2.png" if taken. Used to bring an outside image next to a company
  // document instead of referencing it where it sits.
  ipcMain.handle('fs:copyInto', async (_e, src: string, destDir: string, name: string) => {
    await mkdir(destDir, { recursive: true })
    const dot = name.lastIndexOf('.')
    const stem = dot > 0 ? name.slice(0, dot) : name
    const ext = dot > 0 ? name.slice(dot) : ''
    for (let i = 1; i < 1000; i++) {
      const dest = join(destDir, i === 1 ? name : `${stem}-${i}${ext}`)
      try {
        await copyFile(src, dest, fsConstants.COPYFILE_EXCL)
        return { path: dest }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      }
    }
    throw new Error(`could not find a free name for ${name} in ${destDir}`)
  })

  ipcMain.handle('fs:mkdir', async (_e, dir: string) => {
    await mkdir(dir, { recursive: true })
    return { dir }
  })

  ipcMain.handle('fs:touch', async (_e, path: string) => {
    await writeFile(path, '', { flag: 'wx' }).catch(() => undefined)
    return { path }
  })

  ipcMain.handle('fs:move', async (_e, src: string, dest: string) => {
    await rename(src, dest)
    return { src, dest }
  })

  // undoable delete: into ~/.gwtcad/deleted, and back on undo
  ipcMain.handle('fs:softDelete', (_e, path: string) => softDel.softDelete(resolve(path)))
  ipcMain.handle('fs:restore', (_e, held: string, path: string) => softDel.restore(held, resolve(path)))
  ipcMain.handle('fs:trash', async (_e, path: string) => {
    await shell.trashItem(resolve(path))
    return { trashed: path }
  })

  // Opens a file with the OS's own default handler for its type - used for
  // "Open in KiCad" on an F (PCB Assembly) part's .kicad_pro: launches
  // whatever the user's system has registered for that extension (real
  // KiCad if installed) rather than hardcoding a kicad binary path/name,
  // which would vary by OS/install method and go stale on every KiCad
  // update. shell.openPath's own return value IS the error message (empty
  // string on success) - never rejects, so this surfaces failures as a
  // real error string instead of a silently-swallowed one.
  ipcMain.handle('shell:openPath', async (_e, path: string) => {
    const err = await shell.openPath(resolve(path))
    if (err) throw new Error(err)
    return { opened: path }
  })

  // sibling folders of `path`'s directory (targets for "Move to folder")
  ipcMain.handle('fs:siblingDirs', async (_e, path: string) => {
    const base = dirname(path)
    const up = resolve(base, '..')
    const out: string[] = [base]
    for (const root of [base, up]) {
      const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
      for (const e of entries) {
        if (e.isDirectory() && !e.name.startsWith('.')) out.push(join(root, e.name))
      }
    }
    return [...new Set(out)]
  })

  const thumbPath = (design: string): string =>
    join(dirname(design), '.gwtcad-thumbs', basename(design).replace(/\.FCStd$/i, '') + '.png')

  ipcMain.handle('win:captureThumb', async (_e, design: string) => {
    if (!win || !design) return { path: null }
    const img = await win.webContents.capturePage()
    const small = img.resize({ width: 320, quality: 'good' })
    const out = thumbPath(design)
    await mkdir(dirname(out), { recursive: true })
    await writeFile(out, small.toPNG())
    return { path: out }
  })

  ipcMain.handle('fs:thumb', async (_e, design: string) => {
    // an image is its own thumbnail (small ones only - the panel shows it
    // at icon size, a multi-MB photo isn't worth base64-ing per row)
    if (fileKind(design) === 'image' || extOf(design) === 'svg') {
      try {
        if ((await stat(design)).size > 2_000_000) return null
        return `data:${imageMime(design)};base64,${(await readFile(design)).toString('base64')}`
      } catch {
        return null
      }
    }
    try {
      const buf = await readFile(thumbPath(design))
      return `data:image/png;base64,${buf.toString('base64')}`
    } catch {
      return null
    }
  })

  // after an unasked-for respawn the sidecar doc is empty - tell the renderer so
  // it can refetch (and surface a notice that geometry state was lost)
  sidecar.onRespawn = () => {
    win?.webContents.send('cad:sidecarRespawned')
  }

  try {
    const ep = await sidecar.start()
    process.stdout.write(`[main] sidecar ready on ${ep.host}:${ep.port}\n`)
  } catch (e) {
    process.stderr.write(`[main] sidecar failed to start: ${(e as Error).message}\n`)
  }

  await createWindow()

  // --e2e <scenario.js> : wait for renderer + engine, eval the scenario file in
  // the renderer (it drives window.__gwtcad and returns {passed,failed,lines}),
  // print TAP-ish output, exit 0/1. Runs the real component tree + IPC + sidecar.
  const e2eIdx = process.argv.indexOf('--e2e')
  if (e2eIdx !== -1 && win) {
    const scenarioPath = process.argv[e2eIdx + 1]
    void (async () => {
      const w = win!
      let code = 1
      try {
        for (let i = 0; i < 120; i++) {
          const ready = await w.webContents
            .executeJavaScript(
              `(async () => (window.__gwtcad && (await window.cad.rpc('ping',{}).then(()=>1).catch(()=>0))) ? 1 : 0)()`
            )
            .catch(() => 0)
          if (ready) break
          await new Promise((r) => setTimeout(r, 500))
        }
        const harness = await readFile(resolve(REPO_ROOT, 'test/e2e/harness.js'), 'utf-8')
        const scenario = await readFile(resolve(process.cwd(), scenarioPath), 'utf-8')
        // pass a whitelist of env through to the renderer (process.env is not
        // reachable there); scenarios read it via ENV.<NAME>
        const envOut: Record<string, string | undefined> = {}
        for (const k of Object.keys(process.env)) {
          if (/^(FUZZ|MONKEY|E2E)_/.test(k)) envOut[k] = process.env[k]
        }
        await w.webContents
          .executeJavaScript(`window.__E2E_ENV = ${JSON.stringify(envOut)};0`)
          .catch(() => 0)
        const raw = await w.webContents.executeJavaScript(
          `(async () => {
             ${harness}
             try { await (async () => { ${scenario}
             })() } catch (e) { _failed++; _lines.push('not ok - scenario threw: ' + ((e && e.message) || e)) }
             return { passed: _passed, failed: _failed, lines: _lines }
           })()`
        )
        const res = raw as { passed: number; failed: number; lines: string[] }
        const report =
          res.lines.join('\n') + `\n\n# ${scenarioPath}: ${res.passed} passed, ${res.failed} failed\n`
        process.stdout.write(report)
        // also drop a file - stdout capture through the harness / backgrounding
        // is unreliable in some shells, and app.exit() can truncate a pipe
        try {
          const base = basename(scenarioPath).replace(/\.js$/, '')
          await writeFile(resolve(REPO_ROOT, `test/e2e/report-${base}.txt`), report)
        } catch {
          /* best effort */
        }
        code = res.failed === 0 ? 0 : 1
      } catch (e) {
        process.stderr.write(`[e2e] harness error: ${(e as Error).message}\n`)
        code = 1
      }
      if (process.env.E2E_SHOT) {
        try {
          const img = await w.webContents.capturePage()
          await writeFile(process.env.E2E_SHOT, img.toPNG())
          process.stdout.write(`[e2e] wrote screenshot to ${process.env.E2E_SHOT}\n`)
        } catch (e) {
          process.stderr.write(`[e2e] screenshot failed: ${(e as Error).message}\n`)
        }
      }
      app.exit(code)
    })()
  }

  // --drive <script.js> : like --e2e but deliberately does NOT set
  // window.__E2E_ENV, so promptText/promptForm show REAL dialogs instead of
  // auto-cancelling - lets a script click through Note/Section View/etc.
  // dialogs the same way a real user would. Combine with E2E_SHOT to
  // screenshot the result. Dev-only manual verification tool, not part of
  // the automated suite.
  const driveIdx = process.argv.indexOf('--drive')
  if (driveIdx !== -1 && win) {
    const scriptPath = process.argv[driveIdx + 1]
    void (async () => {
      const w = win!
      let code = 1
      try {
        for (let i = 0; i < 120; i++) {
          const ready = await w.webContents
            .executeJavaScript(
              `(async () => (window.__gwtcad && (await window.cad.rpc('ping',{}).then(()=>1).catch(()=>0))) ? 1 : 0)()`
            )
            .catch(() => 0)
          if (ready) break
          await new Promise((r) => setTimeout(r, 500))
        }
        const harness = await readFile(resolve(REPO_ROOT, 'test/e2e/harness.js'), 'utf-8')
        const script = await readFile(resolve(process.cwd(), scriptPath), 'utf-8')
        const raw = await w.webContents.executeJavaScript(
          `(async () => {
             ${harness}
             try { await (async () => { ${script}
             })() } catch (e) { _failed++; _lines.push('not ok - script threw: ' + ((e && e.message) || e)) }
             return { passed: _passed, failed: _failed, lines: _lines }
           })()`
        )
        const res = raw as { passed: number; failed: number; lines: string[] }
        process.stdout.write(res.lines.join('\n') + `\n\n# ${scriptPath}: ${res.passed} passed, ${res.failed} failed\n`)
        code = res.failed === 0 ? 0 : 1
      } catch (e) {
        process.stderr.write(`[drive] error: ${(e as Error).message}\n`)
        code = 1
      }
      if (process.env.E2E_SHOT) {
        try {
          const img = await w.webContents.capturePage()
          await writeFile(process.env.E2E_SHOT, img.toPNG())
          process.stdout.write(`[drive] wrote screenshot to ${process.env.E2E_SHOT}\n`)
        } catch (e) {
          process.stderr.write(`[drive] screenshot failed: ${(e as Error).message}\n`)
        }
      }
      app.exit(code)
    })()
  }

  // --shot <out.png> [--shot-demo] : wait for the renderer + engine, optionally
  // build a demo part via the test bridge, capturePage, and quit. Dev tooling.
  const shotIdx = process.argv.indexOf('--shot')
  if (shotIdx !== -1 && win) {
    const out = process.argv[shotIdx + 1] || join(homedir(), 'gwtcad-shot.png')
    const demo = process.argv.includes('--shot-demo')
    void (async () => {
      const w = win!
      for (let i = 0; i < 60; i++) {
        const ready = await w.webContents
          .executeJavaScript(`window.cad.rpc('ping',{}).then(()=>true).catch(()=>false)`)
          .catch(() => false)
        if (ready) break
        await new Promise((r) => setTimeout(r, 500))
      }
      await w.webContents.executeJavaScript(`window.__gwtcad&&window.__gwtcad.refresh();0`).catch(() => 0)
      if (demo) {
        await w.webContents
          .executeJavaScript(
            `(async()=>{const r=window.cad.rpc;
             const cz=(g,m)=>{let z=0,n=0;for(let i=g.start;i<g.start+g.count;i++){z+=m.positions[m.indices[i]*3+2];n++}return z/n};
             const topFace=m=>{let tf=m.faceGroups[0],b=-1e9;for(const g of m.faceGroups){const z=cz(g,m);if(z>b){b=z;tf=g}}return 'Face'+(tf.face+1)};
             await r('session.reset',{});
             const s=await r('sketch.on',{ref:{kind:'origin',role:'XY_Plane'}});
             await r('sketch.finish',{sketchId:s.sketchId,elements:[{type:'rect',a:[-45,-30],b:[45,30]}],constraints:[]});
             await r('feature.extrude',{sketchId:s.sketchId,length:36});
             const bid=(await r('tree.get',{})).bodies[0].id;
             let m=(await r('scene.get',{})).meshes[0];
             const es=m.edges.filter(e=>{const zs=e.points.filter((_,i)=>i%3===2);return Math.max(...zs)-Math.min(...zs)>30}).slice(0,4).map(e=>'Edge'+(e.edge+1));
             await r('feature.fillet',{edges:es,radius:10});
             m=(await r('scene.get',{})).meshes[0];
             const hs=await r('sketch.on',{ref:{kind:'face',bodyId:bid,sub:topFace(m)}});
             await r('sketch.finish',{sketchId:hs.sketchId,elements:[{type:'circle',c:[0,0],r:15}],constraints:[]});
             await r('feature.extrude',{sketchId:hs.sketchId,length:16});
             m=(await r('scene.get',{})).meshes[0];
             const bs=await r('sketch.on',{ref:{kind:'face',bodyId:bid,sub:topFace(m)}});
             await r('sketch.finish',{sketchId:bs.sketchId,elements:[{type:'circle',c:[0,0],r:8}],constraints:[]});
             await r('feature.extrude',{sketchId:bs.sketchId,length:60,cut:true});
             const t=await r('tree.get',{}); const sc=await r('scene.get',{});
             return 'ok feats='+(t.bodies[0]?t.bodies[0].features.length:'?')+' meshes='+sc.meshes.length+' verts='+(sc.meshes[0]?sc.meshes[0].positions.length/3:0);})()`
          )
          .then((v) => process.stdout.write('[shot] demo -> ' + v + '\n'))
          .catch((e) => process.stderr.write('[shot] demo err ' + e + '\n'))
        process.stdout.write('[shot] demo built, refreshing\n')
        await new Promise((r) => setTimeout(r, 1200))
        const rr = await w.webContents
          .executeJavaScript(`window.__gwtcad.refresh().then(()=>'refreshed').catch(e=>'ref err '+e)`)
          .catch((e) => 'ref throw ' + e)
        process.stdout.write('[shot] ' + rr + '\n')
        await new Promise((r) => setTimeout(r, 1500))
        const dbg = await w.webContents
          .executeJavaScript(
            `(async()=>{const cs=[...document.querySelectorAll('canvas')].map(c=>[c.width,c.height]);
             const t=await window.cad.rpc('tree.get',{});
             return JSON.stringify({canvases:cs,feats:t.bodies[0]?t.bodies[0].features.length:-1})})()`
          )
          .catch((e) => 'dbg err ' + e)
        process.stdout.write('[shot] dbg ' + dbg + '\n')
        await w.webContents.executeJavaScript(`window.__gwtcad.fit();0`).catch(() => 0)
        await new Promise((r) => setTimeout(r, 1500))
        await w.webContents.executeJavaScript(`window.__gwtcad.fit();0`).catch(() => 0)
        await new Promise((r) => setTimeout(r, 2000))
      } else {
        await new Promise((r) => setTimeout(r, 1500))
      }
      const img = await w.webContents.capturePage()
      await writeFile(out, img.toPNG())
      process.stdout.write(`[shot] wrote ${out} ${img.getSize().width}x${img.getSize().height}\n`)
      app.quit()
    })()
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // before-quit stops the sidecar (and waits for it)
  if (process.platform !== 'darwin') app.quit()
  else void sidecar?.stop()
})

let releasingLockOnQuit = false
let sidecarStoppedForQuit = false
app.on('before-quit', (e) => {
  // best-effort, bounded: release the standalone-open lock (if held) before
  // actually exiting, so a normal quit never leaves a lock for someone
  // else to wait out the staleness threshold on. Only delays quit once -
  // releaseLock's own network calls are already timeout-bounded (8s), so
  // this adds at most that long, never blocks indefinitely, and a second
  // quit request (e.g. the user impatiently quitting twice) falls through
  // immediately rather than looping.
  if (activeLockedPaths.size && !releasingLockOnQuit) {
    releasingLockOnQuit = true
    e.preventDefault()
    const paths = [...activeLockedPaths]
    activeLockedPaths.clear()
    void lockfile
      .releaseLocks(paths)
      .catch(() => undefined)
      .then(() => app.quit())
    return
  }
  void mcmaster.cleanup()
  // hold the quit until the sidecar has really exited (at most ~2s, then
  // it's SIGKILLed) - quitting first left it running as an orphan
  if (sidecar && !sidecarStoppedForQuit) {
    e.preventDefault()
    sidecarStoppedForQuit = true
    void sidecar.stop().finally(() => app.quit())
  }
})
