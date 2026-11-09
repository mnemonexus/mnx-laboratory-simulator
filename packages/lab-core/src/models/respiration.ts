// Aerobic respiration of whole organisms (contract organism.respiration, T1): seeds, woodlice or
// maggots take up oxygen at a rate per gram at 25 °C, doubling for each 10 °C (Q10), slowing as the
// oxygen around them runs low, and give out carbon dioxide (RQ per oxygen) and heat (about 470 kJ
// per mol of oxygen, glucose's). In a sealed respirometer they use the trapped air: soda lime takes
// up the carbon dioxide, so the gas shrinks by the oxygen used; without it, the volume hardly
// changes. In an open vessel (a vacuum flask plugged with cotton wool) the air is unlimited, and
// only the heat shows.
import type { Catalogue } from '../catalogue/catalogue.ts'
import { molarMass } from '../kernel/materials.ts'
import type { Container } from '../kernel/state.ts'
import { heatCapacityJK } from './thermochem.ts'

const OXYGEN = 'core:oxygen'
const CO2 = 'aq:carbon-dioxide'
const AIR_O2 = 0.2095
/** Respiration's heat per mol of oxygen (glucose: 2803 kJ / 6). */
const HEAT_J_PER_MOL_O2 = 467e3
/** Oxygen fraction at which respiration runs at half speed. */
const O2_HALF = 0.02

export function respire(cat: Catalogue, respiring: Set<string>, c: Container, dt: number): void {
  const contents = c.contents
  const T = contents.temperatureK
  let demand = 0
  let co2PerO2 = 0
  for (const id of respiring) {
    const n = contents.solid[id] ?? 0
    const r = n > 0 ? cat.substances.get(id)?.respiration : undefined
    if (!r) continue
    const grams = n * (molarMass(cat, id) ?? 1000)
    const mol = grams * r.rate * 1e-6 * Math.pow(r.q10 ?? 2, (T - 298.15) / 10) * (dt / 60)
    demand += mol
    co2PerO2 += mol * (r.rq ?? 1)
  }
  if (!(demand > 0)) return
  co2PerO2 /= demand
  let used = demand
  const g = c.gasSample
  if (g) {
    // A sealed respirometer: the oxygen in the trapped air, and what soda lime takes up.
    const d = (g.delta ??= {})
    const o2 = AIR_O2 * g.airMol + (d[OXYGEN] ?? 0)
    const total = g.airMol + Object.values(d).reduce((a, x) => a + x, 0)
    const fraction = total > 0 ? o2 / total : 0
    used = Math.min(o2, demand * (fraction / (fraction + O2_HALF)) * ((AIR_O2 + O2_HALF) / AIR_O2))
    d[OXYGEN] = (d[OXYGEN] ?? 0) - used
    const absorbed = Object.entries(contents.solid).some(([s, n]) => n > 0 && cat.substances.get(s)?.absorbs === CO2)
    if (!absorbed) d[CO2] = (d[CO2] ?? 0) + used * co2PerO2
  }
  // The heat warms what is there (seeds alone, without liquid, in a vacuum flask).
  const held = heatCapacityJK(cat, contents)
  if (held > 0) contents.temperatureK += (used * HEAT_J_PER_MOL_O2) / held
}
