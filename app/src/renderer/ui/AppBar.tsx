import { FileMenu, type FileActions } from './FileMenu'

/** Thin application bar: Data Panel toggle (the "waffle"), file menu, quick actions, history toggle. */
export function AppBar({
  onToggleData,
  dataOpen,
  onToggleGit,
  gitOpen,
  docName,
  dirty,
  fileActions,
  history
}: {
  onToggleData: () => void
  dataOpen: boolean
  onToggleGit: () => void
  gitOpen: boolean
  docName: string
  dirty: boolean
  fileActions: FileActions
  history: { onUndo: () => void; onRedo: () => void; canUndo: boolean; canRedo: boolean }
}): JSX.Element {
  return (
    <div className="appbar">
      <button
        className={dataOpen ? 'waffle active' : 'waffle'}
        title="Show Data Panel"
        onClick={onToggleData}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          {[0, 6, 12].flatMap((y) =>
            [0, 6, 12].map((x) => <rect key={`${x}-${y}`} x={x} y={y} width="4" height="4" rx="1" />)
          )}
        </svg>
      </button>

      <FileMenu docName={docName + (dirty ? ' *' : '')} actions={fileActions} />

      <div className="qat">
        <button className="qat-btn" title="Save (Ctrl+S)" onClick={fileActions.onSave}>
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.3">
            <path d="M2 2 h9 l2 2 v9 h-11 z" />
            <path d="M4.5 2 v3.5 h6 V2 M4.5 13 v-4 h6 v4" />
          </svg>
        </button>
        <button
          className="qat-btn"
          title="Undo (Ctrl+Z)"
          disabled={!history.canUndo}
          onClick={history.onUndo}
        >
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.3">
            <path d="M5 4 L2 7 L5 10" />
            <path d="M2 7 h7 a3.5 3.5 0 0 1 0 7 H6" />
          </svg>
        </button>
        <button
          className="qat-btn"
          title="Redo (Ctrl+Shift+Z)"
          disabled={!history.canRedo}
          onClick={history.onRedo}
        >
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.3">
            <path d="M10 4 L13 7 L10 10" />
            <path d="M13 7 H6 a3.5 3.5 0 0 0 0 7 H9" />
          </svg>
        </button>
      </div>

      <div className="appbar-spacer" />

      <button
        className={gitOpen ? 'appbar-gitbtn active' : 'appbar-gitbtn'}
        title="History (Git)"
        onClick={onToggleGit}
      >
        ⎇ History
      </button>
    </div>
  )
}
