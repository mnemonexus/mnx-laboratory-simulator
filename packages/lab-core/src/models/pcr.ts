// PCR (contract amplification, T2; scientific simulation §3.1): each cycle copies every target
// whose two primers are present, with an efficiency set by the program (annealing against the
// primers' Tm, extension time against the product length, denaturation) and limited as primers
// and nucleotides run out. Products are themselves templates, so carry-over contamination
// amplifies. Primers anneal to each other at low annealing temperatures (primer-dimers), which
// then amplify late, unless a real product takes the polymerase and nucleotides first. The run is
// stepped cycle by cycle, so a real-time cycler can read the dsDNA after each one.
import type { Catalogue } from '../catalogue/catalogue.ts'
import type { Layer, Population } from '../kernel/state.ts'
import type { Rng } from '../rng/rng.ts'
import { parseValue } from '../units/index.ts'

const NA = 6.022e23
const K0 = 273.15

export interface PcrProgram {
  cycles: number
  denatureK: number
  denatureS: number
  annealK: number
  annealS: number
  extendK: number
  extendS: number
}

/** Best per-cycle efficiency, and the share of the limiting primer that ends up in product. */
const E_MAX = 0.95
const PRIMER_YIELD = 0.3
/** Annealing above the primers' Tm by more than this loses priming quickly (K). */
const ANNEAL_TOLERANCE = 2
/** Below Tm − this, primers start to pair with each other (K). */
const DIMER_BELOW = 5
const DIMER_ID = 'molbio:primer-dimer'
/** Primer-dimers: the most of the primer pool they can take, their per-cycle efficiency once
 * formed, and the share of that most formed afresh each cycle (they reach it after ~35 cycles). */
const DIMER_SHARE = 0.15
const DIMER_E = 0.85
const DIMER_SEED = 3e-9
/** Below this many molecules, the copies in a reaction are counted (Poisson), not averaged. */
const DISCRETE_BELOW = 1e5
/** Well-to-well spread of the efficiency (relative): replicate Cq values differ by ~0.1 cycle. */
const EFFICIENCY_SPREAD = 0.005

export interface Amplification {
  products: Record<string, number>
  efficiency: Record<string, number>
  /** dsDNA in the reaction (molecules × bp) before cycling and after each cycle. */
  dsBp: number[]
}

function roleOf(cat: Catalogue, s: string): string | undefined {
  return cat.substances.get(s)?.pcr?.role
}

/** Double-stranded DNA in a layer (molecules × bp): templates, products and duplex probes, not primers. */
export function dsDnaBp(cat: Catalogue, layer: Layer): number {
  let bp = 0
  for (const [s, n] of Object.entries(layer.species)) {
    const def = cat.substances.get(s)
    if (!(n > 0) || !def?.dna?.lengthBp || def.pcr) continue
    bp += n * NA * def.dna.lengthBp
  }
  return bp
}

/** Amplify in one layer (a PCR tube's reaction). Adds product species in place. With an RNG, a
 * template present as only a few molecules is counted into the reaction (Poisson), and each
 * reaction's efficiency varies a little. */
/** Cells per µL beyond which their debris starts to inhibit the polymerase (a heavy colony pick). */
const INHIBIT_CELLS_PER_UL = 3e5

/**
 * Colony PCR: cells in the reaction burst in the first denaturation and release their DNA (the
 * chromosome once, plasmids at their copy number). Too many cells inhibit the polymerase. Returns the efficiency factor left.
 */
export function lyseCells(_cat: Catalogue, layer: Layer, dnaOfStrain: (key: string) => Array<[string, number]>, proteinsOfStrain?: (key: string, pop: Population) => Array<[string, number]>): number {
  if (!layer.populations || layer.volumeL <= 0) return 1
  let cells = 0
  for (const [key, pop] of Object.entries(layer.populations)) {
    if (!(pop.count > 0)) continue
    cells += pop.count
    for (const [dna, copies] of dnaOfStrain(key)) layer.species[dna] = (layer.species[dna] ?? 0) + (pop.count * copies) / NA
    // Burst cells release their proteins too.
    for (const [protein, mol] of proteinsOfStrain?.(key, pop) ?? []) if (mol > 0) layer.species[protein] = (layer.species[protein] ?? 0) + pop.count * mol
  }
  delete layer.populations
  const perUL = cells / (layer.volumeL * 1e6)
  return 1 / (1 + (perUL / INHIBIT_CELLS_PER_UL) ** 2)
}

