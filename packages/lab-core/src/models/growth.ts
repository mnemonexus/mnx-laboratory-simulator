// Populations over time (contract growth, T1–T2; state model §6): growth in a medium, killing
// by antibiotics, transformation by plasmid DNA in a heat shock, expression of the resistance a
// plasmid carries, and colonies on agar plates. Counts are expected values until colonies form;
// then the number of colonies is drawn (Poisson) from a seeded generator, so replay is exact.
//
// A strain is keyed by its organism id plus "+plasmid" for each plasmid it carries, so a
// transformant is a separate population with its own markers.
import type { Catalogue } from '../catalogue/catalogue.ts'
import type { Differential } from '../catalogue/types.ts'
import { type Container, type Contents, type Layer, mergePopulation, type Population, type SurfaceCells } from '../kernel/state.ts'
import { createRng } from '../rng/rng.ts'
import { parseValue } from '../units/index.ts'
import { populationDelta } from './numerics.ts'

const LN2 = Math.LN2
const K0 = 273.15

// ---- Strains ----

export function strainKey(organism: string, plasmids: readonly string[] = []): string {
  return [organism, ...[...new Set(plasmids)].sort()].join('+')
}
// Strain keys are parsed in the time loop, so their parts are remembered.
const keyParts = new Map<string, string[]>()
function partsOf(key: string): string[] {
  let parts = keyParts.get(key)
  if (!parts) keyParts.set(key, (parts = key.split('+')))
  return parts
}
export function baseOrganism(key: string): string {
  return partsOf(key)[0]
}
export function plasmidsOf(key: string): string[] {
  return partsOf(key).slice(1)
}

const markerCache = new WeakMap<Catalogue, Map<string, Set<string>>>()

/** A strain's plasmids: those it was given (transformants) and those its organism carries of its own. */
export function allPlasmids(cat: Catalogue, key: string): string[] {
  return [...new Set([...plasmidsOf(key), ...(cat.substances.get(baseOrganism(key))?.organism?.plasmids ?? [])])]
}

const genomeCache = new WeakMap<Catalogue, Map<string, string[]>>()

/** The DNA each cell of a strain holds: its chromosome (a DNA substance declaring `genomeOf` it) once, and its plasmids at their copy number. */
export function strainDna(cat: Catalogue, key: string): Array<[string, number]> {
  let genomes = genomeCache.get(cat)
  if (!genomes) {
    genomes = new Map()
    for (const s of cat.substances.values()) if (s.dna?.genomeOf) genomes.set(s.dna.genomeOf, [...(genomes.get(s.dna.genomeOf) ?? []), s.id])
    genomeCache.set(cat, genomes)
  }
  return [
    ...(genomes.get(baseOrganism(key)) ?? []).map((id) => [id, 1] as [string, number]),
    ...allPlasmids(cat, key).map((p) => [p, cat.substances.get(p)?.plasmid?.copyNumber ?? 20] as [string, number]),
  ]
}

/** Markers of a strain: its organism's own plus those of its plasmids. */
export function markersOf(cat: Catalogue, key: string): Set<string> {
  let byKey = markerCache.get(cat)
  if (!byKey) markerCache.set(cat, (byKey = new Map()))
  const hit = byKey.get(key)
  if (hit) return hit
  const out = new Set(cat.substances.get(baseOrganism(key))?.organism?.markers ?? [])
  for (const p of allPlasmids(cat, key)) for (const m of cat.substances.get(p)?.plasmid?.markers ?? []) out.add(m)
  byKey.set(key, out)
  return out
}

// ---- Growth parameters ----

interface GrowthParams {
  doublingS: number
  tMinK: number
  tOptK: number
  tMaxK: number
  maxPerL: number
}

const growthCache = new WeakMap<Catalogue, Map<string, GrowthParams>>()

export function growthParams(cat: Catalogue, organism: string): GrowthParams {
  let byOrg = growthCache.get(cat)
  if (!byOrg) growthCache.set(cat, (byOrg = new Map()))
  const hit = byOrg.get(organism)
  if (hit) return hit
  const o = cat.substances.get(organism)?.organism
  const t = (v: string | undefined, d: number) => (v ? parseValue(v).si : d + K0)
  const p: GrowthParams = {
    doublingS: o?.doublingTime ? parseValue(o.doublingTime).si : 1800,
    tMinK: t(o?.growth?.tMin, 8),
    tOptK: t(o?.growth?.tOpt, 37),
    tMaxK: t(o?.growth?.tMax, 45),
    maxPerL: o?.growth?.maxDensity ? parseValue(o.growth.maxDensity).si / 1000 : 2e12,
  }
  byOrg.set(organism, p)
  return p
}

/** Cardinal temperature model with inflection (Rosso): 1 at the optimum, 0 outside the range. */
export function cardinal(T: number, tMin: number, tOpt: number, tMax: number): number {
  if (T <= tMin || T >= tMax) return 0
  const num = (T - tMax) * (T - tMin) * (T - tMin)
  const den = (tOpt - tMin) * ((tOpt - tMin) * (T - tOpt) - (tOpt - tMax) * (tOpt + tMin - 2 * T))
  return den === 0 ? 0 : Math.max(0, Math.min(1, num / den))
}

// ---- What a liquid or a plate offers ----

interface Environment {
  nutrient: boolean
  /** How much of a full-strength medium this is (0..1): the cell density it can support scales with it. */
  nutrientShare: number
  /** Resistance markers needed to survive the antibiotics present at selecting concentrations. */
  selects: string[]
  /** Each antibiotic present: the marker that resists it, its concentration (mol/L), and that relative to its own MIC. */
  drugs: Array<{ substance: string; resistance: string; molPerL: number; ratio: number }>
  /** What a selective medium stops growing: a Gram class, and/or organisms lacking a marker. */
  inhibits: Array<{ gram?: string; unless?: string }>
  /** Nutrients only some organisms can use (a sole carbon source): the marker needed and the share. */
  marked: Array<{ marker: string; share: number }>
  /** Mineral nitrogen and phosphorus (shares of full strength): growth on a sole carbon source needs both. */
  minerals: { nitrogen: number; phosphorus: number }
  /** Substances present (mol/L), for inducers. */
  present: Set<string>
  /** Mutagens dissolved in it (mol/L), and the lethal exposure they add up to (Σ c / c_toxic). */
  mutagens: Array<{ m: Mutagen; molPerL: number }>
  exposure: number
}

