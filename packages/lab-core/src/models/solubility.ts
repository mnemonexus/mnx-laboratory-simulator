// Solubility (contract solubility, T2; scientific simulation §3.1): how much of a substance a
// liquid holds at its temperature and pH. Excess comes out as solid when a solution cools or
// loses solvent; solid dissolves up to the limit, at once when mixed and slowly when standing.
// For an acid or base the limit is the solubility of one form (usually the neutral one), so the
// total that dissolves rises as the pH turns it into ions: the basis of acid–base extraction.
// Ideal: no common-ion, salting-out or supersaturation effects; the solvent is water.
import type { Catalogue } from '../catalogue/catalogue.ts'
import { molarMass } from '../kernel/materials.ts'
import { type Contents, liquidVolume, meanLayer } from '../kernel/state.ts'
import { parseValue } from '../units/index.ts'
import { fractions, solvePH, systemsIn } from './acidbase.ts'
import { phaseView } from './phases.ts'
import { ionicEquilibrate } from './ionic.ts'
import { releaseHeat, settledEnthalpyJ } from './thermochem.ts'

export interface SolubilityLimit {
  /** (temperature K, mol/L) points, ascending in temperature; one point = constant (none: no fixed limit). */
  points: Array<[number, number]>
  /** Salting out: log₁₀ S (g/L) = beta − ks × [salt]; the molar mass converts to mol/L. */
  saltingOut?: { salt: string; beta: number; ks: number; molarMass: number }
  /** A fine precipitate stays suspended in the liquid until it is centrifuged. */
  fine: boolean
  /** The acid–base form the limit applies to, and the system's pKa values (ascending). */
  form?: number
  pKa?: number[]
}

const cache = new WeakMap<Catalogue, Map<string, SolubilityLimit>>()

/** Substances with a solubility limit, from their `solubility` facets. */
export function solubilityLimits(cat: Catalogue): Map<string, SolubilityLimit> {
  const hit = cache.get(cat)
  if (hit) return hit
  const out = new Map<string, SolubilityLimit>()
  for (const s of cat.substances.values()) {
    const sol = s.solubility
    if (!sol || (!sol.maxConc && !sol.curve?.length && !sol.saltingOut)) continue
    const mm = molarMass(cat, s.id) ?? 1
    const molPerL = (text: string) => {
      const q = parseValue(text)
      return q.dim[0] === 1 ? q.si / mm : q.si / 1000
    }
    const points: Array<[number, number]> = sol.curve?.length
      ? sol.curve.map((p) => [parseValue(p.temperature).si, molPerL(p.conc)] as [number, number]).sort((a, b) => a[0] - b[0])
      : sol.maxConc
        ? [[298.15, molPerL(sol.maxConc)]]
        : []
    const limit: SolubilityLimit = {
      points,
      fine: sol.precipitate === 'fine',
      ...(sol.saltingOut ? { saltingOut: { ...sol.saltingOut, molarMass: mm } } : {}),
    }
    if (s.acidBase) {
      limit.pKa = [...s.acidBase.pKa].sort((a, b) => a - b)
      // By default the limit is for the uncharged form.
      limit.form = Math.max(0, Math.min(limit.pKa.length, sol.form ?? s.acidBase.charge ?? 0))
    }
    out.set(s.id, limit)
  }
  cache.set(cat, out)
  return out
}

/** The limit (mol/L) at a temperature: log-linear between points, held constant beyond them. */
export function limitAt(limit: SolubilityLimit, temperatureK: number): number {
  const pts = limit.points
  if (pts.length === 0) return Infinity
  if (pts.length === 1 || temperatureK <= pts[0][0]) return pts[0][1]
  if (temperatureK >= pts[pts.length - 1][0]) return pts[pts.length - 1][1]
  for (let i = 0; i < pts.length - 1; i++) {
    const [t0, c0] = pts[i]
    const [t1, c1] = pts[i + 1]
    if (temperatureK >= t0 && temperatureK <= t1) {
      const f = (temperatureK - t0) / (t1 - t0)
      return Math.exp(Math.log(c0) + f * (Math.log(c1) - Math.log(c0)))
    }
  }
  return pts[pts.length - 1][1]
}

function dissolvedMol(c: Contents, s: string): number {
  return c.layers.reduce((a, l) => a + (l.species[s] ?? 0), 0)
}

function suspendedMol(c: Contents, s: string): number {
  return c.layers.reduce((a, l) => a + (l.particles?.[s] ?? 0), 0)
}

