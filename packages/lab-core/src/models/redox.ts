// Redox equilibrium (contract equilibrium.redox, T3): half-reaction couples in one solution share a
// single electrode potential E. Each couple Ox + n e⁻ + m H⁺ ⇌ Red has a formal potential
// E°' = E° − (m/n)·(RT ln10/F)·pH and splits between its forms by the Nernst equation; the
// electrons the couples hold between them are conserved. So mixing permanganate with iron(II)
// moves electrons until the potentials agree: almost completely in acid, much less in neutral
// solution, where permanganate's potential falls. Substances declare their couple, form and
// partner (`redox`); the stored amounts say what was added, and this is the equilibrium view.
// A couple may make more than one reduced unit per oxidised one (I₂ + 2e⁻ → 2I⁻), when the
// Nernst ratio [Ox]/[Red]^k depends on concentration. The protons used are not taken from the
// solution: the method assumes an acid medium in excess.
import type { Catalogue } from '../catalogue/catalogue.ts'
import type { Layer } from '../kernel/state.ts'
import { scientificNumerics } from './numerics.ts'

/** RT ln10 / F (V) at a temperature: 0.05916 V at 25 °C. */
export function nernstSlope(temperatureK: number): number {
  return (8.314462618 * temperatureK * Math.LN10) / 96485.33212
}

interface Couple {
  ox: string
  red: string
  n: number
  e0: number
  protons: number
  /** Reduced units per oxidised one (2 for I₂/2I⁻). */
  k: number
  /** Mol of the oxidised and reduced forms as added. */
  oxMol: number
  redMol: number
  /** Every substance in the layer that is a form of this couple (two salts of one ion, say). */
  members: string[]
}

/** The redox couples in a layer (by couple id), with what each form holds. */
function couplesIn(cat: Catalogue, layer: Layer): Couple[] {
  const byId = new Map<string, Couple>()
  for (const [s, n] of Object.entries(layer.species)) {
    if (!(n > 0)) continue
    const r = cat.substances.get(s)?.redox
    if (!r) continue
    const c = byId.get(r.couple) ?? {
      ox: r.form === 'oxidised' ? s : r.partner,
      red: r.form === 'reduced' ? s : r.partner,
      n: r.electrons,
      e0: r.e0,
      protons: r.protons ?? 0,
      k: r.reducedPer ?? 1,
      oxMol: 0,
      redMol: 0,
      members: [],
    }
    c.members.push(s)
    if (r.form === 'oxidised') c.oxMol += n
    else c.redMol += n
    byId.set(r.couple, c)
  }
  return [...byId.values()]
}

/**
 * A solution never holds one form alone: air and impurities leave a trace of the other (taken as
 * a thousandth). It sets the potential of a couple given as one form only, and nothing else.
 */
const TRACE = 1e-3

function formalPotential(c: Couple, pH: number, s: number): number {
  return c.e0 - (c.protons / c.n) * s * pH
}

/** A couple's total in oxidised units: Ox + Red/k. */
const totalOx = (c: Couple) => c.oxMol + c.redMol / c.k

/** The potential of a couple with a trace of its missing form (a solution of one couple, or all one form). */
function traceLimited(c: Couple, pH: number, s: number, volumeL: number): number {
  const t = totalOx(c)
  const ox = Math.max(c.oxMol, TRACE * t) / volumeL
  const red = Math.max(c.redMol, TRACE * c.k * t) / volumeL
  return formalPotential(c, pH, s) + (s / c.n) * Math.log10(ox / Math.pow(red, c.k))
}

/**
 * Mol of a couple's reduced form at potential E, from [Ox]/[Red]^k = 10^(n(E − E°')/s) and
 * Ox + Red/k = its total. For k = 2 the quadratic's root is taken in a form that cannot cancel.
 */
