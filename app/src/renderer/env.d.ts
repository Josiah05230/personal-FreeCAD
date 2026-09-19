/// <reference types="vite/client" />

interface DirEntry {
  name: string
  path: string
  isDir: boolean
  ext: string
  /** dirs only: does this folder contain a .FCStd within a few levels? */
  hasDesign?: boolean
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
  ahead?: number
  behind?: number
  hasUpstream?: boolean
  detached?: boolean
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
interface GitFileChange {
  path: string
  index: string
  worktree: string
}
interface GitRemote {
  name: string
  url: string
}
type PinMode = 'commit' | 'branch'
interface ComponentPin {
  sourcePath: string
  mode?: PinMode
  ref?: string
  resolvedCommit?: string
  drift?: boolean
}
interface AsmPinFile {
  [componentId: string]: ComponentPin
}
interface ResolvedPin {
  linkPath: string
  pinned: boolean
  commit?: string
  drift?: boolean
}

interface CadBridge {
  isE2E: boolean
  rpc<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
  sidecarStatus(): Promise<{ started: boolean }>
  appVersion(): Promise<string>
  onSidecarRespawned(fn: () => void): () => void
  listDir(dir?: string): Promise<DirListing>
  saveDialog(defaultPath?: string): Promise<string | null>
  openDialog(filters?: { name: string; extensions: string[] }[]): Promise<string | null>
  openDirectoryDialog(): Promise<string | null>
  exportDialog(defaultPath?: string): Promise<string | null>
  saveRender(
    dataUrl: string,
    defaultPath?: string,
    format?: 'png' | 'jpeg'
  ): Promise<string | null>
  saveDebugLog(text: string, defaultPath?: string): Promise<string | null>
  gitStatus(filePath: string): Promise<GitStatus>
  gitLog(filePath: string, limit?: number): Promise<GitCommit[]>
  gitLogAll(filePath: string, limit?: number): Promise<GitCommit[]>
  gitBranches(filePath: string): Promise<GitBranch[]>
  gitChangedFiles(filePath: string): Promise<GitFileChange[]>
  gitRemotes(filePath: string): Promise<GitRemote[]>
  gitInit(filePath: string): Promise<{ root: string }>
  gitClone(url: string, destDir: string): Promise<{ root: string }>
  gitAdd(filePath: string, paths?: string[]): Promise<void>
  gitUnstage(filePath: string, paths?: string[]): Promise<void>
  gitCommit(
    filePath: string,
    message: string,
    authorName?: string,
    authorEmail?: string
  ): Promise<{ hash: string }>
  gitCommitAll(
    filePath: string,
    message: string,
    authorName?: string,
    authorEmail?: string
  ): Promise<{ hash: string }>
  gitCreateBranch(filePath: string, name: string, from?: string): Promise<void>
  gitCheckout(filePath: string, name: string): Promise<void>
  gitDeleteBranch(filePath: string, name: string, force?: boolean): Promise<void>
  gitMerge(filePath: string, from: string): Promise<{ conflict: boolean }>
  gitAbortMerge(filePath: string): Promise<void>
  gitPush(filePath: string, remote?: string): Promise<void>
  gitPull(filePath: string, remote?: string): Promise<{ conflict: boolean }>
  gitFetch(filePath: string, remote?: string): Promise<void>
  gitDiscardAll(filePath: string): Promise<void>
  gitAddRemote(filePath: string, name: string, url: string): Promise<void>
  asmPinRead(asmPath: string): Promise<AsmPinFile>
  asmPinSet(asmPath: string, componentId: string, pin: ComponentPin | null): Promise<void>
  asmPinResolve(pin: ComponentPin): Promise<ResolvedPin>
  asmPinResolveRefToCommit(filePath: string, ref: string): Promise<string>
  asmPinCurrentCommit(filePath: string): Promise<string | null>
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
  mcmasterShow(bounds: { x: number; y: number; width: number; height: number }): Promise<void>
  mcmasterSetBounds(bounds: { x: number; y: number; width: number; height: number }): Promise<void>
  mcmasterHide(): Promise<void>
  mcmasterCurrentUrl(): Promise<string>
  mcmasterGoBack(): Promise<void>
  mcmasterGoForward(): Promise<void>
  mcmasterGoHome(): Promise<void>
  mcmasterNavigate(input: string): Promise<void>
  mcmasterDownloadCad(format?: 'STEP' | 'IGES'): Promise<string>
  mcmasterScrapeCurrentPart(): Promise<Record<string, unknown> | null>
}

interface Window {
  cad: CadBridge
}
