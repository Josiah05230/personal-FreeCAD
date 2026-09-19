import { useEffect, useRef, useState } from 'react'
import { api } from '../rpc'

/**
 * "Insert McMaster-Carr Component" - F360-style embedded browser: a real
 * Chromium view (WebContentsView in the main process, positioned to track
 * this panel's content slot every frame) renders mcmaster.com directly, so
 * the user searches/browses their actual site. Two actions read off
 * whatever page is currently loaded in that view:
 *  - "Import CAD" clicks MMC's own CAD-download control and feeds the
 *    resulting STEP file into the model via the normal importModel path.
 *  - the full page (spec table, price, description, images) is scraped and
 *    stamped onto the imported object as McMaster metadata.
 * The slot div itself renders nothing - it's just a positioning reference,
 * the actual pixels come from the native view layered on top of it by main.
 */
export function McMasterPanel({
  onClose,
  onImported
}: {
  onClose: () => void
  onImported: () => void
}): JSX.Element {
  const slotRef = useRef<HTMLDivElement>(null)
  const [url, setUrl] = useState('https://www.mcmaster.com/')
  const [urlDraft, setUrlDraft] = useState('')
  const [editingUrl, setEditingUrl] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [lastImported, setLastImported] = useState<{ partNumber: string; title?: string } | null>(
    null
  )

  useEffect(() => {
    let raf = 0
    const sync = (): void => {
      const el = slotRef.current
      if (el) {
        const r = el.getBoundingClientRect()
        void window.cad.mcmasterSetBounds({
          x: Math.round(r.x),
          y: Math.round(r.y),
          width: Math.round(r.width),
          height: Math.round(r.height)
        })
      }
      raf = requestAnimationFrame(sync)
    }
    const el = slotRef.current
    if (el) {
      const r = el.getBoundingClientRect()
      void window.cad.mcmasterShow({
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height)
      })
    }
    raf = requestAnimationFrame(sync)
    const poll = window.setInterval(() => {
      void window.cad.mcmasterCurrentUrl().then(setUrl)
    }, 1000)
    return () => {
      cancelAnimationFrame(raf)
      window.clearInterval(poll)
      void window.cad.mcmasterHide()
    }
  }, [])

  const isProductPage = /mcmaster\.com\/[A-Za-z0-9]+\/?/.test(url)

  const doImport = async (): Promise<void> => {
    setErr(null)
    setBusy('Downloading CAD model...')
    try {
      const path = await window.cad.mcmasterDownloadCad('STEP')
      setBusy('Scraping part data...')
      const meta = await window.cad.mcmasterScrapeCurrentPart()
      setBusy('Importing into design...')
      const r = await api.importModel(path)
      if (r.imported.length && meta) {
        const partNumber = (meta.partNumber as string) ?? 'unknown'
        for (const id of r.imported) {
          await api.tagMcMaster(id, partNumber, meta)
        }
        setLastImported({ partNumber, title: meta.title as string | undefined })
      }
      onImported()
      setBusy(null)
    } catch (e) {
      setErr((e as Error).message)
      setBusy(null)
    }
  }

  return (
    <div className="mcmaster-panel">
      <div className="mcmaster-head">
        <button onClick={() => void window.cad.mcmasterGoBack()} title="Back">
          &#8592;
        </button>
        <button onClick={() => void window.cad.mcmasterGoForward()} title="Forward">
          &#8594;
        </button>
        <button onClick={() => void window.cad.mcmasterGoHome()} title="Home">
          &#8962;
        </button>
        {editingUrl ? (
          <input
            className="mcmaster-url-input"
            autoFocus
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
            onBlur={() => setEditingUrl(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && urlDraft.trim()) {
                void window.cad.mcmasterNavigate(urlDraft.trim())
                setEditingUrl(false)
              } else if (e.key === 'Escape') {
                setEditingUrl(false)
              }
            }}
            placeholder="Search McMaster-Carr or enter a URL"
          />
        ) : (
          <span
            className="mcmaster-url"
            title={`${url}  (click to search or enter a URL)`}
            onClick={() => {
              setUrlDraft('')
              setEditingUrl(true)
            }}
          >
            {url}
          </span>
        )}
        <button
          className="mcmaster-import"
          disabled={!isProductPage || !!busy}
          onClick={() => void doImport()}
          title={isProductPage ? 'Download the CAD model and insert it into the design' : 'Open a part page first'}
        >
          Import CAD
        </button>
        <button onClick={onClose} title="Close">
          &times;
        </button>
      </div>
      {(busy || err || lastImported) && (
        <div className="mcmaster-status">
          {busy && <span>{busy}</span>}
          {err && <span className="mcmaster-err">{err}</span>}
          {!busy && !err && lastImported && (
            <span>
              Imported {lastImported.partNumber}
              {lastImported.title ? ` - ${lastImported.title}` : ''}
            </span>
          )}
        </div>
      )}
      <div className="mcmaster-slot" ref={slotRef} />
    </div>
  )
}
