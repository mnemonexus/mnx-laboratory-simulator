// Liquid–liquid phases (contract equilibrium.liquid-liquid, T2). A solvent that does not mix with
// water (its `immiscible` facet: how much of it water dissolves, how much water it dissolves) forms
// its own layer once there is more of it than the water takes up, above or below the water as the
// densities fall. Shaken together, the two layers reach partition equilibrium: a solute with a logP
// divides as D = 10^logP × its uncharged share at the water's pH, so an acid goes into the solvent
// from acidic water and back into alkaline water as its anion (acid–base extraction, washing with
// bicarbonate). Salts, strong acids and anything without a logP stay in the water. The solvent
// holds water in proportion to the water's activity, so a brine wash leaves it drier; a drying agent
// binds the rest, and droplets of water carried over with what they hold, as its hydrate.
// Ideal: volumes are additive, the solvents' mutual solubility ignores what else is dissolved, and
// logP stands in for each solvent's own partition coefficient.
import type { Catalogue } from '../catalogue/catalogue.ts'
import { molarMass } from '../kernel/materials.ts'
import { type Contents, type Layer, meanLayer } from '../kernel/state.ts'
import { parseValue } from '../units/index.ts'
import { fractions, ionicStrength, layerPH } from './acidbase.ts'
import { molarVolume, WATER_MOLAR_L, waterMol } from './distillation.ts'
import { resyncEnthalpy } from './thermochem.ts'

interface Immiscible {
  /** Most of it that water dissolves, mol per litre of water. */
  inWaterMolPerL: number
  /** Water it dissolves, litres per litre of solvent (at a water activity of 1). */
  holdsWaterLPerL: number
  molarL: number
}

const solventCache = new WeakMap<Catalogue, Map<string, Immiscible>>()

/** Solvents that do not mix with water, from their `immiscible` facets. */
export function immiscibleSolvents(cat: Catalogue): Map<string, Immiscible> {
  const hit = solventCache.get(cat)
  if (hit) return hit
  const out = new Map<string, Immiscible>()
  for (const s of cat.substances.values()) {
    const im = s.physical?.immiscible
    if (!im) continue
    const q = parseValue(im.inWater)
    const mm = molarMass(cat, s.id) ?? 1
    out.set(s.id, {
      inWaterMolPerL: q.dim[0] === 1 ? q.si / mm : q.si / 1000,
      holdsWaterLPerL: parseValue(im.holdsWater).si / 997,
      molarL: molarVolume(cat, s.id),
    })
  }
  solventCache.set(cat, out)
  return out
}

function solventL(layer: Layer, solvents: Map<string, Immiscible>): number {
  let v = 0
  for (const [s, im] of solvents) v += Math.max(0, layer.species[s] ?? 0) * im.molarL
  return v
}

/** A solvent layer: it holds a water-immiscible solvent and is less than half water (by volume). */
export function isOrganic(cat: Catalogue, layer: Layer): boolean {
  const solvents = immiscibleSolvents(cat)
  if (solvents.size === 0 || !(layer.volumeL > 0) || !(solventL(layer, solvents) > 0)) return false
  return waterMol(cat, layer) * WATER_MOLAR_L < 0.5 * layer.volumeL
}

function holdsImmiscible(c: Contents, solvents: Map<string, Immiscible>): boolean {
  for (const l of c.layers) for (const s of solvents.keys()) if ((l.species[s] ?? 0) > 0) return true
  return false
}

/** Two liquid phases stand in the container (they do not mix by diffusion). */
export function twoPhase(cat: Catalogue, c: Contents): boolean {
  const solvents = immiscibleSolvents(cat)
  if (solvents.size === 0 || c.layers.length < 2 || !holdsImmiscible(c, solvents)) return false
  const first = isOrganic(cat, c.layers[0])
  return c.layers.some((l) => isOrganic(cat, l) !== first)
}

