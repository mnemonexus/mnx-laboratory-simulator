// Gases over and in a liquid (contract equilibrium.gas-liquid, T2). A vessel's headspace is air
// unless it has been purged with an inert gas through a septum; open to the room it soon is air
// again. Dissolved oxygen (where a liquid tracks it: `core:oxygen` among its species) tends towards
// Henry's-law saturation with the headspace's oxygen: slowly in a still liquid, fast when it is
// stirred, shaken or poured through the air, and away again when nitrogen is bubbled through it.
// Ideal: oxygen is not consumed, salts do not lower its solubility, and the liquid is water.
import type { Catalogue } from '../catalogue/catalogue.ts'
import type { Container, Contents } from '../kernel/state.ts'
import { liquidVolume } from '../kernel/state.ts'
import { parseValue } from '../units/index.ts'
import { isOrganic } from './phases.ts'

export const OXYGEN = 'core:oxygen'

export interface GasParams {
  /** Henry's-law solubility of oxygen at 25 °C, mol/L per atm, and its temperature coefficient (K). */
  henryMolPerLAtm: number
  henryTempK: number
  /** Oxygen's share of air. */
  airO2: number
  /** Liquid-side exchange rate (kLa, per second) in a still liquid. */
  kLaStill: number
  /** Purging a headspace: its time constant per 100 mL; sparging (bubbling through the liquid): its time constant. */
  purgeTauSPer100mL: number
  spargeTauS: number
  /** An open vessel's headspace becomes air with this time constant. */
  openTauS: number
  /** Air in a syringe that was not flushed: what rides in with the liquid (its dead space and needle). */
  syringeAirL: number
}

const cache = new WeakMap<Catalogue, GasParams>()

export function gasParams(cat: Catalogue): GasParams {
  const hit = cache.get(cat)
  if (hit) return hit
  const p = cat.models.get('core:gas-exchange')?.params ?? {}
  const num = (k: string, d: number) => (p[k] === undefined ? d : Number(p[k]))
  const sec = (k: string, d: number) => (p[k] === undefined ? d : parseValue(String(p[k])).si)
  const out: GasParams = {
    henryMolPerLAtm: p.henryO2 === undefined ? 1.23e-3 : parseValue(String(p.henryO2)).si / 1000,
    henryTempK: num('henryTempK', 1860),
    airO2: num('airO2', 0.2095),
    kLaStill: num('kLaStill', 5e-5),
    purgeTauSPer100mL: sec('purgeTau', 20),
    spargeTauS: sec('spargeTau', 120),
    openTauS: sec('openTau', 60),
    syringeAirL: p.syringeAir === undefined ? 1e-4 : parseValue(String(p.syringeAir)).si * 1000,
  }
  cache.set(cat, out)
  return out
}

/** Oxygen dissolved at saturation (mol/L) under a headspace that is this share air, at a temperature. */
export function oxygenSaturation(cat: Catalogue, temperatureK: number, airShare: number): number {
  const g = gasParams(cat)
  return g.henryMolPerLAtm * Math.exp(g.henryTempK * (1 / temperatureK - 1 / 298.15)) * g.airO2 * airShare
}

export function headspaceAir(c: Container): number {
  return c.headspaceAir ?? 1
}

/** The headspace volume (L): what the liquid leaves of the vessel. */
export function headspaceL(c: Container): number {
  return Math.max(1e-6, c.capacityL - liquidVolume(c.contents))
}

/** Liquids tracking oxygen move this fraction of the way to saturation under the given air share. */
export function relaxOxygen(cat: Catalogue, contents: Contents, airShare: number, fraction: number): void {
  if (!(fraction > 0)) return
  const sat = oxygenSaturation(cat, contents.temperatureK, airShare)
  for (const l of contents.layers) {
    if (!(OXYGEN in l.species) || !(l.volumeL > 0)) continue
    const n = l.species[OXYGEN]
    l.species[OXYGEN] = Math.max(0, n + (sat * l.volumeL - n) * Math.min(1, fraction))
  }
}

/** Time passing: an open vessel's headspace turns to air, and dissolved oxygen exchanges with it. */
export function gasStep(cat: Catalogue, c: Container, dt: number): void {
  const g = gasParams(cat)
  if (c.headspaceAir !== undefined && c.open && !c.septum) {
    c.headspaceAir = 1 - (1 - c.headspaceAir) * Math.exp(-dt / g.openTauS)
    if (c.headspaceAir > 0.9999) delete c.headspaceAir
  }
  const v = liquidVolume(c.contents)
  if (!(v > 0) || !c.contents.layers.some((l) => OXYGEN in l.species)) return
  // A stoppered bottle filled to the brim (a BOD bottle) has no air to exchange with. (A bubble of
  // 0.3 % of its volume would hold a tenth as much oxygen as the water.)
  if (!c.open && !c.septum && c.capacityL - v < 0.003 * c.capacityL) return
  // A still liquid exchanges through its surface: slower the deeper it is (kLa at 10 mL, ∝ V^-1/3);
  // a layer of oil floating on it all but stops the exchange.
  const oiled = c.contents.layers.length > 1 && isOrganic(cat, c.contents.layers[0])
  const kLa = g.kLaStill * Math.cbrt(1e-2 / Math.max(v, 1e-6)) * (oiled ? 0.01 : 1)
  relaxOxygen(cat, c.contents, headspaceAir(c), 1 - Math.exp(-kLa * dt))
}