export function amplify(cat: Catalogue, layer: Layer, program: PcrProgram, rng?: Rng, inhibition = 1): Amplification {
  const base = dsDnaBp(cat, layer)
  const out: Amplification = { products: {}, efficiency: {}, dsBp: Array.from({ length: program.cycles + 1 }, () => base) }
  if (layer.volumeL <= 0) return out
  const present = (s: string) => (layer.species[s] ?? 0) > 0
  const polymerase = Object.keys(layer.species).find((s) => present(s) && roleOf(cat, s) === 'polymerase')
  const nucleotides = Object.keys(layer.species).filter((s) => present(s) && roleOf(cat, s) === 'nucleotides')
  if (!polymerase || nucleotides.length === 0) return out
  const active = layer.active?.[polymerase] ?? layer.species[polymerase]
  if (!(active > 0)) return out
  const bpPerS = cat.substances.get(polymerase)?.pcr?.bpPerS ?? 16
  const dntpMolecules = nucleotides.reduce((a, s) => a + layer.species[s] * NA, 0)
  const tmOf = (s: string) => {
    const t = cat.substances.get(s)?.pcr?.tm
    return t ? parseValue(t).si : 60 + K0
  }
  const fDenature = program.denatureK >= 93 + K0 ? 1 : program.denatureK >= 90 + K0 ? 0.5 : 0.02
  // Targets: anything with an amplicon whose primers are both here (templates and products alike).
  const targets = new Map<string, { forward: string; reverse: string; n: number }>()
  for (const [s, n] of Object.entries(layer.species)) {
    if (!(n > 0)) continue
    for (const a of cat.substances.get(s)?.dna?.amplicons ?? []) {
      if (!present(a.forward) || !present(a.reverse)) continue
      const t = targets.get(a.product) ?? { forward: a.forward, reverse: a.reverse, n: 0 }
      t.n += n * NA
      targets.set(a.product, t)
    }
  }
  const runs = [...targets].map(([product, t]) => {
    const tm = Math.min(tmOf(t.forward), tmOf(t.reverse))
    const over = program.annealK - tm - ANNEAL_TOLERANCE
    const fAnneal = over <= 0 ? 1 : Math.exp(-over / 1.5)
    const length = cat.substances.get(product)?.dna?.lengthBp ?? 500
    const fExtend = Math.min(1, (program.extendS * bpPerS) / length)
    const e = Math.min(1, E_MAX * fAnneal * fExtend * fDenature * inhibition * (rng ? 1 + rng.normal(0, EFFICIENCY_SPREAD) : 1))
    const primers = Math.min(layer.species[t.forward], layer.species[t.reverse]) * NA
    const n0 = rng && t.n < DISCRETE_BELOW ? rng.poisson(t.n) : t.n
    const max = Math.max(n0, Math.min(PRIMER_YIELD * primers, dntpMolecules / (2 * length)))
    out.efficiency[product] = e
    return { product, t, e, length, n0, n: n0, max }
  })
  // Primer-dimers: at low annealing temperatures, from any primer present.
  const primers = Object.keys(layer.species).filter((s) => present(s) && roleOf(cat, s) === 'primer')
  let dimerMax = 0
  if (primers.length && cat.substances.has(DIMER_ID)) {
    const below = Math.min(...primers.map(tmOf)) - DIMER_BELOW - program.annealK
    if (below > 0) dimerMax = Math.min(...primers.map((s) => layer.species[s])) * NA * DIMER_SHARE * Math.min(1, below / 10)
  }
  const dimerBp = cat.substances.get(DIMER_ID)?.dna?.lengthBp ?? 50
  let dimers = 0
  for (let c = 1; c <= program.cycles; c++) {
    for (const r of runs) r.n += r.e * r.n * Math.max(0, 1 - r.n / r.max)
    if (dimerMax > 0) {
      // A product near its plateau has taken the polymerase and nucleotides: dimers stop forming.
      const free = runs.reduce((a, r) => (r.n > r.n0 ? Math.min(a, Math.max(0, 1 - r.n / r.max)) : a), 1)
      dimers += free * (DIMER_SEED * dimerMax + DIMER_E * dimers * Math.max(0, 1 - dimers / dimerMax))
    }
    out.dsBp[c] = base + runs.reduce((a, r) => a + (r.n - r.n0) * r.length, 0) + dimers * dimerBp
  }
  for (const r of runs) {
    const made = Math.max(0, r.n - r.n0)
    if (made <= 0) continue
    layer.species[r.product] = (layer.species[r.product] ?? 0) + made / NA
    // Primers are used up by what was made.
    layer.species[r.t.forward] = Math.max(0, layer.species[r.t.forward] - made / NA)
    layer.species[r.t.reverse] = Math.max(0, layer.species[r.t.reverse] - made / NA)
    out.products[r.product] = made
  }
  if (dimers > 0) {
    layer.species[DIMER_ID] = (layer.species[DIMER_ID] ?? 0) + dimers / NA
    out.products[DIMER_ID] = dimers
  }
  return out
}

/**
 * Melting temperature (K) of a short duplex: 81.5 + 16.6 log10[M+] + 41 GC − 675/N (°C), with the
 * monovalent-ion equivalent of a PCR buffer (about 0.1 M, magnesium included).
 */
export function duplexTmK(cat: Catalogue, substance: string): number {
  const dna = cat.substances.get(substance)?.dna
  const n = dna?.lengthBp ?? 500
  const gc = dna?.gcFraction ?? 0.5
  return 81.5 + 16.6 * Math.log10(0.1) + 41 * gc - 675 / n + K0
}

/** The program's duration (s), including an initial denaturation and a final extension. */
export function programDuration(p: PcrProgram, initialS: number, finalS: number): number {
  return initialS + p.cycles * (p.denatureS + p.annealS + p.extendS) + finalS
}
