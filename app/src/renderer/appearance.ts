/**
 * Client-side appearance model: colour maths (RGB / HEX / CMYK / HSV), the
 * surface-finish -> three.js material-param table, edge styling defaults, the
 * built-in presets, and the partial-merge that makes a preset overrule ONLY the
 * keys it defines.
 *
 * The renderer applies all of this instantly; App also queues every change to
 * the sidecar (`api.appearanceSet` / `api.appearanceRenderSet`) so it persists
 * in the .gwtcad companion and colour/opacity land on the FreeCAD object too.
 */
import type {
  ObjectAppearance,
  RenderSettings,
  FinishName,
  EdgeAppearance,
  AppearancePreset
} from './rpc'

// --------------------------------------------------------------------------- //
// colour conversions - everything internal is linear-ish 0..1 RGB triples
// --------------------------------------------------------------------------- //

export type RGB = [number, number, number]
export type CMYK = [number, number, number, number]
export type HSV = [number, number, number]

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)

export function rgbToHex([r, g, b]: RGB): string {
  const h = (v: number): string =>
    Math.round(clamp01(v) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}`
}

export function hexToRgb(hex: string): RGB {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim())
  if (!m) return [0.55, 0.58, 0.62]
  return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255]
}

/** CMYK (each 0..1) -> RGB 0..1. Simple non-ICC conversion, which is what a
 *  CAD viewport wants (screen preview, not print separation). */
export function cmykToRgb([c, m, y, k]: CMYK): RGB {
  return [
    clamp01((1 - c) * (1 - k)),
    clamp01((1 - m) * (1 - k)),
    clamp01((1 - y) * (1 - k))
  ]
}

/** RGB 0..1 -> CMYK 0..1. */
export function rgbToCmyk([r, g, b]: RGB): CMYK {
  const k = 1 - Math.max(r, g, b)
  if (k >= 1 - 1e-6) return [0, 0, 0, 1]
  return [
    clamp01((1 - r - k) / (1 - k)),
    clamp01((1 - g - k) / (1 - k)),
    clamp01((1 - b - k) / (1 - k)),
    clamp01(k)
  ]
}

export function rgbToHsv([r, g, b]: RGB): HSV {
  const mx = Math.max(r, g, b)
  const mn = Math.min(r, g, b)
  const d = mx - mn
  let h = 0
  if (d > 1e-6) {
    if (mx === r) h = ((g - b) / d) % 6
    else if (mx === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  return [h, mx <= 0 ? 0 : d / mx, mx]
}

export function hsvToRgb([h, s, v]: HSV): RGB {
  const c = v * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = v - c
  let rgb: RGB = [0, 0, 0]
  if (h < 60) rgb = [c, x, 0]
  else if (h < 120) rgb = [x, c, 0]
  else if (h < 180) rgb = [0, c, x]
  else if (h < 240) rgb = [0, x, c]
  else if (h < 300) rgb = [x, 0, c]
  else rgb = [c, 0, x]
  return [clamp01(rgb[0] + m), clamp01(rgb[1] + m), clamp01(rgb[2] + m)]
}

// --------------------------------------------------------------------------- //
// finishes -> three.js MeshPhysicalMaterial parameters
// --------------------------------------------------------------------------- //

export interface FinishParams {
  metalness: number
  roughness: number
  clearcoat: number
  clearcoatRoughness: number
  /** default opacity when a finish implies translucency and none is set */
  opacity?: number
  /** flat-shade the mesh (no smooth normals) for a faceted / clay look */
  flatShading?: boolean
  /** treat as a pure wireframe object - no filled surface */
  wireframeOnly?: boolean
  reflectivity?: number
  sheen?: number
}

export const FINISHES: Record<FinishName, FinishParams> = {
  plastic: { metalness: 0.0, roughness: 0.45, clearcoat: 0.35, clearcoatRoughness: 0.35 },
  matte: { metalness: 0.0, roughness: 0.95, clearcoat: 0.0, clearcoatRoughness: 1.0 },
  glossy: { metalness: 0.0, roughness: 0.12, clearcoat: 0.8, clearcoatRoughness: 0.08 },
  satin: { metalness: 0.0, roughness: 0.62, clearcoat: 0.2, clearcoatRoughness: 0.5 },
  metal: { metalness: 1.0, roughness: 0.35, clearcoat: 0.0, clearcoatRoughness: 0.3, reflectivity: 0.7 },
  'brushed-metal': {
    metalness: 1.0,
    roughness: 0.55,
    clearcoat: 0.0,
    clearcoatRoughness: 0.4,
    reflectivity: 0.5
  },
  'polished-metal': {
    metalness: 1.0,
    roughness: 0.08,
    clearcoat: 0.0,
    clearcoatRoughness: 0.1,
    reflectivity: 0.9
  },
  chrome: {
    metalness: 1.0,
    roughness: 0.02,
    clearcoat: 0.0,
    clearcoatRoughness: 0.05,
    reflectivity: 1.0
  },
  glass: {
    metalness: 0.0,
    roughness: 0.05,
    clearcoat: 1.0,
    clearcoatRoughness: 0.05,
    opacity: 0.25,
    reflectivity: 0.5
  },
  rubber: { metalness: 0.0, roughness: 1.0, clearcoat: 0.0, clearcoatRoughness: 1.0, sheen: 0.3 },
  ceramic: { metalness: 0.0, roughness: 0.25, clearcoat: 0.6, clearcoatRoughness: 0.2 },
  clay: {
    metalness: 0.0,
    roughness: 0.9,
    clearcoat: 0.0,
    clearcoatRoughness: 1.0,
    flatShading: true
  },
  anodized: { metalness: 0.8, roughness: 0.4, clearcoat: 0.3, clearcoatRoughness: 0.3 },
  painted: { metalness: 0.0, roughness: 0.5, clearcoat: 0.45, clearcoatRoughness: 0.3 },
  'wireframe-only': {
    metalness: 0,
    roughness: 1,
    clearcoat: 0,
    clearcoatRoughness: 1,
    wireframeOnly: true
  }
}

export const FINISH_NAMES = Object.keys(FINISHES) as FinishName[]

// --------------------------------------------------------------------------- //
// defaults + built-in presets
// --------------------------------------------------------------------------- //

export const DEFAULT_SOLID_RGB: RGB = [0.54, 0.56, 0.59]

export const DEFAULT_APPEARANCE: Required<Omit<ObjectAppearance, 'edges'>> & {
  edges: Required<EdgeAppearance>
} = {
  color: DEFAULT_SOLID_RGB,
  opacity: 1,
  finish: 'plastic',
  edges: { show: true, color: [0.11, 0.12, 0.14], width: 1, tangent: 'show', hidden: 'hide' }
}

export const DEFAULT_RENDER: Required<RenderSettings> = {
  shading: 'shaded-edges',
  lighting: 'studio',
  background: 'gradient',
  backgroundColor: '#2b3038',
  edgeMode: 'auto',
  edgeColor: '#1c1f24',
  tangentEdges: 'show',
  hiddenEdges: 'hide',
  outlineOnly: false,
  ao: false,
  exposure: 1
}

/** Built-in presets. Each defines ONLY the keys it means to override. */
export const BUILTIN_PRESETS: AppearancePreset[] = [
  {
    id: 'builtin.clear',
    name: 'Clear (10%)',
    scope: 'object',
    appearance: { opacity: 0.1, finish: 'glass' },
    render: {}
  },
  {
    id: 'builtin.ghost',
    name: 'Ghost (25%)',
    scope: 'object',
    appearance: { opacity: 0.25, finish: 'plastic' },
    render: {}
  },
  {
    id: 'builtin.machined-aluminum',
    name: 'Machined Aluminum',
    scope: 'object',
    appearance: { color: [0.82, 0.83, 0.85], opacity: 1, finish: 'brushed-metal' },
    render: {}
  },
  {
    id: 'builtin.matte-black',
    name: 'Matte Black',
    scope: 'object',
    appearance: { color: [0.06, 0.06, 0.07], opacity: 1, finish: 'matte' },
    render: {}
  },
  {
    id: 'builtin.blueprint',
    name: 'Blueprint',
    scope: 'both',
    appearance: { color: [0.1, 0.35, 0.75], opacity: 1, finish: 'matte' },
    render: {
      shading: 'hidden-line',
      background: 'custom',
      backgroundColor: '#0d2b6b',
      edgeColor: '#dbe6ff',
      tangentEdges: 'dashed'
    }
  },
  {
    id: 'builtin.studio-render',
    name: 'Studio Render',
    scope: 'document',
    appearance: {},
    render: {
      shading: 'shaded',
      lighting: 'three-point',
      background: 'gradient',
      ao: true,
      exposure: 1.05,
      edgeMode: 'none'
    }
  }
]

// --------------------------------------------------------------------------- //
// partial merge - the core "presets overrule only what they define" rule
// --------------------------------------------------------------------------- //

/** Merge `patch` onto `base`, key by key. `edges` is merged one level deep so a
 *  preset that only sets `edges.tangent` keeps the rest of the edge style. */
export function mergeAppearance(
  base: ObjectAppearance | undefined,
  patch: ObjectAppearance | undefined
): ObjectAppearance {
  const out: ObjectAppearance = { ...(base ?? {}) }
  if (!patch) return out
  if (patch.color !== undefined) out.color = patch.color
  if (patch.opacity !== undefined) out.opacity = patch.opacity
  if (patch.finish !== undefined) out.finish = patch.finish
  if (patch.edges !== undefined) out.edges = { ...(out.edges ?? {}), ...patch.edges }
  return out
}

export function mergeRender(
  base: RenderSettings | undefined,
  patch: RenderSettings | undefined
): RenderSettings {
  return { ...(base ?? {}), ...(patch ?? {}) }
}

/** Effective appearance for rendering: DEFAULT <- object record. */
export function effectiveAppearance(rec: ObjectAppearance | undefined): ObjectAppearance {
  return mergeAppearance(DEFAULT_APPEARANCE, rec)
}

export function effectiveRender(rec: RenderSettings | undefined): Required<RenderSettings> {
  return { ...DEFAULT_RENDER, ...(rec ?? {}) } as Required<RenderSettings>
}

// --------------------------------------------------------------------------- //
// background helpers shared by the viewport and the image exporter
// --------------------------------------------------------------------------- //

export interface BackgroundResolved {
  /** null => transparent (alpha 0) */
  cssColor: string | null
  gradient: boolean
}

export function resolveBackground(r: Required<RenderSettings>): BackgroundResolved {
  switch (r.background) {
    case 'transparent':
      return { cssColor: null, gradient: false }
    case 'white':
      return { cssColor: '#ffffff', gradient: false }
    case 'black':
      return { cssColor: '#000000', gradient: false }
    case 'gray':
      return { cssColor: '#8a8f96', gradient: false }
    case 'custom':
      return { cssColor: r.backgroundColor || '#2b3038', gradient: false }
    case 'gradient':
    default:
      return { cssColor: null, gradient: true }
  }
}
