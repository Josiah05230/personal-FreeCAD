/**
 * App-wide undo/redo: Ctrl+Z undoes whatever was done last, anywhere.
 *
 * One ordered history holds two kinds of steps:
 *  - app actions (Data Panel delete/rename/move/new folder, hide folder,
 *    default folder, Company Directories edits, ...), each carrying its own
 *    undo/redo, pushed by whatever UI performed it;
 *  - document steps: one marker per FreeCAD undo step, detected from the
 *    document's UndoCount (noteDocState) - undoing one calls the engine's
 *    undo, so the two kinds interleave by recency.
 * The drawing sheet and sketch mode keep their own local stacks while open.
 */
export interface AppAction {
  label: string
  undo: () => Promise<void>
  redo: () => Promise<void>
  /** consecutive actions with the same key within COALESCE_MS merge into one
   *  step (a slider drag): the first one's undo, the latest one's redo */
  key?: string
}

const COALESCE_MS = 1000
let lastPush = { key: '', at: 0 }

export type HistoryEntry = { kind: 'app'; action: AppAction } | { kind: 'doc' }

const MAX = 200
const undoStack: HistoryEntry[] = []
const redoStack: HistoryEntry[] = []
const listeners = new Set<() => void>()
let doc = { path: null as string | null, undoCount: 0, redoCount: 0 }

function emit(): void {
  for (const l of listeners) l()
}

export function subscribeHistory(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Record an app action that has just been done. */
export function pushAppAction(action: AppAction): void {
  const now = Date.now()
  const top = undoStack[undoStack.length - 1]
  if (
    action.key &&
    top?.kind === 'app' &&
    top.action.key === action.key &&
    lastPush.key === action.key &&
    now - lastPush.at < COALESCE_MS
  ) {
    top.action = { ...top.action, redo: action.redo, label: action.label }
    lastPush = { key: action.key, at: now }
    redoStack.length = 0
    emit()
    return
  }
  lastPush = { key: action.key ?? '', at: now }
  undoStack.push({ kind: 'app', action })
  if (undoStack.length > MAX) undoStack.shift()
  redoStack.length = 0
  emit()
}

/** Tell the history what the engine reports after any document change.
 *  `via` = this state came from our own undo/redo (already accounted for). */
export function noteDocState(
  path: string | null,
  undoCount: number,
  redoCount: number,
  via?: 'undo' | 'redo'
): void {
  if (path !== doc.path) {
    // another document is active now: the old one's FreeCAD history went
    // with it (the engine holds one document), so its markers are dead
    const keep = (e: HistoryEntry): boolean => e.kind === 'app'
    const u = undoStack.filter(keep)
    const r = redoStack.filter(keep)
    undoStack.length = 0
    undoStack.push(...u)
    redoStack.length = 0
    redoStack.push(...r)
    doc = { path, undoCount, redoCount }
    emit()
    return
  }
  if (!via) {
    const d = undoCount - doc.undoCount
    if (d > 0) {
      for (let i = 0; i < d; i++) undoStack.push({ kind: 'doc' })
      if (undoStack.length > MAX) undoStack.splice(0, undoStack.length - MAX)
      // a fresh document edit ends any redo chain
      if (redoCount === 0) redoStack.length = 0
    } else if (d < 0) {
      // the engine dropped steps on its own (reload, cleared history):
      // forget that many of the newest document markers
      let drop = -d
      for (let i = undoStack.length - 1; i >= 0 && drop > 0; i--) {
        if (undoStack[i].kind === 'doc') {
          undoStack.splice(i, 1)
          drop--
        }
      }
    }
  }
  doc = { path, undoCount, redoCount }
  emit()
}

export function peekUndo(): HistoryEntry | undefined {
  return undoStack[undoStack.length - 1]
}
export function peekRedo(): HistoryEntry | undefined {
  return redoStack[redoStack.length - 1]
}

/** Move the newest entry across after it has been undone / redone. */
export function markUndone(): void {
  const e = undoStack.pop()
  if (e) redoStack.push(e)
  emit()
}
export function markRedone(): void {
  const e = redoStack.pop()
  if (e) undoStack.push(e)
  emit()
}
/** Drop the newest undo entry (its undo failed and can't be retried). */
export function dropUndo(): void {
  undoStack.pop()
  emit()
}
export function dropRedo(): void {
  redoStack.pop()
  emit()
}

export function historySizes(): { undo: number; redo: number } {
  return { undo: undoStack.length, redo: redoStack.length }
}
