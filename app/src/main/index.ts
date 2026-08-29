import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import { resolve, join } from 'path'
import { readdir, writeFile, readFile, mkdir } from 'fs/promises'
import { homedir } from 'os'
import { Sidecar, loadConfig } from './sidecar'
import * as gitw from './git'

// repo root is one level above app/ in dev; in a packaged build this is
// remapped by the installer (Milestone 5).
const REPO_ROOT = resolve(app.getAppPath(), '..')

let win: BrowserWindow | null = null
let sidecar: Sidecar | null = null

/** Does this directory contain any .FCStd within `depth` levels? (bounded) */
async function hasDesign(dir: string, depth: number): Promise<boolean> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return false
  }
  const subdirs: string[] = []
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    if (e.isFile() && e.name.toLowerCase().endsWith('.fcstd')) return true
    if (e.isDirectory()) subdirs.push(join(dir, e.name))
  }
  if (depth <= 0) return false
  for (const s of subdirs) {
    if (await hasDesign(s, depth - 1)) return true
  }
  return false
}

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
      contextIsolation: true
    }
  })

  win.once('ready-to-show', () => win?.show())

  win.webContents.on('console-message', (_e, level, message, line, source) => {
    const tag = ['v', 'i', 'w', 'e'][level] ?? '?'
    process.stdout.write(`[renderer:${tag}] ${message}  (${source}:${line})\n`)
  })
  win.webContents.on('render-process-gone', (_e, details) =>
    process.stderr.write(`[renderer] gone: ${JSON.stringify(details)}\n`)
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
    return sidecar.rpc(method, params ?? {})
  })
  ipcMain.handle('cad:sidecarStatus', () => ({ started: !!sidecar }))

  ipcMain.handle('fs:listDir', async (_e, dir?: string) => {
    const target = dir && dir.length ? resolve(dir) : homedir()
    const entries = await readdir(target, { withFileTypes: true })
    const raw = entries
      .filter((e) => !e.name.startsWith('.'))
      .map((e) => {
        const isDir = e.isDirectory()
        const ext = isDir ? '' : e.name.slice(e.name.lastIndexOf('.') + 1).toLowerCase()
        return { name: e.name, path: join(target, e.name), isDir, ext }
      })

    // files: only designs. dirs: only those with a design within a few levels.
    const files = raw.filter((it) => !it.isDir && it.ext === 'fcstd')
    const dirs = []
    for (const it of raw.filter((r) => r.isDir)) {
      if (await hasDesign(it.path, 3)) dirs.push(it)
    }
    const items = [...dirs.sort((a, b) => a.name.localeCompare(b.name)), ...files.sort((a, b) => a.name.localeCompare(b.name))]
    return { dir: target, parent: resolve(target, '..'), items }
  })

  ipcMain.handle('dialog:save', async (_e, defaultPath?: string) => {
    const r = await dialog.showSaveDialog(win!, {
      defaultPath,
      filters: [{ name: 'FreeCAD Design', extensions: ['FCStd'] }]
    })
    return r.canceled ? null : r.filePath
  })

  ipcMain.handle('dialog:open', async (_e, filters?: { name: string; extensions: string[] }[]) => {
    const r = await dialog.showOpenDialog(win!, {
      properties: ['openFile'],
      filters: filters ?? [{ name: 'FreeCAD Design', extensions: ['FCStd'] }]
    })
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0]
  })

  ipcMain.handle('dialog:export', async (_e, defaultPath?: string) => {
    const r = await dialog.showSaveDialog(win!, {
      defaultPath,
      filters: [
        { name: 'STEP', extensions: ['step', 'stp'] },
        { name: 'STL', extensions: ['stl'] }
      ]
    })
    return r.canceled ? null : r.filePath
  })

  ipcMain.handle('git:status', (_e, filePath: string) => gitw.status(filePath))
  ipcMain.handle('git:log', (_e, filePath: string, limit?: number) => gitw.log(filePath, limit))
  ipcMain.handle('git:branches', (_e, filePath: string) => gitw.branches(filePath))

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

  ipcMain.handle('fs:readImage', async (_e, path: string) => {
    const buf = await readFile(path)
    const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
    return `data:${mime};base64,${buf.toString('base64')}`
  })

  ipcMain.handle('fs:mkdir', async (_e, dir: string) => {
    await mkdir(dir, { recursive: true })
    return { dir }
  })

  ipcMain.handle('fs:touch', async (_e, path: string) => {
    await writeFile(path, '', { flag: 'wx' }).catch(() => undefined)
    return { path }
  })

  try {
    const ep = await sidecar.start()
    process.stdout.write(`[main] sidecar ready on ${ep.host}:${ep.port}\n`)
  } catch (e) {
    process.stderr.write(`[main] sidecar failed to start: ${(e as Error).message}\n`)
  }

  await createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  sidecar?.stop()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => sidecar?.stop())
