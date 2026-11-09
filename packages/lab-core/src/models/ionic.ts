// Ionic equilibrium (contract equilibrium.ionic, T3): acid–base, complexation, hydrolysis and
// precipitation in one solve, by the tableau method of chemical speciation codes (the Rust
// `lab_equilibrium` kernel). Engaged for a liquid that holds an ion carrier (`aqueous`), a salt
// that dissolves to ions (`ions`) or a substance that can come out as a solid (`solid`); other
// liquids keep the charge-balance solver of acidbase.ts.
//
// Components are free H⁺ and one per ion carrier: for an acid–base system its fully deprotonated
// form, otherwise the ion itself. Protons are implicit, as in the charge balance: a carrier stands
// for its neutral acid or base (chloride for HCl, sodium for NaOH, a metal ion for its hydroxide),
// so its proton content is minus its component's charge and a salt's is the sum of its ions'. A
// solid's dissolution follows from its ions the same way: Cu(OH)₂ is Cu²⁺ less two protons.
// Davies activity coefficients from the ionic strength, as PHREEQC uses for species without
// ion-size parameters (the charge-balance solver for plain acids and bases stays ideal); log K at
// 25 °C with van 't Hoff corrections where a ΔH is given.
import type { Catalogue } from '../catalogue/catalogue.ts'
import type { Contents, Layer } from '../kernel/state.ts'
import { liquidVolume } from '../kernel/state.ts'
import { soluteDensity } from '../kernel/materials.ts'
import { parseValue } from '../units/index.ts'
import { pKw, primeSpeciation, solvePH, systemsIn } from './acidbase.ts'
import { isOrganic } from './phases.ts'
import { type EquilibriumProblem, requireNumerics } from './numerics.ts'

const LN10 = Math.LN10
const R = 8.314462618
/** Enthalpy of water's ionisation, kJ/mol (H₂O = H⁺ + OH⁻). */
const WATER_ION_KJ = 55.8

/** log K at a temperature from its value at 25 °C and a reaction enthalpy in kJ/mol (van 't Hoff). */
export function logKAt(logK25: number, dHkJ: number | undefined, temperatureK: number): number {
  if (!dHkJ) return logK25
  return logK25 - ((dHkJ * 1000) / (R * LN10)) * (1 / temperatureK - 1 / 298.15)
}

/**
 * The ion carriers present in a liquid (carriers themselves, and what salts dissolve to), and those
 * from substances without an acid–base facet (which only the ionic model describes).
 */
function carriersIn(cat: Catalogue, layer: Layer): { all: string[]; own: string[] } {
  const all = new Set<string>()
  const own = new Set<string>()
  for (const [s, n] of Object.entries(layer.species)) {
    if (!(n > 0)) continue
    const def = cat.substances.get(s)
    const carriers = def?.aqueous ? [s] : def?.ions ? Object.keys(def.ions) : []
    for (const c of carriers) {
      all.add(c)
      if (!def?.acidBase) own.add(c)
    }
  }
  return { all: [...all].sort(), own: [...own] }
}

/** A carrier with chemistry or colour of its own (not a spectator like Na⁺ or Cl⁻). */
function active(cat: Catalogue, carrier: string): boolean {
  const def = cat.substances.get(carrier)
  return !!(def?.optics?.epsilon || (def?.aqueous?.species?.length ?? 0) > 0)
}

const reactiveCache = new WeakMap<Catalogue, Map<string, boolean>>()

/**
 * Whether something can happen among these carriers beyond acid–base: a solid they could form or
 * a complex between two of them. Salt water alone (sodium and chloride) needs no ionic solve.
 */
