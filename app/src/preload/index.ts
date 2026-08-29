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

/** Minimal, typed bridge. The renderer never touches Node or the sidecar directly. */
const cad = {
  rpc<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return ipcRenderer.invoke('cad:rpc', method, params) as Promise<T>
  },
  sidecarStatus(): Promise<{ started: boolean }> {
    return ipcRenderer.invoke('cad:sidecarStatus') as Promise<{ started: boolean }>
  },
  listDir(dir?: string): Promise<DirListing> {
    return ipcRenderer.invoke('fs:listDir', dir) as Promise<DirListing>
  }
}

contextBridge.exposeInMainWorld('cad', cad)

export type CadBridge = typeof cad