// ---------------------------------------------------------------------------------------------
// Gas given off (contract gas.evolution, T2): bubbles from a reaction (hydrogen from a metal, CO₂
// from a carbonate, oxygen from peroxide) go where the vessel sends them: into a gas syringe on a
// bung, through a delivery tube into another liquid (limewater), or into its headspace and out to
// the room. The headspace keeps what has just come off for a time set by how fast it airs through
// the mouth; that is what a splint or damp litmus held there meets.

const R_L_ATM = 0.082057
/** Air leaving a vessel's mouth: headspace time constant = headspace volume / (this × mouth area). */
const MOUTH_EXCHANGE_M_PER_S = 0.003

/** Dissolved oxygen above saturation under 1 atm of pure oxygen comes out as bubbles. */
function oxygenBubbles(cat: Catalogue, c: Contents): number {
  let out = 0
  const sat = oxygenSaturation(cat, c.temperatureK, 1 / gasParams(cat).airO2)
  for (const l of c.layers) {
    const n = l.species[OXYGEN] ?? 0
    const max = sat * l.volumeL
    if (n > max * 1.02) {
      out += n - max
      l.species[OXYGEN] = max
    }
  }
  return out
}

/** Bubbles give up this fraction of their gas per cm of liquid they rise through (1 − e^(−depth/L)). */
const BUBBLE_UPTAKE_CM = 4

/**
 * The fraction of the gas in bubbles from a delivery tube that a liquid takes up on their way to the
 * surface: a few-millimetre bubble rises through a test tube's few centimetres in a fraction of a
 * second and gives up about half of its gas (more into a liquid that reacts with it, which the ionic
 * model settles afterwards; illustrative). The rest escapes to the vessel's headspace.
 */
export function bubbleUptake(cat: Catalogue, c: Container): number {
  const v = liquidVolume(c.contents)
  if (!(v > 0)) return 0
  const d = Number(cat.property(c.equipment, 'pathCm'))
  const depthCm = d > 0 ? (v * 1000) / (Math.PI * (d / 2) ** 2) : 3
  return 1 - Math.exp(-depthCm / BUBBLE_UPTAKE_CM)
}

/** The headspace's time constant (s) for airing out through the mouth. */
export function headspaceTauS(cat: Catalogue, c: Container): number {
  const mouth = cat.property(c.equipment, 'mouthArea')
  const areaM2 = mouth ? parseValue(String(mouth)).si : 5e-4
  return Math.max(2, (headspaceL(c) / 1000) / (MOUTH_EXCHANGE_M_PER_S * areaM2))
}

/**
 * Time passing for gas given off: take what the contents gave off to the syringe, the other liquid
 * or the headspace; the headspace airs out. Returns the mol given off (for bubbles).
 */
export function routeGas(cat: Catalogue, world: { containers: Record<string, Container> }, c: Container, dt: number, onLiquid?: (target: Container, gas: string, mol: number) => void): number {
  const off = c.contents.evolved ?? {}
  const o2 = oxygenBubbles(cat, c.contents)
  if (o2 > 0) off[OXYGEN] = (off[OXYGEN] ?? 0) + o2
  delete c.contents.evolved
  let total = 0
  for (const n of Object.values(off)) total += n
  const g = (c.gas ??= {})
  g.rateMolPerS = dt > 0 ? total / dt : 0
  const head = (g.headspaceMol ??= {})
  // The headspace airs out (a closed vessel's does not).
  const tau = headspaceTauS(cat, c)
  if (c.open && !c.septum) for (const s of Object.keys(head)) head[s] *= Math.exp(-dt / tau)
  for (const [s, n] of Object.entries(off)) {
    if (!(n > 0)) continue
    if (g.to?.kind === 'syringe') (g.collectedMol ??= {})[s] = (g.collectedMol?.[s] ?? 0) + n
    else if (g.to?.kind === 'liquid' && world.containers[g.to.container] && onLiquid) onLiquid(world.containers[g.to.container], s, n)
    else head[s] = (head[s] ?? 0) + n
  }
  for (const s of Object.keys(head)) if (!(head[s] > 1e-12)) delete head[s]
  if (Object.keys(head).length === 0) delete g.headspaceMol
  if (!g.to && !g.headspaceMol && !(g.rateMolPerS > 0)) delete c.gas
  return total
}

/** The headspace as mole fractions: each gas given off, the rest air (oxygen 0.21 of it). */
export function headspaceFractions(cat: Catalogue, c: Container): Record<string, number> {
  const molesHere = (headspaceL(c) / R_L_ATM / 298.15)
  const out: Record<string, number> = {}
  let given = 0
  for (const [s, n] of Object.entries(c.gas?.headspaceMol ?? {})) {
    out[s] = Math.min(1, n / molesHere)
    given += out[s]
  }
  // A tube that held no air (filled with liquid and upturned to collect a gas) holds only what was collected.
  const scale = given > 1 || (c.headspaceAir === 0 && given > 0) ? 1 / given : 1
  for (const s of Object.keys(out)) out[s] *= scale
  const air = Math.max(0, 1 - Math.min(1, given)) * headspaceAir(c)
  out[OXYGEN] = (out[OXYGEN] ?? 0) + air * gasParams(cat).airO2
  out.air = air
  return out
}

/** Volume (L) a quantity of gas takes at a temperature and 1 atm. */
export function gasVolumeL(mol: number, temperatureK: number): number {
  return mol * R_L_ATM * temperatureK
}