interface MediumRole {
  nutrient: boolean
  /** A nutrient only organisms with this marker can use. */
  usableWith?: string
  /** A mineral nutrient (nitrogen or phosphorus). */
  mineral?: 'nitrogen' | 'phosphorus'
  /** Mass concentration (g/L) of full strength, and the molar mass to get there; absent = any amount is full strength. */
  fullStrengthGPerL?: number
  molarMassGPerMol?: number
  /** Antibiotics: the resistance needed and the selecting concentration (mol/L). */
  resistance?: string
  thresholdMolPerL?: number
}

const roleCache = new WeakMap<Catalogue, Map<string, MediumRole | null>>()

function mediumRole(cat: Catalogue, s: string): MediumRole | null {
  let bySub = roleCache.get(cat)
  if (!bySub) roleCache.set(cat, (bySub = new Map()))
  if (bySub.has(s)) return bySub.get(s)!
  const def = cat.substances.get(s)
  let role: MediumRole | null = null
  if (def?.medium?.nutrient || def?.medium?.mineral || def?.antibiotic) {
    role = { nutrient: def.medium?.nutrient === true, ...(def.medium?.usableWith ? { usableWith: def.medium.usableWith } : {}), ...(def.medium?.mineral ? { mineral: def.medium.mineral } : {}) }
    if (def.medium?.fullStrength && def.physical?.molarMass) {
      role.fullStrengthGPerL = parseValue(def.medium.fullStrength).si
      role.molarMassGPerMol = parseValue(def.physical.molarMass).si * 1000
    }
    if (def.antibiotic) {
      const mm = def.physical?.molarMass ? parseValue(def.physical.molarMass).si * 1000 : 1
      role.molarMassGPerMol ??= mm
      const effective = parseValue(def.antibiotic.effective ?? '10 ug/mL')
      role.resistance = def.antibiotic.resistance
      role.thresholdMolPerL = effective.dim[0] === 1 ? effective.si / mm : effective.si / 1000
    }
  }
  bySub.set(s, role)
  return role
}

function environmentOf(cat: Catalogue, layer: Layer): Environment {
  const env: Environment = { nutrient: false, nutrientShare: 0, selects: [], drugs: [], inhibits: [], marked: [], minerals: { nitrogen: 0, phosphorus: 0 }, present: new Set(), mutagens: [], exposure: 0 }
  if (layer.volumeL <= 0) return env
  for (const [s, n] of Object.entries(layer.species)) {
    if (!(n > 0)) continue
    env.present.add(s)
    const m = mutagenOf(cat, s)
    if (m) {
      env.mutagens.push({ m, molPerL: n / layer.volumeL })
      env.exposure += n / layer.volumeL / m.toxicMolPerL
    }
    const inhibits = cat.substances.get(s)?.medium?.inhibits
    if (inhibits) env.inhibits.push(inhibits)
    const role = mediumRole(cat, s)
    if (!role) continue
    if (role.mineral) env.minerals[role.mineral] += role.fullStrengthGPerL ? (n * role.molarMassGPerMol!) / layer.volumeL / role.fullStrengthGPerL : 1
    if (role.nutrient) {
      const share = role.fullStrengthGPerL ? (n * role.molarMassGPerMol!) / layer.volumeL / role.fullStrengthGPerL : 1
      if (role.usableWith) env.marked.push({ marker: role.usableWith, share })
      else {
        env.nutrient = true
        env.nutrientShare += share
      }
    }
    if (role.resistance) {
      const ratio = n / layer.volumeL / role.thresholdMolPerL!
      env.drugs.push({ substance: s, resistance: role.resistance, molPerL: n / layer.volumeL, ratio })
      if (ratio >= 1) env.selects.push(role.resistance)
    }
  }
  return env
}

/** Whether a selective medium stops this strain growing. */
function inhibitedBy(cat: Catalogue, key: string, env: Environment): boolean {
  if (env.inhibits.length === 0) return false
  const gram = cat.substances.get(baseOrganism(key))?.organism?.gram
  const markers = markersOf(cat, key)
  return env.inhibits.some((i) => (i.gram === undefined || i.gram === gram) && (i.unless === undefined || !markers.has(i.unless)))
}

/**
 * How much of a full-strength medium this strain can grow on: the general nutrients, and the sole
 * carbon sources its markers let it use, which yield no more than the scarcer of mineral nitrogen
 * and phosphorus allows (Liebig's law of the minimum).
 */
function shareFor(cat: Catalogue, key: string, env: Environment): number {
  if (env.marked.length === 0) return env.nutrientShare
  const markers = markersOf(cat, key)
  const carbon = env.marked.reduce((a, m) => a + (markers.has(m.marker) ? m.share : 0), 0)
  return env.nutrientShare + Math.min(carbon, env.minerals.nitrogen, env.minerals.phosphorus)
}

function resistant(cat: Catalogue, key: string, env: Environment): boolean {
  const markers = markersOf(cat, key)
  return env.selects.every((m) => markers.has(m))
}

/**
 * An organism's MIC of an antibiotic (mol/L): its own where the catalogue gives one, else the
 * antibiotic's. Undefined for a strain carrying the resistance marker (it is not inhibited).
 */
export function micMolPerL(cat: Catalogue, key: string, antibiotic: string): number | undefined {
  const role = mediumRole(cat, antibiotic)
  if (!role?.resistance) return undefined
  if (markersOf(cat, key).has(role.resistance)) return undefined
  const own = cat.substances.get(baseOrganism(key))?.organism?.susceptibility?.[antibiotic]
  if (!own) return role.thresholdMolPerL
  const q = parseValue(own)
  return q.dim[0] === 1 ? q.si / (role.molarMassGPerMol ?? molarMassOf(cat, antibiotic)) : q.si / 1000
}

function molarMassOf(cat: Catalogue, s: string): number {
  const mm = cat.substances.get(s)?.physical?.molarMass
  return mm ? parseValue(mm).si * 1000 : 1
}

/** The FICI of two antibiotics together: declared on either, else additive (1). */
export function fici(cat: Catalogue, a: string, b: string): number {
  return cat.substances.get(a)?.antibiotic?.interactions?.[b] ?? cat.substances.get(b)?.antibiotic?.interactions?.[a] ?? 1
}

/**
 * Several antibiotics at once, as one multiple of the MIC (1 = just inhibitory): each drug's
 * concentration over its MIC, summed (Loewe additivity), plus an interaction term for each pair,
 * α √(xᵢ xⱼ) with α = 2 (1/FICI − 1), so that equal shares of the two inhibit together at FICI.
 */
