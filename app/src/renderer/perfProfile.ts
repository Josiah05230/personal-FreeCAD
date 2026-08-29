/**
 * A one-shot read of what this machine can spare, used to size caches and how
 * aggressively we prefetch / render. Deliberately conservative: the goal is that
 * a weak laptop stays responsive and a strong workstation does more work ahead
 * of time. Everything degrades gracefully if the hints are missing.
 */

export interface PerfProfile {
  tier: 'low' | 'mid' | 'high'
  cores: number
  memGB: number
  /** how many timeline steps either side of the marker to warm in the background */
  prefetchRadius: number
  /** max scene/tree snapshots to keep cached */
  rollCacheMax: number
  /** devicePixelRatio ceiling for the WebGL renderer */
  pixelRatioCap: number
  /** software / very weak GL detected -> caller may drop effects */
  softwareGL: boolean
}

function detectSoftwareGL(): boolean {
  try {
    const c = document.createElement('canvas')
    const gl = (c.getContext('webgl2') || c.getContext('webgl')) as WebGLRenderingContext | null
    if (!gl) return true
    const dbg = gl.getExtension('WEBGL_debug_renderer_info')
    const r = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : ''
    return /swiftshader|software|llvmpipe|basic render/i.test(r)
  } catch {
    return false
  }
}

let _profile: PerfProfile | null = null

export function perfProfile(): PerfProfile {
  if (_profile) return _profile
  const cores = Math.max(1, Number(navigator.hardwareConcurrency) || 4)
  // deviceMemory is Chromium-only and quantised (0.25..8); treat missing as 8
  const memGB = Number((navigator as unknown as { deviceMemory?: number }).deviceMemory) || 8
  const softwareGL = detectSoftwareGL()

  let tier: PerfProfile['tier'] = 'mid'
  if (softwareGL || cores <= 2 || memGB <= 2) tier = 'low'
  else if (cores >= 8 && memGB >= 8) tier = 'high'

  _profile = {
    tier,
    cores,
    memGB,
    prefetchRadius: tier === 'high' ? 2 : tier === 'mid' ? 1 : 0,
    rollCacheMax: tier === 'high' ? 24 : tier === 'mid' ? 12 : 6,
    pixelRatioCap: tier === 'low' ? 1 : 2,
    softwareGL
  }
  return _profile
}
