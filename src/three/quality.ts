// Graphics quality tiers.
// One table drives every cost knob in the renderer: pixel ratio, anti-aliasing,
// post effects, the lighting bake, reflection probes, texture resolution and
// prop detail. "Auto" picks a tier from the GPU string. In a session, a
// frame-time watchdog lowers resolution and then sheds runtime effects; if that
// is not enough, Auto starts one tier lower at the next launch (never up, and
// never a rebuild while the lab is in use).

export type Tier = 'low' | 'medium' | 'high' | 'ultra'
export type Preset = 'auto' | Tier | 'custom'

export const TIERS: Tier[] = ['low', 'medium', 'high', 'ultra']

export interface GraphicsSettings {
  /** multiplier on the tier's pixel-ratio cap (0.5 – 1) */
  renderScale: number
  maxPixelRatio: number
  /** dynamic resolution never drops below this fraction of the cap */
  minDynamicScale: number
  /** SMAA is a cheap post-process edge filter; MSAA is hardware multisampling */
  antialias: 'off' | 'smaa' | 'msaa4' | 'msaa8'
  /** supersample the image progressively whenever the camera is still */
  refine: boolean
  ao: 'off' | 'half' | 'full'
  /** screen-space reflections on polished floors and worktops (over the room probe) */
  ssr: 'off' | 'half' | 'full'
  bloom: boolean
  shadows: 'off' | 'medium' | 'high'
  /** baked lighting quality */
  lighting: Tier
  /** procedural texture resolution */
  textures: Tier
  detail: 'reduced' | 'full'
  /** 0 = follow display refresh */
  fpsCap: 30 | 60 | 0
}

export const PRESETS: Record<Tier, GraphicsSettings> = {
  low: {
    renderScale: 1,
    maxPixelRatio: 1,
    minDynamicScale: 0.6,
    antialias: 'smaa',
    refine: false,
    ao: 'off',
    ssr: 'off',
    bloom: false,
    shadows: 'off',
    lighting: 'low',
    textures: 'low',
    detail: 'reduced',
    fpsCap: 60,
  },
  medium: {
    renderScale: 1,
    maxPixelRatio: 1.25,
    minDynamicScale: 0.7,
    antialias: 'msaa4',
    refine: false,
    ao: 'off',
    ssr: 'off',
    bloom: false,
    shadows: 'off',
    lighting: 'medium',
    textures: 'medium',
    detail: 'full',
    fpsCap: 60,
  },
  high: {
    renderScale: 1,
    maxPixelRatio: 1.5,
    minDynamicScale: 0.8,
    antialias: 'msaa4',
    refine: true,
    ao: 'off',
    ssr: 'half',
    bloom: true,
    shadows: 'off',
    lighting: 'high',
    textures: 'high',
    detail: 'full',
    fpsCap: 60,
  },
  ultra: {
    renderScale: 1,
    maxPixelRatio: 2,
    minDynamicScale: 0.9,
    antialias: 'msaa4',
    refine: true,
    ao: 'full',
    ssr: 'full',
    bloom: true,
    shadows: 'high',
    lighting: 'ultra',
    textures: 'ultra',
    detail: 'full',
    fpsCap: 0,
  },
}

/**
 * Baked light is the same on every tier: it is baked once, offline, and
 * shipped (`npm run bake`), so a phone shows the same light as a desktop at no
 * cost. Lightmap texel and irradiance-volume cell, in scene units.
 */
export const LIGHTMAP_TEXEL = 0.05
export const VOLUME_CELL = 0.16

/**
 * Sampling for the shipped bake (`offline`), and for the fallback that bakes a
 * room at load when the shipped bake no longer matches it (a layout changed).
 */
export const BAKE_SAMPLING = {
  offline: { aoRays: 64, lightSamples: 4, supersample: 2 },
  runtime: { aoRays: 8, lightSamples: 2, supersample: 1 },
} as const

/**
 * Reflection probe size per lighting tier. Every room's probe stays resident
 * (no captures while walking), so it sets that memory: roughly 0.4 / 1.7 /
 * 1.7 / 6.7 MB per room.
 */
export const BAKE_QUALITY: Record<Tier, { probeSize: number }> = {
  low: { probeSize: 64 },
  medium: { probeSize: 128 },
  high: { probeSize: 128 },
  ultra: { probeSize: 256 },
}

/** Texture resolution / filtering per texture tier. */
export const TEXTURE_QUALITY: Record<Tier, { size: number; normalMaps: boolean; anisotropy: number }> = {
  low: { size: 512, normalMaps: false, anisotropy: 2 },
  medium: { size: 1024, normalMaps: true, anisotropy: 4 },
  high: { size: 1024, normalMaps: true, anisotropy: 8 },
  ultra: { size: 2048, normalMaps: true, anisotropy: 16 },
}

/** Settings that can only change by rebuilding the renderer / world. */
export function rebuildKey(s: GraphicsSettings) {
  return [s.antialias, s.shadows, s.lighting, s.textures, s.detail].join('|')
}

export interface GpuInfo {
  tier: Tier
  renderer: string
}

let detected: GpuInfo | null = null

/** Pick a tier from the GPU string and device hints. Ultra is never automatic. */
export function detectTier(): GpuInfo {
  if (detected) return detected
  let renderer = ''
  try {
    const canvas = document.createElement('canvas')
    const gl = (canvas.getContext('webgl2') || canvas.getContext('webgl')) as WebGLRenderingContext | null
    if (gl) {
      const info = gl.getExtension('WEBGL_debug_renderer_info')
      renderer = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER))
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
  } catch {
    /* no WebGL — the viewport will report its own error */
  }
  const r = renderer.toLowerCase()
  const nav = navigator as Navigator & { deviceMemory?: number }
  const cores = nav.hardwareConcurrency ?? 8
  const memory = nav.deviceMemory ?? 8
  const mobile = /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent)

  let tier: Tier = 'medium'
  if (/swiftshader|llvmpipe|softpipe|basic render|software/.test(r)) tier = 'low'
  else if (mobile) tier = /apple gpu|adreno \(tm\) 7|adreno 7/.test(r) ? 'medium' : 'low'
  else if (/nvidia|geforce|rtx|gtx|quadro|radeon rx|radeon pro|rx \d{3,4}|arc\(tm\) a|arc a\d/.test(r)) tier = 'high'
  else if (/apple m\d|apple gpu/.test(r)) tier = 'high'
  else if (/iris|xe graphics|radeon\(tm\) graphics|radeon graphics|vega|780m|760m|680m/.test(r)) tier = 'medium'
  else if (/intel|uhd|hd graphics|mali|powervr|adreno/.test(r)) tier = 'low'

  if (tier !== 'low' && (cores <= 4 || memory <= 4)) tier = TIERS[Math.max(0, TIERS.indexOf(tier) - 1)]
  detected = { tier, renderer }
  return detected
}

export function lowerTier(t: Tier): Tier {
  return TIERS[Math.max(0, TIERS.indexOf(t) - 1)]
}