function canReact(cat: Catalogue, carriers: string[]): boolean {
  let cache = reactiveCache.get(cat)
  if (!cache) reactiveCache.set(cat, (cache = new Map()))
  const key = carriers.join('|')
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const set = new Set(carriers)
  let result = false
  for (const def of cat.substances.values()) {
    // A gas phase is not enough on its own: see gasCouldForm.
    if (def.solid && def.ions && def.solid.phase !== 'gas' && Object.keys(def.ions).every((c) => set.has(c))) {
      result = true
      break
    }
  }
  if (!result) {
    outer: for (const c of carriers) {
      for (const sp of cat.substances.get(c)?.aqueous?.species ?? []) {
        const others = Object.keys(sp.with ?? {}).filter((w) => w !== 'H+' && w !== c)
        if (others.length > 0 && others.every((w) => set.has(w))) {
          result = true
          break outer
        }
      }
    }
  }
  cache.set(key, result)
  return result
}

/**
 * Whether a liquid (and the solids with it) needs the ionic model: an ionic solid is present, a
 * salt brings an ion with chemistry or colour of its own, or its ions could form a solid or a
 * complex. Acid–base substances alone keep the charge-balance solver.
 */
export function isIonic(cat: Catalogue, layer: Layer, solids?: Record<string, number>): boolean {
  for (const [s, n] of Object.entries(solids ?? {})) if (n > 0 && cat.substances.get(s)?.solid) return true
  const { all, own } = carriersIn(cat, layer)
  return own.some((c) => active(cat, c)) || (all.length > 0 && (canReact(cat, all) || gasCouldForm(cat, layer, all)))
}

const gasPhaseCache = new WeakMap<Catalogue, Array<{ carrier: string; species: string; henry: number }>>()

/**
 * Whether a gas could come out of the liquid: its carrier's total, all as the gas's aqueous
 * species at the charge-balance pH, reaches half its solubility under 1 atm (Henry's law). An
 * alkaline carbonate buffer cannot give off CO₂; an acidified carbonate can, and then the ionic
 * model takes it over.
 */
function gasCouldForm(cat: Catalogue, layer: Layer, carriers: string[]): boolean {
  let phases = gasPhaseCache.get(cat)
  if (!phases) {
    phases = []
    for (const def of cat.substances.values()) {
      const ions = Object.keys(def.ions ?? {})
      if (def.solid?.phase !== 'gas' || ions.length !== 1 || !def.gas?.species) continue
      phases.push({ carrier: ions[0], species: def.gas.species, henry: def.gas.henry })
    }
    gasPhaseCache.set(cat, phases)
  }
  if (!(layer.volumeL > 0)) return false
  let pH: number | undefined
  for (const g of phases) {
    if (!carriers.includes(g.carrier)) continue
    let total = 0
    for (const [s, n] of Object.entries(layer.species)) if (n > 0) total += (n * (carriersOf(cat, s)[g.carrier] ?? 0)) / layer.volumeL
    if (total < 0.5 * g.henry) continue
    // The carrier's protonated forms (species with only H⁺ terms): the gas species' share at this pH.
    pH ??= solvePH(systemsIn(cat, layer), 298.15)
    let sum = 1
    let share = 0
    for (const sp of cat.substances.get(g.carrier)?.aqueous?.species ?? []) {
      const terms = Object.keys(sp.with ?? {})
      if (terms.some((t) => t !== 'H+')) continue
      const w = Math.pow(10, sp.logK - (sp.with?.['H+'] ?? 0) * pH)
      sum += w
      if (sp.formula === g.species) share = w
    }
    if ((total * share) / sum >= 0.5 * g.henry) return true
  }
  return false
}

/** The ion carriers a substance dissolves to (itself if it is one), with counts. */
export function carriersOf(cat: Catalogue, substance: string): Record<string, number> {
  const def = cat.substances.get(substance)
  if (def?.ions) return def.ions
  return { [substance]: 1 }
}

interface Component {
  carrier: string
  /** Charge of the component species (the fully deprotonated form, or the ion). */
  charge: number
}

