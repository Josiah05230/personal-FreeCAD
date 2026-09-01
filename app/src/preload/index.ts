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

const cad = {
  rpc<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return ipcRenderer.invoke('cad:rpc', method, params) as Promise<T>
  },
  sidecarStatus: () => ipcRenderer.invoke('cad:sidecarStatus') as Promise<{ started: boolean }>,
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

  gitStatus: (filePath: string) => ipcRenderer.invoke('git:status', filePath) as Promise<GitStatus>,
  gitLog: (filePath: string, limit?: number) =>
    ipcRenderer.invoke('git:log', filePath, limit) as Promise<GitCommit[]>,
  gitBranches: (filePath: string) =>
    ipcRenderer.invoke('git:branches', filePath) as Promise<GitBranch[]>,

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
