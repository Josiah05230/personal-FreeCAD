import { useEffect, useState } from 'react'
import { api, type Selection } from '../rpc'

export type OpKind =
  | 'extrude'
  | 'revolve'
  | 'loft'
  | 'draft'
  | 'combine'
  | 'fillet'
  | 'chamfer'
  | 'shell'
  | 'hole'
  | 'patternLinear'
  | 'patternCircular'
  | 'mirror'
  | 'datumPlane'
  | 'splitBody'
  | 'baseFlange'

interface FieldSpec {
  key: string
  label: string
  type: 'number' | 'select' | 'checkbox'
  default: number | string | boolean
  min?: number
  step?: number
  options?: string[]
}

interface OpSpec {
  title: string
  needs: 'none' | 'edges' | 'faces' | 'sketch' | 'sketches2' | 'planeFace' | 'plane' | 'axis'
  fields: FieldSpec[]
  hint?: string
}

const SPECS: Record<OpKind, OpSpec> = {
  extrude: {
    title: 'Extrude',
    needs: 'sketch',
    fields: [
      { key: 'length', label: 'Distance', type: 'number', default: 10, step: 1 },
      { key: 'cut', label: 'Cut', type: 'checkbox', default: false },
      { key: 'midplane', label: 'Symmetric', type: 'checkbox', default: false },
      { key: 'reversed', label: 'Flip', type: 'checkbox', default: false }
    ]
  },
  revolve: {
    title: 'Revolve',
    needs: 'sketch',
    hint: 'Axis: also select an edge / sketch line / datum axis (else the sketch’s vertical)',
    fields: [
      { key: 'angle', label: 'Angle', type: 'number', default: 360, step: 15 },
      { key: 'cut', label: 'Cut', type: 'checkbox', default: false }
    ]
  },
  loft: {
    title: 'Loft',
    needs: 'sketches2',
    fields: [{ key: 'cut', label: 'Cut', type: 'checkbox', default: false }]
  },
  draft: {
    title: 'Draft',
    needs: 'faces',
    fields: [{ key: 'angle', label: 'Angle', type: 'number', default: 3, step: 1 }]
  },
  combine: {
    title: 'Combine',
    needs: 'none',
    fields: [
      {
        key: 'op',
        label: 'Operation',
        type: 'select',
        default: 'Fuse',
        options: ['Fuse', 'Cut', 'Common']
      }
    ]
  },
  patternCircular: {
    title: 'Circular Pattern',
    needs: 'axis',
    fields: [
      { key: 'count', label: 'Quantity', type: 'number', default: 4, min: 2, step: 1 },
      { key: 'angle', label: 'Total angle', type: 'number', default: 360, step: 15 }
    ]
  },
  fillet: {
    title: 'Fillet',
    needs: 'edges',
    fields: [{ key: 'radius', label: 'Radius', type: 'number', default: 2, min: 0.01, step: 0.5 }]
  },
  chamfer: {
    title: 'Chamfer',
    needs: 'edges',
    fields: [{ key: 'size', label: 'Distance', type: 'number', default: 2, min: 0.01, step: 0.5 }]
  },
  shell: {
    title: 'Shell',
    needs: 'faces',
    fields: [
      { key: 'thickness', label: 'Thickness', type: 'number', default: 2, min: 0.01, step: 0.5 }
    ]
  },
  hole: {
    title: 'Hole',
    needs: 'planeFace',
    fields: [
      { key: 'diameter', label: 'Diameter', type: 'number', default: 6, min: 0.01, step: 0.5 },
      { key: 'depth', label: 'Depth', type: 'number', default: 10, min: 0.01, step: 1 },
      { key: 'throughAll', label: 'Through all', type: 'checkbox', default: false }
    ]
  },
  patternLinear: {
    title: 'Rectangular Pattern',
    needs: 'none',
    fields: [
      { key: 'axis', label: 'Axis', type: 'select', default: 'X', options: ['X', 'Y', 'Z'] },
      { key: 'count', label: 'Quantity', type: 'number', default: 3, min: 2, step: 1 },
      { key: 'spacing', label: 'Spacing', type: 'number', default: 20, min: 0.01, step: 1 }
    ]
  },
  mirror: {
    title: 'Mirror',
    needs: 'plane',
    fields: []
  },
  datumPlane: {
    title: 'Offset Plane',
    needs: 'plane',
    fields: [{ key: 'offset', label: 'Offset', type: 'number', default: 10, step: 1 }]
  },
  splitBody: {
    title: 'Split Body',
    needs: 'plane',
    fields: []
  },
  baseFlange: {
    title: 'Base Flange',
    needs: 'sketch',
    fields: [
      { key: 'thickness', label: 'Thickness', type: 'number', default: 1.5, min: 0.1, step: 0.5 }
    ]
  }
}

export type OpValues = Record<string, number | string | boolean>

