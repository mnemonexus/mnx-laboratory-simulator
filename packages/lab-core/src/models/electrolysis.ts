// Electrolysis (contract electrochemistry.electrolysis, T2): a current I passes I·dt/F mol of
// electrons in a step. At the cathode they go first to the reduction with the highest potential,
// at the anode to the oxidation with the lowest, each only as fast as its ions reach the
// electrode (n F km A c, km = 2 × 10⁻⁵ m/s), the rest to the next:
//   - cathode: a metal ion (E° + (RT ln10/zF) log a), or water to hydrogen (−0.059 pH less the
//     electrode's hydrogen overpotential), always available;
//   - anode: the anode's own metal dissolving (copper refining, a reactive anode), a halide to its
//     halogen (E° − (RT ln10 × count/electrons F) log a), or water to oxygen (1.229 − 0.059 pH plus
//     the electrode's oxygen overpotential).
// So copper(II) sulfate gives copper and oxygen on graphite; brine gives hydrogen and chlorine (and,
// dilute, mostly oxygen); a copper anode dissolves as fast as copper plates the cathode. Ions leave
// or join the liquid as carriers with their protons implicit, so the pH follows (sulfuric acid
// builds up as copper plates out; brine turns alkaline as chlorine leaves).
import type { Catalogue } from '../catalogue/catalogue.ts'
import { molarMass } from '../kernel/materials.ts'
import { type Contents, type Layer, liquidVolume } from '../kernel/state.ts'
import { carriersOf, ionicEquilibrium, layerTotals } from './ionic.ts'
import { nernstSlope } from './redox.ts'
import { HYDROGEN } from './surface.ts'

export const FARADAY = 96485.33212
const OXYGEN = 'core:oxygen'
/** Mass-transfer coefficient to an electrode in still liquid stirred by its own bubbles, m/s. */
const KM = 2e-5
/** An electrode whose area is not known (m²). */
const DEFAULT_AREA = 1e-3
const DEFAULT_H2_OVERPOTENTIAL = 0.5
const DEFAULT_O2_OVERPOTENTIAL = 0.8

export interface ElectrodeProducts {
  /** Mol of each product (a metal deposited or dissolved, a gas, a halogen). */
  made: Record<string, number>
  /** Mol of electrons each reaction took. */
  electrons: Record<string, number>
}

interface Candidate {
  key: string
  E: number
  /** Most mol of electrons it can take this step. */
  limit: number
  apply: (mol: number) => void
}

/** What an electrode is made of: its largest piece (a deposit on it does not change its overpotentials). */
function material(cat: Catalogue, electrode: Contents): string | undefined {
  let best: string | undefined
  let most = 0
  for (const [s, n] of Object.entries(electrode.solid)) {
    const def = cat.substances.get(s)
    if (n > most && (def?.metal || def?.electrode)) {
      best = s
      most = n
    }
  }
  return best
}

/** Wetted area of an electrode (m²): its pieces' specific surface times their mass. */
function area(cat: Catalogue, electrode: Contents): number {
  let a = 0
  for (const [s, n] of Object.entries(electrode.solid)) {
    const m2PerG = cat.substances.get(s)?.surface?.m2PerG
    if (m2PerG && n > 0) a += m2PerG * n * (molarMass(cat, s) ?? 0)
  }
  return a > 0 ? a : DEFAULT_AREA
}

/** Take a layer's salts apart into their ion carriers, so that ions can leave or join it one by one. */
function asCarriers(cat: Catalogue, layer: Layer): void {
  for (const [s, n] of Object.entries(layer.species)) {
    const parts = carriersOf(cat, s)
    if (!(n > 0) || (Object.keys(parts).length === 1 && parts[s] === 1)) continue
    delete layer.species[s]
    for (const [carrier, k] of Object.entries(parts)) layer.species[carrier] = (layer.species[carrier] ?? 0) + n * k
  }
}

/** Hand `mol` of electrons to the candidates in order, each up to its limit. */
function allocate(candidates: Candidate[], mol: number, out: ElectrodeProducts): void {
  let left = mol
  for (const c of candidates) {
    if (!(left > 0)) break
    const take = Math.min(left, c.limit)
    if (!(take > 0)) continue
    c.apply(take)
    out.electrons[c.key] = (out.electrons[c.key] ?? 0) + take
    left -= take
  }
}

/**
 * Pass a current for `dt` seconds through the liquid in `cell` between two electrodes (containers
 * holding their strip or rod). Gases go to `gasOut` by electrode; the rest changes the liquid and
 * the electrodes in place. Returns what each electrode made.
 */
