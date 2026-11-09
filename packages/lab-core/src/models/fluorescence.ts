// Fluorescence (contract measurement.fluorescence, T2). A fluorophore absorbs at the excitation
// wavelength (its molar absorption coefficient) and emits a band around its emission maximum, with
// its quantum yield. A probe whose `fluorescence.bound` names a protein emits differently when bound
// to it (ANS: almost dark in water, bright and blue-shifted in a hydrophobic pocket); the bound share
// follows from the sites and Kd (exact single-class binding). Light is absorbed on its way to the
// middle of the cell and on its way out (the inner filter effect), so a strongly absorbing solution
// gives less than its concentration would suggest.
// Ideal: Gaussian bands, no quenching or energy transfer, one class of sites, a 1 cm cell read at 90°.
import type { Catalogue } from '../catalogue/catalogue.ts'
import { type Container, liquidVolume, meanLayer } from '../kernel/state.ts'
import { parseValue } from '../units/index.ts'
import { sampleAbsorbance, epsilon } from './measurement.ts'

/** Counts per (absorbance unit absorbed × quantum yield) at the band's peak. */
const GAIN = 2e6
/** A fluorophore's band half-width when the catalogue gives none (nm, Gaussian σ). */
const DEFAULT_WIDTH = 30

export interface EmissionSpectrum {
  wavelengths: number[]
  intensity: number[]
}

/** Bound concentration (M) of a ligand L with a protein offering S sites of dissociation constant Kd. */
export function boundLigand(ligandM: number, sitesM: number, kdM: number): number {
  const b = ligandM + sitesM + kdM
  return Math.max(0, (b - Math.sqrt(Math.max(0, b * b - 4 * ligandM * sitesM))) / 2)
}

/** The true emission spectrum of a cuvette's contents, excited at `exNm`, from `from` to `to` nm. */
export function emissionSpectrum(cat: Catalogue, c: Container, exNm: number, from: number, to: number, step = 2): EmissionSpectrum {
  const v = liquidVolume(c.contents)
  const wavelengths: number[] = []
  for (let nm = from; nm <= to + 1e-9; nm += step) wavelengths.push(nm)
  if (!(v > 0)) return { wavelengths, intensity: wavelengths.map(() => 0) }
  const mean = meanLayer(c.contents)
  const conc = (s: string) => (mean.species[s] ?? 0) / v
  // Each emitting population: its absorbance at the excitation, its yield and its band.
  const emitters: Array<{ absorbed: number; yield: number; centre: number; width: number }> = []
  for (const [s, n] of Object.entries(mean.species)) {
    const f = cat.substances.get(s)?.fluorescence
    if (!f || !(n > 0)) continue
    const total = n / v
    const absorbedPerM = epsilon(cat, s, exNm)
    if (!(absorbedPerM > 0)) continue
    let bound = 0
    if (f.bound) {
      const sites = conc(f.bound.to) * (f.bound.sites ?? 1)
      if (sites > 0) bound = boundLigand(total, sites, parseValue(f.bound.kd).si / 1000)
    }
    const width = f.width ?? DEFAULT_WIDTH
    emitters.push({ absorbed: absorbedPerM * (total - bound), yield: f.yield, centre: f.emission, width })
    if (f.bound && bound > 0) emitters.push({ absorbed: absorbedPerM * bound, yield: f.bound.yield, centre: f.bound.emission, width })
  }
  // Inner filter: the exciting beam and the emitted light each cross half the 1 cm cell.
  const exFilter = Math.pow(10, -0.5 * sampleAbsorbance(cat, c, exNm, 1))
  const intensity = wavelengths.map((nm) => {
    let i = 0
    for (const e of emitters) i += e.absorbed * e.yield * Math.exp(-0.5 * ((nm - e.centre) / e.width) ** 2)
    return GAIN * i * exFilter * Math.pow(10, -0.5 * sampleAbsorbance(cat, c, nm, 1))
  })
  return { wavelengths, intensity }
}