/** A liquid added to a layer of the other phase floats or sinks on it rather than mixing in. */
export function samePhase(cat: Catalogue, a: Layer, b: Layer | undefined): boolean {
  return !b || isOrganic(cat, a) === isOrganic(cat, b)
}

function logPOf(cat: Catalogue, s: string): number | undefined {
  return cat.substances.get(s)?.physical?.logP
}

/** The share of a substance that is uncharged at a pH (1 for one that is not an acid or base). */
function unchargedShare(cat: Catalogue, s: string, pH: number): number {
  const ab = cat.substances.get(s)?.acidBase
  if (!ab) return 1
  const charge = ab.charge ?? 0
  if (charge < 0 || charge > ab.pKa.length) return 0
  return fractions([...ab.pKa].sort((x, y) => x - y), pH)[charge] ?? 0
}

/** Water activity of an aqueous layer from its ions (ln a_w ≈ −M_w × osmolarity, osmolarity ≈ 2I). */
function waterActivity(cat: Catalogue, layer: Layer, temperatureK: number): number {
  return Math.exp(-0.018015 * 2 * ionicStrength(cat, layer, temperatureK))
}

/**
 * Density of a layer (g/mL) from what takes up its volume: water and the substances with a density.
 * Solutes without one add no volume, so their mass is left out too (they would make it too dense).
 */
function layerDensity(cat: Catalogue, layer: Layer): number {
  let g = waterMol(cat, layer) * 18.015
  for (const [s, n] of Object.entries(layer.species)) if (n > 0 && cat.substances.get(s)?.physical?.density) g += n * (molarMass(cat, s) ?? 0)
  return g / (layer.volumeL * 1000)
}

/**
 * Split one layer into its two phases at partition equilibrium, or undefined if it is one phase
 * (the water dissolves all the solvent, or the solvent all the water).
 */
