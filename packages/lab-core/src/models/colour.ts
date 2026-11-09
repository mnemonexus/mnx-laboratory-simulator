// Perceived colour (contract appearance.colour, T2 from optics): what a liquid looks like, computed
// from what it absorbs and scatters rather than from a name. Light from a daylight source (CIE D65)
// passes through the liquid; each species removes light by Beer–Lambert, ε(λ)·c·ℓ, summed over
// species and their forms (indicator forms, complexes) at the liquid's own pH; the eye's response
// is the CIE 1931 2° observer. Suspended solids and cells scatter: they make the liquid cloudy and
// lend it their own body colour. Ideal: no fluorescence, no refraction at the glass, a uniform path.
//
// The colour-matching functions are the multi-lobe Gaussian fits of Wyman, Sloan and Shirley
// (2013), within about 1 % of the CIE 1931 tables; the source is D65 at 10 nm. The white point is
// normalised so that a clear liquid is exactly white.

/** Wavelengths integrated, nm: 380–780 in 5 nm steps. */
export const WAVELENGTHS: readonly number[] = Array.from({ length: 81 }, (_, i) => 380 + 5 * i)

/** CIE standard illuminant D65, relative spectral power at 10 nm from 380 to 780 nm. */
const D65_10NM = [
  49.98, 54.65, 82.75, 91.49, 93.43, 86.68, 104.86, 117.01, 117.81, 114.86, 115.92, 108.81, 109.35, 107.8, 104.79, 107.69, 104.41, 104.05, 100.0, 96.33, 95.79,
  88.69, 90.01, 89.6, 87.7, 83.29, 83.7, 80.03, 80.21, 82.28, 78.28, 69.72, 71.61, 74.35, 61.6, 69.89, 75.09, 63.59, 46.42, 66.81, 63.38,
]

function d65(nm: number): number {
  const x = (nm - 380) / 10
  const i = Math.max(0, Math.min(D65_10NM.length - 2, Math.floor(x)))
  const f = Math.max(0, Math.min(1, x - i))
  return D65_10NM[i] * (1 - f) + D65_10NM[i + 1] * f
}

/** Piecewise Gaussian: σ₁ below the peak, σ₂ above it. */
function lobe(nm: number, mu: number, s1: number, s2: number): number {
  const t = (nm - mu) / (nm < mu ? s1 : s2)
  return Math.exp(-0.5 * t * t)
}

/** CIE 1931 2° colour-matching functions x̄, ȳ, z̄ at a wavelength (Wyman et al. 2013). */
export function cmf(nm: number): [number, number, number] {
  const x = 1.056 * lobe(nm, 599.8, 37.9, 31.0) + 0.362 * lobe(nm, 442.0, 16.0, 26.7) - 0.065 * lobe(nm, 501.1, 20.4, 26.2)
  const y = 0.821 * lobe(nm, 568.8, 46.9, 40.5) + 0.286 * lobe(nm, 530.9, 16.3, 31.1)
  const z = 1.217 * lobe(nm, 437.0, 11.8, 36.0) + 0.681 * lobe(nm, 459.0, 26.0, 13.8)
  return [x, y, z]
}

/** Source × observer weights per wavelength, and the white they integrate to. */
const WEIGHTS = WAVELENGTHS.map((nm) => {
  const [x, y, z] = cmf(nm)
  const s = d65(nm)
  return [x * s, y * s, z * s] as [number, number, number]
})
const WHITE = WEIGHTS.reduce((a, w) => [a[0] + w[0], a[1] + w[1], a[2] + w[2]], [0, 0, 0])

/** D65 white in XYZ (Y = 1), the sRGB reference white. */
const D65_WHITE: [number, number, number] = [0.95047, 1, 1.08883]

/** XYZ (Y of a perfect white = 1) of light through a filter with transmittance T(λ) per WAVELENGTHS. */
export function transmittedXYZ(transmittance: readonly number[]): [number, number, number] {
  let X = 0
  let Y = 0
  let Z = 0
  for (let i = 0; i < WEIGHTS.length; i++) {
    const t = transmittance[i]
    X += t * WEIGHTS[i][0]
    Y += t * WEIGHTS[i][1]
    Z += t * WEIGHTS[i][2]
  }
  // Scale each channel so that T = 1 everywhere lands exactly on D65 white (the fitted functions'
  // own white differs from the tabulated one by under 1 %).
  return [(X / WHITE[0]) * D65_WHITE[0], Y / WHITE[1], (Z / WHITE[2]) * D65_WHITE[2]]
}

/** sRGB companding of a linear channel. */
function encode(c: number): number {
  const v = Math.max(0, Math.min(1, c))
  return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
}

