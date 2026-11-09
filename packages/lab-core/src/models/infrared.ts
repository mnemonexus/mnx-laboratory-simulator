// Infrared spectroscopy (contract measurement.infrared, T2): an ATR spectrum of a solid or neat
// liquid sample. Each substance's `ir` facet lists its bands (wavenumber, strength, half-width);
// the sample absorbs as the mass-weighted sum of its components' bands, water in a wet sample
// included, and the spectrum is shown as % transmittance from 4000 to 600 cm⁻¹. The bands an
// analyst would pick out are the dips deeper than a threshold, labelled strong, medium or weak
// and broad where they are wide.
// Ideal: band shapes are Gaussian, intensities add, and the ATR depth does not vary with wavenumber.
import type { Catalogue } from '../catalogue/catalogue.ts'
import { molarMass } from '../kernel/materials.ts'
import type { Contents } from '../kernel/state.ts'
import { waterMol } from './distillation.ts'

export const IR_FROM = 4000
export const IR_TO = 600
export const IR_STEP = 2

/** Water's own bands, for a wet sample (O–H stretch and H–O–H bend). */
const WATER_BANDS: Array<[number, number, number]> = [[3400, 0.9, 180], [1640, 0.35, 40]]
/** How deep a band of strength 1 in a pure sample absorbs (absorbance units at its centre). */
const DEPTH = 1.1

export interface IrBand {
  wavenumber: number
  /** Share of the light absorbed at the band's centre (0..1). */
  depth: number
  strength: 'strong' | 'medium' | 'weak'
  broad: boolean
}

export interface IrSpectrum {
  wavenumbers: number[]
  transmittance: number[]
  bands: IrBand[]
}

/** The sample's components by mass fraction (solid, dissolved, and water if wet). */
function massFractions(cat: Catalogue, c: Contents): Array<{ bands: Array<[number, number, number]>; w: number }> {
  const grams: Record<string, number> = {}
  for (const [s, n] of Object.entries(c.solid)) if (n > 0) grams[s] = (grams[s] ?? 0) + n * (molarMass(cat, s) ?? 0)
  let waterG = 0
  for (const l of c.layers) {
    waterG += waterMol(cat, l) * 18.015
    for (const [s, n] of Object.entries(l.species)) if (n > 0) grams[s] = (grams[s] ?? 0) + n * (molarMass(cat, s) ?? 0)
  }
  const total = Object.values(grams).reduce((a, g) => a + g, 0) + waterG
  if (!(total > 0)) return []
  const out = Object.entries(grams).flatMap(([s, g]) => {
    const bands = cat.substances.get(s)?.ir
    return bands?.length ? [{ bands, w: g / total }] : []
  })
  if (waterG > 0) out.push({ bands: WATER_BANDS, w: waterG / total })
  return out
}

/** The true spectrum of what is in a container, or undefined if nothing in it shows in the infrared. */
export function irSpectrum(cat: Catalogue, c: Contents): IrSpectrum | undefined {
  const parts = massFractions(cat, c)
  if (parts.length === 0) return undefined
  const wavenumbers: number[] = []
  const absorbance: number[] = []
  for (let v = IR_FROM; v >= IR_TO; v -= IR_STEP) {
    let a = 0
    for (const p of parts) for (const [nu, h, hw] of p.bands) {
      const x = (v - nu) / hw
      if (Math.abs(x) < 4) a += p.w * h * DEPTH * Math.exp(-x * x * Math.LN2)
    }
    wavenumbers.push(v)
    absorbance.push(a)
  }
  const transmittance = absorbance.map((a) => 100 * Math.pow(10, -a))
  return { wavenumbers, transmittance, bands: pickBands(wavenumbers, transmittance) }
}

/** Dips in a % transmittance trace deeper than `minDepth` (in %T), with their strength and width. */
export function pickBands(wavenumbers: number[], t: number[], minDepth = 8): IrBand[] {
  const out: IrBand[] = []
  for (let i = 1; i < t.length - 1; i++) {
    if (!(t[i] < t[i - 1] && t[i] <= t[i + 1])) continue
    const depth = 100 - t[i]
    if (depth < minDepth) continue
    // Width at half depth, walking out each side.
    const half = 100 - depth / 2
    let l = i
    while (l > 0 && t[l] < half) l--
    let r = i
    while (r < t.length - 1 && t[r] < half) r++
    const fwhm = Math.abs(wavenumbers[l] - wavenumbers[r])
    out.push({ wavenumber: wavenumbers[i], depth: depth / 100, strength: depth > 55 ? 'strong' : depth > 25 ? 'medium' : 'weak', broad: fwhm > 120 })
  }
  return out
}

/** A band as an analyst writes it: "1740 (s)", "3330 (br, s)". */
export function bandText(b: IrBand): string {
  return `${b.wavenumber} (${b.broad ? 'br, ' : ''}${b.strength[0]})`
}

