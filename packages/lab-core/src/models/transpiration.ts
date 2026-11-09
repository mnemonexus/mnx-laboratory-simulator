// Transpiration (contract plants.transpiration, T1): a leafy shoot standing in water loses vapour
// from its leaves at E = g × VPD / P per unit leaf area and draws the same water up from the
// vessel (a potometer). The conductance g is the stomata's and the air's boundary layer's in series:
// stomata open with light (from a fraction in the dark), and moving air thins the boundary layer.
// The vapour pressure deficit is the saturation vapour pressure at the air's temperature (Tetens)
// times one minus its relative humidity. The leaves are taken to be at the air's temperature.
import type { Catalogue } from '../catalogue/catalogue.ts'
import { molarMass } from '../kernel/materials.ts'
import type { Contents, Place } from '../kernel/state.ts'
import { WATER_MOLAR_L } from './distillation.ts'

const PRESSURE_KPA = 101.325
/** Boundary-layer conductance for water vapour of a leaf a few centimetres across, mol m⁻² s⁻¹: g = a + b √u. */
const BOUNDARY_STILL = 0.2
const BOUNDARY_WIND = 1.2

/** Saturation vapour pressure of water, kPa (Tetens). */
export function saturationKPa(T: number): number {
  const c = T - 273.15
  return 0.6108 * Math.exp((17.27 * c) / (c + 237.3))
}

/** The shoot's stomata open with the light where it stands. */
function stomatalOpening(darkOpen: number, lightHalf: number, place: Place): number {
  const light = (place.light ?? 0) * (place.filter ? 0.3 : 1)
  return darkOpen + (1 - darkOpen) * (light / (light + lightHalf))
}

/** Each transpiring shoot in the contents draws water from the largest liquid layer for `dt` seconds. */
export function transpire(cat: Catalogue, shoots: Set<string>, contents: Contents, place: Place, dt: number): void {
  let lossMolS = 0
  for (const id of shoots) {
    const n = contents.solid[id] ?? 0
    const t = n > 0 ? cat.substances.get(id)?.transpiration : undefined
    if (!t) continue
    const areaM2 = n * (molarMass(cat, id) ?? 1000) * t.area * 1e-4
    const gs = t.conductance * stomatalOpening(t.darkOpen ?? 0.1, t.lightHalf ?? 50, place)
    const gb = BOUNDARY_STILL + BOUNDARY_WIND * Math.sqrt(place.windMs ?? 0)
    const g = gs > 0 ? 1 / (1 / gs + 1 / gb) : 0
    const vpd = saturationKPa(place.temperatureK) * (1 - (place.humidity ?? 0.5))
    lossMolS += (g * areaM2 * vpd) / PRESSURE_KPA
  }
  if (!(lossMolS > 0)) return
  const layer = contents.layers.reduce((a, l) => (l.volumeL > a.volumeL ? l : a))
  layer.volumeL = Math.max(0, layer.volumeL - lossMolS * dt * WATER_MOLAR_L)
}
