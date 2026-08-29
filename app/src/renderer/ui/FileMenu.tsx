import { useState } from 'react'

export interface FileActions {
  onNew: () => void
  onOpen: () => void
  onSave: () => void
  onSaveAs: () => void
  onExport: () => void
  onImport: () => void
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
            {item('Import STEP…', actions.onImport)}
            {item('Export (STEP / STL)…', actions.onExport)}
          </div>
        </>
      )}
    </div>
  )
}
