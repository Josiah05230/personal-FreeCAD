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
interface GitStatus {
  isRepo: boolean
  root?: string
  branch?: string
  dirty?: boolean
  tracked?: boolean
}
interface GitCommit {
  hash: string
  short: string
  subject: string
  author: string
  isoDate: string
  relDate: string
}
interface GitBranch {
  name: string
  current: boolean
}

interface CadBridge {
  rpc<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
  sidecarStatus(): Promise<{ started: boolean }>
  listDir(dir?: string): Promise<DirListing>
  saveDialog(defaultPath?: string): Promise<string | null>
  openDialog(filters?: { name: string; extensions: string[] }[]): Promise<string | null>
  exportDialog(defaultPath?: string): Promise<string | null>
  gitStatus(filePath: string): Promise<GitStatus>
  gitLog(filePath: string, limit?: number): Promise<GitCommit[]>
  gitBranches(filePath: string): Promise<GitBranch[]>
  exportPdf(html: string, outPath: string): Promise<{ path: string }>
  writeText(text: string, outPath: string): Promise<{ path: string }>
  readImage(path: string): Promise<string>
  mkdir(dir: string): Promise<{ dir: string }>
  touch(path: string): Promise<{ path: string }>
  move(src: string, dest: string): Promise<{ src: string; dest: string }>
  trash(path: string): Promise<{ trashed: string }>
  siblingDirs(path: string): Promise<string[]>
  captureThumb(design: string): Promise<{ path: string | null }>
  thumb(design: string): Promise<string | null>
}

interface Window {
  cad: CadBridge
}
