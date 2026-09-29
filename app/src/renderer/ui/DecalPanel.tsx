import { useCallback, useEffect, useState, type KeyboardEvent } from 'react'
import { decalApi, DECAL_IMAGE_FILTERS, type DecalRecord } from '../decals'

const basename = (p: string): string => p.split(/[\\/]/).pop() ?? p
const num = (s: string, d: number): number => {
  const n = Number(s)
  return Number.isFinite(n) ? n : d
}

async function imageAspect(path: string): Promise<number | null> {
  try {
    const img = new Image()
    img.src = await window.cad.readImage(path)
    await img.decode()
    return img.naturalWidth > 0 ? img.naturalHeight / img.naturalWidth : null
  } catch {
    return null
  }
}

/**
 * Insert Decal: put a PNG/JPG at true mm size on the selected planar face,
 * then edit (size / offset / rotation / move to another face) or remove the
 * part's decals. Same floating-panel shape as Appearance; every change goes
 * straight to the sidecar and `onChanged` marks the tab dirty + refreshes.
 */
export function DecalPanel({
  face,
  onChanged,
  onClose
}: {
  /** the first selected face, if any */
  face: { bodyId: string; sub: string; label?: string } | null
  onChanged: () => void
  onClose: () => void
}): JSX.Element {
  const [decals, setDecals] = useState<DecalRecord[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [newImage, setNewImage] = useState<string | null>(null)
  const [newAspect, setNewAspect] = useState<number | null>(null)
  const [newWidth, setNewWidth] = useState('50')

  const reload = useCallback(() => {
    void decalApi
      .list()
      .then((r) => setDecals(r.decals))
      .catch((e) => setErr((e as Error).message))
  }, [])
  useEffect(reload, [reload])

  const run = async (f: () => Promise<{ decals: DecalRecord[] }>): Promise<boolean> => {
    setErr(null)
    try {
      const r = await f()
      setDecals(r.decals)
      onChanged()
      return true
    } catch (e) {
      setErr((e as Error).message)
      return false
    }
  }

  const pickImage = async (): Promise<string | null> => {
    const p = await window.cad.openDialog(DECAL_IMAGE_FILTERS)
    return p || null
  }

  const w = num(newWidth, 0)
  const h = newAspect != null && w > 0 ? w * newAspect : null

  return (
    <div className="materials-panel appearance-panel">
      <div className="materials-head">
        <span>DECALS</span>
        <button onClick={onClose} title="Close">
          &times;
        </button>
      </div>
      <div className="appr-body">
        <div className="appr-section">
          <h4>Insert decal</h4>
          <p className="appr-hint">
            {face
              ? `On ${face.label ?? face.bodyId} / ${face.sub}`
              : 'Select a flat face on the part, then choose the image.'}
          </p>
          <div className="appr-fields">
            <label>
              <span>Image</span>
              <b style={{ flex: 1, textAlign: 'left', fontWeight: 400 }}>
                {newImage ? basename(newImage) : 'none'}
              </b>
              <button
                className="materials-clear"
                onClick={async () => {
                  const p = await pickImage()
                  if (!p) return
                  setNewImage(p)
                  setNewAspect(await imageAspect(p))
                }}
              >
                Choose...
              </button>
            </label>
            <label>
              <span>Width (mm)</span>
              <input type="number" min={0} step={0.5} value={newWidth} onChange={(e) => setNewWidth(e.target.value)} />
            </label>
            <label>
              <span>Height (mm)</span>
              <b style={{ flex: 1, textAlign: 'left', fontWeight: 400 }}>
                {h != null ? `${h.toFixed(2)} (from the image aspect)` : '-'}
              </b>
            </label>
            <button
              className="materials-save-btn"
              disabled={!face || !newImage || !(w > 0)}
              onClick={async () => {
                if (!face || !newImage) return
                const ok = await run(() => decalApi.add(face.bodyId, face.sub, newImage, w, h))
                if (ok) setNewImage(null)
              }}
            >
              Place on face
            </button>
          </div>
        </div>

        <div className="appr-section">
          <h4>Decals on this part ({decals.length})</h4>
          {!decals.length && <p className="appr-hint">None yet.</p>}
          {decals.map((d) => (
            <DecalRow
              key={d.id}
              d={d}
              face={face}
              onUpdate={(patch) => run(() => decalApi.update(d.id, patch))}
              onReplaceImage={async () => {
                const p = await pickImage()
                if (p) await run(() => decalApi.update(d.id, { image: p, widthMm: d.widthMm, keepAspect: true }))
              }}
              onRemove={() => run(() => decalApi.remove(d.id))}
            />
          ))}
        </div>
      </div>
      {err && <div className="materials-err">{err}</div>}
    </div>
  )
}

function DecalRow({
  d,
  face,
  onUpdate,
  onReplaceImage,
  onRemove
}: {
  d: DecalRecord
  face: { bodyId: string; sub: string } | null
  onUpdate: (patch: Parameters<typeof decalApi.update>[1]) => Promise<boolean>
  onReplaceImage: () => Promise<void>
  onRemove: () => Promise<boolean>
}): JSX.Element {
  const [wv, setW] = useState(String(d.widthMm))
  const [hv, setH] = useState(String(d.heightMm))
  const [ou, setOu] = useState(String(d.offsetMm[0]))
  const [ov, setOv] = useState(String(d.offsetMm[1]))
  const [rot, setRot] = useState(String(d.rotationDeg))
  const [lock, setLock] = useState(true)
  // server state changed (another edit, reload) - show it
  useEffect(() => {
    setW(String(+d.widthMm.toFixed(3)))
    setH(String(+d.heightMm.toFixed(3)))
    setOu(String(d.offsetMm[0]))
    setOv(String(d.offsetMm[1]))
    setRot(String(d.rotationDeg))
  }, [d.widthMm, d.heightMm, d.offsetMm, d.rotationDeg])

  const aspect = d.widthMm > 0 ? d.heightMm / d.widthMm : 1
  const commit = (): void => {
    const width = num(wv, d.widthMm)
    const height = lock ? width * aspect : num(hv, d.heightMm)
    const offsetMm: [number, number] = [num(ou, 0), num(ov, 0)]
    const rotationDeg = num(rot, 0)
    const same = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9
    if (
      same(width, d.widthMm) &&
      same(height, d.heightMm) &&
      same(offsetMm[0], d.offsetMm[0]) &&
      same(offsetMm[1], d.offsetMm[1]) &&
      same(rotationDeg, d.rotationDeg)
    )
      return
    if (!(width > 0) || !(height > 0)) return
    void onUpdate({
      widthMm: width,
      heightMm: height,
      offsetMm,
      rotationDeg
    })
  }
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Enter') commit()
  }

  return (
    <fieldset className="appr-fields" style={{ borderTop: '1px solid var(--line-soft)', padding: '6px 0' }}>
      <label>
        <span>
          {d.id} - {d.imageName ?? basename(d.image)}
        </span>
        <b style={{ flex: 1, textAlign: 'left', fontWeight: 400, color: d.missing ? '#e0774a' : undefined }}>
          {d.object} / {d.resolvedFace ?? d.face}
          {d.missing ? ' (face not found)' : ''}
        </b>
      </label>
      <label className="appr-wh">
        <span>Size W x H (mm)</span>
        <input type="number" min={0} step={0.5} value={wv} onChange={(e) => setW(e.target.value)} onBlur={commit} onKeyDown={onKey} />
        <input
          type="number"
          min={0}
          step={0.5}
          value={lock ? String(+(num(wv, d.widthMm) * aspect).toFixed(3)) : hv}
          disabled={lock}
          onChange={(e) => setH(e.target.value)}
          onBlur={commit}
          onKeyDown={onKey}
        />
      </label>
      <label className="appr-check">
        <input type="checkbox" checked={lock} onChange={(e) => setLock(e.target.checked)} />
        <span>Keep aspect ratio</span>
      </label>
      <label className="appr-wh">
        <span>Offset U / V (mm)</span>
        <input type="number" step={0.5} value={ou} onChange={(e) => setOu(e.target.value)} onBlur={commit} onKeyDown={onKey} />
        <input type="number" step={0.5} value={ov} onChange={(e) => setOv(e.target.value)} onBlur={commit} onKeyDown={onKey} />
      </label>
      <label>
        <span>Rotation (deg)</span>
        <input type="number" step={5} value={rot} onChange={(e) => setRot(e.target.value)} onBlur={commit} onKeyDown={onKey} />
      </label>
      <div className="appr-quickops" style={{ display: 'flex', gap: 6 }}>
        <button className="materials-clear" onClick={() => void onReplaceImage()}>
          Replace image...
        </button>
        <button
          className="materials-clear"
          disabled={!face}
          title={face ? `Move to ${face.sub}` : 'Select a flat face first'}
          onClick={() => face && void onUpdate({ object: face.bodyId, face: face.sub, offsetMm: [0, 0] })}
        >
          Move to selected face
        </button>
        <button className="materials-clear" onClick={() => void onRemove()}>
          Remove
        </button>
      </div>
    </fieldset>
  )
}