export interface IonicSpecies {
  /** A name for the species ("Cu(NH3)4+2", or the carrier and form "core:ammonia#0"). */
  name: string
  /** The carrier whose form or complex it is (the first term for a complex). */
  carrier: string
  conc: number
  /** Its charge (from its components and protons). */
  charge?: number
  /** Enthalpy of forming it from its components, kJ/mol (water's ionisation for OH⁻). */
  dH?: number
  epsilon?: ReadonlyArray<readonly [number, number]>
  colour?: string
}

export interface IonicResult {
  pH: number
  converged: boolean
  species: IonicSpecies[]
  /** Equilibrium amount of each candidate solid, mol per litre of liquid. */
  solids: Record<string, number>
  /** Free concentration of each carrier's component, mol/L. */
  free: Record<string, number>
}

interface Built {
  problem: EquilibriumProblem
  components: Component[]
  index: Map<string, number>
  speciesInfo: Array<Omit<IonicSpecies, 'conc'>>
  solidIds: string[]
}

/**
 * The tableau for a liquid: carriers' totals (mol/L) after salts are taken apart, and every species
 * and candidate solid whose components are all present. `solids` adds undissolved solid (mol/L) to
 * the totals so that it can dissolve.
 */
function build(cat: Catalogue, totals: Record<string, number>, temperatureK: number): Built {
  const components: Component[] = [{ carrier: 'H+', charge: 1 }]
  const index = new Map<string, number>([['H+', 0]])
  const T: number[] = [0]
  const add = (carrier: string, amount: number): number => {
    let j = index.get(carrier)
    if (j === undefined) {
      const def = cat.substances.get(carrier)
      const ab = def?.acidBase
      const charge = ab ? (ab.charge ?? 0) - ab.pKa.length : (def?.aqueous?.charge ?? 0)
      j = components.length
      components.push({ carrier, charge })
      index.set(carrier, j)
      T.push(0)
    }
    T[j] += amount
    // Protons implicit: the carrier stands for its neutral acid or base. A substance with spectator
    // ions (sodium acetate as one system) carries them in its own proton count.
    const spectator = cat.substances.get(carrier)?.acidBase?.spectator ?? 0
    T[0] += amount * (-components[j].charge - spectator)
    return j
  }
  for (const [s, c] of Object.entries(totals)) {
    if (!(c > 0)) continue
    for (const [carrier, k] of Object.entries(carriersOf(cat, s))) add(carrier, c * k)
  }
  const species: EquilibriumProblem['species'] = []
  const speciesInfo: Built['speciesInfo'] = []
  const lnKw = -pKw(temperatureK) * LN10
  // Water's own species: H⁺ and OH⁻.
  species.push({ lnBeta: 0, terms: [[0, 1]] })
  speciesInfo.push({ name: 'H+', carrier: 'H+', dH: 0 })
  species.push({ lnBeta: lnKw, terms: [[0, -1]] })
  speciesInfo.push({ name: 'OH-', carrier: 'H+', dH: WATER_ION_KJ })
  const termsOf = (self: number, withTerms: Record<string, number> | undefined): Array<[number, number]> | undefined => {
    const out: Array<[number, number]> = [[self, 1]]
    for (const [other, k] of Object.entries(withTerms ?? {})) {
      const j = other === 'H+' ? 0 : index.get(other)
      if (j === undefined) return undefined
      const hit = out.find((t) => t[0] === j)
      if (hit) hit[1] += k
      else out.push([j, k])
    }
    return out
  }
  for (const [j, comp] of components.entries()) {
    if (j === 0) continue
    const def = cat.substances.get(comp.carrier)
    const ab = def?.acidBase
    if (ab) {
      // Forms of an acid–base system: form i has n − i protons more than the component, each
      // bound with minus its site's ionisation enthalpy.
      const sites = ab.pKa.map((pKa, k) => ({ pKa, dH: ab.dH?.[k] ?? 0 })).sort((a, b) => a.pKa - b.pKa)
      const pKa = sites.map((x) => x.pKa)
      const n = pKa.length
      for (let i = 0; i <= n; i++) {
        let logBeta = 0
        let dH = 0
        for (let k = i; k < n; k++) {
          logBeta += pKa[k]
          dH -= sites[k].dH
        }
        species.push({ lnBeta: logBeta * LN10, terms: i < n ? [[j, 1], [0, n - i]] : [[j, 1]] })
        const form = ab.forms?.[i]
        speciesInfo.push({ name: `${comp.carrier}#${i}`, carrier: comp.carrier, dH, ...(form?.epsilon ? { epsilon: form.epsilon } : !ab.forms && def?.optics?.epsilon ? { epsilon: def.optics.epsilon } : {}), ...(form?.colour ? { colour: form.colour } : {}) })
      }
    } else {
      species.push({ lnBeta: 0, terms: [[j, 1]] })
      speciesInfo.push({ name: def?.aqueous?.formula ?? comp.carrier, carrier: comp.carrier, dH: 0, ...(def?.optics?.epsilon ? { epsilon: def.optics.epsilon } : {}), ...(def?.optics?.colour ? { colour: def.optics.colour } : {}) })
    }
    for (const sp of def?.aqueous?.species ?? []) {
      const terms = termsOf(j, sp.with)
      if (!terms) continue
      species.push({ lnBeta: logKAt(sp.logK, sp.dH, temperatureK) * LN10, terms })
      speciesInfo.push({ name: sp.formula, carrier: comp.carrier, dH: sp.dH ?? 0, ...(sp.epsilon ? { epsilon: sp.epsilon } : {}), ...(sp.colour ? { colour: sp.colour } : {}) })
    }
  }
  species.forEach((sp, k) => (speciesInfo[k].charge = sp.terms.reduce((a, [j, n]) => a + n * components[j].charge, 0)))
  // Candidate solids: those whose ions are all present.
  const solids: EquilibriumProblem['solids'] = []
  const solidIds: string[] = []
  for (const def of cat.substances.values()) {
    if (!def.solid || !def.ions) continue
    const terms: Array<[number, number]> = []
    let proton = 0
    let ok = true
    for (const [carrier, k] of Object.entries(def.ions)) {
      const j = index.get(carrier)
      if (j === undefined) {
        ok = false
        break
      }
      terms.push([j, k])
      const spectator = cat.substances.get(carrier)?.acidBase?.spectator ?? 0
      proton += k * (-components[j].charge - spectator)
    }
    if (!ok) continue
    if (proton !== 0) terms.push([0, proton])
    solids.push({ lnK: logKAt(def.solid.logK, def.solid.dH, temperatureK) * LN10, terms })
    solidIds.push(def.id)
  }
  return { problem: { totals: T, species, solids, charges: components.map((c) => c.charge), daviesA: daviesA(temperatureK) }, components, index, speciesInfo, solidIds }
}