/** The limit in this liquid (mol/L): the temperature curve and, if it salts out, the salt present. */
function capacityPerL(c: Contents, limit: SolubilityLimit): number {
  let cap = limitAt(limit, c.temperatureK)
  if (limit.saltingOut) {
    const v = liquidVolume(c)
    const salt = v > 0 ? dissolvedMol(c, limit.saltingOut.salt) / v : 0
    cap = Math.min(cap, Math.pow(10, limit.saltingOut.beta - limit.saltingOut.ks * salt) / limit.saltingOut.molarMass)
  }
  return cap
}

/**
 * The amount (mol) of s that would be dissolved at equilibrium, out of `total`, in the
 * container's liquid. For acids and bases the limit is on one form, so the pH is solved with it.
 */
export function equilibriumDissolved(cat: Catalogue, c: Contents, s: string, limit: SolubilityLimit, total: number): number {
  const v = liquidVolume(c)
  if (v <= 0) return 0
  const cap = capacityPerL(c, limit) * v
  // The form is at most all of what is dissolved, so up to the plain limit always dissolves.
  if (total <= cap || limit.form === undefined || !limit.pKa) return Math.min(total, cap)
  const layer = meanLayer(c)
  const T = c.temperatureK
  const formAmount = (d: number): number => {
    layer.species[s] = d
    const pH = solvePH(systemsIn(cat, layer), T)
    return d * (fractions(limit.pKa!, pH)[limit.form!] ?? 0)
  }
  // g(d) = form amount − limit rises with d; g(cap) ≤ 0 < g(total). Illinois regula falsi
  // converges in a few steps where bisection needs dozens (each step solves the pH).
  let lo = cap
  let hi = total
  let gLo = formAmount(lo) - cap
  let gHi = formAmount(hi) - cap
  if (gHi <= 0) return total
  if (gLo >= 0) return lo
  let side = 0
  for (let i = 0; i < 60 && hi - lo > cap * 1e-9; i++) {
    const d = (lo * gHi - hi * gLo) / (gHi - gLo)
    const g = formAmount(d) - cap
    if (Math.abs(g) <= cap * 1e-10) return d
    if (g > 0) {
      hi = d
      gHi = g
      if (side === 1) gLo /= 2
      side = 1
    } else {
      lo = d
      gLo = g
      if (side === -1) gHi /= 2
      side = -1
    }
  }
  return lo
}

export interface Equilibration {
  /** mol per substance; positive = came out of solution, negative = dissolved. */
  change: Record<string, number>
}

/**
 * Bring every solubility-limited substance towards equilibrium: precipitate any excess at once,
 * dissolve solid by `dissolveFraction` of the way (1 when mixed). Substances without a limit are
 * left alone. Returns what changed.
 */
/**
 * equilibrate, with the heat of whatever dissolves or comes out (and of any reaction it settles):
 * the solids' change is passed to releaseHeat, so the liquid's carried enthalpy stays true. Every
 * equilibration outside another heat window should come through here.
 */
export function equilibrateWithHeat(cat: Catalogue, all: Contents, dissolveFraction = 1): Equilibration {
  const before = settledEnthalpyJ(cat, all)
  const r = equilibrate(cat, all, dissolveFraction)
  releaseHeat(cat, all, before - settledEnthalpyJ(cat, all))
  return r
}

export function equilibrate(cat: Catalogue, all: Contents, dissolveFraction = 1): Equilibration {
  const change = equilibrateLimited(cat, all, dissolveFraction)
  // Ionic solids (precipitates by their solubility products) and salts taken apart into ions.
  for (const [s, n] of Object.entries(ionicEquilibrate(cat, all, dissolveFraction))) change[s] = (change[s] ?? 0) + n
  return { change }
}