export function combinedRatio(cat: Catalogue, ratios: ReadonlyArray<{ substance: string; ratio: number }>): number {
  let r = 0
  for (let i = 0; i < ratios.length; i++) {
    r += ratios[i].ratio
    for (let j = i + 1; j < ratios.length; j++) r += 2 * (1 / fici(cat, ratios[i].substance, ratios[j].substance) - 1) * Math.sqrt(ratios[i].ratio * ratios[j].ratio)
  }
  return Math.max(0, r)
}

// ---- Growth factors, mutants and mutagens ----

interface Requirement {
  substance: string
  molPerCell: number
  ksMolPerL: number
}

interface Mutant {
  to: string
  kind: string
  rate: number
  frequency: number
}

export interface Mutagen {
  substance: string
  /** Induced mutations per cell division per µM, by kind. */
  potency: Record<string, number>
  /** The concentration that kills all but 1/e of the cells exposed to it (Infinity: harmless). */
  toxicMolPerL: number
  diffusionCm2PerS: number
}

const requirementCache = new WeakMap<Catalogue, Map<string, Requirement[]>>()

/** The growth factors an organism cannot make (empty for a prototroph). */
function requirementsOf(cat: Catalogue, organism: string): Requirement[] {
  let m = requirementCache.get(cat)
  if (!m) requirementCache.set(cat, (m = new Map()))
  let list = m.get(organism)
  if (!list) {
    list = (cat.substances.get(organism)?.organism?.requires ?? []).map((r) => ({ substance: r.substance, molPerCell: parseValue(r.perCell).si, ksMolPerL: r.ks ? parseValue(r.ks).si / 1000 : 1e-6 }))
    m.set(organism, list)
  }
  return list
}

/** How fast an auxotroph's growth factors let it grow (0..1): S/(Ks + S) for each, multiplied. */
function factorShare(reqs: Requirement[], layer: Layer): number {
  let f = 1
  for (const r of reqs) {
    const s = layer.volumeL > 0 ? Math.max(0, layer.species[r.substance] ?? 0) / layer.volumeL : 0
    f *= s / (r.ksMolPerL + s)
  }
  return f
}

/** The most new cells the growth factors left in a layer can make. */
function factorRoom(reqs: Requirement[], layer: Layer): number {
  let room = Infinity
  for (const r of reqs) room = Math.min(room, Math.max(0, layer.species[r.substance] ?? 0) / r.molPerCell)
  return room
}

/** New cells use up the growth factors they need. */
function useFactors(reqs: Requirement[], layer: Layer, cells: number): void {
  for (const r of reqs) layer.species[r.substance] = Math.max(0, (layer.species[r.substance] ?? 0) - cells * r.molPerCell)
}

const mutantCache = new WeakMap<Catalogue, Map<string, Mutant[]>>()

function mutantsOf(cat: Catalogue, organism: string): Mutant[] {
  let m = mutantCache.get(cat)
  if (!m) mutantCache.set(cat, (m = new Map()))
  let list = m.get(organism)
  if (!list) {
    list = (cat.substances.get(organism)?.organism?.mutants ?? []).map((x) => ({ to: x.to, kind: x.kind, rate: x.rate, frequency: x.frequency ?? 0 }))
    m.set(organism, list)
  }
  return list
}

const mutagenCache = new WeakMap<Catalogue, Map<string, Mutagen | null>>()

/** A substance's mutagenic action, or null. */
export function mutagenOf(cat: Catalogue, s: string): Mutagen | null {
  let m = mutagenCache.get(cat)
  if (!m) mutagenCache.set(cat, (m = new Map()))
  if (m.has(s)) return m.get(s)!
  const d = cat.substances.get(s)?.mutagen
  let out: Mutagen | null = null
  if (d) {
    let toxic = Infinity
    if (d.toxic) {
      const q = parseValue(d.toxic)
      toxic = q.dim[0] === 1 ? q.si / molarMassOf(cat, s) : q.si / 1000
    }
    out = { substance: s, potency: d.potency, toxicMolPerL: toxic, diffusionCm2PerS: d.diffusion ? parseValue(d.diffusion).si * 1e4 : 5e-6 }
  }
  m.set(s, out)
  return out
}

/**
 * Mutations among new cells: each mutant arises at its spontaneous rate per division plus what the
 * mutagens induce for its kind of mutation (`induced`, per division). The mutants become their own
 * strain (the mutant organism, with the same plasmids) and keep the cells' state.
 */
function mutate(cat: Catalogue, key: string, pops: Record<string, Population>, divisions: number, induced: (kind: string) => number): void {
  const p = pops[key]
  for (const m of mutantsOf(cat, baseOrganism(key))) {
    const n = Math.min(p.viable, divisions * (m.rate + induced(m.kind)))
    if (!(n > 0)) continue
    mergePopulation((pops[strainKey(m.to, plasmidsOf(key))] ??= { count: 0, viable: 0 }), { ...p, count: n, viable: n }, 1)
    p.count -= n
    p.viable -= n
  }
}

/** Induced mutations per division of one kind from mutagens at uniform concentrations. */
function inducedBy(mutagens: Environment['mutagens'], kind: string): number {
  let r = 0
  for (const x of mutagens) r += (x.m.potency[kind] ?? 0) * x.molPerL * 1e6
  return r
}

/**
 * A mutagen's lesions kill as well as mutate: cells exposed to c survive with e^(−c / c_toxic), the
 * share set by the highest exposure they have met (`exposure`, Σ c / c_toxic over the mutagens). So
 * revertants, survivors times mutations, rise with the dose and then fall: most at c_toxic.
 */
function expose(p: Population, exposure: number): void {
  if (!(exposure > (p.exposure ?? 0))) return
  p.viable *= Math.exp(-(exposure - (p.exposure ?? 0)))
  p.exposure = exposure
}

/** A grown culture already holds its spontaneous mutants: each at its declared share. */
export function mutantsAtStart(cat: Catalogue, layer: Layer): void {
  const pops = layer.populations
  if (!pops) return
  for (const [key, p] of Object.entries(pops)) {
    for (const m of mutantsOf(cat, baseOrganism(key))) {
      if (!(m.frequency > 0) || !(p.count > 0)) continue
      const n = p.count * m.frequency
      const alive = p.viable / p.count
      mergePopulation((pops[strainKey(m.to, plasmidsOf(key))] ??= { count: 0, viable: 0 }), { ...p, count: n, viable: n * alive }, 1)
      p.count -= n
      p.viable -= n * alive
    }
  }
}

/** Decimal reduction time at 60 °C (s) and z value (K) of a vegetative bacterium when the catalogue gives none. */
const D60_S = 120
const Z_K = 5