/**
 * The Davies (Debye–Hückel) A at a temperature, log₁₀ units, from water's dielectric constant
 * (Malmberg and Maryott 1956): A = 1.8248×10⁶ √ρ (εT)^−3/2; 0.511 at 25 °C.
 */
export function daviesA(temperatureK: number): number {
  const t = temperatureK - 273.15
  const eps = 87.74 - 0.40008 * t + 9.398e-4 * t * t - 1.41e-6 * t * t * t
  return (1.82483e6 * Math.sqrt(0.997)) / Math.pow(eps * temperatureK, 1.5)
}

/**
 * Solve the ionic equilibrium of dissolved totals (mol/L by substance, salts included) plus any
 * solids present (mol/L), with Davies activity coefficients. Returns the pH (−log a(H⁺)), every
 * species' concentration, the components' free activities, and how much of each candidate solid is
 * present at equilibrium.
 */
export function ionicEquilibrium(cat: Catalogue, totals: Record<string, number>, temperatureK: number, warm?: number[]): IonicResult & { warm: number[] } {
  const b = build(cat, totals, temperatureK)
  const out = requireNumerics().equilibrium(b.problem, warm && warm.length === b.components.length ? warm : undefined)
  const free: Record<string, number> = {}
  b.components.forEach((c, j) => (free[c.carrier] = Math.exp(out.z[j])))
  const solids: Record<string, number> = {}
  b.solidIds.forEach((id, k) => (solids[id] = out.solid[k]))
  return {
    pH: -out.z[0] / LN10,
    converged: out.converged,
    species: b.speciesInfo.map((info, k) => ({ ...info, conc: out.conc[k] })),
    solids,
    free,
    warm: out.z,
  }
}

