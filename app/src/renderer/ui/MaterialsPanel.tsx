import { useEffect, useMemo, useState } from 'react'
import { api, type CustomMaterialPreset, type MaterialDTO, type MaterialFamily } from '../rpc'

/**
 * Assign a real FreeCAD Material (appearance + physical properties) to the
 * selected body, from the ~200 built-in presets or a saved custom one.
 * Physical properties (density, Young's modulus, ...) and appearance (color,
 * glossiness, transparency) live on a genuine FreeCAD Material object, so it
 * round-trips in any FreeCAD install. A few properties FreeCAD has no slot
 * for (friction, a finish/pattern tag, notes) are GWT-CAD-only extras stored
 * alongside - visible here, not in plain FreeCAD.
 */
export function MaterialsPanel({
  targetId,
  targetLabel,
  onClose,
  onModelChanged
}: {
  targetId: string | null
  targetLabel: string | null
  onClose: () => void
  onModelChanged: () => void
}): JSX.Element {
  const [families, setFamilies] = useState<MaterialFamily[]>([])
  const [customs, setCustoms] = useState<CustomMaterialPreset[]>([])
  const [assigned, setAssigned] = useState<MaterialDTO | null>(null)
  const [family, setFamily] = useState<string>('')
  const [detail, setDetail] = useState<MaterialDTO | null>(null)
  const [editing, setEditing] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const load = (): void => {
    void Promise.all([api.materialPresets(), api.materialCustomList(), api.materialGet(targetId)])
      .then(([p, c, g]) => {
        setFamilies(p.families)
        setCustoms(c.presets)
        setAssigned(g.assigned)
        if (!family && p.families.length) setFamily(p.families[0].family)
      })
      .catch((e) => setErr((e as Error).message))
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [targetId])

  const activeFamily = useMemo(() => families.find((f) => f.family === family), [families, family])

  const pick = async (uuid: string): Promise<void> => {
    try {
      const d = await api.materialPresetDetail(uuid)
      setDetail(d)
      setEditing(false)
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  const assign = async (): Promise<void> => {
    if (!detail) return
    try {
      await api.materialAssign(targetId, detail.uuid, assigned?.extra ?? {})
      onModelChanged()
      load()
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  const assignCustom = async (id: string): Promise<void> => {
    try {
      await api.materialCustomAssign(targetId, id)
      onModelChanged()
      load()
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  const clear = async (): Promise<void> => {
    try {
      await api.materialClear(targetId)
      onModelChanged()
      load()
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  const deleteCustom = async (id: string): Promise<void> => {
    await api.materialCustomDelete(id)
    load()
  }

  return (
    <div className="materials-panel">
      <div className="materials-head">
        <span>MATERIAL{targetLabel ? ` - ${targetLabel}` : ''}</span>
        <button onClick={onClose} title="Close">
          &times;
        </button>
      </div>

      {assigned && (
        <div className="materials-current">
          <span
            className="materials-swatch"
            style={{ background: swatchColor(String(assigned.appearance.DiffuseColor ?? '')) }}
          />
          <span className="materials-current-name">{assigned.name}</span>
          <button className="materials-clear" onClick={() => void clear()} title="Remove material">
            Clear
          </button>
        </div>
      )}

      <div className="materials-body">
        <div className="materials-families">
          {families.map((f) => (
            <button
              key={f.family}
              className={f.family === family ? 'materials-fam active' : 'materials-fam'}
              onClick={() => setFamily(f.family)}
            >
              {f.family}
            </button>
          ))}
          <button
            className={family === '__custom' ? 'materials-fam active' : 'materials-fam'}
            onClick={() => setFamily('__custom')}
          >
            Custom ({customs.length})
          </button>
        </div>

        <div className="materials-list">
          {family === '__custom'
            ? customs.map((c) => (
                <div key={c.id} className="materials-item-row">
                  <button className="materials-item" onClick={() => void assignCustom(c.id)}>
                    <span
                      className="materials-swatch sm"
                      style={{ background: swatchColor(c.appearance.DiffuseColor as string) }}
                    />
                    {c.name}
                  </button>
                  <button
                    className="materials-del"
                    title="Delete preset"
                    onClick={() => void deleteCustom(c.id)}
                  >
                    &times;
                  </button>
                </div>
              ))
            : (activeFamily?.materials ?? []).map((m) => (
                <button key={m.uuid} className="materials-item" onClick={() => void pick(m.uuid)}>
                  {m.name}
                </button>
              ))}
          {family === '__custom' && !customs.length && (
            <div className="materials-empty">No custom presets yet - pick a built-in one, then Save as custom.</div>
          )}
        </div>
      </div>

      {detail && (
        <MaterialDetailForm
          detail={detail}
          onAssign={() => void assign()}
          onSaveCustom={async (name, appearance, physical, extra) => {
            try {
              await api.materialCustomSave(name, detail.uuid, appearance, physical, extra)
              load()
              setEditing(false)
            } catch (e) {
              setErr((e as Error).message)
            }
          }}
          editing={editing}
          onToggleEdit={() => setEditing((v) => !v)}
        />
      )}

      {err && <div className="materials-err">{err}</div>}
    </div>
  )
}

function swatchColor(diffuse?: string): string {
  // FreeCAD colour strings look like "(0.8000, 0.1000, 0.1000, 1.0)"
  if (!diffuse) return '#888'
  const m = diffuse.match(/([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/)
  if (!m) return '#888'
  const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])].map((x) => Math.round(x * 255))
  return `rgb(${r}, ${g}, ${b})`
}

function colorToFreeCAD(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  return `(${r.toFixed(4)}, ${g.toFixed(4)}, ${b.toFixed(4)}, 1.0)`
}

function colorToHex(diffuse?: string): string {
  if (!diffuse) return '#888888'
  const m = diffuse.match(/([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/)
  if (!m) return '#888888'
  const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])].map((x) =>
    Math.round(x * 255)
      .toString(16)
      .padStart(2, '0')
  )
  return `#${r}${g}${b}`
}

/** Physical / appearance detail for the picked preset, editable into a custom one. */
function MaterialDetailForm({
  detail,
  editing,
  onToggleEdit,
  onAssign,
  onSaveCustom
}: {
  detail: MaterialDTO
  editing: boolean
  onToggleEdit: () => void
  onAssign: () => void
  onSaveCustom: (
    name: string,
    appearance: Record<string, unknown>,
    physical: Record<string, unknown>,
    extra: Record<string, unknown>
  ) => void
}): JSX.Element {
  const [name, setName] = useState(detail.name + ' (custom)')
  const [color, setColor] = useState(colorToHex(detail.appearance.DiffuseColor as string))
  const [shininess, setShininess] = useState(String(detail.appearance.Shininess ?? '0.1'))
  const [density, setDensity] = useState(String(detail.physical.Density ?? ''))
  const [frictionStatic, setFrictionStatic] = useState('0.3')
  const [pattern, setPattern] = useState('')

  return (
    <div className="materials-detail">
      <div className="materials-detail-head">
        <b>{detail.name}</b>
        <span>{detail.family}</span>
      </div>
      <div className="materials-detail-props">
        {Object.entries(detail.physical).map(([k, v]) => (
          <div key={k} className="materials-prop">
            <span>{k}</span>
            <span>{typeof v === 'number' ? v.toPrecision(4) : String(v)}</span>
          </div>
        ))}
      </div>
      <div className="materials-actions">
        <button onClick={onAssign}>Assign as-is</button>
        <button onClick={onToggleEdit}>{editing ? 'Cancel' : 'Save as custom...'}</button>
      </div>
      {editing && (
        <div className="materials-custom-form">
          <label>
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            <span>Color</span>
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
          </label>
          <label>
            <span>Glossiness (0-1)</span>
            <input value={shininess} onChange={(e) => setShininess(e.target.value)} />
          </label>
          <label>
            <span>Density (e.g. 2.7e-06 kg/mm^3)</span>
            <input value={density} onChange={(e) => setDensity(e.target.value)} />
          </label>
          <label>
            <span>Friction (static)</span>
            <input value={frictionStatic} onChange={(e) => setFrictionStatic(e.target.value)} />
          </label>
          <label>
            <span>Pattern / finish (GWT-CAD only)</span>
            <input
              placeholder="e.g. brushed, anodized, matte"
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
            />
          </label>
          <button
            className="materials-save-btn"
            onClick={() =>
              onSaveCustom(
                name,
                { DiffuseColor: colorToFreeCAD(color), Shininess: shininess },
                density ? { Density: density } : {},
                { frictionStatic: Number(frictionStatic) || 0, pattern }
              )
            }
          >
            Save preset
          </button>
        </div>
      )}
    </div>
  )
}
