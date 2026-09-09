import { useEffect, useMemo, useRef, useState } from 'react'
import {
  api,
  type AppearancePreset,
  type ObjectAppearance,
  type RenderSettings,
  type FinishName,
  type EdgeStyle
} from '../rpc'
import type { ViewportApi, RenderImageOptions } from '../viewport/types'
import {
  BUILTIN_PRESETS,
  DEFAULT_APPEARANCE,
  DEFAULT_RENDER,
  FINISH_NAMES,
  cmykToRgb,
  effectiveAppearance,
  effectiveRender,
  hexToRgb,
  mergeAppearance,
  mergeRender,
  rgbToCmyk,
  rgbToHex,
  rgbToHsv,
  hsvToRgb,
  type RGB
} from '../appearance'

/**
 * Rendering / viewing / appearances. Everything is applied to the three.js
 * viewport instantly; App also queues each change to the FreeCAD engine so it
 * persists (colour + opacity land on the real object, the rest in the .gwtcad
 * companion). Presets overrule ONLY the keys they define.
 */
export function AppearancePanel({
  targetId,
  targetLabel,
  appearance,
  renderSettings,
  vpApi,
  docPath,
  onSetAppearance,
  onClearAppearance,
  onSetRender,
  onClose
}: {
  targetId: string | null
  targetLabel: string | null
  appearance: ObjectAppearance | undefined
  renderSettings: RenderSettings
  vpApi: { current: ViewportApi | null }
  docPath: string | null
  onSetAppearance: (targetId: string, patch: ObjectAppearance, merge?: boolean) => void
  onClearAppearance: (targetId: string) => void
  onSetRender: (patch: RenderSettings, merge?: boolean) => void
  onClose: () => void
}): JSX.Element {
  const [tab, setTab] = useState<'object' | 'edges' | 'scene' | 'presets' | 'render'>('object')
  const [savedPresets, setSavedPresets] = useState<AppearancePreset[]>([])
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    void api
      .appearancePresetList()
      .then((r) => setSavedPresets(r.presets))
      .catch(() => undefined)
  }, [])

  const eff = effectiveAppearance(appearance)
  const R = effectiveRender(renderSettings)

  const setA = (patch: ObjectAppearance): void => {
    if (!targetId) return
    onSetAppearance(targetId, patch, true)
  }
  const setR = (patch: RenderSettings): void => onSetRender(patch, true)

  const applyPreset = (p: AppearancePreset): void => {
    // partial merge - only the keys the preset defines change
    if ((p.scope === 'object' || p.scope === 'both') && targetId) {
      onSetAppearance(targetId, p.appearance, true)
    }
    if (p.scope === 'document' || p.scope === 'both') {
      onSetRender(p.render, true)
    }
  }

  const allPresets = useMemo(
    () => [...BUILTIN_PRESETS, ...savedPresets],
    [savedPresets]
  )

  return (
    <div className="materials-panel appearance-panel">
      <div className="materials-head">
        <span>APPEARANCE{targetLabel ? ` - ${targetLabel}` : ''}</span>
        <button onClick={onClose} title="Close">
          &times;
        </button>
      </div>

      <div className="materials-families appr-tabs">
        {(['object', 'edges', 'scene', 'presets', 'render'] as const).map((t) => (
          <button
            key={t}
            className={t === tab ? 'materials-fam active' : 'materials-fam'}
            onClick={() => setTab(t)}
          >
            {t === 'object'
              ? 'Color / Finish'
              : t === 'scene'
                ? 'Shading / Light'
                : t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      <div className="appr-body">
        {tab === 'object' && (
          <ObjectTab
            eff={eff}
            hasRecord={!!appearance}
            disabled={!targetId}
            onChange={setA}
            onReset={() => targetId && onClearAppearance(targetId)}
          />
        )}
        {tab === 'edges' && <EdgesTab eff={eff} disabled={!targetId} onChange={setA} R={R} onR={setR} />}
        {tab === 'scene' && <SceneTab R={R} onChange={setR} />}
        {tab === 'presets' && (
          <PresetsTab
            presets={allPresets}
            onApply={applyPreset}
            onSaveCurrent={async (name, scope) => {
              try {
                const saved = await api.appearancePresetSave(
                  name,
                  scope === 'document' ? {} : (appearance ?? eff),
                  scope === 'object' ? {} : (renderSettings ?? R),
                  scope
                )
                setSavedPresets((p) => [...p, saved])
              } catch (e) {
                setErr((e as Error).message)
              }
            }}
            onDelete={async (id) => {
              if (id.startsWith('builtin.')) return
              await api.appearancePresetDelete(id).catch(() => undefined)
              setSavedPresets((p) => p.filter((x) => x.id !== id))
            }}
          />
        )}
        {tab === 'render' && (
          <RenderTab vpApi={vpApi} R={R} docPath={docPath} onNotice={setErr} />
        )}
      </div>

      {err && <div className="materials-err">{err}</div>}
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Color / opacity / finish
// --------------------------------------------------------------------------- //

function ObjectTab({
  eff,
  hasRecord,
  disabled,
  onChange,
  onReset
}: {
  eff: ObjectAppearance
  hasRecord: boolean
  disabled: boolean
  onChange: (p: ObjectAppearance) => void
  onReset: () => void
}): JSX.Element {
  const rgb = (eff.color ?? DEFAULT_APPEARANCE.color) as RGB
  const opacity = eff.opacity ?? 1
  const [mode, setMode] = useState<'rgb' | 'hex' | 'cmyk' | 'hsv'>('hex')

  const setColor = (c: RGB): void => onChange({ color: c })

  return (
    <div className="appr-section">
      <div className="appr-swatch-row">
        <span
          className="appr-swatch-big"
          style={{
            background: rgbToHex(rgb),
            opacity: Math.max(0.15, opacity)
          }}
        />
        <div className="appr-color-modes">
          {(['hex', 'rgb', 'cmyk', 'hsv'] as const).map((m) => (
            <button
              key={m}
              className={m === mode ? 'active' : ''}
              onClick={() => setMode(m)}
            >
              {m.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      <fieldset disabled={disabled} className="appr-fields">
        {mode === 'hex' && (
          <label>
            <span>Hex</span>
            <input
              type="color"
              value={rgbToHex(rgb)}
              onChange={(e) => setColor(hexToRgb(e.target.value))}
            />
            <input
              type="text"
              value={rgbToHex(rgb)}
              onChange={(e) => {
                if (/^#?[0-9a-f]{6}$/i.test(e.target.value.trim())) setColor(hexToRgb(e.target.value))
              }}
            />
          </label>
        )}

        {mode === 'rgb' &&
          (['R', 'G', 'B'] as const).map((ch, i) => (
            <label key={ch}>
              <span>{ch}</span>
              <input
                type="range"
                min={0}
                max={255}
                value={Math.round(rgb[i] * 255)}
                onChange={(e) => {
                  const next = [...rgb] as RGB
                  next[i] = Number(e.target.value) / 255
                  setColor(next)
                }}
              />
              <b>{Math.round(rgb[i] * 255)}</b>
            </label>
          ))}

        {mode === 'cmyk' &&
          (() => {
            const cmyk = rgbToCmyk(rgb)
            const labels = ['C', 'M', 'Y', 'K']
            return labels.map((ch, i) => (
              <label key={ch}>
                <span>{ch}</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(cmyk[i] * 100)}
                  onChange={(e) => {
                    const next = [...cmyk] as [number, number, number, number]
                    next[i] = Number(e.target.value) / 100
                    setColor(cmykToRgb(next))
                  }}
                />
                <b>{Math.round(cmyk[i] * 100)}</b>
              </label>
            ))
          })()}

        {mode === 'hsv' &&
          (() => {
            const hsv = rgbToHsv(rgb)
            const cfg: [string, number][] = [
              ['H', 360],
              ['S', 100],
              ['V', 100]
            ]
            return cfg.map(([ch, max], i) => (
              <label key={ch}>
                <span>{ch}</span>
                <input
                  type="range"
                  min={0}
                  max={max}
                  value={Math.round((i === 0 ? hsv[0] : hsv[i] * 100))}
                  onChange={(e) => {
                    const next = [...hsv] as [number, number, number]
                    next[i] = i === 0 ? Number(e.target.value) : Number(e.target.value) / 100
                    setColor(hsvToRgb(next))
                  }}
                />
                <b>{Math.round(i === 0 ? hsv[0] : hsv[i] * 100)}</b>
              </label>
            ))
          })()}

        <label className="appr-opacity">
          <span>Opacity</span>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(opacity * 100)}
            onChange={(e) => onChange({ opacity: Number(e.target.value) / 100 })}
          />
          <b>{Math.round(opacity * 100)}%</b>
        </label>
        <div className="appr-quickops">
          <button onClick={() => onChange({ opacity: 0.1, finish: 'glass' })}>Clear 10%</button>
          <button onClick={() => onChange({ opacity: 0.25 })}>Ghost 25%</button>
          <button onClick={() => onChange({ opacity: 1 })}>Opaque</button>
        </div>

        <label>
          <span>Finish</span>
          <select
            value={eff.finish ?? 'plastic'}
            onChange={(e) => onChange({ finish: e.target.value as FinishName })}
          >
            {FINISH_NAMES.map((f) => (
              <option key={f} value={f}>
                {f.replace('-', ' ')}
              </option>
            ))}
          </select>
        </label>
      </fieldset>

      {hasRecord && (
        <button className="materials-clear" onClick={onReset}>
          Reset to default
        </button>
      )}
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Edges (per-object override + document defaults)
// --------------------------------------------------------------------------- //

function EdgesTab({
  eff,
  disabled,
  onChange,
  R,
  onR
}: {
  eff: ObjectAppearance
  disabled: boolean
  onChange: (p: ObjectAppearance) => void
  R: Required<RenderSettings>
  onR: (p: RenderSettings) => void
}): JSX.Element {
  const e = eff.edges ?? DEFAULT_APPEARANCE.edges
  const edgeColor = typeof e.color === 'string' ? e.color : rgbToHex((e.color as RGB) ?? [0.11, 0.12, 0.14])
  const styleSel = (
    label: string,
    value: EdgeStyle,
    set: (v: EdgeStyle) => void
  ): JSX.Element => (
    <label>
      <span>{label}</span>
      <select value={value} onChange={(ev) => set(ev.target.value as EdgeStyle)}>
        <option value="show">Show</option>
        <option value="hide">Hide</option>
        <option value="dashed">Dashed</option>
      </select>
    </label>
  )

  return (
    <div className="appr-section">
      <h4>This body</h4>
      <fieldset disabled={disabled} className="appr-fields">
        <label className="appr-check">
          <input
            type="checkbox"
            checked={e.show ?? true}
            onChange={(ev) => onChange({ edges: { show: ev.target.checked } })}
          />
          <span>Show model edges</span>
        </label>
        <label>
          <span>Edge color</span>
          <input
            type="color"
            value={edgeColor}
            onChange={(ev) => onChange({ edges: { color: ev.target.value } })}
          />
        </label>
        {styleSel('Tangent (smooth) edges', (e.tangent ?? 'show') as EdgeStyle, (v) =>
          onChange({ edges: { tangent: v } })
        )}
        {styleSel('Hidden (occluded) edges', (e.hidden ?? 'hide') as EdgeStyle, (v) =>
          onChange({ edges: { hidden: v } })
        )}
      </fieldset>

      <h4>Document default</h4>
      <div className="appr-fields">
        <label>
          <span>Edge display</span>
          <select
            value={R.edgeMode}
            onChange={(ev) => onR({ edgeMode: ev.target.value as RenderSettings['edgeMode'] })}
          >
            <option value="auto">Auto (follow shading mode)</option>
            <option value="all">Always show</option>
            <option value="none">Never show</option>
          </select>
        </label>
        <label>
          <span>Default edge color</span>
          <input
            type="color"
            value={R.edgeColor}
            onChange={(ev) => onR({ edgeColor: ev.target.value })}
          />
        </label>
        {styleSel('Default tangent edges', R.tangentEdges, (v) => onR({ tangentEdges: v }))}
        {styleSel('Default hidden edges', R.hiddenEdges, (v) => onR({ hiddenEdges: v }))}
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Scene: shading mode, lighting rig, background
// --------------------------------------------------------------------------- //

function SceneTab({
  R,
  onChange
}: {
  R: Required<RenderSettings>
  onChange: (p: RenderSettings) => void
}): JSX.Element {
  return (
    <div className="appr-section appr-fields">
      <label>
        <span>Shading mode</span>
        <select
          value={R.shading}
          onChange={(e) => onChange({ shading: e.target.value as RenderSettings['shading'] })}
        >
          <option value="shaded">Shaded</option>
          <option value="shaded-edges">Shaded + edges</option>
          <option value="flat">Flat (faceted)</option>
          <option value="wireframe">Wireframe</option>
          <option value="hidden-line">Hidden line</option>
        </select>
      </label>
      <label>
        <span>Lighting</span>
        <select
          value={R.lighting}
          onChange={(e) => onChange({ lighting: e.target.value as RenderSettings['lighting'] })}
        >
          <option value="studio">Studio</option>
          <option value="soft">Soft</option>
          <option value="hard">Hard</option>
          <option value="three-point">Three-point</option>
          <option value="outdoor">Outdoor</option>
          <option value="flat">Flat / even</option>
        </select>
      </label>
      <label>
        <span>Ambient occlusion</span>
        <input
          type="checkbox"
          checked={R.ao}
          onChange={(e) => onChange({ ao: e.target.checked })}
        />
      </label>
      <label>
        <span>Exposure</span>
        <input
          type="range"
          min={50}
          max={200}
          value={Math.round((R.exposure ?? 1) * 100)}
          onChange={(e) => onChange({ exposure: Number(e.target.value) / 100 })}
        />
        <b>{(R.exposure ?? 1).toFixed(2)}</b>
      </label>
      <label>
        <span>Background</span>
        <select
          value={R.background}
          onChange={(e) =>
            onChange({ background: e.target.value as RenderSettings['background'] })
          }
        >
          <option value="gradient">Gradient</option>
          <option value="transparent">Transparent</option>
          <option value="white">White</option>
          <option value="black">Black</option>
          <option value="gray">Gray</option>
          <option value="custom">Custom color</option>
        </select>
      </label>
      {R.background === 'custom' && (
        <label>
          <span>Custom color</span>
          <input
            type="color"
            value={R.backgroundColor}
            onChange={(e) => onChange({ backgroundColor: e.target.value })}
          />
        </label>
      )}
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Presets - partial-override bundles
// --------------------------------------------------------------------------- //

function PresetsTab({
  presets,
  onApply,
  onSaveCurrent,
  onDelete
}: {
  presets: AppearancePreset[]
  onApply: (p: AppearancePreset) => void
  onSaveCurrent: (name: string, scope: AppearancePreset['scope']) => void
  onDelete: (id: string) => void
}): JSX.Element {
  const [name, setName] = useState('My Preset')
  const [scope, setScope] = useState<AppearancePreset['scope']>('object')
  return (
    <div className="appr-section">
      <p className="appr-hint">
        Applying a preset changes only the settings it defines - everything else
        stays as it is.
      </p>
      <div className="appr-preset-list">
        {presets.map((p) => (
          <div key={p.id} className="materials-item-row">
            <button className="materials-item" onClick={() => onApply(p)}>
              {swatchFor(p)}
              <span>
                {p.name} <em>({p.scope})</em>
              </span>
            </button>
            {!p.id.startsWith('builtin.') && (
              <button className="materials-del" title="Delete" onClick={() => onDelete(p.id)}>
                &times;
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="appr-fields appr-save-preset">
        <label>
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          <span>Captures</span>
          <select value={scope} onChange={(e) => setScope(e.target.value as AppearancePreset['scope'])}>
            <option value="object">This body (color / finish / edges)</option>
            <option value="document">Scene (shading / lighting / background)</option>
            <option value="both">Both</option>
          </select>
        </label>
        <button className="materials-save-btn" onClick={() => onSaveCurrent(name, scope)}>
          Save current as preset
        </button>
      </div>
    </div>
  )
}

function swatchFor(p: AppearancePreset): JSX.Element {
  const c = p.appearance.color
  const bg = c ? rgbToHex(c as RGB) : '#7a7f86'
  return (
    <span
      className="materials-swatch sm"
      style={{ background: bg, opacity: Math.max(0.2, p.appearance.opacity ?? 1) }}
    />
  )
}

// --------------------------------------------------------------------------- //
// Render / image export
// --------------------------------------------------------------------------- //

const RES_PRESETS: [string, number, number][] = [
  ['Viewport', 0, 0],
  ['1280 x 720', 1280, 720],
  ['1920 x 1080', 1920, 1080],
  ['2560 x 1440', 2560, 1440],
  ['3840 x 2160', 3840, 2160]
]

function RenderTab({
  vpApi,
  R,
  docPath,
  onNotice
}: {
  vpApi: { current: ViewportApi | null }
  R: Required<RenderSettings>
  docPath: string | null
  onNotice: (m: string | null) => void
}): JSX.Element {
  const [res, setRes] = useState(2)
  const [w, setW] = useState(1920)
  const [h, setH] = useState(1080)
  const [fmt, setFmt] = useState<'png' | 'jpeg'>('png')
  const [bg, setBg] = useState<'scene' | 'transparent' | 'white' | 'black' | 'gray' | 'custom'>(
    'scene'
  )
  const [custom, setCustom] = useState('#ffffff')
  const [ss, setSs] = useState(2)
  const [quality, setQuality] = useState(92)
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<string | null>(null)
  const hostRef = useRef<HTMLDivElement>(null)

  const bgColor = (): string | null => {
    switch (bg) {
      case 'transparent':
        return null
      case 'white':
        return '#ffffff'
      case 'black':
        return '#000000'
      case 'gray':
        return '#8a8f96'
      case 'custom':
        return custom
      case 'scene':
      default: {
        // mirror the current scene background choice
        switch (R.background) {
          case 'transparent':
            return null
          case 'white':
            return '#ffffff'
          case 'black':
            return '#000000'
          case 'gray':
            return '#8a8f96'
          case 'custom':
            return R.backgroundColor
          default:
            // gradient: the offscreen capture can't reproduce the CSS gradient,
            // so fall back to its mid tone as a solid.
            return '#2b3038'
        }
      }
    }
  }

  const opts = (): RenderImageOptions => {
    const useViewport = RES_PRESETS[res][1] === 0
    const rect = hostRef.current?.getBoundingClientRect()
    return {
      width: useViewport ? Math.round(rect?.width ?? 1280) : w,
      height: useViewport ? Math.round(rect?.height ?? 720) : h,
      background: bgColor(),
      supersample: ss,
      format: fmt,
      quality: quality / 100
    }
  }

  const doRender = async (): Promise<string | null> => {
    const vp = vpApi.current
    if (!vp) {
      onNotice('viewport not ready')
      return null
    }
    setBusy(true)
    onNotice(null)
    try {
      const url = await vp.renderImage(opts())
      return url
    } catch (e) {
      onNotice((e as Error).message)
      return null
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="appr-section appr-fields" ref={hostRef}>
      <label>
        <span>Resolution</span>
        <select
          value={res}
          onChange={(e) => {
            const i = Number(e.target.value)
            setRes(i)
            if (RES_PRESETS[i][1]) {
              setW(RES_PRESETS[i][1])
              setH(RES_PRESETS[i][2])
            }
          }}
        >
          {RES_PRESETS.map(([label], i) => (
            <option key={label} value={i}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {RES_PRESETS[res][1] !== 0 && (
        <label className="appr-wh">
          <span>W x H</span>
          <input type="number" value={w} min={16} onChange={(e) => setW(Number(e.target.value))} />
          <input type="number" value={h} min={16} onChange={(e) => setH(Number(e.target.value))} />
        </label>
      )}
      <label>
        <span>Supersample</span>
        <select value={ss} onChange={(e) => setSs(Number(e.target.value))}>
          <option value={1}>1x</option>
          <option value={2}>2x</option>
          <option value={3}>3x</option>
          <option value={4}>4x</option>
        </select>
      </label>
      <label>
        <span>Format</span>
        <select value={fmt} onChange={(e) => setFmt(e.target.value as 'png' | 'jpeg')}>
          <option value="png">PNG</option>
          <option value="jpeg">JPEG</option>
        </select>
      </label>
      {fmt === 'jpeg' && (
        <label>
          <span>Quality</span>
          <input
            type="range"
            min={40}
            max={100}
            value={quality}
            onChange={(e) => setQuality(Number(e.target.value))}
          />
          <b>{quality}</b>
        </label>
      )}
      <label>
        <span>Background</span>
        <select value={bg} onChange={(e) => setBg(e.target.value as typeof bg)}>
          <option value="scene">Match scene</option>
          <option value="transparent">Transparent</option>
          <option value="white">White</option>
          <option value="black">Black</option>
          <option value="gray">Gray</option>
          <option value="custom">Custom</option>
        </select>
      </label>
      {bg === 'custom' && (
        <label>
          <span>Color</span>
          <input type="color" value={custom} onChange={(e) => setCustom(e.target.value)} />
        </label>
      )}
      {fmt === 'jpeg' && bg === 'transparent' && (
        <p className="appr-hint">JPEG has no transparency - a transparent background exports black.</p>
      )}

      <div className="appr-quickops">
        <button
          disabled={busy}
          onClick={async () => {
            const url = await doRender()
            if (url) setPreview(url)
          }}
        >
          {busy ? 'Rendering...' : 'Preview'}
        </button>
        <button
          disabled={busy}
          onClick={async () => {
            const url = await doRender()
            if (!url) return
            const stem = docPath
              ? docPath.replace(/\\/g, '/').split('/').pop()?.replace(/\.FCStd$/i, '') ?? 'render'
              : 'render'
            const saved = await window.cad.saveRender(
              url,
              `${stem}.${fmt === 'jpeg' ? 'jpg' : 'png'}`,
              fmt
            )
            if (saved) onNotice(`Saved ${saved}`)
          }}
        >
          Save image...
        </button>
      </div>

      {preview && (
        <div className="appr-preview">
          <img src={preview} alt="render preview" />
        </div>
      )}
    </div>
  )
}

// re-exported for tests / callers that want the merge helpers alongside the panel
export { mergeAppearance, mergeRender, DEFAULT_RENDER }