function reducedMol(c: Couple, E: number, pH: number, s: number, volumeL: number): number {
  const x = (c.n * (E - formalPotential(c, pH, s))) / s
  const T = totalOx(c)
  if (c.k === 1) {
    if (x > 300) return 0
    if (x < -300) return T
    return T / (1 + Math.pow(10, x))
  }
  const t = T / volumeL
  const Q = x > 300 ? Infinity : x < -300 ? 0 : Math.pow(10, x)
  let r: number
  if (c.k === 2) r = (2 * t) / (0.5 + Math.sqrt(0.25 + 4 * Q * t))
  else {
    // Q·r^k + r/k = t rises with r: bisect.
    let lo = 0
    let hi = c.k * t
    for (let i = 0; i < 80; i++) {
      const mid = (lo + hi) / 2
      if (Q * Math.pow(mid, c.k) + mid / c.k > t) hi = mid
      else lo = mid
    }
    r = (lo + hi) / 2
  }
  return Number.isFinite(r) ? r * volumeL : 0
}

export interface RedoxEquilibrium {
  /** The solution's potential (V vs the standard hydrogen electrode). */
  potentialV: number
  /** The layer with each couple's forms redistributed. */
  layer: Layer
}

/**
 * Bring the couples in a layer to one potential. Undefined when fewer than two couples meet (a
 * couple on its own keeps the forms it was given, and its potential follows from them).
 */
export function redoxEquilibrate(cat: Catalogue, layer: Layer, pH: number, temperatureK: number): RedoxEquilibrium | undefined {
  if (layer.volumeL <= 0) return undefined
  const couples = couplesIn(cat, layer)
  if (couples.length === 0) return undefined
  const rust = scientificNumerics()
  if (rust) {
    const result = rust.redox(couples, pH, temperatureK, layer.volumeL)
    if (!result.reducedMol) return { potentialV: result.potentialV, layer }
    const species = { ...layer.species }
    couples.forEach((couple, index) => {
      const red = result.reducedMol![index]
      for (const member of couple.members) species[member] = 0
      species[couple.red] = red
      species[couple.ox] = Math.max(0, totalOx(couple) - red / couple.k)
    })
    return { potentialV: result.potentialV, layer: { ...layer, species } }
  }
  const s = nernstSlope(temperatureK)
  const V = layer.volumeL
  // One couple: its potential is fixed by the forms as they are.
  if (couples.length === 1) return { potentialV: traceLimited(couples[0], pH, s, V), layer }
  // Electrons held: n per oxidised unit reduced, so n·Red/k.
  const electrons = couples.reduce((a, c) => a + (c.n * c.redMol) / c.k, 0)
  const capacity = couples.reduce((a, c) => a + c.n * totalOx(c), 0)
  // Nothing to move (all reduced, or all oxidised): the trace sets the potential, at the couple
  // most easily oxidised (all reduced) or most easily reduced (all oxidised).
  if (electrons >= capacity * (1 - 1e-12)) return { potentialV: Math.min(...couples.map((c) => traceLimited(c, pH, s, V))), layer }
  if (electrons <= capacity * 1e-12) return { potentialV: Math.max(...couples.map((c) => traceLimited(c, pH, s, V))), layer }
  // Electrons held fall as E rises; bisect over a span wider than any couple's.
  const held = (E: number) => couples.reduce((a, c) => a + (c.n * reducedMol(c, E, pH, s, V)) / c.k, 0)
  let lo = -4
  let hi = 4
  for (let i = 0; i < 64; i++) {
    const mid = (lo + hi) / 2
    if (held(mid) > electrons) lo = mid
    else hi = mid
  }
  const E = (lo + hi) / 2
  const species = { ...layer.species }
  for (const c of couples) {
    const red = reducedMol(c, E, pH, s, V)
    for (const m of c.members) species[m] = 0
    species[c.red] = red
    species[c.ox] = Math.max(0, totalOx(c) - red / c.k)
  }
  return { potentialV: E, layer: { ...layer, species } }
}
