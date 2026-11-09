// Distilling from a heated flask (contract separation.distillation-continuous, T2). A flask with a
// still head and condenser on it (core:connect-condenser) sends what boils off into a receiver,
// instead of back down a reflux condenser or out into the room. The liquid boils at its bubble
// point, where the partial pressures of its volatile parts add up to one atmosphere: each part's
// pure vapour pressure (Clausius–Clapeyron from its boiling point and enthalpy of vaporisation)
// times its mole fraction (Raoult's law), the solutes that do not evaporate (salts, sulfuric acid,
// chromium) diluting the rest. The heater's surplus over that temperature sets how fast it boils,
// and the vapour (yᵢ = xᵢ·pᵢ*/P) is richer in what boils lower: a product that boils far below the
// mixture (ethanal, 20 °C, from an alcohol in hot aqueous oxidant) leaves almost as soon as it
// forms, while under reflux it stays to react on. An acid or base distils as its uncharged
// molecule, so ethanoic acid comes over from acidified water but stays behind as ethanoate in alkali.
// The thermometer in the still head reads the vapour's dew point.
// Ideal: no activity coefficients (no azeotropes), the layers boil as one liquid (immiscible
// liquids are not given their separate vapour pressures), no fractionating column.
import type { Catalogue } from '../catalogue/catalogue.ts'
import { addOnTop, type Container, type Layer, liquidVolume, type Place, type World } from '../kernel/state.ts'
import { parseValue } from '../units/index.ts'
import { fractions, layerPH } from './acidbase.ts'
import { molarVolume, WATER_MOLAR_L, waterMol } from './distillation.ts'
import { ATM_KPA, R_J } from './gaslaws.ts'

const WATER = 'core:water'
/** Liquid boiled off per kelvin that the heater is above the boiling point (L/s/K), as for an open flask. */
const BOIL_OFF_L_PER_S_PER_K = 0.5e-6

interface Volatile {
  /** The molecule that evaporates (what the receiver gets). */
  molecule: string
  dHJ: number
  bpK: number
  /** An acid or base: only its uncharged form evaporates. */
  acidBase?: { pKa: number[]; charge: number }
}

const cache = new WeakMap<Catalogue, Map<string, Volatile>>()

/**
 * What can evaporate, by the species a layer holds it as: a volatile liquid itself, and for one that
 * the ionic model keeps as an ion carrier (ethanoic acid as its ethanoate), the carrier too.
 */
function volatiles(cat: Catalogue): Map<string, Volatile> {
  const hit = cache.get(cat)
  if (hit) return hit
  const out = new Map<string, Volatile>()
  for (const s of cat.substances.values()) {
    const p = s.physical
    if (!p?.enthalpyOfVaporisation || !p.boilingPoint || s.id === WATER) continue
    const ab = s.acidBase ? { pKa: [...s.acidBase.pKa].sort((a, b) => a - b), charge: s.acidBase.charge ?? 0 } : undefined
    const v: Volatile = { molecule: s.id, dHJ: parseValue(p.enthalpyOfVaporisation).si, bpK: parseValue(p.boilingPoint).si, ...(ab ? { acidBase: ab } : {}) }
    out.set(s.id, v)
    const carriers = Object.keys(s.ions ?? {})
    if (ab && carriers.length === 1 && !out.has(carriers[0])) out.set(carriers[0], v)
  }
  cache.set(cat, out)
  return out
}

function waterVolatile(cat: Catalogue): Volatile {
  const dH = cat.substances.get(WATER)?.physical?.enthalpyOfVaporisation
  return { molecule: WATER, dHJ: dH ? parseValue(dH).si : 40700, bpK: 373.15 }
}

/** Pure vapour pressure (kPa) at T. */
function pureKPa(v: Volatile, T: number): number {
  return ATM_KPA * Math.exp((-v.dHJ / R_J) * (1 / T - 1 / v.bpK))
}

interface Part {
  v: Volatile
  /** Species it is held as, and the mol of it in each layer that can evaporate. */
  species: string
  byLayer: number[]
  mol: number
}

/** The pot's volatile parts and its total mol (everything dissolved counts in the mole fractions). */
function parts(cat: Catalogue, layers: Layer[], T: number): { parts: Part[]; total: number } {
  const table = volatiles(cat)
  const water: Part = { v: waterVolatile(cat), species: WATER, byLayer: layers.map(() => 0), mol: 0 }
  const found = new Map<string, Part>()
  let total = 0
  layers.forEach((l, i) => {
    if (!(l.volumeL > 0)) return
    const w = waterMol(cat, l)
    water.byLayer[i] = w
    water.mol += w
    total += w
    let pH: number | undefined
    for (const [s, n] of Object.entries(l.species)) {
      if (!(n > 0)) continue
      total += n
      const v = table.get(s)
      if (!v) continue
      let free = n
      if (v.acidBase) {
        pH ??= layerPH(cat, l, T) ?? 7
        free = n * (fractions(v.acidBase.pKa, pH)[v.acidBase.charge] ?? 0)
      }
      const part = found.get(s) ?? { v, species: s, byLayer: layers.map(() => 0), mol: 0 }
      part.byLayer[i] += free
      part.mol += free
      found.set(s, part)
    }
  })
  return { parts: [water, ...found.values()].filter((p) => p.mol > 0), total }
}

