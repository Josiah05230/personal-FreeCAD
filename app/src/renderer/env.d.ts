/// <reference types="vite/client" />

interface DirEntry {
  name: string
  path: string
  isDir: boolean
  ext: string
}
interface DirListing {
  dir: string
  parent: string
  items: DirEntry[]
}

interface CadBridge {
  rpc<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
  sidecarStatus(): Promise<{ started: boolean }>
  listDir(dir?: string): Promise<DirListing>
}

interface Window {
  cad: CadBridge
}
