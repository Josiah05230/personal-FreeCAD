import { contextBridge, ipcRenderer } from 'electron'

export interface DirEntry {
  name: string
  path: string
  isDir: boolean
  ext: string
}
export interface DirListing {
  dir: string
  parent: string
  items: DirEntry[]
}
export interface GitStatus {
  isRepo: boolean
  root?: string
  branch?: string
  dirty?: boolean
  tracked?: boolean
  ahead?: number
  behind?: number
  hasUpstream?: boolean
  detached?: boolean
}
export interface GitCommit {
  hash: string
  short: string
  subject: string
  author: string
  isoDate: string
  relDate: string
}
export interface GitBranch {
  name: string
  current: boolean
}
export interface GitFileChange {
  path: string
  index: string
  worktree: string
}
export interface GitRemote {
  name: string
  url: string
}

const cad = {
  /** true when launched by the E2E harness (`--e2e <scenario>`) - the renderer
   *  suppresses one-shot modals like the first-run wizard so scenarios run clean */
  isE2E: process.argv.includes('--e2e'),
  rpc<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return ipcRenderer.invoke('cad:rpc', method, params) as Promise<T>
  },
  sidecarStatus: () => ipcRenderer.invoke('cad:sidecarStatus') as Promise<{ started: boolean }>,
  /** the packaged app's own version (package.json), for the status bar */
  appVersion: () => ipcRenderer.invoke('app:version') as Promise<string>,
  /** fires after the geometry engine crashed and was respawned (doc is now empty) */
  onSidecarRespawned: (fn: () => void) => {
    const h = (): void => fn()
    ipcRenderer.on('cad:sidecarRespawned', h)
    return () => ipcRenderer.removeListener('cad:sidecarRespawned', h)
  },
  listDir: (dir?: string) => ipcRenderer.invoke('fs:listDir', dir) as Promise<DirListing>,

  saveDialog: (defaultPath?: string) =>
    ipcRenderer.invoke('dialog:save', defaultPath) as Promise<string | null>,
  openDialog: (filters?: { name: string; extensions: string[] }[]) =>
    ipcRenderer.invoke('dialog:open', filters) as Promise<string | null>,
  exportDialog: (defaultPath?: string) =>
    ipcRenderer.invoke('dialog:export', defaultPath) as Promise<string | null>,
  saveRender: (dataUrl: string, defaultPath?: string, format?: 'png' | 'jpeg') =>
    ipcRenderer.invoke('render:save', dataUrl, defaultPath, format) as Promise<string | null>,
  saveDebugLog: (text: string, defaultPath?: string) =>
    ipcRenderer.invoke('debug:saveLog', text, defaultPath) as Promise<string | null>,

  gitStatus: (filePath: string) => ipcRenderer.invoke('git:status', filePath) as Promise<GitStatus>,
  gitLog: (filePath: string, limit?: number) =>
    ipcRenderer.invoke('git:log', filePath, limit) as Promise<GitCommit[]>,
  gitLogAll: (filePath: string, limit?: number) =>
    ipcRenderer.invoke('git:logAll', filePath, limit) as Promise<GitCommit[]>,
  gitBranches: (filePath: string) =>
    ipcRenderer.invoke('git:branches', filePath) as Promise<GitBranch[]>,
  gitChangedFiles: (filePath: string) =>
    ipcRenderer.invoke('git:changedFiles', filePath) as Promise<GitFileChange[]>,
  gitRemotes: (filePath: string) =>
    ipcRenderer.invoke('git:remotes', filePath) as Promise<GitRemote[]>,
  gitInit: (filePath: string) => ipcRenderer.invoke('git:init', filePath) as Promise<{ root: string }>,
  gitClone: (url: string, destDir: string) =>
    ipcRenderer.invoke('git:clone', url, destDir) as Promise<{ root: string }>,
  gitAdd: (filePath: string, paths?: string[]) =>
    ipcRenderer.invoke('git:add', filePath, paths) as Promise<void>,
  gitUnstage: (filePath: string, paths?: string[]) =>
    ipcRenderer.invoke('git:unstage', filePath, paths) as Promise<void>,
  gitCommit: (filePath: string, message: string, authorName?: string, authorEmail?: string) =>
    ipcRenderer.invoke('git:commit', filePath, message, authorName, authorEmail) as Promise<{
      hash: string
    }>,
  gitCommitAll: (filePath: string, message: string, authorName?: string, authorEmail?: string) =>
    ipcRenderer.invoke('git:commitAll', filePath, message, authorName, authorEmail) as Promise<{
      hash: string
    }>,
  gitCreateBranch: (filePath: string, name: string, from?: string) =>
    ipcRenderer.invoke('git:createBranch', filePath, name, from) as Promise<void>,
  gitCheckout: (filePath: string, name: string) =>
    ipcRenderer.invoke('git:checkout', filePath, name) as Promise<void>,
  gitDeleteBranch: (filePath: string, name: string, force?: boolean) =>
    ipcRenderer.invoke('git:deleteBranch', filePath, name, force) as Promise<void>,
  gitMerge: (filePath: string, from: string) =>
    ipcRenderer.invoke('git:merge', filePath, from) as Promise<{ conflict: boolean }>,
  gitAbortMerge: (filePath: string) => ipcRenderer.invoke('git:abortMerge', filePath) as Promise<void>,
  gitPush: (filePath: string, remote?: string) =>
    ipcRenderer.invoke('git:push', filePath, remote) as Promise<void>,
  gitPull: (filePath: string, remote?: string) =>
    ipcRenderer.invoke('git:pull', filePath, remote) as Promise<{ conflict: boolean }>,
  gitFetch: (filePath: string, remote?: string) =>
    ipcRenderer.invoke('git:fetch', filePath, remote) as Promise<void>,
  gitDiscardAll: (filePath: string) => ipcRenderer.invoke('git:discardAll', filePath) as Promise<void>,
  gitAddRemote: (filePath: string, name: string, url: string) =>
    ipcRenderer.invoke('git:addRemote', filePath, name, url) as Promise<void>,

  exportPdf: (html: string, outPath: string) =>
    ipcRenderer.invoke('drawing:exportPdf', html, outPath) as Promise<{ path: string }>,
  writeText: (text: string, outPath: string) =>
    ipcRenderer.invoke('drawing:writeText', text, outPath) as Promise<{ path: string }>,
  readImage: (path: string) => ipcRenderer.invoke('fs:readImage', path) as Promise<string>,
  mkdir: (dir: string) => ipcRenderer.invoke('fs:mkdir', dir) as Promise<{ dir: string }>,
  touch: (path: string) => ipcRenderer.invoke('fs:touch', path) as Promise<{ path: string }>,
  move: (src: string, dest: string) =>
    ipcRenderer.invoke('fs:move', src, dest) as Promise<{ src: string; dest: string }>,
  trash: (path: string) =>
    ipcRenderer.invoke('fs:trash', path) as Promise<{ trashed: string }>,
  siblingDirs: (path: string) => ipcRenderer.invoke('fs:siblingDirs', path) as Promise<string[]>,
  captureThumb: (design: string) =>
    ipcRenderer.invoke('win:captureThumb', design) as Promise<{ path: string | null }>,
  thumb: (design: string) => ipcRenderer.invoke('fs:thumb', design) as Promise<string | null>
}

contextBridge.exposeInMainWorld('cad', cad)
export type CadBridge = typeof cad