export function splitPhases(cat: Catalogue, layer: Layer, temperatureK: number): { organic: Layer; aqueous: Layer } | undefined {
  const solvents = immiscibleSolvents(cat)
  if (solvents.size === 0 || !(layer.volumeL > 0)) return undefined
  const waterL = waterMol(cat, layer) * WATER_MOLAR_L
  const present = [...solvents].filter(([s]) => (layer.species[s] ?? 0) > 0)
  if (present.length === 0) return undefined
  // One phase if the water takes up every solvent, or the solvent all the water.
  if (present.every(([s, im]) => layer.species[s] <= im.inWaterMolPerL * waterL)) return undefined
  const totalSolventL = solventL(layer, solvents)
  if (waterL <= present.reduce((a, [s, im]) => a + layer.species[s] * im.molarL * im.holdsWaterLPerL, 0) || totalSolventL <= 0) return undefined

  const partitioning: string[] = []
  const fixed: Record<string, number> = {}
  for (const [s, n] of Object.entries(layer.species)) {
    if (!(n > 0) || solvents.has(s)) continue
    if (logPOf(cat, s) !== undefined) partitioning.push(s)
    else fixed[s] = n
  }
  const toOrganic: Record<string, number> = Object.fromEntries(partitioning.map((s) => [s, 0.5]))
  const volumeOf = (s: string, n: number) => (cat.substances.get(s)?.physical?.density ? n * molarVolume(cat, s) : 0)
  let wOrgL = 0
  let organic: Layer = { volumeL: 0, species: {} }
  let aqueous: Layer = { volumeL: 0, species: {} }
  const build = (): void => {
    const wAqL = waterL - wOrgL
    organic = { volumeL: wOrgL, species: {} }
    aqueous = { volumeL: wAqL, species: { ...fixed } }
    for (const [s, n] of Object.entries(fixed)) aqueous.volumeL += volumeOf(s, n)
    for (const [s, im] of present) {
      const n = layer.species[s]
      const inAq = Math.min(n, im.inWaterMolPerL * wAqL)
      aqueous.species[s] = inAq
      aqueous.volumeL += inAq * im.molarL
      organic.species[s] = n - inAq
      organic.volumeL += (n - inAq) * im.molarL
    }
    for (const s of partitioning) {
      const n = layer.species[s]
      const f = toOrganic[s]
      organic.species[s] = n * f
      aqueous.species[s] = n * (1 - f)
      organic.volumeL += volumeOf(s, n * f)
      aqueous.volumeL += volumeOf(s, n * (1 - f))
    }
  }
  // Shares into the solvent at a pH, with the phase volumes as they stand.
  const shares = (pH: number): void => {
    for (const s of partitioning) {
      const d = Math.pow(10, logPOf(cat, s)!) * unchargedShare(cat, s, pH)
      toOrganic[s] = (d * organic.volumeL) / (d * organic.volumeL + aqueous.volumeL)
    }
  }
  const ionisable = partitioning.filter((s) => cat.substances.get(s)?.acidBase)
  let pH = 7
  for (let iter = 0; iter < 12; iter++) {
    build()
    if (!(organic.volumeL > 0) || !(aqueous.volumeL > 0)) return undefined
    if (ionisable.length > 0) {
      // The water's pH depends on how much of each acid or base stays in it, and that on the pH:
      // solve h(pH) = pH(water at these shares) − pH = 0, which falls monotonically.
      const h = (x: number): number => {
        shares(x)
        build()
        return (layerPH(cat, aqueous, temperatureK) ?? 7) - x
      }
      let lo = -2
      let hi = 16
      for (let k = 0; k < 50 && hi - lo > 1e-6; k++) {
        const mid = (lo + hi) / 2
        if (h(mid) > 0) lo = mid
        else hi = mid
      }
      pH = (lo + hi) / 2
      shares(pH)
    } else {
      pH = layerPH(cat, aqueous, temperatureK) ?? 7
      shares(pH)
    }
    build()
    const aw = waterActivity(cat, aqueous, temperatureK)
    let next = 0
    for (const [s, im] of present) next += (organic.species[s] ?? 0) * im.molarL * im.holdsWaterLPerL * aw
    next = Math.min(next, waterL * 0.5)
    const done = Math.abs(next - wOrgL) < 1e-12
    wOrgL = next
    if (done) break
  }
  build()
  // Organisms, particles and proteins' activity stay with the water.
  if (layer.populations) aqueous.populations = layer.populations
  if (layer.particles) aqueous.particles = layer.particles
  if (layer.cut) aqueous.cut = layer.cut
  if (layer.active) aqueous.active = { ...layer.active }
  resyncEnthalpy(cat, organic, temperatureK)
  resyncEnthalpy(cat, aqueous, temperatureK)
  return { organic, aqueous }
}

/**
 * After anything is done to a container: a layer holding both phases separates into them at
 * partition equilibrium, each phase stands as one layer (the lighter on top), and any drying agent
 * among the solids binds the water it can reach.
 */
export function settlePhases(cat: Catalogue, c: Contents): void {
  const solvents = immiscibleSolvents(cat)
  if (solvents.size === 0 || c.layers.length === 0 || !holdsImmiscible(c, solvents)) return
  const T = c.temperatureK
  const layers: Layer[] = []
  for (const l of c.layers) {
    if (!(l.volumeL > 1e-12)) continue
    const parts = splitPhases(cat, l, T)
    if (parts) layers.push(parts.organic, parts.aqueous)
    else layers.push(l)
  }
  const organic = layers.filter((l) => isOrganic(cat, l))
  const aqueous = layers.filter((l) => !isOrganic(cat, l))
  if (organic.length > 0 && aqueous.length > 0) {
    const o = organic.length > 1 ? meanLayer({ ...c, layers: organic }) : organic[0]
    const a = aqueous.length > 1 ? meanLayer({ ...c, layers: aqueous }) : aqueous[0]
    const lighter = layerDensity(cat, o) <= layerDensity(cat, a)
    c.layers = lighter ? [o, a] : [a, o]
  } else {
    c.layers = layers
  }
  if (organic.length === 0) return
  // Salts and anything else without a logP do not dissolve in a solvent layer: water that went into
  // it dissolved (droplets taken up), it leaves them behind on the glass.
  for (const l of c.layers) {
    if (!isOrganic(cat, l)) continue
    for (const [s, n] of Object.entries(l.species)) {
      if (!(n > 0) || solvents.has(s) || logPOf(cat, s) !== undefined) continue
      c.solid[s] = (c.solid[s] ?? 0) + n
      if (cat.substances.get(s)?.physical?.density) l.volumeL = Math.max(0, l.volumeL - n * molarVolume(cat, s))
      delete l.species[s]
    }
  }
  dry(cat, c)
}

