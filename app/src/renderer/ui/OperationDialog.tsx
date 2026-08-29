import { useEffect, useState } from 'react'
import type { Selection } from '../rpc'

export type OpKind =
  | 'box'
  | 'cylinder'
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
  needs: 'none' | 'edges' | 'faces' | 'sketch' | 'sketches2' | 'planeFace'
  fields: FieldSpec[]
}

const SPECS: Record<OpKind, OpSpec> = {
  box: {
    title: 'Box',
    needs: 'none',
    fields: [
      { key: 'width', label: 'Width', type: 'number', default: 40, min: 0.01, step: 1 },
      { key: 'depth', label: 'Depth', type: 'number', default: 40, min: 0.01, step: 1 },
      { key: 'height', label: 'Height', type: 'number', default: 40, min: 0.01, step: 1 }
    ]
  },
  cylinder: {
    title: 'Cylinder',
    needs: 'none',
    fields: [
      { key: 'diameter', label: 'Diameter', type: 'number', default: 40, min: 0.01, step: 1 },
      { key: 'height', label: 'Height', type: 'number', default: 40, min: 0.01, step: 1 }
    ]
  },
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
    fields: [
      { key: 'angle', label: 'Angle', type: 'number', default: 360, step: 15 },
      { key: 'axis', label: 'Axis', type: 'select', default: 'V', options: ['V', 'H'] },
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
    needs: 'none',
    fields: [
      { key: 'axisPlane', label: 'Around', type: 'select', default: 'XY', options: ['XY', 'XZ', 'YZ'] },
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
    needs: 'none',
    fields: [
      { key: 'plane', label: 'Mirror plane', type: 'select', default: 'YZ', options: ['XY', 'XZ', 'YZ'] }
    ]
  },
  datumPlane: {
    title: 'Offset Plane',
    needs: 'none',
    fields: [
      { key: 'basePlane', label: 'Base', type: 'select', default: 'XY', options: ['XY', 'XZ', 'YZ'] },
      { key: 'offset', label: 'Offset', type: 'number', default: 10, step: 1 }
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

  useEffect(() => {
    if (spec) {
      const init: OpValues = {}
      for (const f of spec.fields) init[f.key] = f.default
      setValues(init)
    }
  }, [kind]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!kind || !spec) return null

  const edges = selection.filter((s) => s.kind === 'edge')
  const faces = selection.filter((s) => s.kind === 'face')
  const sketchesSel = selection.filter((s) => s.kind === 'sketch')
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
            : null

  const ready =
    spec.needs === 'none' ||
    (spec.needs === 'edges' && edges.length > 0) ||
    (spec.needs === 'faces' && faces.length > 0) ||
    (spec.needs === 'planeFace' && faces.length === 1) ||
    (spec.needs === 'sketch' && sketchesSel.length === 1) ||
    (spec.needs === 'sketches2' && sketchesSel.length >= 2)

  return (
    <div className="opdlg">
      <div className="opdlg-title">{spec.title}</div>
      {needMsg && (
        <div className={ready ? 'opdlg-need ok' : 'opdlg-need'}>{needMsg}</div>
      )}
      <div className="opdlg-body">
        {spec.fields.map((f) => (
          <label key={f.key} className="opdlg-field">
            <span>{f.label}</span>
            {f.type === 'number' && (
              <input
                type="number"
                value={Number(values[f.key] ?? f.default)}
                min={f.min}
                step={f.step}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: Number(e.target.value) }))}
              />
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
        <button
          className="opdlg-ok"
          disabled={!ready}
          onClick={() => onApply(kind, values)}
        >
          OK
        </button>
      </div>
    </div>
  )
}
