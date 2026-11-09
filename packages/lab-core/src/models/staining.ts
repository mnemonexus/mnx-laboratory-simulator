// Staining (contract staining, T1–T2; scientific simulation §3.1, §5): what stains do to cells
// fixed on a slide. The Gram stain is not a rule table of right answers: retention of crystal
// violet decays during decolourisation at a rate set by the cell wall (Gram class) and by
// whether iodine has complexed the dye, so timing mistakes give the classic misreadings.
import type { Catalogue } from '../catalogue/catalogue.ts'
import type { FixedCells, Layer } from '../kernel/state.ts'
import { baseOrganism } from './growth.ts'
import { parseValue } from '../units/index.ts'

interface StainParams {
  /** Decolourisation rate constants (1/s) by Gram class, with and without the iodine complex. */
  decolourise: Record<string, { complexed: number; plain: number }>
  /** Time constant (s) for a stain or mordant to take. */
  uptakeS: number
}

/** Defaults when no pack declares a staining model. */
const DEFAULTS: StainParams = {
  decolourise: {
    positive: { complexed: 0.04, plain: 0.3 },
    negative: { complexed: 0.8, plain: 1.0 },
    variable: { complexed: 0.15, plain: 0.6 },
  },
  uptakeS: 10,
}

const cache = new WeakMap<Catalogue, StainParams>()

/** Parameters from a model entry with contract "staining" (flat keys: decolourise.<class>.<complexed|plain>, uptakeTime). */
export function stainParams(cat: Catalogue): StainParams {
  const hit = cache.get(cat)
  if (hit) return hit
  const out: StainParams = { decolourise: Object.fromEntries(Object.entries(DEFAULTS.decolourise).map(([k, v]) => [k, { ...v }])), uptakeS: DEFAULTS.uptakeS }
  for (const m of cat.models.values()) {
    if (m.contract !== 'staining' || m.kind !== 'process') continue
    for (const [k, v] of Object.entries(m.params ?? {})) {
      const parts = k.split('.')
      if (parts[0] === 'decolourise' && parts.length === 3 && typeof v === 'number') {
        const entry = (out.decolourise[parts[1]] ??= { ...DEFAULTS.decolourise.variable })
        if (parts[2] === 'complexed' || parts[2] === 'plain') entry[parts[2]] = v
      }
      if (k === 'uptakeTime') out.uptakeS = parseValue(String(v)).si
    }
  }
  cache.set(cat, out)
  return out
}

export function applyStain(cat: Catalogue, film: Record<string, FixedCells & { fixed: boolean }>, reagent: Layer, durationS: number): string[] {
  const params = stainParams(cat)
  const roles = new Set<string>()
  for (const [s, n] of Object.entries(reagent.species)) {
    if (!(n > 0)) continue
    const role = cat.substances.get(s)?.stain?.role
    if (role) roles.add(role)
  }
  const uptake = 1 - Math.exp(-durationS / params.uptakeS)
  for (const [organism, cells] of Object.entries(film)) {
    const gram = cat.substances.get(baseOrganism(organism))?.organism?.gram ?? 'variable'
    if (roles.has('primary')) {
      cells.primary += (1 - cells.primary) * uptake
      // Fresh dye is not yet complexed.
      cells.complexed *= 1 - uptake
    }
    if (roles.has('mordant') && cells.primary > 0) cells.complexed += (1 - cells.complexed) * uptake
    if (roles.has('decolouriser')) {
      const k = params.decolourise[gram] ?? params.decolourise.variable
      const rate = cells.complexed * k.complexed + (1 - cells.complexed) * k.plain
      cells.primary *= Math.exp(-rate * durationS)
    }
    if (roles.has('counterstain')) cells.counter += (1 - cells.counter) * uptake
  }
  return [...roles]
}

/** What the cells look like: crystal violet dominates while enough is retained. */
export function cellColour(cells: FixedCells): 'purple' | 'pink' | 'colourless' {
  if (cells.primary >= 0.4) return 'purple'
  if (cells.counter >= 0.5) return 'pink'
  return 'colourless'
}

/** A smear covers about 1 cm²; an oil-immersion field is about 0.18 mm across. */
const SMEAR_AREA_MM2 = 100
const FIELD_AREA_MM2 = 0.025

/** Cells per microscope field for a count on the slide. */
export function cellsPerField(count: number): number {
  return (count * FIELD_AREA_MM2) / SMEAR_AREA_MM2
}