/** Dissolved totals of a layer (mol/L), and undissolved solids (mol/L of the liquid) added to them. */
export function layerTotals(layer: Layer, solids?: Record<string, number>, volumeL = layer.volumeL): Record<string, number> {
  const t: Record<string, number> = {}
  if (!(volumeL > 0)) return t
  for (const [s, n] of Object.entries(layer.species)) if (n > 0) t[s] = (t[s] ?? 0) + n / volumeL
  for (const [s, n] of Object.entries(solids ?? {})) if (n > 0) t[s] = (t[s] ?? 0) + n / volumeL
  return t
}

/**
 * Bring a container's liquid and its ionic solids to equilibrium: salts are taken apart into their
 * ions, solids precipitate at once and dissolve by `dissolveFraction` of the way (1 when mixed).
 * Precipitate stays suspended as particles until it settles or is spun down; existing solid
 * (crystals, a pellet) dissolves where it lies. Returns the change in each solid (mol; positive =
 * came out of solution).
 */
export function ionicEquilibrate(cat: Catalogue, c: Contents, dissolveFraction = 1): Record<string, number> {
  const change: Record<string, number> = {}
  const v = liquidVolume(c)
  if (!(v > 0) || c.layers.length === 0) return change
  // Undissolved ionic solids: settled (crystals, a pellet) and suspended (fresh precipitate).
  const settled: Record<string, number> = {}
  const suspended: Record<string, number> = {}
  for (const [s, n] of Object.entries(c.solid)) if (n > 0 && cat.substances.get(s)?.solid) settled[s] = n
  for (const l of c.layers) for (const [s, n] of Object.entries(l.particles ?? {})) if (n > 0 && cat.substances.get(s)?.solid) suspended[s] = (suspended[s] ?? 0) + n
  const solidsHere: Record<string, number> = {}
  for (const [s, n] of [...Object.entries(settled), ...Object.entries(suspended)]) solidsHere[s] = (solidsHere[s] ?? 0) + n
  // The ionic model treats the aqueous liquid as one (an organic layer holds no ions).
  const aqueous = c.layers.filter((l) => !isOrganic(cat, l))
  if (aqueous.length === 0) return change
  const mixedVolume = aqueous.reduce((a, l) => a + l.volumeL, 0)
  const merged: Layer = { volumeL: mixedVolume, species: {} }
  for (const l of aqueous) for (const [s, n] of Object.entries(l.species)) merged.species[s] = (merged.species[s] ?? 0) + n
  if (!(mixedVolume > 0) || !isIonic(cat, merged, solidsHere)) return change
  const r = ionicEquilibrium(cat, layerTotals(merged, solidsHere, mixedVolume), c.temperatureK)
  if (!r.converged) return change
  // New solid amounts: precipitation at once; dissolution part of the way when unstirred.
  const finalSolid: Record<string, number> = {}
  // Whether the liquid is left at the solve's equilibrium (not part-way through dissolving).
  let atEquilibrium = true
  for (const [s, eqC] of Object.entries(r.solids)) {
    const before = solidsHere[s] ?? 0
    const eq = eqC * mixedVolume
    const after = eq >= before ? eq : before + (eq - before) * dissolveFraction
    if (eq < before && dissolveFraction < 1) atEquilibrium = false
    if (Math.abs(after - before) > 1e-15) change[s] = after - before
    finalSolid[s] = after
  }
  // Carriers' dissolved totals: everything in the liquid and the solids, less what is now solid.
  const carriers: Record<string, number> = {}
  const addCarriers = (s: string, n: number) => {
    for (const [carrier, k] of Object.entries(carriersOf(cat, s))) carriers[carrier] = (carriers[carrier] ?? 0) + n * k
  }
  const taken = new Set<string>()
  for (const [s, n] of Object.entries(merged.species)) {
    if (!(n > 0)) continue
    const def = cat.substances.get(s)
    if (def?.ions || def?.aqueous || def?.acidBase) {
      taken.add(s)
      addCarriers(s, n)
    }
  }
  for (const [s, n] of Object.entries(solidsHere)) addCarriers(s, n)
  for (const [s, n] of Object.entries(finalSolid)) addCarriers(s, -n)
  // The contents' mass before (dissolved solutes by their volume, solids whole), to keep it.
  const before = massAndSoluteVolume(cat, aqueous, solidsHere)
  // Write back: each aqueous layer gets its share of the carriers (salts are now their ions).
  for (const l of aqueous) {
    const share = l.volumeL / mixedVolume
    for (const s of taken) delete l.species[s]
    for (const [carrier, n] of Object.entries(carriers)) if (n > 1e-18) l.species[carrier] = (l.species[carrier] ?? 0) + n * share
  }
  // Solids: fresh precipitate is suspended through the liquid; a dissolving solid goes from the
  // suspension first, then from what has settled.
  for (const [s, after] of Object.entries(finalSolid)) {
    // A gas phase leaves the liquid as bubbles: given off, never kept as a solid.
    if (cat.substances.get(s)?.solid?.phase === 'gas') {
      if (after > 0) giveOffGas(c, s, after)
      continue
    }
    const before = solidsHere[s] ?? 0
    if (after >= before) {
      const fresh = after - before
      if (fresh > 0) for (const l of aqueous) (l.particles ??= {})[s] = (l.particles[s] ?? 0) + fresh * (l.volumeL / mixedVolume)
      continue
    }
    let loss = before - after
    const inSuspension = suspended[s] ?? 0
    const fromSuspension = Math.min(loss, inSuspension)
    if (fromSuspension > 0) {
      for (const l of c.layers) {
        const n = l.particles?.[s] ?? 0
        if (n > 0) l.particles![s] = n - fromSuspension * (n / inSuspension)
      }
      loss -= fromSuspension
    }
    if (loss > 0) c.solid[s] = Math.max(0, (c.solid[s] ?? 0) - loss)
  }
  // The liquid's volume follows: the water a salt's formula held beyond its carriers (NaOH is Na⁺
  // less a proton plus a water), the solute volume the carriers took up, and the water a solid
  // takes into its formula (two for Cu(OH)₂, five for a pentahydrate) all balance, so the contents
  // weigh what they did. Crystals cannot take more than there is: the liquid keeps a tenth of its
  // volume (the equilibrium assumes a liquid).
  // (Gas given off is counted as it leaves: its carriers' mass less the gas's stays as water.)
  const after = massAndSoluteVolume(cat, aqueous, finalSolid)
  const total = aqueous.reduce((a, l) => a + l.volumeL, 0)
  const dV = Math.max(-0.9 * total, after.soluteL - before.soluteL + (before.grams - after.grams) / WATER_G_PER_L)
  if (total > 0 && dV !== 0) for (const l of aqueous) l.volumeL = Math.max(0, l.volumeL + (dV * l.volumeL) / total)
  c.equilibratedK = c.temperatureK
  // The single aqueous layer is now this solution: its next speciation needs no solve.
  if (aqueous.length === 1 && atEquilibrium) primeSpeciation(cat, aqueous[0], c.temperatureK, r)
  return change
}

