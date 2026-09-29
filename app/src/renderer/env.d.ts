/// <reference types="vite/client" />

interface DirEntry {
  name: string
  path: string
  isDir: boolean
  ext: string
  /** dirs only: holds a GWT-CAD-usable file somewhere beneath (true),
   *  known not to (false - hidden), gave up looking (null), or not checked
   *  yet (undefined) */
  relevant?: boolean | null
  /** the user hid this folder from the Data Panel (right-click) */
  hidden?: boolean
}
interface DirListing {
  dir: string
  parent: string
  items: DirEntry[]
}
interface FileCommit {
  hash: string
  short: string
  subject: string
  /** the rest of the commit message - the version's notes */
  body: string
  author: string
  isoDate: string
  relDate: string
  /** repo-relative path of the file as of this commit */
  pathAtCommit: string
  /** lock / auto-generated drawing / supplier reference commit */
  auto: boolean
}

interface DataPanelPrefs {
  hidden: string[]
  defaultDir: string | null
}

interface SearchResult {
  name: string
  path: string
  isDir: boolean
  ext: string
  depth: number
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
interface LockInfo {
  holder: string
  machine: string
  pid: number
  openedAt: string
}
type LockAcquireResult =
  | { status: 'acquired' }
  | { status: 'reclaimed'; previousHolder: string; previousOpenedAt: string }
  | { status: 'held'; lock: LockInfo }
  | { status: 'unreachable' }
interface UpstreamChange {
  filePath: string
  commits: GitCommit[]
}

interface CadBridge {
  isE2E: boolean
  rpc<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
  sidecarStatus(): Promise<{ started: boolean }>
  appVersion(): Promise<string>
  onSidecarRespawned(fn: () => void): () => void
  listDir(dir?: string): Promise<DirListing>
  dirRelevance(dirs: string[]): Promise<Record<string, boolean | null>>
  searchDir(root: string, query: string, alsoMatch?: string[]): Promise<{ results: SearchResult[]; partial?: boolean }>
  warmIndex(dir: string): Promise<void>
  dataPanelPrefs(): Promise<DataPanelPrefs>
  setFolderHidden(dir: string, hidden: boolean): Promise<DataPanelPrefs>
  setDefaultFolder(dir: string | null): Promise<DataPanelPrefs>
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
  gitInitBare(dirPath: string): Promise<{ root: string }>
  gitClone(url: string, destDir: string): Promise<{ root: string }>
  gitAdd(filePath: string, paths?: string[]): Promise<void>
  gitUnstage(filePath: string, paths?: string[]): Promise<void>
  gitCommit(
    filePath: string,
    message: string,
    authorName?: string,
    authorEmail?: string
  ): Promise<{ hash: string }>
  gitCommitFile(
    filePath: string,
    message: string,
    opts?: { wholeDir?: boolean; extraPaths?: string[] }
  ): Promise<{ hash: string }>
  gitFileLog(filePath: string, limit?: number): Promise<FileCommit[]>
  gitRevisionFile(filePath: string, commit: string, pathAtCommit: string): Promise<string>
  gitDropRevisionFile(path: string): Promise<void>
  gitFileChanges(filePath: string): Promise<{ path: string; status: string }[]>
  gitDiscardFile(filePath: string): Promise<{ backup: { orig: string; copy: string }[] }>
  gitUndoDiscard(backup: { orig: string; copy: string }[]): Promise<void>
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
  gitPushForceWithLease(filePath: string, remote?: string): Promise<void>
  gitPull(filePath: string, remote?: string): Promise<{ conflict: boolean }>
  gitFetch(filePath: string, remote?: string): Promise<void>
  gitIsReachable(filePath: string, remote?: string): Promise<boolean>
  gitChangedUpstream(filePath: string, remote?: string): Promise<GitCommit[]>
  gitDiscardAll(filePath: string): Promise<void>
  gitAddRemote(filePath: string, name: string, url: string): Promise<void>
  lockAcquire(filePath: string): Promise<LockAcquireResult>
  lockRelease(filePath: string): Promise<void>
  lockCurrent(filePath: string): Promise<LockInfo | null>
  onLockPublishProblem(
    fn: (filePath: string, r: { status: 'held'; lock: LockInfo } | { status: 'unreachable' }) => void
  ): () => void
  gitWatchCheckOne(filePath: string): Promise<UpstreamChange | null>
  gitWatchCheckMany(filePaths: string[]): Promise<UpstreamChange[]>
  gitWatchFetchUpstreamVersion(filePath: string): Promise<{ path: string; commit: string }>
  asmPinRead(asmPath: string): Promise<AsmPinFile>
  asmPinSet(asmPath: string, componentId: string, pin: ComponentPin | null): Promise<void>
  asmPinResolve(pin: ComponentPin): Promise<ResolvedPin>
  asmPinResolveRefToCommit(filePath: string, ref: string): Promise<string>
  asmPinCurrentCommit(filePath: string): Promise<string | null>
  exportPdf(html: string, outPath: string): Promise<{ path: string }>
  writeText(text: string, outPath: string): Promise<{ path: string }>
  readImage(path: string): Promise<string>
  readBytes(path: string): Promise<Uint8Array>
  realpath(path: string): Promise<string | null>
  copyInto(src: string, destDir: string, name: string): Promise<{ path: string }>
  mkdir(dir: string): Promise<{ dir: string }>
  touch(path: string): Promise<{ path: string }>
  move(src: string, dest: string): Promise<{ src: string; dest: string }>
  softDelete(path: string): Promise<{ held: string }>
  restore(held: string, path: string): Promise<{ restored: string }>
  trash(path: string): Promise<{ trashed: string }>
  openPath(path: string): Promise<{ opened: string }>
  findKicadProject(dir: string): Promise<{
    pcbPath: string | null
    proPath: string | null
    schPath: string | null
  }>
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
  mcmasterFetchStepHeadless(mfgPn: string): Promise<string>
  mcmasterScrapeCurrentPart(): Promise<Record<string, unknown> | null>
}

interface Window {
  cad: CadBridge
}
