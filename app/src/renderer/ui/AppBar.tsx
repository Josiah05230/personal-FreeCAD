/** Thin application bar: Data Panel toggle (the "waffle"), file name, quick actions. */
export function AppBar({
  onToggleData,
  dataOpen,
  docName
}: {
  onToggleData: () => void
  dataOpen: boolean
  docName: string
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

      <div className="appbar-file">
        <span className="appbar-docname">{docName}</span>
        <span className="appbar-caret">▾</span>
      </div>

      <div className="qat">
        <button className="qat-btn" title="Save" disabled>
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.3">
            <path d="M2 2 h9 l2 2 v9 h-11 z" />
            <path d="M4.5 2 v3.5 h6 V2 M4.5 13 v-4 h6 v4" />
          </svg>
        </button>
        <button className="qat-btn" title="Undo" disabled>
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.3">
            <path d="M5 4 L2 7 L5 10" />
            <path d="M2 7 h7 a3.5 3.5 0 0 1 0 7 H6" />
          </svg>
        </button>
        <button className="qat-btn" title="Redo" disabled>
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.3">
            <path d="M10 4 L13 7 L10 10" />
            <path d="M13 7 H6 a3.5 3.5 0 0 0 0 7 H9" />
          </svg>
        </button>
      </div>

      <div className="appbar-spacer" />
    </div>
  )
}