function equilibrateLimited(cat: Catalogue, all: Contents, dissolveFraction: number): Record<string, number> {
  const change: Record<string, number> = {}
  const limits = solubilityLimits(cat)
  if (limits.size === 0) return change
  for (const [s, limit] of limits) {
    // Only the layers that can dissolve it (a salt does not dissolve in a solvent layer).
    const c = phaseView(cat, all, s)
    if (!c) continue
    const v = liquidVolume(c)
    const solid = c.solid[s] ?? 0
    const dissolved = v > 0 ? dissolvedMol(c, s) : 0
    const suspended = v > 0 ? suspendedMol(c, s) : 0
    if (solid <= 0 && dissolved <= 0 && suspended <= 0) continue
    if (v <= 0) continue
    const eq = equilibriumDissolved(cat, c, s, limit, solid + suspended + dissolved)
    if (dissolved > eq * (1 + 1e-9)) {
      // Out of solution, from every layer in proportion to what it holds: crystals settle, a fine precipitate stays where it formed.
      const out = dissolved - eq
      for (const l of c.layers) {
        const n = l.species[s] ?? 0
        if (!(n > 0)) continue
        const here = (out * n) / dissolved
        l.species[s] = n - here
        if (limit.fine) (l.particles ??= {})[s] = (l.particles[s] ?? 0) + here
      }
      if (!limit.fine) c.solid[s] = solid + out
      change[s] = out
    } else if (solid + suspended > 0 && eq > dissolved * (1 + 1e-9) && dissolveFraction > 0) {
      // Suspended particles dissolve where they are; a pellet or crystals dissolve into the whole liquid.
      let want = (eq - dissolved) * dissolveFraction
      let moved = 0
      for (const l of c.layers) {
        const n = l.particles?.[s] ?? 0
        if (!(n > 0) || want <= 0) continue
        const take = Math.min(n, want * (suspended > 0 ? n / suspended : 0) + 1e-30)
        l.particles![s] = n - take
        l.species[s] = (l.species[s] ?? 0) + take
        moved += take
      }
      want -= moved
      if (want > 0 && solid > 0) {
        const fromSolid = Math.min(solid, want)
        c.solid[s] = solid - fromSolid
        for (const l of c.layers) l.species[s] = (l.species[s] ?? 0) + fromSolid * (l.volumeL / v)
        moved += fromSolid
      }
      change[s] = -moved
    }
  }
  return change
}

/** Whether a container holds anything that equilibrate() acts on (cheap test for the time loop). */
export function hasLimited(cat: Catalogue, c: Contents): boolean {
  // Undissolved ionic solid keeps dissolving (or growing) as time passes.
  for (const [s, n] of Object.entries(c.solid)) if (n > 0 && cat.substances.get(s)?.solid) return true
  for (const l of c.layers) for (const [s, n] of Object.entries(l.particles ?? {})) if (n > 0 && cat.substances.get(s)?.solid) return true
  // A liquid the ionic model settled at another temperature: cooling can bring crystals out.
  if (c.equilibratedK !== undefined && Math.abs(c.temperatureK - c.equilibratedK) > 0.5) return true
  // A gas made in the liquid as time passes (carbon dioxide from fermenting yeast) comes out once it is supersaturated.
  for (const l of c.layers) for (const [s, n] of Object.entries(l.species)) if (n > 0 && cat.substances.get(s)?.solid?.phase === 'gas') return true
  const limits = solubilityLimits(cat)
  if (limits.size === 0) return false
  for (const s of limits.keys()) {
    if ((c.solid[s] ?? 0) > 0) return true
    for (const l of c.layers) if ((l.species[s] ?? 0) > 0 || (l.particles?.[s] ?? 0) > 0) return true
  }
  return false
}

/** Mixing lifts a pellet of fine precipitate back into suspension. */
export function resuspend(cat: Catalogue, c: Contents): void {
  const v = liquidVolume(c)
  if (v <= 0) return
  for (const [s, limit] of solubilityLimits(cat)) {
    const n = c.solid[s] ?? 0
    if (!limit.fine || !(n > 0)) continue
    c.solid[s] = 0
    for (const l of c.layers) (l.particles ??= {})[s] = (l.particles[s] ?? 0) + n * (l.volumeL / v)
  }
}

/** Centrifugal dose (g·min) that pellets about 63 % of a fine precipitate. */
const PELLET_DOSE = 30000

/** Spin: suspended particles go to the pellet (the container's solid) by the dose given. */
export function pellet(c: Contents, rcf: number, minutes: number): number {
  const f = 1 - Math.exp((-rcf * minutes) / PELLET_DOSE)
  let moved = 0
  for (const l of c.layers) {
    for (const [s, n] of Object.entries(l.particles ?? {})) {
      if (!(n > 0)) continue
      const down = n * f
      l.particles![s] = n - down
      c.solid[s] = (c.solid[s] ?? 0) + down
      moved += down
    }
  }
  return moved
}

/** Particles out of suspension into a solid (drying, or a filter that keeps them). */
export function settleAll(c: Contents): void {
  for (const l of c.layers) {
    for (const [s, n] of Object.entries(l.particles ?? {})) if (n > 0) c.solid[s] = (c.solid[s] ?? 0) + n
    delete l.particles
  }
}
