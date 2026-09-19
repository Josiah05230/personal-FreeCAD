/** Open-design tabs, left-aligned above the canvas (Fusion-style).
 *
 *  The FreeCAD sidecar holds exactly one document at a time - these tabs are
 *  a history of recently-opened documents, not simultaneously-live ones like
 *  a browser or IDE. `path` is what makes clicking an inactive tab actually
 *  reopen that file (see App.tsx's onActivate) instead of just relabelling
 *  the title bar while the sidecar keeps editing whatever was open before -
 *  a real bug found live: the title bar and active-tab highlight said one
 *  document, the status bar and every panel said another (user feedback,
 *  2026-09-19). `null` only for a brand-new "Untitled" tab that was never
 *  saved, which can't be reopened once you've navigated away from it. */
export interface DocTab {
  id: string
  name: string
  dirty: boolean
  path: string | null
}

export function DocTabs({
  tabs,
  activeId,
  onActivate,
  onClose,
  onNew
}: {
  tabs: DocTab[]
  activeId: string
  onActivate: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
}): JSX.Element {
  return (
    <div className="doctabs">
      {tabs.map((t) => (
        <div
          key={t.id}
          className={t.id === activeId ? 'doctab active' : 'doctab'}
          onClick={() => onActivate(t.id)}
        >
          <span className="doctab-name">
            {t.name}
            {t.dirty ? ' *' : ''}
          </span>
          <span
            className="doctab-close"
            onClick={(e) => {
              e.stopPropagation()
              onClose(t.id)
            }}
          >
            ×
          </span>
        </div>
      ))}
      <button className="doctab-new" title="New design" onClick={onNew}>
        +
      </button>
    </div>
  )
}
