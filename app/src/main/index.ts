import { app, BrowserWindow, ipcMain } from 'electron'
import { resolve, join } from 'path'
import { readdir } from 'fs/promises'
import { homedir } from 'os'
import { Sidecar, loadConfig } from './sidecar'

// repo root is one level above app/ in dev; in a packaged build this is
// remapped by the installer (Milestone 5).
const REPO_ROOT = resolve(app.getAppPath(), '..')

let win: BrowserWindow | null = null
let sidecar: Sidecar | null = null

async function createWindow(): Promise<void> {
  win = new BrowserWindow({
    width: 1600,
    height: 1000,
    backgroundColor: '#2b2b2b',
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
    const items = entries
      .filter((e) => !e.name.startsWith('.'))
      .map((e) => {
        const isDir = e.isDirectory()
        const ext = isDir ? '' : e.name.slice(e.name.lastIndexOf('.') + 1).toLowerCase()
        return { name: e.name, path: join(target, e.name), isDir, ext }
      })
      .filter((it) => it.isDir || it.ext === 'fcstd')
      .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
    return { dir: target, parent: resolve(target, '..'), items }
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
