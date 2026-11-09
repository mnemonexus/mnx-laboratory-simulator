// Flame emission (contract appearance.flame, T2 from atomic and molecular emission): what colour a
// sample gives a non-luminous Bunsen flame, computed from what its atoms and molecules emit rather
// than from a table of flame colours. Each emitting element carries its lines and bands (catalogue
// facet `emission`: wavelength and radiant power per mol in the flame; bands have a width, and some
// need a partner such as chloride for CuCl). The spectrum adds to the burner's own faint blue (CH
// and C₂ emission); the eye's response is the CIE 1931 observer, and its brightness response is
// logarithmic over about five decades. Cobalt-blue glass filters the light before the eye; a
// spectroscope shows the bright lines themselves.
//
// Ideal: what reaches the flame is a fixed share of what the wire holds, saturating as the wire is
// loaded (a heavily loaded wire does not put proportionally more into the flame); no self-absorption,
// no spectral interference between elements beyond adding their light.
import type { Catalogue } from '../catalogue/catalogue.ts'
import type { Contents } from '../kernel/state.ts'
import { cmf, colourName, srgbToLab } from './colour.ts'

/** Amount on the wire (mol of emitter) at which the flame's uptake is half of proportional. */
const SATURATION_MOL = 1e-6
/** The burner's own light, in the same units as a line's weight × mol: the faint blue of a roaring flame. */
const BURNER_Y = 2e-7
/** CH (431 nm) and C₂ Swan (516 nm) bands and a weak blue continuum: shares of the burner's light. */
const BURNER_LINES: ReadonlyArray<EmissionLine> = [
  { nm: 431, width: 4, weight: 1 / 2 },
  { nm: 516, width: 5, weight: 0.2 },
  { nm: 470, width: 40, weight: 0.3 },
]
/** Luminance (same units) the eye can just see in the flame, and five decades above it, dazzling. */
const THRESHOLD_Y = 1e-8
const DECADES = 5

export interface EmissionLine {
  /** Wavelength (nm). */
  nm: number
  /** Radiant power per mol of the element in the flame (relative units; the sodium D lines total 1000). */
  weight: number
  /** A molecular band's full width at half maximum (nm); absent for an atomic line. */
  width?: number
  /** A band needing a partner on the wire (CuCl needs chloride): scaled by the partner's share, up to one per element. */
  with?: string
}

/** A filter between the flame and the eye: transmittance at a wavelength. */
export type Filter = (nm: number) => number

/** Cobalt-blue glass: passes violet and blue and the deep red, absorbs from green to orange (sodium's yellow almost wholly). */
export const COBALT_GLASS: Filter = (nm) => {
  if (nm < 500) return 0.7
  if (nm < 520) return 0.7 - (nm - 500) * 0.0345
  if (nm < 650) return nm > 555 && nm < 625 ? 1e-4 : 0.003
  if (nm < 690) return 0.003 + (nm - 650) * 0.015
  return 0.6
}

/**
 * The observer, with the red tail the fitted functions miss: beyond 680 nm the CIE 1931 x̄ halves
 * every 10 nm (0.0468 at 680, 8 × 10⁻⁵ at 770) and ȳ is 0.36 of it. Potassium's lines at 766 and
 * 770 nm depend on it.
 */
function observer(nm: number): [number, number, number] {
  if (nm >= 680) {
    const x = 0.0468 * Math.pow(2, -(nm - 680) / 10)
    return [x, 0.36 * x, 0]
  }
  return cmf(nm)
}

/** Emitters in some contents (mol per element carrier), counting salts and solids by their ions. */
export function emittersIn(cat: Catalogue, contents: Contents, share = 1): Record<string, number> {
  const out: Record<string, number> = {}
  const add = (s: string, n: number) => {
    if (!(n > 0)) return
    const def = cat.substances.get(s)
    if (def?.emission || s === 'aq:chloride') out[s] = (out[s] ?? 0) + n * share
    for (const [ion, k] of Object.entries(def?.ions ?? {})) {
      if (cat.substances.get(ion)?.emission || ion === 'aq:chloride') out[ion] = (out[ion] ?? 0) + n * k * share
    }
  }
  for (const [s, n] of Object.entries(contents.solid)) add(s, n)
  for (const l of contents.layers) {
    for (const [s, n] of Object.entries(l.species)) add(s, n)
    for (const [s, n] of Object.entries(l.particles ?? {})) add(s, n)
  }
  return out
}

/** Every line and band the emitters give, with its power (weight × the amount in the flame). */
export function flameLines(cat: Catalogue, onWire: Record<string, number>): Array<EmissionLine & { power: number; element: string }> {
  let total = 0
  for (const [s, n] of Object.entries(onWire)) if (cat.substances.get(s)?.emission) total += n
  // Uptake into the flame saturates as the wire is loaded.
  const uptake = SATURATION_MOL / (total + SATURATION_MOL)
  const out: Array<EmissionLine & { power: number; element: string }> = []
  for (const [s, n] of Object.entries(onWire)) {
    const em = cat.substances.get(s)?.emission
    if (!em || !(n > 0)) continue
    for (const line of em.lines) {
      const partner = line.with ? Math.min(1, (onWire[line.with] ?? 0) / n) : 1
      const power = n * uptake * line.weight * partner
      if (power > 0) out.push({ ...line, power, element: s })
    }
  }
  return out
}

