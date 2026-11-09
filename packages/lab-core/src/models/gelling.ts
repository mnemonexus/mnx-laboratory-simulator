// Gelling agents (agar). A liquid holding enough of one sets as it cools and melts again only when
// heated near boiling: agar sets at about 38 °C and melts at about 85 °C, so molten agar held at
// 45–60 °C stays liquid until it is taken out and left to cool. Top agar must be poured before it
// sets in its tube; poured onto a plate, it carries its cells over the agar as it sets.
import type { Catalogue } from '../catalogue/catalogue.ts'
import type { Container, Layer } from '../kernel/state.ts'
import { parseValue } from '../units/index.ts'

export interface Gel {
  substance: string
  setsK: number
  meltsK: number
}

interface GelDef extends Gel {
  minGPerL: number
  molarMassGPerMol: number
}

const cache = new WeakMap<Catalogue, Map<string, GelDef | null>>()

function gelDef(cat: Catalogue, s: string): GelDef | null {
  let m = cache.get(cat)
  if (!m) cache.set(cat, (m = new Map()))
  if (m.has(s)) return m.get(s)!
  const def = cat.substances.get(s)
  const g = def?.gel
  const mm = def?.physical?.molarMass
  const out = g && mm ? { substance: s, setsK: parseValue(g.sets).si, meltsK: parseValue(g.melts).si, minGPerL: parseValue(g.minConc).si, molarMassGPerMol: parseValue(mm).si * 1000 } : null
  m.set(s, out)
  return out
}

/** The gelling agent a liquid holds at a concentration that sets, if any. */
export function gellingAgent(cat: Catalogue, layer: Layer): Gel | undefined {
  if (!(layer.volumeL > 0)) return undefined
  for (const [s, n] of Object.entries(layer.species)) {
    if (!(n > 0)) continue
    const g = gelDef(cat, s)
    if (g && (n * g.molarMassGPerMol) / layer.volumeL >= g.minGPerL) return g
  }
  return undefined
}

/** Set or melt a container's agar by its temperature. Agar plates, deeps and slopes are set already. */
export function updateGel(cat: Catalogue, c: Container): void {
  if (cat.property(c.equipment, 'agar') === true) return
  let gel: Gel | undefined
  for (const l of c.contents.layers) if ((gel = gellingAgent(cat, l))) break
  if (!gel) {
    delete c.contents.gelled
    return
  }
  if (c.contents.temperatureK < gel.setsK) c.contents.gelled = true
  else if (c.contents.temperatureK > gel.meltsK) delete c.contents.gelled
}