/** The share of cells that survive `dt` of heat above the organism's maximum growth temperature. */
function heatSurvival(cat: Catalogue, key: string, T: number, dt: number, tMaxK: number): number {
  if (T <= tMaxK) return 1
  const h = cat.substances.get(baseOrganism(key))?.organism?.heatResistance
  const d60 = h ? parseValue(h.d60).si : D60_S
  const z = h?.z ?? Z_K
  return Math.pow(10, -dt / (d60 * Math.pow(10, (333.15 - T) / z)))
}

/** Killing rate (1/s) of a susceptible, growing population far above the MIC. */
const KILL_PER_S = 1 / 1800
/** Steepness of the concentration–effect curve (Hill coefficient). */
const HILL = 3

/**
 * Net growth rate (1/s) under the antibiotics a strain does not resist, taken together (pharmacodynamic model,
 * Regoes et al. 2004): ψ(c) = ψmax − (ψmax − ψmin) x / (x − ψmin/ψmax), x = (c/MIC)^κ. It falls
 * through zero at the MIC (slower growth below it, killing above it, towards ψmin). Without
 * growth there is no killing below the MIC, and only slow killing above it.
 */
function netRate(cat: Catalogue, key: string, env: Environment, psiMax: number, fitness: number): number {
  const ratios: Array<{ substance: string; ratio: number }> = []
  for (const d of env.drugs) {
    const mic = micMolPerL(cat, key, d.substance)
    if (mic !== undefined) ratios.push({ substance: d.substance, ratio: d.molPerL / mic })
  }
  const ratio = ratios.length === 1 ? ratios[0].ratio : combinedRatio(cat, ratios)
  if (ratio <= 0) return psiMax
  const psiMin = -KILL_PER_S * Math.max(0.05, fitness)
  if (psiMax <= 0) return ratio >= 1 ? psiMin : 0
  const x = Math.pow(ratio, HILL)
  return psiMax - ((psiMax - psiMin) * x) / (x - psiMin / psiMax)
}

// ---- Transformation (T1, tuned to the standard heat-shock protocol) ----

/** Fraction of competent cells that take up a plasmid at best: about 1e-5 (10³–10⁴ transformants per µg). */
const UPTAKE_MAX = 1e-5
/** DNA mass at which binding is about two-thirds saturated (ng). */
const DNA_SAT_NG = 200
/** Binding on ice, time constant (s). */
const BIND_S = 300
/** Heat dose (K·s above 30 °C) that gives the most transformants: what 50 s at 42 °C gives a 1.5 mL tube. */
const DOSE_OPT = 250
/** Above this dose the heat starts to kill (K·s). */
const DOSE_LETHAL = 600

function shockFactor(dose: number): number {
  const x = dose / DOSE_OPT
  return x <= 0 ? 0 : x * Math.exp(1 - x)
}

function plasmidsIn(cat: Catalogue, layer: Layer): Array<{ id: string; ng: number }> {
  const out: Array<{ id: string; ng: number }> = []
  for (const [s, n] of Object.entries(layer.species)) {
    if (!(n > 0) || !cat.substances.get(s)?.plasmid) continue
    const mm = cat.substances.get(s)?.physical?.molarMass
    out.push({ id: s, ng: n * (mm ? parseValue(mm).si * 1000 : 3.3e6) * 1e9 })
  }
  return out.sort((a, b) => b.ng - a.ng)
}

/**
 * Competent cells and plasmid DNA: binding on ice, a dose of heat during the shock, and uptake
 * when the cells cool again. Warmth without a shock loses competence and bound DNA.
 */
function transform(cat: Catalogue, layer: Layer, T: number, dt: number): void {
  const pops = layer.populations
  if (!pops) return
  const dna = plasmidsIn(cat, layer)
  for (const key of Object.keys(pops)) {
    const p = pops[key]
    if (p.competence === undefined || p.viable <= 0) continue
    const tC = T - K0
    if (tC < 10) {
      const target = (p.competence ?? 0) * (dna.length ? 1 - Math.exp(-dna[0].ng / DNA_SAT_NG) : 0)
      p.bound = (p.bound ?? 0) + (target - (p.bound ?? 0)) * (1 - Math.exp(-dt / BIND_S))
    } else if (tC < 30 && !(p.dose ?? 0)) {
      // Lukewarm: competence and bound DNA are lost over some minutes.
      const f = Math.exp(-dt * ((tC - 10) / 10) / 600)
      p.competence = (p.competence ?? 0) * f
      p.bound = (p.bound ?? 0) * f
    }
    if (tC > 30) p.dose = (p.dose ?? 0) + (tC - 30) * dt
    // The shock ends when the cells have cooled again (ice, or the bench): uptake, and heat damage.
    if ((p.dose ?? 0) > 0 && tC < 25) {
      const dose = p.dose ?? 0
      const transformed = p.viable * (p.bound ?? 0) * UPTAKE_MAX * shockFactor(dose)
      const survive = Math.exp(-Math.max(0, dose - DOSE_LETHAL) / DOSE_LETHAL)
      p.viable *= survive
      p.dose = 0
      p.bound = 0
      p.competence = (p.competence ?? 0) * 0.2
      if (transformed > 0 && dna.length) {
        const k = strainKey(baseOrganism(key), [...plasmidsOf(key), dna[0].id])
        const t = (pops[k] ??= { count: 0, viable: 0, expressed: 0 })
        const n = transformed * survive
        t.count += n
        t.viable += n
        p.viable -= n
        p.count -= n
      }
    }
  }
}

// ---- Growth in liquid ----

