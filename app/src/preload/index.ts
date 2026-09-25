import { contextBridge, ipcRenderer } from 'electron'

export interface DirEntry {
  name: string
  path: string
  isDir: boolean
  ext: string
  /** dirs only: does this folder contain a .FCStd within a few levels? */
  hasDesign?: boolean
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
export type PinMode = 'commit' | 'branch'
export interface ComponentPin {
  sourcePath: string
  mode?: PinMode
  ref?: string
  resolvedCommit?: string
  drift?: boolean
}
export interface AsmPinFile {
  [componentId: string]: ComponentPin
}
export interface ResolvedPin {
  linkPath: string
  pinned: boolean
  commit?: string
  drift?: boolean
}
export interface LockInfo {
  holder: string
  machine: string
  pid: number
  openedAt: string
}
export type LockAcquireResult =
  | { status: 'acquired' }
  | { status: 'reclaimed'; previousHolder: string; previousOpenedAt: string }
  | { status: 'held'; lock: LockInfo }
  | { status: 'unreachable' }
export interface UpstreamChange {
  filePath: string
  commits: GitCommit[]
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
  openDirectoryDialog: () =>
    ipcRenderer.invoke('dialog:openDirectory') as Promise<string | null>,
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
  /** test-only: git init --bare, for building a self-contained local push
   *  target without a real GitHub remote (the renderer has no Node
   *  integration to shell out to `git` directly). Not used by any
   *  production UI. */
  gitInitBare: (dirPath: string) => ipcRenderer.invoke('git:initBare', dirPath) as Promise<{ root: string }>,
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
  /** force-push with --force-with-lease, ONLY from an explicit "push mine
   *  over theirs anyway" user action (see the upstream-change watch) -
   *  never a silent fallback from a normal push. */
  gitPushForceWithLease: (filePath: string, remote?: string) =>
    ipcRenderer.invoke('git:pushForceWithLease', filePath, remote) as Promise<void>,
  gitPull: (filePath: string, remote?: string) =>
    ipcRenderer.invoke('git:pull', filePath, remote) as Promise<{ conflict: boolean }>,
  gitFetch: (filePath: string, remote?: string) =>
    ipcRenderer.invoke('git:fetch', filePath, remote) as Promise<void>,
  /** cheap online/offline probe (a targeted fetch of just HEAD) - check
   *  this BEFORE attempting an auto-pull/auto-push so the app can degrade
   *  cleanly instead of hanging or surfacing a raw network error. */
  gitIsReachable: (filePath: string, remote?: string) =>
    ipcRenderer.invoke('git:isReachable', filePath, remote) as Promise<boolean>,
  /** commits present on origin/<branch> for this exact path that local
   *  HEAD doesn't have yet - caller must fetch first (this never touches
   *  the network). Empty = nothing changed upstream. Used by the
   *  upstream-change watch (assembly components + already-open files). */
  gitChangedUpstream: (filePath: string, remote?: string) =>
    ipcRenderer.invoke('git:changedUpstream', filePath, remote) as Promise<GitCommit[]>,
  gitDiscardAll: (filePath: string) => ipcRenderer.invoke('git:discardAll', filePath) as Promise<void>,
  gitAddRemote: (filePath: string, name: string, url: string) =>
    ipcRenderer.invoke('git:addRemote', filePath, name, url) as Promise<void>,

  asmPinRead: (asmPath: string) => ipcRenderer.invoke('asmPin:read', asmPath) as Promise<AsmPinFile>,
  asmPinSet: (asmPath: string, componentId: string, pin: ComponentPin | null) =>
    ipcRenderer.invoke('asmPin:set', asmPath, componentId, pin) as Promise<void>,
  asmPinResolve: (pin: ComponentPin) =>
    ipcRenderer.invoke('asmPin:resolve', pin) as Promise<ResolvedPin>,
  asmPinResolveRefToCommit: (filePath: string, ref: string) =>
    ipcRenderer.invoke('asmPin:resolveRefToCommit', filePath, ref) as Promise<string>,
  asmPinCurrentCommit: (filePath: string) =>
    ipcRenderer.invoke('asmPin:currentCommit', filePath) as Promise<string | null>,

  /** standalone-open blocking lock - "X has this part open" (see
   *  lockfile.ts). Only for a part opened DIRECTLY, never for a component
   *  merely referenced live inside an open assembly (that gets the softer
   *  gitWatch* below instead). */
  lockAcquire: (filePath: string) => ipcRenderer.invoke('lock:acquire', filePath) as Promise<LockAcquireResult>,
  lockRelease: (filePath: string) => ipcRenderer.invoke('lock:release', filePath) as Promise<void>,
  lockCurrent: (filePath: string) => ipcRenderer.invoke('lock:current', filePath) as Promise<LockInfo | null>,

  /** soft upstream-change watch - assembly components (live/unpinned) and
   *  already-open files. Read-only (fetch only, never pulls/merges). */
  gitWatchCheckOne: (filePath: string) =>
    ipcRenderer.invoke('gitWatch:checkOne', filePath) as Promise<UpstreamChange | null>,
  gitWatchCheckMany: (filePaths: string[]) =>
    ipcRenderer.invoke('gitWatch:checkMany', filePaths) as Promise<UpstreamChange[]>,
  /** fetch the origin/<branch> version of a file to a local cache path, for
   *  the "Review" action's side-by-side comparison - read-only against the
   *  source repo (never touches its working tree/index). */
  gitWatchFetchUpstreamVersion: (filePath: string) =>
    ipcRenderer.invoke('gitWatch:fetchUpstreamVersion', filePath) as Promise<{
      path: string
      commit: string
    }>,

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
  thumb: (design: string) => ipcRenderer.invoke('fs:thumb', design) as Promise<string | null>,

  mcmasterShow: (bounds: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke('mcmaster:show', bounds) as Promise<void>,
  mcmasterSetBounds: (bounds: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke('mcmaster:setBounds', bounds) as Promise<void>,
  mcmasterHide: () => ipcRenderer.invoke('mcmaster:hide') as Promise<void>,
  mcmasterCurrentUrl: () => ipcRenderer.invoke('mcmaster:currentUrl') as Promise<string>,
  mcmasterGoBack: () => ipcRenderer.invoke('mcmaster:goBack') as Promise<void>,
  mcmasterGoForward: () => ipcRenderer.invoke('mcmaster:goForward') as Promise<void>,
  mcmasterGoHome: () => ipcRenderer.invoke('mcmaster:goHome') as Promise<void>,
  mcmasterNavigate: (input: string) => ipcRenderer.invoke('mcmaster:navigate', input) as Promise<void>,
  mcmasterDownloadCad: (format?: 'STEP' | 'IGES') =>
    ipcRenderer.invoke('mcmaster:downloadCad', format) as Promise<string>,
  mcmasterScrapeCurrentPart: () =>
    ipcRenderer.invoke('mcmaster:scrapeCurrentPart') as Promise<Record<string, unknown> | null>
}

contextBridge.exposeInMainWorld('cad', cad)
export type CadBridge = typeof cad