export function OperationDialog({
  kind,
  selection,
  onApply,
  onCancel
}: {
  kind: OpKind | null
  selection: Selection[]
  onApply: (kind: OpKind, values: OpValues) => void
  onCancel: () => void
}): JSX.Element | null {
  const spec = kind ? SPECS[kind] : null
  const [values, setValues] = useState<OpValues>({})
  const [preview, setPreview] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (spec) {
      const init: OpValues = {}
      for (const f of spec.fields) init[f.key] = f.default
      setValues(init)
      setPreview({})
    }
  }, [kind]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!kind || !spec) return null

  const numberFields = spec.fields.filter((f) => f.type === 'number')
  const kindOf = (key: string): 'length' | 'angle' => (key === 'angle' ? 'angle' : 'length')

  const evalField = async (key: string): Promise<void> => {
    const raw = String(values[key] ?? '')
    if (!raw.trim() || !isNaN(Number(raw))) {
      setPreview((p) => ({ ...p, [key]: '' }))
      return
    }
    try {
      const r = await api.exprEval(raw, kindOf(key))
      setPreview((p) => ({ ...p, [key]: `= ${Number(r.value.toFixed(4))}` }))
    } catch (e) {
      setPreview((p) => ({ ...p, [key]: (e as Error).message }))
    }
  }

  const submit = async (): Promise<void> => {
    setBusy(true)
    try {
      const out: OpValues = { ...values }
      for (const f of numberFields) {
        const raw = String(values[f.key] ?? f.default)
        out[f.key] = isNaN(Number(raw))
          ? (await api.exprEval(raw, kindOf(f.key))).value
          : Number(raw)
      }
      onApply(kind, out)
    } catch (e) {
      window.alert((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const edges = selection.filter((s) => s.kind === 'edge')
  const faces = selection.filter((s) => s.kind === 'face')
  const sketchesSel = selection.filter((s) => s.kind === 'sketch')
  const planeSel = selection.filter((s) => s.kind === 'plane' || s.kind === 'face')
  const axisSel = selection.filter((s) => s.kind === 'plane' || s.kind === 'edge' || s.kind === 'face')
  const needMsg =
    spec.needs === 'edges'
      ? `${edges.length} edge${edges.length === 1 ? '' : 's'} selected`
      : spec.needs === 'faces' || spec.needs === 'planeFace'
        ? `${faces.length} face${faces.length === 1 ? '' : 's'} selected`
        : spec.needs === 'sketch'
          ? sketchesSel.length
            ? 'sketch selected'
            : 'select a sketch'
          : spec.needs === 'sketches2'
            ? `${sketchesSel.length} sketches selected (need 2+)`
            : spec.needs === 'plane'
              ? planeSel.length
                ? 'plane selected'
                : 'click a plane (tree) or a flat face'
              : spec.needs === 'axis'
                ? axisSel.length
                  ? 'axis selected'
                  : 'click an axis / edge / plane / face'
                : null

  const ready =
    spec.needs === 'none' ||
    (spec.needs === 'edges' && edges.length > 0) ||
    (spec.needs === 'faces' && faces.length > 0) ||
    (spec.needs === 'planeFace' && faces.length === 1) ||
    (spec.needs === 'sketch' && sketchesSel.length === 1) ||
    (spec.needs === 'sketches2' && sketchesSel.length >= 2) ||
    (spec.needs === 'plane' && planeSel.length === 1) ||
    (spec.needs === 'axis' && axisSel.length === 1)

  return (
    <div className="opdlg">
      <div className="opdlg-title">{spec.title}</div>
      {needMsg && (
        <div className={ready ? 'opdlg-need ok' : 'opdlg-need'}>{needMsg}</div>
      )}
      {spec.hint && <div className="opdlg-hint">{spec.hint}</div>}
      <div className="opdlg-body">
        {spec.fields.map((f) => (
          <label key={f.key} className="opdlg-field">
            <span>{f.label}</span>
            {f.type === 'number' && (
              <input
                type="text"
                inputMode="text"
                value={String(values[f.key] ?? f.default)}
                title="number or expression, e.g. 15in + 2.4mm, width/2"
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                onBlur={() => void evalField(f.key)}
              />
            )}
            {f.type === 'number' && preview[f.key] && (
              <span className="opdlg-eval">{preview[f.key]}</span>
            )}
            {f.type === 'checkbox' && (
              <input
                type="checkbox"
                checked={Boolean(values[f.key] ?? f.default)}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.checked }))}
              />
            )}
            {f.type === 'select' && (
              <select
                value={String(values[f.key] ?? f.default)}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              >
                {f.options!.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            )}
          </label>
        ))}
      </div>
      <div className="opdlg-actions">
        <button className="opdlg-cancel" onClick={onCancel}>
          Cancel
        </button>
        <button className="opdlg-ok" disabled={!ready || busy} onClick={() => void submit()}>
          {busy ? '…' : 'OK'}
        </button>
      </div>
    </div>
  )
}