/** Growth, killing by antibiotics, and expression of plasmid resistance in one liquid layer. */
export function growLayer(cat: Catalogue, layer: Layer, T: number, dt: number, rate = 1): void {
  const pops = layer.populations
  if (!pops || layer.volumeL <= 0) return
  transform(cat, layer, T, dt)
  const env = environmentOf(cat, layer)
  let total = 0
  for (const p of Object.values(pops)) total += p.viable
  for (const [key, p] of Object.entries(pops)) {
    if (p.viable <= 0) continue
    const g = growthParams(cat, baseOrganism(key))
    // Too hot to grow is hot enough to kill, slowly just above the maximum and in seconds at 70 °C.
    const survive = heatSurvival(cat, key, T, dt, g.tMaxK)
    if (survive < 1) {
      p.viable *= survive
      continue
    }
    const fitness = cardinal(T, g.tMinK, g.tOptK, g.tMaxK)
    if (plasmidsOf(key).length) p.expressed = (p.expressed ?? 0) + (1 - (p.expressed ?? 0)) * (1 - Math.exp((-dt * fitness) / 1800))
    if (env.exposure > 0) expose(p, env.exposure)
    if (inhibitedBy(cat, key, env)) {
      p.viable *= Math.exp(-dt / 7200)
      continue
    }
    const share = shareFor(cat, key, env)
    const capacity = g.maxPerL * layer.volumeL * Math.min(1, share)
    const reqs = requirementsOf(cat, baseOrganism(key))
    const psiMax = share > 0 && fitness > 0 ? (LN2 / g.doublingS) * fitness * rate * Math.max(0, 1 - total / capacity) * (reqs.length ? factorShare(reqs, layer) : 1) : 0
    const psi = netRate(cat, key, env, psiMax, fitness)
    if (psi < 0) {
      // Antibiotics kill growing cells over about half an hour; dormant ones (cold) survive.
      p.viable += populationDelta(p.viable, psi, dt)
      continue
    }
    induce(cat, key, p, env, psi, fitness, dt)
    // An auxotroph grows no further than its growth factors allow.
    const growth = populationDelta(p.viable, psi, dt, reqs.length ? factorRoom(reqs, layer) : Infinity)
    p.viable += growth
    p.count += growth
    if (reqs.length) useFactors(reqs, layer, growth)
    if (growth > 0 && mutantsOf(cat, baseOrganism(key)).length) mutate(cat, key, pops, growth, (kind) => inducedBy(env.mutagens, kind))
  }
}

// ---- Proteins in cells ----

/** Protein made from an induced plasmid accumulates over about this long (s) in growing cells. */
const INDUCTION_S = 3600

interface Inducible {
  substance: string
  molPerCell: number
  inducer?: string
  basal: number
}

const proteinCache = new WeakMap<Catalogue, Map<string, Inducible[]>>()

/** A strain's proteins per cell (mol): its organism's, and what its plasmids make. */
function proteinsOf(cat: Catalogue, key: string): Inducible[] {
  let m = proteinCache.get(cat)
  if (!m) proteinCache.set(cat, (m = new Map()))
  let list = m.get(key)
  if (!list) {
    const mol = (substance: string, perCell: string) => {
      const mm = cat.substances.get(substance)?.physical?.molarMass
      return mm ? (parseValue(perCell).si * 1000) / (parseValue(mm).si * 1000) : 0
    }
    list = (cat.substances.get(baseOrganism(key))?.organism?.proteins ?? []).map((p) => ({ substance: p.substance, molPerCell: mol(p.substance, p.perCell), basal: 1 }))
    for (const pl of allPlasmids(cat, key)) {
      for (const e of cat.substances.get(pl)?.plasmid?.expresses ?? []) list.push({ substance: e.substance, molPerCell: mol(e.substance, e.perCell), ...(e.inducer ? { inducer: e.inducer } : {}), basal: e.inducer ? (e.basal ?? 0.01) : 1 })
    }
    m.set(key, list)
  }
  return list
}

/** What a population's cells release when they burst: [protein, mol per cell]. */
export function strainProteins(cat: Catalogue, key: string, p: Population): Array<[string, number]> {
  return proteinsOf(cat, key).map((x) => [x.substance, x.molPerCell * (x.inducer ? x.basal + (1 - x.basal) * (p.induced ?? 0) : 1)])
}

/** A culture made up with its inducer already in it has been induced: its protein is there in full. */
export function inducedAtStart(cat: Catalogue, layer: Layer): void {
  for (const [key, p] of Object.entries(layer.populations ?? {})) {
    const inducers = proteinsOf(cat, key).flatMap((x) => (x.inducer ? [x.inducer] : []))
    if (inducers.length) p.induced = inducers.some((i) => (layer.species[i] ?? 0) > 0) ? 1 : 0
  }
}

/** Induction: with the inducer present the protein accumulates; without it, growth dilutes it. */
function induce(cat: Catalogue, key: string, p: Population, env: Environment, psi: number, fitness: number, dt: number): void {
  const inducers = proteinsOf(cat, key).flatMap((x) => (x.inducer ? [x.inducer] : []))
  if (!inducers.length) return
  const on = inducers.some((i) => env.present.has(i))
  const now = p.induced ?? 0
  p.induced = on ? now + (1 - now) * (1 - Math.exp((-dt * fitness) / INDUCTION_S)) : now * Math.exp(-Math.max(0, psi) * dt)
}

// ---- Soils ----

/** Relative water content (of field capacity) at and above which a soil's water no longer slows growth. */
export const MOISTURE_OPT = 0.6

const wettableCache = new WeakMap<Catalogue, Map<string, number>>()

/** A wettable solid's field capacity (L of water per mol of it), 0 if it holds none. */
function capacityPerMol(cat: Catalogue, s: string): number {
  let m = wettableCache.get(cat)
  if (!m) wettableCache.set(cat, (m = new Map()))
  let v = m.get(s)
  if (v === undefined) {
    const def = cat.substances.get(s)
    const fc = def?.wettable?.fieldCapacity
    const mm = def?.physical?.molarMass
    v = fc && mm ? parseValue(fc).si * parseValue(mm).si * 1000 : 0
    m.set(s, v)
  }
  return v
}

/**
 * How much a soil's water lets its organisms grow (0..1): in a soil wetter than 60 % of its field
 * capacity, fully; below that, in proportion to its water (thin films, slow diffusion). A suspension
 * of soil in much more water than it holds is a liquid culture (1).
 */
export function moistureFactor(cat: Catalogue, c: Contents, water: number): number {
  let held = 0
  for (const [s, n] of Object.entries(c.solid)) if (n > 0) held += n * capacityPerMol(cat, s)
  if (held <= 0) return 1
  return Math.min(1, water / held / MOISTURE_OPT)
}

// ---- Plates ----

/** Doublings from one cell to a visible colony (about 10⁵ cells). */
export const VISIBLE_DOUBLINGS = 17
/** Doubling on agar is slower than in shaken broth. */
const PLATE_SLOWDOWN = 1.5
/**
 * Lawn density (cells/cm²) at which growth outpaces a drug diffusing from a disc: the zone's edge
 * is fixed where the drug reaches the MIC at that moment (Cooper's critical time). A standard
 * inoculum reaches it in about four hours at 37 °C.
 */
export const LAWN_CRITICAL_PER_CM2 = 6e7

