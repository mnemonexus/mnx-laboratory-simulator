// Thin-layer chromatography on silica (contract separation.adsorption, T1). A compound's retention
// factor follows a linear solvent-strength rule: log10 k = S − W ε, Rf = 1 / (1 + k), where S is
// its adsorption on silica and ε the eluent's eluotropic strength (a volume-weighted mean for a
// mixture). A weak eluent leaves everything near the origin and a strong one carries everything
// to the front. Spots start wider when more is loaded and spread as they travel, so close spots
// run together. Under 254 nm light a spot shows where it quenches the plate's indicator.
import type { Catalogue } from '../catalogue/catalogue.ts'
import type { Species } from '../kernel/state.ts'
import { epsilon } from './measurement.ts'
import { parseValue } from '../units/index.ts'

/** How strongly the eluent strength moves log k (per unit of ε). */
const W = 10
/** Spot diameter at the origin (mm) for a small load, and its growth with the load. */
const SPOT_MM = 2
const SPOT_LOAD_UG = 20
/** Spreading as a spot travels (mm of diameter per mm run). */
const SPREAD = 0.06
/** Quenching (mol × ε at 254 nm) a spot needs to be seen; above 20× it looks dark. */
const QUENCH_SEEN = 5e-5

/** The eluent's strength from the solvents in it (volume-weighted ε° on silica). */
export function eluentStrength(cat: Catalogue, species: Species): number | undefined {
  let volume = 0
  let weighted = 0
  for (const [s, n] of Object.entries(species)) {
    const def = cat.substances.get(s)
    const e = def?.eluotropic
    if (e === undefined || !(n > 0) || !def?.physical?.density || !def.physical.molarMass) continue
    const v = (n * parseValue(def.physical.molarMass).si * 1000) / parseValue(def.physical.density).si
    volume += v
    weighted += v * e
  }
  return volume > 0 ? weighted / volume : undefined
}

/** Rf of a compound in an eluent of strength ε (undefined for compounds silica does not hold). */
export function rf(cat: Catalogue, substance: string, strength: number): number | undefined {
  const s = cat.substances.get(substance)?.adsorption?.silica
  if (s === undefined) return undefined
  return 1 / (1 + Math.pow(10, s - W * strength))
}

export interface TlcSpot {
  lane: number
  positionMm: number
  diameterMm: number
  intensity: 'faint' | 'clear' | 'dark'
  /** In daylight, the colour of a coloured compound's spot. */
  colour?: string
}

/** How strongly a compound absorbs anywhere in the visible (its strongest ε from 400 to 700 nm). */
function visibleEpsilon(cat: Catalogue, s: string): number {
  let best = 0
  for (let nm = 400; nm <= 700; nm += 10) best = Math.max(best, epsilon(cat, s, nm))
  return best
}

/**
 * The spots one lane shows, merging those that overlap: under 254 nm where a compound quenches the
 * indicator, or in daylight where a coloured compound (a leaf pigment) absorbs, in its own colour.
 */
export function laneSpots(cat: Catalogue, lane: number, load: Species, positions: Record<string, number>, light: 'uv' | 'daylight' = 'uv'): TlcSpot[] {
  const spots: Array<{ pos: number; d: number; quench: number; colour?: string }> = []
  for (const [s, n] of Object.entries(load)) {
    if (!(n > 0) || positions[s] === undefined) continue
    const mm = cat.substances.get(s)?.physical?.molarMass
    const ug = n * (mm ? parseValue(mm).si * 1000 : 200) * 1e6
    const d = SPOT_MM * (1 + Math.sqrt(ug / SPOT_LOAD_UG)) + SPREAD * positions[s]
    const colour = light === 'daylight' ? cat.substances.get(s)?.optics?.colour : undefined
    spots.push({ pos: positions[s], d, quench: n * (light === 'uv' ? epsilon(cat, s, 254) : visibleEpsilon(cat, s)), ...(colour ? { colour } : {}) })
  }
  spots.sort((a, b) => a.pos - b.pos)
  const merged: typeof spots = []
  for (const x of spots) {
    const last = merged[merged.length - 1]
    if (last && x.pos - last.pos < 0.6 * (x.d + last.d) / 2) {
      const q = last.quench + x.quench
      last.pos = q > 0 ? (last.pos * last.quench + x.pos * x.quench) / q : (last.pos + x.pos) / 2
      last.d = Math.max(last.d, x.d) + Math.abs(x.pos - last.pos)
      if (x.quench > last.quench && x.colour) last.colour = x.colour
      last.quench = q
    } else merged.push({ ...x })
  }
  return merged
    .filter((x) => x.quench >= QUENCH_SEEN)
    .map((x) => ({ lane, positionMm: x.pos, diameterMm: x.d, intensity: x.quench >= 20 * QUENCH_SEEN ? 'dark' : x.quench >= 4 * QUENCH_SEEN ? 'clear' : 'faint', ...(x.colour ? { colour: x.colour } : {}) }))
}
