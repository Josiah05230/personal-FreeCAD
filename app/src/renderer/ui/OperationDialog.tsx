import { useEffect, useState } from 'react'
import { api, type Selection } from '../rpc'

export type OpKind =
  | 'extrude'
  | 'revolve'
  | 'rib'
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
  | 'datumAxis'
  | 'datumPoint'
  | 'moveBody'
  | 'copyBody'
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
  /** render label on its own line, control full-width (for long selects) */
  wide?: boolean
  /** only show this field when the predicate passes for the current values */
  showIf?: (v: Record<string, number | string | boolean>) => boolean
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
    hint: 'Profile: a sketch, or any flat face of the model. For "To object", also select the face to stop at.',
    fields: [
      {
        key: 'operation',
        label: 'Operation',
        type: 'select',
        default: 'Join',
        options: ['New body', 'Join', 'Cut'],
        wide: true
      },
      {
        key: 'mode',
        label: 'Extent',
        type: 'select',
        default: 'Blind',
        options: ['Blind', 'To object'],
        wide: true
      },
      {
        key: 'length',
        label: 'Distance',
        type: 'number',
        default: 10,
        step: 1,
        showIf: (v) => v.mode !== 'To object'
      },
      {
        key: 'offset',
        label: 'Offset',
        type: 'number',
        default: 0,
        step: 1,
        showIf: (v) => v.mode === 'To object'
      },
      {
        key: 'midplane',
        label: 'Symmetric',
        type: 'checkbox',
        default: false,
        showIf: (v) => v.mode !== 'To object'
      },
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
  rib: {
    title: 'Rib',
    needs: 'sketch',
    hint: 'An open profile sketch that reaches the solid; thickened to both sides',
    fields: [
      { key: 'thickness', label: 'Thickness', type: 'number', default: 3, min: 0.01, step: 0.5 },
      { key: 'reversed', label: 'Flip side', type: 'checkbox', default: false }
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
    hint: 'Also select a plane or flat face as the neutral (pull) plane',
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
      },
      { key: 'keepTools', label: 'Keep tool bodies', type: 'checkbox', default: false }
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
    hint: 'Select the face(s) to remove (open the shell); the rest is hollowed to the thickness.',
    fields: [
      { key: 'thickness', label: 'Thickness', type: 'number', default: 2, min: 0.01, step: 0.5 }
    ]
  },
  hole: {
    title: 'Hole',
    needs: 'planeFace',
    hint: 'Click the face where the hole goes (click again to move the point), then set the size.',
    fields: [
      { key: 'diameter', label: 'Diameter', type: 'number', default: 6, min: 0.01, step: 0.5 },
      { key: 'depth', label: 'Depth', type: 'number', default: 10, min: 0.01, step: 1 },
      { key: 'throughAll', label: 'Through all', type: 'checkbox', default: false },
      {
        key: 'cutType',
        label: 'Head',
        type: 'select',
        default: 'None',
        options: ['None', 'Counterbore', 'Countersink']
      },
      { key: 'cutDiameter', label: 'Head dia', type: 'number', default: 0, min: 0, step: 0.5 },
      { key: 'cutDepth', label: 'C-bore depth', type: 'number', default: 0, min: 0, step: 0.5 }
    ]
  },
  copyBody: {
    title: 'Copy Body',
    needs: 'none',
    hint: 'Duplicates the selected body (or the first body) as an independent body',
    fields: []
  },
  moveBody: {
    title: 'Move / Rotate Body',
    needs: 'none',
    hint: 'Applies to the selected body (or the first body). Rotation in degrees.',
    fields: [
      { key: 'dx', label: 'Move X', type: 'number', default: 0, step: 1 },
      { key: 'dy', label: 'Move Y', type: 'number', default: 0, step: 1 },
      { key: 'dz', label: 'Move Z', type: 'number', default: 0, step: 1 },
      { key: 'rx', label: 'Rotate X', type: 'number', default: 0, step: 5 },
      { key: 'ry', label: 'Rotate Y', type: 'number', default: 0, step: 5 },
      { key: 'rz', label: 'Rotate Z', type: 'number', default: 0, step: 5 }
    ]
  },
  patternLinear: {
    title: 'Rectangular Pattern',
    needs: 'axis',
    hint: 'Direction: an edge, a sketch line, or a datum / origin axis',
    fields: [
      { key: 'count', label: 'Quantity', type: 'number', default: 3, min: 2, step: 1 },
      { key: 'spacing', label: 'Spacing', type: 'number', default: 20, min: 0.01, step: 1 }
    ]
  },
  mirror: {
    title: 'Mirror',
    needs: 'plane',
    hint: 'Select the mirror plane (a datum / origin plane or a flat face). The whole body is mirrored and joined.',
    fields: []
  },
  datumPlane: {
    title: 'Plane',
    needs: 'plane',
    hint: 'Pick a base plane / face. In "To object" mode also pick a point / edge / face to reach, with an optional extra offset.',
    fields: [
      {
        key: 'mode',
        label: 'Type',
        type: 'select',
        default: 'Distance',
        options: ['Distance', 'To object']
      },
      { key: 'offset', label: 'Offset', type: 'number', default: 10, step: 1 }
    ]
  },
  datumAxis: {
    title: 'Axis',
    needs: 'axis',
    hint: 'One edge, or two planes / faces for their intersection',
    fields: []
  },
  datumPoint: {
    title: 'Point',
    needs: 'none',
    hint: 'Select a vertex (or an edge / face centre) to place it there, else the body origin',
    fields: []
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

/** ops whose result we can re-render live as the number changes */
const LIVE_PREVIEW: ReadonlySet<OpKind> = new Set<OpKind>([
  'extrude',
  'revolve',
  'fillet',
  'chamfer',
  'shell',
  'hole',
  'draft',
  'rib'
])

export function OperationDialog({
  kind,
  selection,
  onApply,
  onCancel,
  onPreview,
  onLivePreview,
  onLivePreviewEnd,
  handleDrag
}: {
  kind: OpKind | null
  selection: Selection[]
  onApply: (kind: OpKind, values: OpValues, exprs: Record<string, string>) => void
  onCancel: () => void
  onPreview?: (info: { mode: string; offset: number } | null) => void
  onLivePreview?: (kind: OpKind, values: OpValues) => void
  onLivePreviewEnd?: () => void
  handleDrag?: { delta: number; phase: 'move' | 'end'; seq: number } | null
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

  // Offset Plane: picking a second piece of geometry while in Distance mode
  // means "put the plane there" - switch to To object and start the extra
  // offset at 0, like Fusion.
  useEffect(() => {
    if (kind !== 'datumPlane') return
    if (values.mode === 'Distance' && selection.length >= 2) {
      setValues((v) => ({ ...v, mode: 'To object', offset: '0' }))
    }
  }, [kind, selection, values.mode])

  // push a live ghost of where the Offset Plane will land
  useEffect(() => {
    if (!onPreview) return
    if (kind !== 'datumPlane') {
      onPreview(null)
      return
    }
    const off = Number(String(values.offset ?? 0))
    if (isNaN(off)) return
    const t = setTimeout(
      () => onPreview({ mode: String(values.mode ?? 'Distance'), offset: off }),
      120
    )
    return () => clearTimeout(t)
  }, [kind, values.mode, values.offset, selection, onPreview])

  // drop the ghost when the dialog unmounts
  useEffect(() => () => onPreview?.(null), []) // eslint-disable-line react-hooks/exhaustive-deps

  // live feature preview: debounce value / selection changes and ask the app to
  // build the feature in the engine so it renders as you tune the number
  useEffect(() => {
    if (!kind || !LIVE_PREVIEW.has(kind) || !onLivePreview) return
    if (!selection.length) return
    // short debounce - the app coalesces overlapping calls and the in-place
    // fast path is a single recompute, so this can stay snappy while typing
    console.log(`[preview-effect] scheduled kind=${kind} values=${JSON.stringify(values)}`)
    const t = setTimeout(() => {
      console.log(`[preview-effect] FIRE kind=${kind}`)
      onLivePreview(kind, values)
    }, 130)
    return () => clearTimeout(t)
  }, [kind, selection, values]) // eslint-disable-line react-hooks/exhaustive-deps

  // roll the live preview back when the dialog closes without applying
  useEffect(() => () => onLivePreviewEnd?.(), []) // eslint-disable-line react-hooks/exhaustive-deps

  // apply drags of the ghost's handle to the Offset field
  const dragBaseRef = useState<{ v: number | null }>(() => ({ v: null }))[0]
  useEffect(() => {
    if (!handleDrag || kind !== 'datumPlane') return
    if (dragBaseRef.v == null) dragBaseRef.v = Number(String(values.offset ?? 0)) || 0
    const next = Math.round((dragBaseRef.v + handleDrag.delta) * 100) / 100
    setValues((v) => ({ ...v, offset: String(next) }))
    if (handleDrag.phase === 'end') dragBaseRef.v = null
  }, [handleDrag]) // eslint-disable-line react-hooks/exhaustive-deps

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
      const exprs: Record<string, string> = {}
      for (const f of numberFields) {
        const raw = String(values[f.key] ?? f.default).trim()
        if (isNaN(Number(raw))) {
          out[f.key] = (await api.exprEval(raw, kindOf(f.key))).value
          exprs[f.key] = raw // remember the formula for this dimension
        } else {
          out[f.key] = Number(raw)
        }
      }
      onApply(kind, out, exprs)
    } catch (e) {
      window.alert((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const edges = selection.filter((s) => s.kind === 'edge')
  const faces = selection.filter((s) => s.kind === 'face')
  const sketchesSel = selection.filter((s) => s.kind === 'sketch')
  const extrudeToObj = kind === 'extrude' && values.mode === 'To object'
  // extrude accepts a sketch OR a flat model face as the profile
  const extrudeProfileOk = kind === 'extrude' && (sketchesSel.length === 1 || faces.length >= 1)
  const planeSel = selection.filter((s) => s.kind === 'plane' || s.kind === 'face')
  const datumPlaneToObj = kind === 'datumPlane' && values.mode === 'To object'
  const datumPlaneMsg = datumPlaneToObj
    ? selection.length >= 2
      ? 'base + target selected'
      : `pick a base plane / face, then a point / edge / face to reach (${selection.length}/2)`
    : null
  const axisSel = selection.filter((s) => s.kind === 'plane' || s.kind === 'edge' || s.kind === 'face')
  const needMsg =
    datumPlaneMsg ??
    (spec.needs === 'edges'
      ? `${edges.length} edge${edges.length === 1 ? '' : 's'} selected`
      : spec.needs === 'faces' || spec.needs === 'planeFace'
        ? `${faces.length} face${faces.length === 1 ? '' : 's'} selected`
        : spec.needs === 'sketch'
          ? kind === 'extrude' && !sketchesSel.length && !faces.length
            ? 'select a sketch, or a flat face of the model'
            : !sketchesSel.length && kind !== 'extrude'
              ? 'select a sketch (click its outline or filled face)'
              : extrudeToObj && faces.length <= (sketchesSel.length ? 0 : 1)
                ? 'now select the face to extrude up to'
                : sketchesSel.length
                  ? 'sketch selected'
                  : 'face selected'
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
                : null)

  const ready =
    (datumPlaneToObj && selection.length >= 2) ||
    (kind === 'datumPlane' && !datumPlaneToObj && planeSel.length >= 1) ||
    spec.needs === 'none' ||
    (spec.needs === 'edges' && edges.length > 0) ||
    (spec.needs === 'faces' && faces.length > 0) ||
    (spec.needs === 'planeFace' && faces.length === 1) ||
    (spec.needs === 'sketch' &&
      kind !== 'extrude' &&
      sketchesSel.length === 1 &&
      (!extrudeToObj || faces.length >= 1)) ||
    (kind === 'extrude' &&
      extrudeProfileOk &&
      (!extrudeToObj || faces.length >= (sketchesSel.length ? 1 : 2))) ||
    (spec.needs === 'sketches2' && sketchesSel.length >= 2) ||
    (spec.needs === 'plane' && planeSel.length >= 1) ||
    (spec.needs === 'axis' && axisSel.length >= 1)

  return (
    <div className="opdlg">
      <div className="opdlg-title">{spec.title}</div>
      {needMsg && (
        <div className={ready ? 'opdlg-need ok' : 'opdlg-need'}>{needMsg}</div>
      )}
      {spec.hint && <div className="opdlg-hint">{spec.hint}</div>}
      <div className="opdlg-body">
        {spec.fields
          .filter((f) => !f.showIf || f.showIf(values))
          .map((f) => (
          <label key={f.key} className={f.wide ? 'opdlg-field col' : 'opdlg-field'}>
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