/** A seeded Poisson draw (normal approximation for large means). */
export function poisson(mean: number, seed: string): number {
  if (mean <= 0) return 0
  const rng = createRng(seed)
  if (mean > 50) return Math.max(0, Math.round(mean + Math.sqrt(mean) * rng.normal()))
  const l = Math.exp(-mean)
  let k = 0
  let p = 1
  do {
    k++
    p *= rng.next()
  } while (p > l)
  return k - 1
}

/** Doublings beyond which a colony grows no larger (about 10⁸ cells): divisions and growth factors are counted no further. */
const COLONY_MAX_DOUBLINGS = 27

type Disc = NonNullable<Contents['discs']>[number]
interface DiscAgent {
  disc: Disc
  m: Mutagen
  mol: number
}

/** The mutagens on a plate's discs. */
function discAgents(cat: Catalogue, c: Container): DiscAgent[] {
  const out: DiscAgent[] = []
  for (const d of c.contents.discs ?? []) {
    for (const x of d.drugs ?? (d.substance ? [{ substance: d.substance, mol: d.mol }] : [])) {
      const m = mutagenOf(cat, x.substance)
      if (m && x.mol > 0) out.push({ disc: d, m, mol: x.mol })
    }
  }
  return out
}

function agarDepthCm(cat: Catalogue, c: Container): number {
  const volumeL = c.contents.layers.reduce((a, l) => a + l.volumeL, 0)
  return Math.max(0.05, (volumeL * 1000) / plateAreaCm2(cat, c))
}

/** Rings of a plate round a disc at its centre, out to the rim: mid-radius and area (cm, cm²). */
const RINGS = 40
function ringsOf(areaCm2: number): Array<{ r: number; a: number }> {
  const w = Math.sqrt(areaCm2 / Math.PI) / RINGS
  return Array.from({ length: RINGS }, (_, i) => ({ r: (i + 0.5) * w, a: Math.PI * (2 * i + 1) * w * w }))
}

/** A disc's killing is followed this long after it went on; by then its mutagen has spread far and thin. */
const DISC_KILL_HORIZON_S = 24 * 3600
/** A ring where fewer than this share survive shows no background growth. */
const CLEARED_SURVIVAL = 0.02

/**
 * What a plate's discs do to its cells now: who is still alive, and the mutations they induce per
 * division. Each disc's mutagen spreads as from a point source in a slab, c(r, t) = M/(4πDth)
 * e^(−r²/4Dt), passing its peak, M/(π e h r²), at each radius when 4Dt = r². Cells in each ring
 * survive by the peak they have met (see `expose`); the survivors divide, and mutate at the
 * concentration round them now. Killing is applied as each disc's surviving share falls.
 */
function discEffects(cat: Catalogue, c: Container, agents: DiscAgent[], nowS: number, mutating: boolean): Record<string, number> {
  const area = plateAreaCm2(cat, c)
  const h = agarDepthCm(cat, c)
  const rings = ringsOf(area)
  const induced: Record<string, number> = {}
  for (const d of [...new Set(agents.map((x) => x.disc))]) {
    const t = nowS - d.placedS
    if (!(t > 0) || (!mutating && t > DISC_KILL_HORIZON_S)) continue
    const mine = agents.filter((x) => x.disc === d)
    let alive = 0
    let cleared = 0
    const perKind: Record<string, number> = {}
    for (const ring of rings) {
      let lethal = 0
      const nowUM: number[] = []
      for (const x of mine) {
        const four = 4 * x.m.diffusionCm2PerS * t
        const now = ((1000 * x.mol) / (Math.PI * four * h)) * Math.exp((-ring.r * ring.r) / four)
        const peak = ring.r * ring.r < four ? (1000 * x.mol) / (Math.PI * Math.E * h * ring.r * ring.r) : now
        lethal += peak / x.m.toxicMolPerL
        nowUM.push(now * 1e6)
      }
      const s = Math.exp(-lethal)
      if (s < CLEARED_SURVIVAL) cleared = ring.r + Math.sqrt(area / Math.PI) / (2 * RINGS)
      alive += s * ring.a
      if (mutating) mine.forEach((x, j) => {
        for (const [kind, potency] of Object.entries(x.m.potency)) perKind[kind] = (perKind[kind] ?? 0) + s * ring.a * potency * nowUM[j]
      })
    }
    const share = alive / area
    if (share < (d.alive ?? 1)) {
      // Cells not yet grown into colonies die where the mutagen reached them.
      for (const s of Object.values(c.contents.surface ?? {})) if (s.founders === undefined) s.viable *= share / (d.alive ?? 1)
      d.alive = share
    }
    if (cleared > (d.clearedCm ?? 0)) d.clearedCm = cleared
    for (const [kind, v] of Object.entries(perKind)) induced[kind] = (induced[kind] ?? 0) + v / Math.max(1e-12, alive)
  }
  return induced
}

/**
 * Mutants among a strain's new cells on a plate, at each mutant's spontaneous rate plus what the
 * mutagens mixed into the agar and those diffusing from discs (`discInduced`) induce per division.
 */
function mutateOnSurface(cat: Catalogue, c: Container, key: string, cells: SurfaceCells, divisions: number, env: Environment, discInduced: Record<string, number>): void {
  const surface = c.contents.surface!
  for (const m of mutantsOf(cat, baseOrganism(key))) {
    const n = divisions * (m.rate + inducedBy(env.mutagens, m.kind) + (discInduced[m.kind] ?? 0))
    if (!(n > 0)) continue
    const t = (surface[strainKey(m.to, plasmidsOf(key))] ??= { count: 0, viable: 0, doublings: 0, spread: cells.spread } as SurfaceCells)
    // A mutant arising once its strain's colonies are counted is too late to show.
    if (t.founders !== undefined) continue
    t.count += n
    t.viable += n
    if (cells.spread) t.spread = true
  }
}

/** Cells that grew a few divisions and stopped short of colonies, enough to haze the plate (an auxotroph on a trace of its growth factor). */
export function backgroundLawn(c: Contents): boolean {
  return Object.values(c.surface ?? {}).some((s) => !((s.founders ?? 0) > 0) && s.viable > 0 && s.doublings >= 2 && s.doublings < VISIBLE_DOUBLINGS && s.viable * 2 ** s.doublings >= 1e8)
}