/** Linear sRGB (IEC 61966-2-1) from XYZ, unclipped. */
export function xyzToLinearRgb([X, Y, Z]: readonly [number, number, number]): [number, number, number] {
  return [3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z, -0.969266 * X + 1.8760108 * Y + 0.041556 * Z, 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z]
}

/** Display sRGB (0–1, companded) from XYZ; out-of-gamut colours are desaturated toward their own grey, not clipped per channel. */
export function xyzToSrgb(xyz: readonly [number, number, number]): [number, number, number] {
  const lin = xyzToLinearRgb(xyz)
  const lo = Math.min(...lin)
  if (lo < 0) {
    // Mix toward the grey of equal luminance until no channel is negative: keeps the hue.
    const Y = xyz[1]
    const k = Y / (Y - lo)
    for (let i = 0; i < 3; i++) lin[i] = Y + (lin[i] - Y) * k
  }
  return [encode(lin[0]), encode(lin[1]), encode(lin[2])]
}

/** linear sRGB of a display sRGB colour. */
export function srgbToLinear(c: readonly [number, number, number]): [number, number, number] {
  const d = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))
  return [d(c[0]), d(c[1]), d(c[2])]
}

/** Display sRGB of light through absorbance A(λ) per WAVELENGTHS (decadic, over the whole path). */
export function colourOfAbsorbance(absorbance: readonly number[]): [number, number, number] {
  return xyzToSrgb(transmittedXYZ(absorbance.map((a) => Math.pow(10, -Math.max(0, a)))))
}

/** Hex string (#rrggbb) of a display sRGB colour. */
export function hex(rgb: readonly [number, number, number]): string {
  return '#' + rgb.map((c) => Math.round(Math.max(0, Math.min(1, c)) * 255).toString(16).padStart(2, '0')).join('')
}

/**
 * The colour of a liquid with suspended matter: a fraction `opacity` of what is seen is light
 * scattered back by the particles (their body colour, itself filtered by the liquid), the rest is
 * light through the liquid. Mixed in linear light.
 */
export function withScattering(liquid: readonly [number, number, number], body: readonly [number, number, number], opacity: number): [number, number, number] {
  const a = srgbToLinear(liquid)
  const b = srgbToLinear(body)
  const o = Math.max(0, Math.min(1, opacity))
  const mixed = [0, 1, 2].map((i) => a[i] * (1 - o) + b[i] * a[i] * o) as [number, number, number]
  return [encode(mixed[0]), encode(mixed[1]), encode(mixed[2])]
}

/** CIE L*a*b* (D65) of a display sRGB colour: lightness 0–100 and the two opponent axes. */
export function srgbToLab(rgb: readonly [number, number, number]): [number, number, number] {
  const [r, g, b] = srgbToLinear(rgb)
  const X = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / D65_WHITE[0]
  const Y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b
  const Z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / D65_WHITE[2]
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116)
  const fx = f(X)
  const fy = f(Y)
  const fz = f(Z)
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

/** Hue names by CIE LCh hue angle (degrees): [upper limit, name when light, name when dark]. */
const HUES: ReadonlyArray<readonly [number, string, string]> = [
  [15, 'pink', 'red'],
  [45, 'red', 'red'],
  [72, 'orange', 'brown'],
  [110, 'yellow', 'brown'],
  [140, 'yellow-green', 'green'],
  [195, 'green', 'green'],
  [218, 'blue-green', 'blue-green'],
  [310, 'blue', 'blue'],
  [328, 'violet', 'violet'],
  [345, 'pink', 'purple'],
  [360, 'pink', 'red'],
]

/**
 * A plain name for a colour as an observer would give it: a liquid barely tinted is "colourless" (a
 * solid "white"), the
 * hue by its angle (lighter and darker names where people use different words: pink and purple,
 * orange and brown), and "pale" or "deep" by lightness.
 */
export function colourName(rgb: readonly [number, number, number], kind: 'liquid' | 'solid' = 'liquid'): string {
  const [L, a, b] = srgbToLab(rgb)
  const C = Math.hypot(a, b)
  if (C < 8) return L > 70 ? (kind === 'liquid' ? 'colourless' : 'white') : L > 35 ? 'grey' : 'black'
  let h = (Math.atan2(b, a) * 180) / Math.PI
  if (h < 0) h += 360
  const [, light, dark] = HUES.find(([limit]) => h < limit) ?? HUES[0]
  let hue = L >= 55 ? light : dark
  // Brown is a dark orange of modest chroma; a dark orange as vivid as a pigment reads as red.
  if (hue === 'brown' && C >= 65 && h < 72) hue = h < 55 ? 'red' : 'orange'
  if (hue === 'brown') return hue
  const shade = L > 90 && C < 15 ? 'very pale ' : L > 80 && C < 35 ? 'pale ' : L < 30 ? 'deep ' : ''
  return shade + hue
}