/** Water's density (g/L), as in contentsMassKg. */
const WATER_G_PER_L = 997

/**
 * What the aqueous layers' solutes weigh and the volume they take up (by their densities, as
 * contentsMassKg counts them), with the solids (whole) added to the weight.
 */
function massAndSoluteVolume(cat: Catalogue, layers: Layer[], solids: Record<string, number>): { grams: number; soluteL: number } {
  let grams = 0
  let soluteL = 0
  for (const l of layers) for (const [s, n] of Object.entries(l.species)) {
    if (!(n > 0)) continue
    const g = n * (molarMassG(cat, s) ?? 0)
    grams += g
    soluteL += g / soluteDensity(cat, s)
  }
  for (const [s, n] of Object.entries(solids)) if (n > 0) grams += n * (molarMassG(cat, s) ?? 0)
  return { grams, soluteL }
}

/** Mol of water a solid's formula holds beyond its carriers (from their molar masses; 0 within rounding). */
export function hiddenWater(cat: Catalogue, solid: string): number {
  const def = cat.substances.get(solid)
  const solidG = molarMassG(cat, solid)
  if (!def?.ions || !solidG) return 0
  let carrierG = 0
  for (const [carrier, k] of Object.entries(def.ions)) carrierG += k * (molarMassG(cat, carrier) ?? 0)
  const w = (solidG - carrierG) / 18.015
  return Math.abs(w) < 0.1 ? 0 : w
}

