// Gas laws (contract gas.ideal, T2): air trapped in a sealed syringe obeys pV = nRT. With the plunger
// free it stays at atmospheric pressure and its volume follows the temperature (Charles); held at a
// volume, its pressure follows (Boyle). A liquid in it evaporates until its vapour reaches the
// liquid's vapour pressure (Raoult's law over its mole fraction; Clausius–Clapeyron from the boiling
// point and enthalpy of vaporisation), or all of it is vapour (a volatile liquid injected into a hot
// syringe, the basis of finding its molar mass). The vapour is taken as ideal too.
import type { Catalogue } from '../catalogue/catalogue.ts'
import { type Container, type Contents } from '../kernel/state.ts'
import { parseValue } from '../units/index.ts'
import { waterMol } from './distillation.ts'

export const R_J = 8.314462618
export const ATM_KPA = 101.325
const WATER = 'core:water'

/** Vapour pressure of a pure liquid (kPa) at T, or undefined if it is not volatile (no boiling point and enthalpy of vaporisation). */
export function vapourPressureKPa(cat: Catalogue, substance: string, T: number): number | undefined {
  const p = cat.substances.get(substance)?.physical
  if (!p?.enthalpyOfVaporisation) return undefined
  const dH = parseValue(p.enthalpyOfVaporisation).si
  const bp = p.boilingPoint ? parseValue(p.boilingPoint).si : substance === WATER ? 373.15 : undefined
  if (bp === undefined) return undefined
  return ATM_KPA * Math.exp((-dH / R_J) * (1 / T - 1 / bp))
}

/** The volatile liquids in the contents: mol of each, and its partial vapour pressure over the liquid (kPa). */
function volatiles(cat: Catalogue, contents: Contents, T: number): Array<{ substance: string; mol: number; pKPa: number }> {
  const mol: Record<string, number> = {}
  let total = 0
  for (const l of contents.layers) {
    if (!(l.volumeL > 0)) continue
    const w = waterMol(cat, l)
    mol[WATER] = (mol[WATER] ?? 0) + w
    total += w
    for (const [s, n] of Object.entries(l.species)) {
      if (!(n > 0)) continue
      total += n
      if (cat.substances.get(s)?.physical?.enthalpyOfVaporisation) mol[s] = (mol[s] ?? 0) + n
    }
  }
  const out: Array<{ substance: string; mol: number; pKPa: number }> = []
  for (const [s, n] of Object.entries(mol)) {
    const pure = vapourPressureKPa(cat, s, T)
    if (pure !== undefined && n > 0) out.push({ substance: s, mol: n, pKPa: pure * (n / total) })
  }
  return out
}

export interface GasSampleState {
  volumeL: number
  pressureKPa: number
  /** Mol of each liquid that is vapour. */
  vapourMol: Record<string, number>
  /** The plunger is at its stop (it would have gone further). */
  atStop: boolean
}

/** The gas in a sealed syringe: its volume and pressure at the contents' temperature. */
export function gasSampleState(cat: Catalogue, c: Container): GasSampleState {
  const g = c.gasSample!
  const T = c.contents.temperatureK
  const RT = R_J * T // kPa·L/mol (1 J = 1 kPa·L)
  const vols = volatiles(cat, c.contents, T)
  const vapourAt = (V: number) => {
    const out: Record<string, number> = {}
    for (const x of vols) out[x.substance] = Math.min(x.mol, (x.pKPa * V) / RT)
    return out
  }
  const sum = (o: Record<string, number>) => Object.values(o).reduce((a, n) => a + n, 0)
  // The trapped gas: its air, and what respiration has taken from it (oxygen) or added (carbon dioxide).
  const gasMol = g.airMol + sum(g.delta ?? {})
  const fixed = g.fixedL !== undefined ? g.fixedL : undefined
  let V: number
  let atStop = false
  if (fixed === undefined) {
    // Free plunger: find V where the gas exerts one atmosphere (f rises with V; bisect).
    const f = (v: number) => (ATM_KPA * v) / RT - gasMol - sum(vapourAt(v))
    let lo = 0
    let hi = Math.max(1e-6, ((gasMol + vols.reduce((a, x) => a + x.mol, 0)) * RT) / ATM_KPA) * 1.01
    for (let i = 0; i < 80; i++) {
      const mid = (lo + hi) / 2
      if (f(mid) > 0) hi = mid
      else lo = mid
    }
    V = hi
    if (V > c.capacityL) {
      V = c.capacityL
      atStop = true
    }
  } else V = fixed
  const vapourMol = vapourAt(V)
  const pressureKPa = ((gasMol + sum(vapourMol)) * RT) / V
  return { volumeL: V, pressureKPa: fixed === undefined && !atStop ? ATM_KPA : pressureKPa, vapourMol, atStop }
}

/** Mol of air in a volume at a temperature and one atmosphere. */
export function airMolIn(volumeL: number, T: number): number {
  return (ATM_KPA * volumeL) / (R_J * T)
}

/**
 * A monolayer of an amphiphile spread on water (contract surface.monolayer): each molecule takes its
 * cross-section, so the film's area is the number of molecules times that area (m²).
 */
export function monolayerAreaM2(cat: Catalogue, contents: Contents): number {
  let area = 0
  for (const l of contents.layers) {
    for (const [s, n] of Object.entries(l.species)) {
      const a = cat.substances.get(s)?.monolayer?.areaNm2
      if (a && n > 0) area += n * 6.02214076e23 * a * 1e-18
    }
  }
  return area
}
