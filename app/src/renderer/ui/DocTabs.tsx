/** Open-design tabs, left-aligned above the canvas (Fusion-style). */
export interface DocTab {
  id: string
  name: string
  dirty: boolean
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