/** Molar volume of liquid water (L/mol) and the volume a dissolved solute takes up (g → L, as in contentsMassKg). */
const WATER_L_PER_MOL = 0.018069
const SOLUTE_G_PER_L = 1500

/**
 * Gas comes out of the liquid: recorded as given off (taken away by the gas step). The write-back's
 * mass balance leaves the water its carriers held (H₂CO₃ → CO₂ + H₂O), so the liquid's mass falls by
 * exactly the gas's mass.
 */
function giveOffGas(c: Contents, gas: string, mol: number): void {
  ;(c.evolved ??= {})[gas] = (c.evolved[gas] ?? 0) + mol
}

function molarMassG(cat: Catalogue, s: string): number | undefined {
  const t = cat.substances.get(s)?.physical?.molarMass
  return t ? parseValue(t).si * 1000 : undefined
}

/**
 * Gas bubbled into a liquid dissolves as its carriers (CO₂ + H₂O → H₂CO₃), the ionic model then
 * settling it (limewater turning milky with calcium carbonate). A gas with no carriers (hydrogen,
 * oxygen) passes through. Returns whether it dissolved.
 */
export function takeUpGas(cat: Catalogue, c: Contents, gas: string, mol: number): boolean {
  const def = cat.substances.get(gas)
  if (!def?.ions || !(mol > 0)) return false
  const layers = c.layers.filter((l) => !isOrganic(cat, l))
  const volumeL = layers.reduce((a, l) => a + l.volumeL, 0)
  if (!(volumeL > 0)) return false
  let carrierG = 0
  for (const [carrier, k] of Object.entries(def.ions)) carrierG += k * (molarMassG(cat, carrier) ?? 0)
  const gasG = molarMassG(cat, gas) ?? carrierG
  const waterMol = (carrierG - gasG) / 18.015
  const dV = mol * (carrierG / SOLUTE_G_PER_L - waterMol * WATER_L_PER_MOL)
  for (const l of layers) {
    const share = l.volumeL / volumeL
    for (const [carrier, k] of Object.entries(def.ions)) l.species[carrier] = (l.species[carrier] ?? 0) + mol * k * share
    l.volumeL = Math.max(0, l.volumeL + dV * share)
  }
  ionicEquilibrate(cat, c, 1)
  return true
}