/** Selection, growth and colony formation for the cells on an agar plate (`startS`: world time at the step's start). */
export function growSurface(cat: Catalogue, worldSeed: number, c: Container, T: number, dt: number, startS = 0): void {
  const surface = c.contents.surface
  if (!surface) return
  const medium = c.contents.layers[0] ?? { volumeL: 0, species: {} }
  const env = environmentOf(cat, medium)
  const agents = discAgents(cat, c)
  // Discs' mutagens kill where they are concentrated; what they induce is worked out only when cells
  // that can mutate are dividing.
  if (agents.length) discEffects(cat, c, agents, startS + dt / 2, false)
  let discInduced: Record<string, number> | undefined
  for (const [key, cells] of Object.entries(surface)) {
    if (!cells.selected) {
      // On a selective plate, transformants survive if the resistance had time to be made.
      if (env.selects.length && plasmidsOf(key).length && resistant(cat, key, env)) cells.viable *= 0.5 + 0.5 * (cells.expressed ?? 0)
      cells.selected = true
    }
    if (cells.viable <= 0) continue
    const g = growthParams(cat, baseOrganism(key))
    const fitness = cardinal(T, g.tMinK, g.tOptK, g.tMaxK)
    // A selective medium (bile salts and crystal violet; CFC) stops what it selects against: no growth, slow death.
    if (env.exposure > 0 && cells.founders === undefined) expose(cells, env.exposure)
    if (inhibitedBy(cat, key, env)) {
      cells.viable *= Math.exp(-dt / 7200)
      continue
    }
    const reqs = requirementsOf(cat, baseOrganism(key))
    const psiMax = shareFor(cat, key, env) > 0 ? ((LN2 * fitness) / (g.doublingS * PLATE_SLOWDOWN)) * (reqs.length ? factorShare(reqs, medium) : 1) : 0
    const psi = netRate(cat, key, env, psiMax, Math.max(fitness, 1))
    if (psi < 0) {
      cells.viable *= Math.exp(psi * dt)
      continue
    }
    if (psi <= 0) continue
    const before = cells.doublings
    const size = (d: number) => Math.pow(2, Math.min(d, COLONY_MAX_DOUBLINGS))
    let step = (psi * dt) / LN2
    // An auxotroph divides only as far as the growth factors left allow (a trace of histidine: a few times).
    if (reqs.length && before < COLONY_MAX_DOUBLINGS) step = Math.min(step, Math.log2(1 + factorRoom(reqs, medium) / Math.max(1e-300, cells.viable * size(before))))
    cells.doublings += step
    const divisions = cells.viable * (size(cells.doublings) - size(before))
    if (reqs.length) useFactors(reqs, medium, divisions)
    // A mutant arising before its strain has grown into colonies founds a colony of its own.
    if (divisions >= 1 && before < VISIBLE_DOUBLINGS && mutantsOf(cat, baseOrganism(key)).length) mutateOnSurface(cat, c, key, cells, divisions, env, (discInduced ??= agents.length ? discEffects(cat, c, agents, startS + dt / 2, true) : {}))
    if (cells.criticalS === undefined && cells.viable > 0) {
      // Doublings for the lawn to reach the critical density from what was laid on the plate.
      const area = plateAreaCm2(cat, c)
      const needed = Math.log2(Math.max(1, (LAWN_CRITICAL_PER_CM2 * area) / cells.viable))
      if (cells.doublings >= needed) cells.criticalS = startS + (dt * (needed - before)) / Math.max(1e-12, cells.doublings - before)
    }
    if (cells.founders === undefined && cells.doublings >= VISIBLE_DOUBLINGS) {
      if (cells.sectors?.length) {
        // A streak plate: each sector's share of the survivors, drawn separately.
        const laid = cells.sectors.reduce((a, b) => a + b, 0)
        cells.foundersBySector = cells.sectors.map((n, i) => poisson(laid > 0 ? (cells.viable * n) / laid : 0, `${worldSeed}|colonies|${c.id}|${key}|${i}`))
        cells.founders = cells.foundersBySector.reduce((a, b) => a + b, 0)
      } else if (cells.discrete) {
        // Cells that arrived one by one (from the air, from fingers): each living one founds a colony.
        cells.founders = Math.round(cells.viable)
      } else cells.founders = poisson(cells.viable, `${worldSeed}|colonies|${c.id}|${key}`)
    }
  }
}

/** The agar surface of a plate (cm²): its catalogue area, else a 90 mm dish's. */
export function plateAreaCm2(cat: Catalogue, c: Container): number {
  const a = cat.property(c.equipment, 'area')
  return typeof a === 'string' ? parseValue(a).si * 1e4 : 57
}

export interface ColonyView {
  strain: string
  organism: string
  colonies: number
  /** Streak plates: colonies per sector (spot plates: per spot). */
  bySector?: number[]
  spots?: boolean
  appearance: string
  fluorescent: boolean
}

/** A streak plate sector by sector (or a spot plate spot by spot): none, confluent growth, or how many separate colonies of each look. */
export function describeSectors(views: ColonyView[], laid = 0): string[] {
  const sectors = Math.max(laid, ...views.map((v) => v.bySector?.length ?? 0))
  const spots = laid > 0 || views.some((v) => v.spots)
  const word = spots ? 'spot' : 'sector'
  const parts: string[] = []
  for (let i = 0; i < sectors; i++) {
    const here = views.map((v) => ({ v, n: v.bySector?.[i] ?? 0 })).filter((x) => x.n > 0)
    const n = here.reduce((a, x) => a + x.n, 0)
    if (n === 0) parts.push(`${word} ${i + 1}: none`)
    else if (n > (spots ? SPOT_CONFLUENT : SECTOR_CONFLUENT)) parts.push(`${word} ${i + 1}: confluent growth`)
    else parts.push(`${word} ${i + 1}: ${n} separate colonies (${here.map((x) => `${x.n} ${x.v.appearance}`).join('; ')})`)
  }
  return parts
}

/** Colonies in each sector or spot, null where they run together. */
export function sectorCounts(views: ColonyView[], laid = 0): Array<number | null> {
  const sectors = Math.max(laid, ...views.map((v) => v.bySector?.length ?? 0))
  const spots = laid > 0 || views.some((v) => v.spots)
  return Array.from({ length: sectors }, (_, i) => {
    const n = views.reduce((a, v) => a + (v.bySector?.[i] ?? 0), 0)
    return n > (spots ? SPOT_CONFLUENT : SECTOR_CONFLUENT) ? null : n
  })
}

/** How many spots were laid on a spot plate (0 if it is not one), whether or not anything grew in them. */
export function laidSpots(c: Contents): number {
  return c.spots ?? 0
}

/** A 5 µL spot holds about this many separate colonies; beyond, they run together. */
export const SPOT_CONFLUENT = 40

