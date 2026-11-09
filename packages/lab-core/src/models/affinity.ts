// Affinity chromatography (contract separation.affinity, T1). A resin holds proteins that carry
// its tag (His6 on nickel) up to a binding capacity, and lets go of them as a competitor
// (imidazole) rises: the share retained per pass is 1 / (1 + (c / c50)^h), an empirical release
// curve. Untagged proteins stick weakly: a share of what passes is held, plain buffer does not
// wash it off, but a little competitor frees it, which is why wash buffers carry some imidazole.
// Each pass of liquid equilibrates with the bed.
import type { Catalogue } from '../catalogue/catalogue.ts'
import type { Layer, Species } from '../kernel/state.ts'
import { parseValue } from '../units/index.ts'

export interface AffinityResin {
  tag: string
  /** Protein the bed holds at most (g). */
  capacityG: number
  competitor: string
  /** Competitor concentration (mol/L) that frees half of the tagged protein, and the curve's steepness. */
  release50: number
  hill: number
  /** Share of an untagged protein that sticks without competitor, and the competitor that halves it (mol/L). */
  nonspecific: number
  nonspecific50: number
}

export function resinOf(cat: Catalogue, equipment: string): AffinityResin | undefined {
  const tag = cat.property(equipment, 'affinityTag')
  if (tag === undefined) return undefined
  const q = (k: string, d: string) => parseValue(String(cat.property(equipment, k) ?? d)).si
  return {
    tag: String(tag),
    capacityG: (Number(cat.property(equipment, 'capacityMgPerMl') ?? 40) * q('bedVolume', '1 mL') * 1000 * 1000) / 1000,
    competitor: String(cat.property(equipment, 'competitor') ?? 'bio:imidazole'),
    release50: q('release50', '100 mM') / 1000,
    hill: Number(cat.property(equipment, 'releaseHill') ?? 4),
    nonspecific: Number(cat.property(equipment, 'nonspecific') ?? 0.05),
    nonspecific50: q('nonspecific50', '5 mM') / 1000,
  }
}

/**
 * Pass one portion of liquid through the bed: what is bound and what arrives equilibrate at the
 * liquid's competitor concentration. Returns what the bed keeps; the rest leaves with the liquid.
 */
export function affinityPass(cat: Catalogue, resin: AffinityResin, bound: Species, passing: Layer): Species {
  const v = passing.volumeL
  const competitor = v > 0 ? (passing.species[resin.competitor] ?? 0) / v : 0
  const tagged = (s: string) => cat.substances.get(s)?.tags?.includes(resin.tag) === true
  const isProtein = (s: string) => {
    const d = cat.substances.get(s)
    return !!d && (d.protein !== undefined || d.identity.class === 'protein' || d.identity.class === 'enzyme')
  }
  const keepTagged = 1 / (1 + Math.pow(competitor / resin.release50, resin.hill))
  // Weakly held proteins: what is held stays unless competitor frees it; a share of what arrives sticks.
  const holdOther = 1 / (1 + Math.pow(competitor / resin.nonspecific50, 2))
  const total: Species = { ...bound }
  for (const [s, n] of Object.entries(passing.species)) if (n > 0 && isProtein(s)) total[s] = (total[s] ?? 0) + n
  const keep: Species = {}
  let usedG = 0
  const grams = (s: string, n: number) => n * (cat.substances.get(s)?.physical?.molarMass ? parseValue(cat.substances.get(s)!.physical!.molarMass!).si * 1000 : 50000)
  // Tagged proteins first, up to the capacity; then what sticks non-specifically.
  for (const [s, n] of Object.entries(total).filter(([s]) => tagged(s))) {
    const want = n * keepTagged
    const room = Math.max(0, resin.capacityG - usedG)
    const k = Math.min(want, room / Math.max(grams(s, 1), 1e-30))
    keep[s] = k
    usedG += grams(s, k)
  }
  for (const [s, n] of Object.entries(total).filter(([s]) => !tagged(s))) {
    const held = bound[s] ?? 0
    keep[s] = (held + (n - held) * resin.nonspecific) * holdOther
  }
  // The liquid leaves with whatever the bed does not keep.
  for (const s of Object.keys(total)) {
    const out = total[s] - (keep[s] ?? 0)
    if (out > 0 || s in passing.species) passing.species[s] = Math.max(0, out)
  }
  return keep
}
