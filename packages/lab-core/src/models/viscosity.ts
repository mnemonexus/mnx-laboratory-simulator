// Viscosity of aqueous liquids (contract physical.viscosity, T1). Each thickening solute adds to
// ln η in proportion to its volume fraction: ln(η / mPa·s) = Σ kᵢ φᵢ, with water at 1 mPa·s. It
// is an empirical fit for the dilute-to-moderate solutions a teaching laboratory uses (glycerol
// 50 % v/v near 8 mPa·s, sucrose 20 % w/v near 2), not for syrups or pure glycerol.
import type { Catalogue } from '../catalogue/catalogue.ts'
import type { Layer } from '../kernel/state.ts'
import { molarVolume } from './distillation.ts'

/** Dynamic viscosity of a layer, mPa·s. */
export function viscosityMPaS(cat: Catalogue, layer: Layer): number {
  if (layer.volumeL <= 0) return 1
  let lnEta = 0
  for (const [s, n] of Object.entries(layer.species)) {
    if (!(n > 0)) continue
    const k = cat.substances.get(s)?.physical?.viscosityCoefficient
    if (!k) continue
    lnEta += k * Math.min(1, (n * molarVolume(cat, s)) / layer.volumeL)
  }
  return Math.exp(lnEta)
}