/** A drop spotted onto agar at a numbered spot: its cells stay there (spots are counted apart). */
export function spotOnSurface(c: Contents, populations: Record<string, Population> | undefined, spot: number): void {
  c.spots = Math.max(c.spots ?? 0, spot)
  if (!populations) return
  c.surface ??= {}
  for (const [key, p] of Object.entries(populations)) {
    if (!(p.count > 0)) continue
    const s = (c.surface[key] ??= { count: 0, viable: 0, doublings: 0, spread: true } as SurfaceCells)
    s.spread = true
    s.spots = true
    const sectors = (s.sectors ??= [])
    while (sectors.length < spot) sectors.push(0)
    sectors[spot - 1] += p.viable
    s.count += p.count
    s.viable += p.viable
  }
}

/** Colonies a sector of a streak plate holds as separate colonies; beyond this they run together. */
export const SECTOR_CONFLUENT = 300

/** The most dilute sector with colonies that are separate (1..SECTOR_CONFLUENT), or -1. */
export function isolatedSector(views: ColonyView[]): number {
  const n = Math.max(0, ...views.map((v) => v.bySector?.length ?? 0))
  for (let i = n - 1; i >= 0; i--) {
    const total = views.reduce((a, v) => a + (v.bySector?.[i] ?? 0), 0)
    if (total >= 1 && total <= SECTOR_CONFLUENT) return i
  }
  return -1
}

/** Visible colonies on a plate, by strain; fluorescence needs a marker the medium switches on. */
export function coloniesOn(cat: Catalogue, c: Contents): ColonyView[] {
  const out: ColonyView[] = []
  const medium = c.layers[0] ?? { volumeL: 0, species: {} }
  const present = new Set(Object.entries(medium.species).filter(([, n]) => n > 0).map(([s]) => s))
  const differential = [...present].map((s) => cat.substances.get(s)?.medium?.differential).find((d) => d !== undefined)
  for (const [key, cells] of Object.entries(c.surface ?? {})) {
    if (cells.founders === undefined || cells.founders <= 0) continue
    const organism = baseOrganism(key)
    let fluorescent = false
    for (const p of plasmidsOf(key)) {
      const pl = cat.substances.get(p)?.plasmid
      if (!pl?.markers.includes('gfp')) continue
      const inducer = pl.regulated?.gfp
      if (!inducer || present.has(inducer)) fluorescent = true
    }
    out.push({
      strain: key,
      organism,
      colonies: cells.founders,
      ...(cells.foundersBySector ? { bySector: cells.foundersBySector } : {}),
      ...(cells.spots ? { spots: true } : {}),
      appearance: appearanceOn(cat, key, differential),
      fluorescent,
    })
  }
  return out
}

/** A colony's look; on a differential medium its colour shows which of the medium's markers the organism has. */
function appearanceOn(cat: Catalogue, key: string, differential: Differential | undefined): string {
  const own = cat.substances.get(baseOrganism(key))?.organism?.colony ?? 'colonies'
  if (!differential) return own
  const markers = markersOf(cat, key)
  const rules = Array.isArray(differential) ? differential : [differential]
  const hit = rules.find((r) => markers.has(r.marker))
  const look = hit ? hit.positive : (rules[rules.length - 1].negative ?? 'colourless')
  return `${look}, ${own.split(',').slice(1).join(',').trim() || 'smooth'}`
}

/** Typical diameters (µm) by morphology: a coccus, a rod's width, a yeast or algal cell. */
const CELL_SIZE_UM: Record<string, number> = { cocci: 1, rods: 1, spirilla: 0.5, yeast: 5, algae: 5 }

/** A cell's diameter in µm: the organism's own, else typical of its morphology. */
export function cellSizeUm(cat: Catalogue, organism: string): number {
  const o = cat.substances.get(baseOrganism(organism))?.organism
  if (o?.size) return parseValue(o.size).si * 1e6
  return CELL_SIZE_UM[o?.morphology ?? ''] ?? 2
}

/**
 * Centrifugal dose (g·min) that brings down about 63 % of 1 µm cells (a bacterium): 4000 × g for
 * 10 minutes pellets 98 %. Sedimentation goes with the square of the size (Stokes), so 5 µm yeast or
 * algae need 25 times less.
 */
const CELL_DOSE_1UM = 1e4

/** Spin: cells in the liquid go down to a pellet by the centrifugal dose and their size. */
export function pelletCells(cat: Catalogue, c: Contents, rcf: number, minutes: number): number {
  let moved = 0
  for (const l of c.layers) {
    for (const [key, p] of Object.entries(l.populations ?? {})) {
      if (!(p.count > 0)) continue
      const f = 1 - Math.exp((-rcf * minutes * cellSizeUm(cat, key) ** 2) / CELL_DOSE_1UM)
      const down = { ...p, count: p.count * f, viable: p.viable * f }
      p.count -= down.count
      p.viable -= down.viable
      c.cellPellet ??= {}
      // The cells keep their state (induction, competence) in the pellet.
      mergePopulation((c.cellPellet[key] ??= { count: 0, viable: 0 }), down, 1)
      moved += down.count
    }
  }
  return moved
}

/** Mixing puts a share of a cell pellet back into the liquid (its top layer). */
export function resuspendCells(c: Contents, fraction: number): void {
  if (!c.cellPellet || !(fraction > 0)) return
  const top = c.layers[0]
  if (!top || top.volumeL <= 0) return
  top.populations ??= {}
  for (const [key, p] of Object.entries(c.cellPellet)) {
    const up = { ...p, count: p.count * fraction, viable: p.viable * fraction }
    p.count -= up.count
    p.viable -= up.viable
    mergePopulation((top.populations[key] ??= { count: 0, viable: 0 }), up, 1)
    if (p.count < 1e-9) delete c.cellPellet[key]
  }
  if (Object.keys(c.cellPellet).length === 0) delete c.cellPellet
}

/**
 * Cells delivered onto an agar plate join its surface (they do not mix into the agar). Cells poured
 * in molten top agar (`spread`) are carried over the whole plate in the overlay as it sets.
 */
export function depositOnSurface(c: Contents, populations: Record<string, Population> | undefined, spread = false): void {
  if (!populations) return
  c.surface ??= {}
  for (const [key, p] of Object.entries(populations)) {
    if (!(p.count > 0)) continue
    const s = (c.surface[key] ??= { count: 0, viable: 0, doublings: 0, spread: false } as SurfaceCells)
    if (spread) s.spread = true
    const before = s.viable
    s.count += p.count
    s.viable += p.viable
    if (p.expressed !== undefined) s.expressed = before + p.viable > 0 ? ((s.expressed ?? 0) * before + p.expressed * p.viable) / (before + p.viable) : p.expressed
  }
}