/** Bubble point (K): where Σ xᵢ pᵢ*(T) is one atmosphere; undefined if it would not boil below 700 K. */
function bubbleK(ps: Part[], total: number): number | undefined {
  const P = (T: number) => ps.reduce((a, p) => a + (p.mol / total) * pureKPa(p.v, T), 0)
  let lo = 150
  let hi = 700
  if (P(hi) < ATM_KPA) return undefined
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (P(mid) > ATM_KPA) hi = mid
    else lo = mid
  }
  return (lo + hi) / 2
}

/** Dew point (K) of a vapour of mole fractions y: where Σ yᵢ P / pᵢ*(T) is one. */
function dewK(ps: Part[], y: number[]): number {
  const f = (T: number) => ps.reduce((a, p, i) => a + (y[i] * ATM_KPA) / pureKPa(p.v, T), 0)
  let lo = 150
  let hi = 700
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (f(mid) > 1) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/**
 * One time step of a flask under a still head: if it is at or above its bubble point it is held
 * there, and the vapour the heater's surplus boils off is condensed into the receiver. Returns
 * whether it was boiling.
 */
export function distilStep(cat: Catalogue, world: World, c: Container, place: Place, dt: number): boolean {
  const still = c.still
  const receiver = still ? world.containers[still.receiver] : undefined
  if (!still || !receiver || receiver.discarded) return false
  const contents = c.contents
  const { parts: ps, total } = parts(cat, contents.layers, contents.temperatureK)
  if (ps.length === 0 || !(total > 0)) return false
  const Tb = bubbleK(ps, total)
  if (Tb === undefined || !(contents.temperatureK > Tb)) return false
  contents.temperatureK = Tb
  const liquidL = Math.max(0, place.temperatureK - Tb) * BOIL_OFF_L_PER_S_PER_K * dt
  if (!(liquidL > 0)) return true
  // Vapour leaving: yᵢ = xᵢ pᵢ*(Tb) / P (they sum to one at the bubble point).
  const y = ps.map((p) => ((p.mol / total) * pureKPa(p.v, Tb)) / ATM_KPA)
  const sum = y.reduce((a, b) => a + b, 0)
  for (let i = 0; i < y.length; i++) y[i] /= sum
  const vm = ps.map((p) => (p.v.molecule === WATER ? WATER_MOLAR_L : molarVolume(cat, p.v.molecule)))
  const nVap = liquidL / y.reduce((a, yi, i) => a + yi * vm[i], 0)
  const condensate: Layer = { volumeL: 0, species: {} }
  ps.forEach((p, i) => {
    const take = Math.min(p.mol, y[i] * nVap)
    if (!(take > 0)) return
    // From each layer by its share; the liquid shrinks by what left.
    contents.layers.forEach((l, j) => {
      const n = (take * p.byLayer[j]) / p.mol
      if (!(n > 0)) return
      if (p.species !== WATER) l.species[p.species] = Math.max(0, (l.species[p.species] ?? 0) - n)
      l.volumeL = Math.max(0, l.volumeL - n * vm[i])
    })
    condensate.volumeL += take * vm[i]
    if (p.v.molecule !== WATER) condensate.species[p.v.molecule] = (condensate.species[p.v.molecule] ?? 0) + take
  })
  contents.layers = contents.layers.filter((l) => l.volumeL > 1e-12)
  // The condensate arrives at the receiver's own temperature (cooled in the condenser, or iced).
  const before = liquidVolume(receiver.contents)
  const tR = (world.places[receiver.place] ?? world.places.bench).temperatureK
  addOnTop(receiver.contents, condensate, 1)
  receiver.contents.temperatureK = before > 0 ? (receiver.contents.temperatureK * before + tR * condensate.volumeL) / (before + condensate.volumeL) : tR
  const origins = new Set([...(receiver.origins ?? []), ...(c.origins ?? [])])
  if (origins.size > 0) receiver.origins = [...origins]
  const head = dewK(ps, y)
  still.headStartK ??= head
  still.headEndK = head
  still.headMinK = Math.min(still.headMinK ?? head, head)
  still.headMaxK = Math.max(still.headMaxK ?? head, head)
  still.collectedL = (still.collectedL ?? 0) + condensate.volumeL
  return true
}