export function electrolyseStep(
  cat: Catalogue,
  cell: Contents,
  anode: Contents,
  cathode: Contents,
  currentA: number,
  dt: number,
  gasOut: (electrode: 'anode' | 'cathode', gas: string, mol: number) => void,
): { anode: ElectrodeProducts; cathode: ElectrodeProducts } {
  const result = { anode: { made: {}, electrons: {} } as ElectrodeProducts, cathode: { made: {}, electrons: {} } as ElectrodeProducts }
  const v = liquidVolume(cell)
  if (!(v > 0) || !(currentA > 0) || !(dt > 0)) return result
  // The ions move in the main (bottom, aqueous) layer.
  const layer = cell.layers[cell.layers.length - 1]
  asCarriers(cat, layer)
  const T = cell.temperatureK
  const slope = nernstSlope(T)
  const eq = ionicEquilibrium(cat, layerTotals(layer), T)
  const conc = (carrier: string) => (layer.species[carrier] ?? 0) / layer.volumeL
  const activity = (carrier: string) => Math.max(1e-9, eq.free[carrier] ?? 0)
  const made = (side: ElectrodeProducts, s: string, n: number) => (side.made[s] = (side.made[s] ?? 0) + n)
  const electrons = (currentA * dt) / FARADAY

  // Cathode: metal ions, then water.
  const cathodeMaterial = material(cat, cathode)
  const ca = area(cat, cathode)
  const reductions: Candidate[] = []
  for (const carrier of Object.keys(layer.species)) {
    const def = cat.substances.get(carrier)
    const m = def?.aqueous?.metal
    const z = def?.aqueous?.charge ?? 0
    if (!m || !(z > 0) || !(conc(carrier) > 0)) continue
    reductions.push({
      key: m.deposit,
      E: m.e0 + (slope / z) * Math.log10(activity(carrier)),
      limit: Math.min(z * KM * ca * conc(carrier) * 1000 * dt, z * (layer.species[carrier] ?? 0)),
      apply: (e) => {
        layer.species[carrier] = Math.max(0, (layer.species[carrier] ?? 0) - e / z)
        cathode.solid[m.deposit] = (cathode.solid[m.deposit] ?? 0) + e / z
        made(result.cathode, m.deposit, e / z)
      },
    })
  }
  const etaH = (cathodeMaterial ? cat.substances.get(cathodeMaterial)?.electrode?.hydrogenOverpotential : undefined) ?? DEFAULT_H2_OVERPOTENTIAL
  reductions.push({
    key: HYDROGEN,
    E: -slope * eq.pH - etaH,
    limit: Infinity,
    apply: (e) => {
      gasOut('cathode', HYDROGEN, e / 2)
      made(result.cathode, HYDROGEN, e / 2)
    },
  })
  allocate(reductions.sort((a, b) => b.E - a.E), electrons, result.cathode)

  // Anode: its own metal, halides, then water.
  const anodeMaterial = material(cat, anode)
  const aa = area(cat, anode)
  const oxidations: Candidate[] = []
  // Any metal on the anode can dissolve (a graphite rod cannot, but copper plated on it can).
  for (const [s, n] of Object.entries(anode.solid)) {
    const m = cat.substances.get(s)?.metal
    if (!m || !(n > 0)) continue
    oxidations.push({
      key: s,
      E: m.e0 + (slope / m.charge) * Math.log10(Math.max(1e-6, eq.free[m.ion] ?? 0)),
      limit: m.charge * n,
      apply: (e) => {
        anode.solid[s] = Math.max(0, (anode.solid[s] ?? 0) - e / m.charge)
        layer.species[m.ion] = (layer.species[m.ion] ?? 0) + e / m.charge
        made(result.anode, s, -e / m.charge)
      },
    })
  }
  for (const def of cat.substances.values()) {
    const ox = def.anodic
    if (!ox || !(conc(ox.from) > 0)) continue
    const perElectron = ox.count / ox.electrons
    oxidations.push({
      key: def.id,
      E: ox.e0 - slope * perElectron * Math.log10(activity(ox.from)),
      limit: Math.min((KM * aa * conc(ox.from) * 1000 * dt) / perElectron, (layer.species[ox.from] ?? 0) / perElectron),
      apply: (e) => {
        layer.species[ox.from] = Math.max(0, (layer.species[ox.from] ?? 0) - e * perElectron)
        const n = e / ox.electrons
        if (def.physical?.phase === 'gas') gasOut('anode', def.id, n)
        else layer.species[def.id] = (layer.species[def.id] ?? 0) + n
        made(result.anode, def.id, n)
      },
    })
  }
  const etaO = (anodeMaterial ? cat.substances.get(anodeMaterial)?.electrode?.oxygenOverpotential : undefined) ?? DEFAULT_O2_OVERPOTENTIAL
  oxidations.push({
    key: OXYGEN,
    E: 1.229 - slope * eq.pH + etaO,
    limit: Infinity,
    apply: (e) => {
      gasOut('anode', OXYGEN, e / 4)
      made(result.anode, OXYGEN, e / 4)
    },
  })
  allocate(oxidations.sort((a, b) => a.E - b.E), electrons, result.anode)
  return result
}
