import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import { resolve, join, dirname, basename } from 'path'
import { readdir, writeFile, readFile, mkdir, rename } from 'fs/promises'
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

  ipcMain.handle('fs:move', async (_e, src: string, dest: string) => {
    await rename(src, dest)
    return { src, dest }
  })

  ipcMain.handle('fs:trash', async (_e, path: string) => {
    await shell.trashItem(resolve(path))
    return { trashed: path }
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
  sidecar?.stop()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => sidecar?.stop())