/** XYZ of a set of lines (power per line) through a filter: a line at its wavelength, a band as a Gaussian. */
function linesXYZ(lines: ReadonlyArray<EmissionLine & { power: number }>, filter?: Filter): [number, number, number] {
  const xyz: [number, number, number] = [0, 0, 0]
  const at = (nm: number, power: number) => {
    const c = observer(nm)
    const t = filter ? filter(nm) : 1
    for (let i = 0; i < 3; i++) xyz[i] += power * c[i] * t
  }
  for (const l of lines) {
    if (!l.width) {
      at(l.nm, l.power)
      continue
    }
    const sigma = l.width / 2.355
    const step = Math.max(0.25, sigma / 4)
    let norm = 0
    for (let nm = l.nm - 3 * sigma; nm <= l.nm + 3 * sigma; nm += step) norm += Math.exp(-0.5 * ((nm - l.nm) / sigma) ** 2)
    for (let nm = l.nm - 3 * sigma; nm <= l.nm + 3 * sigma; nm += step) at(nm, (l.power * Math.exp(-0.5 * ((nm - l.nm) / sigma) ** 2)) / norm)
  }
  return xyz
}

/** Flame colour names by CIE LCh hue of the light at full brightness: [upper limit, name]. */
const FLAME_HUES: ReadonlyArray<readonly [number, string]> = [
  [33, 'crimson'],
  [50, 'red'],
  [60, 'orange-red'],
  [90, 'yellow-orange'],
  [110, 'yellow'],
  [148, 'apple green'],
  [162, 'green'],
  [200, 'blue-green'],
  [290, 'blue'],
  [350, 'lilac'],
  [360, 'crimson'],
]

export interface FlameLook {
  /** What it looks like on the flame as displayed (sRGB 0–1, dimmed by its brightness). */
  rgb: [number, number, number]
  /** The colour at full brightness (sRGB 0–1). */
  hue: [number, number, number]
  /** Perceived brightness 0–1 (logarithmic: the threshold of seeing to dazzling). */
  brightness: number
  /** What an observer would call it: "intense yellow-orange", "faint lilac", or "blue" when the sample adds nothing visible. */
  name: string
}

const lin = ([X, Y, Z]: readonly number[]): [number, number, number] => [
  3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z,
  -0.969266 * X + 1.8760108 * Y + 0.041556 * Z,
  0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z,
]
const encode = (v: number) => {
  const c = Math.max(0, Math.min(1, v))
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
}

/** The flame as seen (directly or through a filter) with these emitters on the wire. */
export function flameLook(cat: Catalogue, onWire: Record<string, number>, filter?: Filter): FlameLook {
  const sample = linesXYZ(flameLines(cat, onWire), filter)
  const burner = linesXYZ(BURNER_LINES.map((l) => ({ ...l, power: (l.weight * BURNER_Y) / 0.3 })), filter)
  const xyz = [0, 1, 2].map((i) => sample[i] + burner[i])
  const Y = xyz[1]
  const brightness = Math.max(0, Math.min(1, Math.log10(Y / THRESHOLD_Y) / DECADES))
  // The hue at full brightness: out-of-gamut light (a pure spectral line) is desaturated toward its
  // own white, then scaled so its brightest channel is full.
  const l = lin(xyz.map((v) => v / Y))
  const lo = Math.min(...l)
  if (lo < 0) for (let i = 0; i < 3; i++) l[i] = 1 + (l[i] - 1) / (1 - lo)
  const peak = Math.max(...l)
  const hue = l.map((v) => encode(v / peak)) as [number, number, number]
  const rgb = l.map((v) => encode((v / peak) * brightness)) as [number, number, number]
  let name: string
  if (sample[1] < 0.3 * burner[1]) name = 'blue'
  else if (brightness < 0.08) name = 'no colour'
  else {
    const [, a, b] = srgbToLab(hue)
    let h = (Math.atan2(b, a) * 180) / Math.PI
    if (h < 0) h += 360
    const base = Math.hypot(a, b) < 15 ? colourName(hue, 'solid') : (FLAME_HUES.find(([limit]) => h < limit) ?? FLAME_HUES[0])[1]
    name = (brightness > 0.9 ? 'intense ' : brightness < 0.3 ? 'faint ' : '') + base
  }
  return { rgb, hue, brightness, name }
}

/**
 * The bright lines a hand spectroscope shows (nm, to its resolution), strongest first: atomic lines
 * and the centres of bands, those bright enough to see against the burner's own light.
 */
export function spectroscopeLines(cat: Catalogue, onWire: Record<string, number>, resolutionNm = 2): Array<{ nm: number; colour: string; band: boolean; brightness: number }> {
  const out: Array<{ nm: number; colour: string; band: boolean; brightness: number }> = []
  for (const l of flameLines(cat, onWire)) {
    const xyz = linesXYZ([{ ...l, width: undefined }])
    const Y = xyz[1]
    const brightness = Math.max(0, Math.min(1, Math.log10(Y / THRESHOLD_Y) / DECADES))
    // Against the instrument's dark field a line is seen nearer the threshold than in the open flame.
    if (brightness < 0.05) continue
    const nm = Math.round(l.nm)
    const near = out.find((x) => Math.abs(x.nm - nm) < resolutionNm * 1.5)
    if (near) {
      near.brightness = Math.max(near.brightness, brightness)
      continue
    }
    out.push({ nm, colour: spectralName(l.nm), band: !!l.width, brightness })
  }
  return out.sort((a, b) => b.brightness - a.brightness)
}

/** The colour of a spectral line by its wavelength. */
function spectralName(nm: number): string {
  if (nm < 450) return 'violet'
  if (nm < 490) return 'blue'
  if (nm < 505) return 'blue-green'
  if (nm < 560) return 'green'
  if (nm < 580) return 'yellow-green'
  if (nm < 595) return 'yellow'
  if (nm < 620) return 'orange'
  return 'red'
}
