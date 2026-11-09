// Electrochemistry (contract electrochemistry.cells, T2): a metal dipping into a solution sits at
// its electrode potential E = E° + (RT ln10 / zF) log a(Mᶻ⁺), the activity of its free ion from the
// ionic model (so complexing ammonia or a precipitate lowers it). With none of its ions in the
// solution a metal still corrodes a little, taken as 1 µM. Two half-cells joined by a salt bridge,
// or two metals in one electrolyte, give the difference of their potentials to a voltmeter that
// draws no current.
//
// Conductivity (contract conductivity.ionic, T2): κ = Σ λᵢ cᵢ over the charged species of the ionic
// equilibrium, each ion's limiting molar conductivity λ° lowered by the crowd of other ions as
// exp(−0.7 |z| √I / (1 + √I)) (within a few per cent of KCl's measured values to 1 M). Weak acids
// conduct only through the ions they form. Read as a meter compensated to 25 °C.
import type { Catalogue } from '../catalogue/catalogue.ts'
import type { Contents, Layer } from '../kernel/state.ts'
import { liquidVolume, meanLayer } from '../kernel/state.ts'
import { ionicEquilibrium, layerTotals } from './ionic.ts'
import { nernstSlope } from './redox.ts'

/** A metal with none of its own ions about: the trace its surface gives off (mol/L). */
const ION_FLOOR = 1e-6

/** The metals in a container that can serve as electrodes (strips, a nail, ribbon), by substance. */
export function electrodesIn(cat: Catalogue, contents: Contents): string[] {
  return Object.entries(contents.solid)
    .filter(([s, n]) => n > 0 && !!cat.substances.get(s)?.metal)
    .map(([s]) => s)
}

/** A metal electrode's potential (V against the standard hydrogen electrode) in a container's liquid. */
export function electrodePotentialV(cat: Catalogue, contents: Contents, metal: string): number | undefined {
  const m = cat.substances.get(metal)?.metal
  if (!m || !(liquidVolume(contents) > 0)) return undefined
  const T = contents.temperatureK
  const free = ionicEquilibrium(cat, layerTotals(meanLayer(contents)), T).free[m.ion] ?? 0
  return m.e0 + (nernstSlope(T) / m.charge) * Math.log10(Math.max(ION_FLOOR, free))
}

interface ConductanceTable {
  /** λ° (S cm² mol⁻¹) by species name (its formula, or carrier#form for acid–base systems). */
  lambda: Map<string, number>
  /** For a species not in the table, per unit of charge. */
  perCharge: number
  /** A spectator ion carried inside an acid–base system (sodium in sodium hydroxide). */
  spectator: number
}

const tableCache = new WeakMap<Catalogue, ConductanceTable>()

function conductances(cat: Catalogue): ConductanceTable {
  const hit = tableCache.get(cat)
  if (hit) return hit
  const lambda = new Map<string, number>()
  let perCharge = 55
  let spectator = 60
  for (const m of cat.models.values()) {
    if (m.contract !== 'conductivity.ionic') continue
    for (const [k, v] of Object.entries(m.params ?? {})) {
      if (k === 'perCharge') perCharge = Number(v)
      else if (k === 'spectator') spectator = Number(v)
      else lambda.set(k, Number(v))
    }
  }
  const t = { lambda, perCharge, spectator }
  tableCache.set(cat, t)
  return t
}

/** A liquid's conductivity, µS/cm at 25 °C. */
export function conductivityUSPerCm(cat: Catalogue, layer: Layer): number {
  if (!(layer.volumeL > 0)) return 0
  const table = conductances(cat)
  const totals = layerTotals(layer)
  const r = ionicEquilibrium(cat, totals, 298.15)
  const ions: Array<{ c: number; z: number; lambda: number }> = []
  for (const sp of r.species) {
    const z = sp.charge ?? 0
    if (z === 0 || !(sp.conc > 0)) continue
    ions.push({ c: sp.conc, z, lambda: table.lambda.get(sp.name) ?? table.perCharge * Math.abs(z) })
  }
  // Spectator ions of acid–base systems (the sodium of sodium hydroxide or sodium acetate).
  for (const [s, c] of Object.entries(totals)) {
    const n = cat.substances.get(s)?.acidBase?.spectator ?? 0
    if (n !== 0 && c > 0) ions.push({ c: Math.abs(n) * c, z: Math.sign(n), lambda: table.spectator })
  }
  const I = 0.5 * ions.reduce((a, x) => a + x.c * x.z * x.z, 0)
  const crowd = Math.sqrt(I) / (1 + Math.sqrt(I))
  // κ (S/cm) = Σ λ (S cm² mol⁻¹) × c (mol/L) / 1000.
  const kappa = ions.reduce((a, x) => a + x.lambda * x.c * Math.exp(-0.7 * Math.abs(x.z) * crowd), 0) / 1000
  return kappa * 1e6
}
