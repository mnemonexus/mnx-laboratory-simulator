// Distillation (contract equilibrium.vapour-liquid, T2). A binary vapour–liquid equilibrium is
// catalogue data: a table of liquid mole fraction x of the lighter component against the vapour's
// y and the boiling temperature, at 1 atm. Boiling the pot sends up vapour of composition y(x);
// a fractionating column of N theoretical plates re-equilibrates it N more times (stepped at total
// reflux), so the distillate is richer, up to the azeotrope where y = x. The pot is depleted in
// small steps (Rayleigh distillation), so the head temperature climbs as the light component runs
// out. Volumes are taken as additive (ideal mixing), as everywhere in the kernel.
import type { Catalogue } from '../catalogue/catalogue.ts'
import type { Layer } from '../kernel/state.ts'
import { parseValue } from '../units/index.ts'

export interface Vle {
  light: string
  x: number[]
  y: number[]
  /** Boiling temperature (K) at each x. */
  T: number[]
}

/** The VLE model for a pot holding its light component, if the catalogue has one. */
export function vleFor(cat: Catalogue, layer: Layer): Vle | undefined {
  for (const m of cat.models.values()) {
    const v = m.vle
    if (m.contract !== 'equilibrium.vapour-liquid' || !v) continue
    if ((layer.species[v.light] ?? 0) > 0) return { light: v.light, x: v.x, y: v.y, T: v.T.map((c) => c + 273.15) }
  }
  return undefined
}

function lerp(xs: number[], ys: number[], x: number): number {
  if (x <= xs[0]) return ys[0]
  for (let i = 0; i + 1 < xs.length; i++) if (x <= xs[i + 1]) return ys[i] + ((ys[i + 1] - ys[i]) * (x - xs[i])) / (xs[i + 1] - xs[i])
  return ys[ys.length - 1]
}

/** Vapour leaving the top of a column of `stages` equilibrium stages (the pot is the first). */
export function vapourAfter(vle: Vle, x: number, stages: number): number {
  let y = x
  for (let k = 0; k < stages; k++) y = lerp(vle.x, vle.y, y)
  return y
}

export function boilingK(vle: Vle, x: number): number {
  return lerp(vle.x, vle.T, x)
}

const WATER_MOLAR_L = 18.015 / 997

/** Molar volume (L/mol) of a pure substance from its density, or of water. */
export function molarVolume(cat: Catalogue, s: string): number {
  const def = cat.substances.get(s)
  if (!def?.physical?.density || !def.physical.molarMass) return WATER_MOLAR_L
  // kg/mol over kg/m³ is m³/mol: a thousand litres per cubic metre.
  return (parseValue(def.physical.molarMass).si / parseValue(def.physical.density).si) * 1000
}

/** Moles of water in a layer: its volume less what its solutes with a density take up. */
export function waterMol(cat: Catalogue, layer: Layer): number {
  let other = 0
  for (const [s, n] of Object.entries(layer.species)) if (n > 0 && cat.substances.get(s)?.physical?.density) other += n * molarVolume(cat, s)
  return Math.max(0, layer.volumeL - other) / WATER_MOLAR_L
}

export { WATER_MOLAR_L }
