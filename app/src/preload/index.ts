import { contextBridge, ipcRenderer } from 'electron'

/** Minimal, typed bridge. The renderer never touches Node or the sidecar directly. */
const cad = {
  rpc<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return ipcRenderer.invoke('cad:rpc', method, params) as Promise<T>
  },
  sidecarStatus(): Promise<{ started: boolean }> {
    return ipcRenderer.invoke('cad:sidecarStatus') as Promise<{ started: boolean }>
  }
}

contextBridge.exposeInMainWorld('cad', cad)

export type CadBridge = typeof cad