/**
 * Drying agents in the solid take up water, as their hydrate: droplets of water first (whatever
 * those held is left on the solid), then the water the solvent layer holds.
 */
function dry(cat: Catalogue, c: Contents): void {
  for (const [agent, n] of Object.entries(c.solid)) {
    const spec = cat.substances.get(agent)?.drying
    if (!spec || !(n > 0) || !(spec.water > 0)) continue
    let capacity = n * spec.water
    const before = capacity
    const kept: Layer[] = []
    // Water standing as its own layer (droplets) is taken first, then the solvent's.
    const order = [...c.layers].sort((a, b) => Number(isOrganic(cat, a)) - Number(isOrganic(cat, b)))
    for (const l of order) {
      const w = waterMol(cat, l)
      const take = Math.min(w, capacity)
      capacity -= take
      if (!isOrganic(cat, l) && take >= w * (1 - 1e-9)) {
        // All its water bound: what it held stays on the solid.
        for (const [s, m] of Object.entries(l.species)) if (m > 0) c.solid[s] = (c.solid[s] ?? 0) + m
        continue
      }
      l.volumeL = Math.max(0, l.volumeL - take * WATER_MOLAR_L)
      kept.push(l)
    }
    c.layers = c.layers.filter((l) => kept.includes(l))
    const hydrated = (before - capacity) / spec.water
    if (hydrated > 0) {
      c.solid[agent] = n - hydrated
      c.solid[spec.hydrate] = (c.solid[spec.hydrate] ?? 0) + hydrated
    }
  }
}

/**
 * The container as a substance sees it: only the layers that can dissolve it (salts and other
 * substances without a logP only water, not a solvent layer). Undefined: nothing can take it, or it
 * is a drying agent with a solvent layer to dry. The view shares the container's layers and solid.
 */
export function phaseView(cat: Catalogue, c: Contents, s: string): Contents | undefined {
  const solvents = immiscibleSolvents(cat)
  if (solvents.size === 0 || !holdsImmiscible(c, solvents)) return c
  const def = cat.substances.get(s)
  if (def?.physical?.logP !== undefined || solvents.has(s)) return c
  const water = c.layers.filter((l) => !isOrganic(cat, l))
  if (water.length === c.layers.length) return c
  if (def?.drying || water.length === 0) return undefined
  return { ...c, layers: water }
}

/** Where a solid dissolves when it is mixed in: its share in each layer (by volume, over the layers that can take it), or undefined if it stays solid. */
export function dissolveShares(cat: Catalogue, c: Contents, s: string): number[] | undefined {
  const view = phaseView(cat, c, s)
  if (!view) return undefined
  const total = view.layers.reduce((a, l) => a + l.volumeL, 0)
  return c.layers.map((l) => (view.layers.includes(l) ? l.volumeL / total : 0))
}

/** The solvent a solvent layer is mostly made of (the most by volume), if it is a solvent layer. */
export function mainSolvent(cat: Catalogue, layer: Layer): string | undefined {
  if (!isOrganic(cat, layer)) return undefined
  let best: string | undefined
  let most = 0
  for (const [s, im] of immiscibleSolvents(cat)) {
    const v = (layer.species[s] ?? 0) * im.molarL
    if (v > most) {
      most = v
      best = s
    }
  }
  return best
}
