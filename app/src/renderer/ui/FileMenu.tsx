import { useEffect, useState } from 'react'

export interface FileActions {
  onNew: () => void
  onOpen: () => void
  onSave: () => void
  onSaveAs: () => void
  onExport: () => void
  onImport: () => void
  onNewPart: () => void
  onNewRevision?: () => void
  onPnBrowser: () => void
  onCompanySettings: () => void
  /** On-demand version of the startup supplier-model sync (App.tsx runs it
   * automatically once on launch too) - lets a user get a just-reserved
   * part's model/drawing without relaunching the whole app. */
  onCheckSupplierModels: () => void
  /** Current document's lifecycle (in_work / active / discontinued), or
   * undefined if it has no PN - only shown/settable when a PN is tagged. */
  currentLifecycle?: string | null
  onSetLifecycle?: (lifecycle: 'in_work' | 'active' | 'discontinued') => void
}

const LIFECYCLE_LABELS: Record<string, string> = {
  in_work: 'In Work',
  active: 'Active',
  discontinued: 'Discontinued'
}
const LIFECYCLE_OPTIONS = ['in_work', 'active', 'discontinued'] as const

/** Lifecycle is a tri-state choice, not a single action, so it gets a small
 * row of inline options instead of the flat item() list above - showing all
 * three at once (current one highlighted) since there's no existing
 * hover-submenu mechanism in this menu to build a nested picker on. */
function LifecycleSubmenu({
  current,
  onSet
}: {
  current: string
  onSet: (lc: 'in_work' | 'active' | 'discontinued') => void
}): JSX.Element {
  return (
    <div className="filemenu-lifecycle">
      <span className="filemenu-lifecycle-label">Lifecycle</span>
      <div className="filemenu-lifecycle-options">
        {LIFECYCLE_OPTIONS.map((lc) => (
          <button
            key={lc}
            className={`filemenu-lifecycle-btn${lc === current ? ' active' : ''}`}
            disabled={lc === current}
            onClick={(e) => {
              e.stopPropagation()
              onSet(lc)
            }}
          >
            {LIFECYCLE_LABELS[lc]}
          </button>
        ))}
      </div>
    </div>
  )
}

/** The dropdown behind the document-name caret in the app bar. */
export function FileMenu({
  docName,
  actions
}: {
  docName: string
  actions: FileActions
}): JSX.Element {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const item = (label: string, fn: () => void, key?: string): JSX.Element => (
    <div
      className="filemenu-item"
      onClick={() => {
        setOpen(false)
        fn()
      }}
    >
      <span>{label}</span>
      {key && <span className="filemenu-key">{key}</span>}
    </div>
  )

  return (
    <div className="filemenu">
      <div className="appbar-file" onClick={() => setOpen((v) => !v)}>
        <span className="appbar-docname">{docName}</span>
        <span className="appbar-caret">▾</span>
      </div>
      {open && (
        <>
          <div className="filemenu-scrim" onClick={() => setOpen(false)} />
          <div className="filemenu-pop">
            {item('New Design', actions.onNew, 'Ctrl+N')}
            {item('Open…', actions.onOpen, 'Ctrl+O')}
            <div className="filemenu-sep" />
            {item('Save', actions.onSave, 'Ctrl+S')}
            {item('Save As…', actions.onSaveAs)}
            <div className="filemenu-sep" />
            {item('New Part…', actions.onNewPart)}
            {actions.onNewRevision && item('New Revision', actions.onNewRevision)}
            {actions.onSetLifecycle && actions.currentLifecycle && (
              <LifecycleSubmenu
                current={actions.currentLifecycle}
                onSet={(lc) => {
                  setOpen(false)
                  actions.onSetLifecycle?.(lc)
                }}
              />
            )}
            {item('Part Number Manager…', actions.onPnBrowser)}
            {item('Check for Supplier Models', actions.onCheckSupplierModels)}
            {item('Company Directories…', actions.onCompanySettings)}
            <div className="filemenu-sep" />
            {item('Import…', actions.onImport)}
            {item('Export…', actions.onExport)}
          </div>
        </>
      )}
    </div>
  )
}
