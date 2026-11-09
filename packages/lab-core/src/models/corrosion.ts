// Corrosion (contract electrochemistry.corrosion, T1): metal under water that holds dissolved
// oxygen corrodes as fast as the oxygen reaches its surface, O₂ + 2H₂O + 4e⁻ → 4OH⁻ at km·A·[O₂]
// (km = 10⁻⁶ m/s in still water), faster with chloride about (× 1 + 3c/(c + 0.05 M): salt
// lets the anodic and cathodic areas work apart and breaks up the protecting film). Metal pieces in
// one vessel are taken to touch (wrapped round each other): the most reactive gives up the
// electrons for all their surfaces, so zinc or magnesium protects iron, and copper speeds its
// attack. The metal ends as its hydroxide (iron as iron(III), rust), a coating that stays on the
// metal and does not change the pH. No water, or no oxygen (boiled water under oil), no corrosion.
import type { Catalogue } from '../catalogue/catalogue.ts'
import { molarMass } from '../kernel/materials.ts'
import type { Contents } from '../kernel/state.ts'
import { carriersOf } from './ionic.ts'

const OXYGEN = 'core:oxygen'
const CHLORIDE = 'aq:chloride'
const KM_O2 = 1e-6

/** The hydroxide (or oxide) an ion ends as: the solid made of that ion alone (protons implicit). */
const productCache = new WeakMap<Catalogue, Map<string, string | undefined>>()
function corrosionProduct(cat: Catalogue, ion: string): string | undefined {
  let byIon = productCache.get(cat)
  if (!byIon) productCache.set(cat, (byIon = new Map()))
  if (!byIon.has(ion)) {
    let found: string | undefined
    for (const def of cat.substances.values()) {
      const ions = Object.keys(def.ions ?? {})
      if (def.solid && def.solid.phase !== 'gas' && ions.length === 1 && ions[0] === ion && def.ions![ion] === 1) found = def.id
    }
    byIon.set(ion, found)
  }
  return byIon.get(ion)
}

/** Whether anything in the contents can corrode: a metal piece under a liquid holding oxygen. */
export function canCorrode(cat: Catalogue, contents: Contents): boolean {
  if (!contents.layers.some((l) => (l.species[OXYGEN] ?? 0) > 0)) return false
  return Object.entries(contents.solid).some(([s, n]) => n > 0 && !!cat.substances.get(s)?.metal)
}

export function corrode(cat: Catalogue, contents: Contents, dt: number): void {
  const layer = contents.layers[contents.layers.length - 1]
  const o2 = layer?.species[OXYGEN] ?? 0
  if (!layer || !(o2 > 0) || !(layer.volumeL > 0)) return
  // Every metal surface takes oxygen; the most reactive metal pays for it.
  let areaM2 = 0
  let anode: string | undefined
  let lowest = Infinity
  for (const [s, n] of Object.entries(contents.solid)) {
    const def = cat.substances.get(s)
    if (!def?.metal || !(n > 0)) continue
    areaM2 += (def.surface?.m2PerG ?? 0.0005) * n * (molarMass(cat, s) ?? 0)
    if (def.metal.e0 < lowest) {
      lowest = def.metal.e0
      anode = s
    }
  }
  if (!anode) return
  let chloride = 0
  for (const [s, n] of Object.entries(layer.species)) chloride += (carriersOf(cat, s)[CHLORIDE] ?? 0) * n
  chloride /= layer.volumeL
  const salt = 1 + (3 * chloride) / (chloride + 0.05)
  const metal = cat.substances.get(anode)!.metal!
  const ion = metal.corrodesTo ?? metal.ion
  const z = cat.substances.get(ion)?.aqueous?.charge ?? metal.charge
  const oxygenMol = Math.min(o2, KM_O2 * areaM2 * (o2 / layer.volumeL) * 1000 * salt * dt)
  const metalMol = Math.min(contents.solid[anode], (4 * oxygenMol) / z)
  if (!(metalMol > 0)) return
  layer.species[OXYGEN] = o2 - (metalMol * z) / 4
  contents.solid[anode] -= metalMol
  const product = corrosionProduct(cat, ion) ?? anode
  ;(contents.coating ??= {})[product] = (contents.coating[product] ?? 0) + metalMol
}
