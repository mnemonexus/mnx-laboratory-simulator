// Acid–base equilibrium (contract equilibrium.acid-base, T3; master-plan/04 §4.3): the pH that
// closes the charge balance over every acid–base system present, from substance facets alone.
// Ideal solution (no activity corrections): Henderson–Hasselbalch is the learner's approximation,
// the solver is the truth, so the gap between them is teachable.
import type { Catalogue } from '../catalogue/catalogue.ts'
import type { Layer } from '../kernel/state.ts'
import { boundShare, complexSystemIn, type ComplexSystem, type Speciation, speciate } from './complexation.ts'
import { redoxEquilibrate } from './redox.ts'
import { scientificNumerics } from './numerics.ts'
import { type IonicResult, ionicEquilibrium, isIonic, layerTotals } from './ionic.ts'

const LN10 = Math.LN10

export interface AcidBaseSystem {
  substance: string
  /** Total concentration, mol/L. */
  total: number
  pKa: number[]
  /** Charge of the most protonated form. */
  charge: number
  /** Spectator charge per formula unit (Na⁺, K⁺ supplied with it). */
  spectator: number
}

/** pKw at temperature T (van 't Hoff with ΔH ≈ 55.8 kJ/mol): 14.00 at 25 °C, about 13.6 at 37 °C. */
export function pKw(temperatureK: number): number {
  return 14.0 + (55800 / (LN10 * 8.314)) * (1 / temperatureK - 1 / 298.15)
}

export function systemsIn(cat: Catalogue, layer: Layer): AcidBaseSystem[] {
  const out: AcidBaseSystem[] = []
  if (layer.volumeL <= 0) return out
  for (const [s, n] of Object.entries(layer.species)) {
    if (!(n > 0)) continue
    const def = cat.substances.get(s)
    const ab = def?.acidBase
    if (!ab) {
      // A salt described by its ions (no acid–base data of its own) counts each ion's charge: an
      // ion carrier stands for its neutral acid or base, so hydrochloric acid as chloride is
      // acidic and sodium chloride neutral. (Ions with chemistry of their own engage the ionic model.)
      const ions = def?.aqueous ? { [s]: 1 } : def?.ions
      for (const [carrier, k] of Object.entries(ions ?? {})) {
        const charge = cat.substances.get(carrier)?.aqueous?.charge
        if (charge) out.push({ substance: carrier, total: (n * k) / layer.volumeL, pKa: [], charge, spectator: 0 })
      }
      continue
    }
    out.push({ substance: s, total: n / layer.volumeL, pKa: [...ab.pKa].sort((a, b) => a - b), charge: ab.charge ?? 0, spectator: ab.spectator ?? 0 })
  }
  return out
}

/** Fractions of each form (index = protons lost) at a pH. */
export function fractions(pKa: readonly number[], pH: number): number[] {
  // log of term i relative to the fully protonated form: Σ_{k<i} (pH − pKa_k) · ln10.
  const logs = [0]
  for (let i = 0; i < pKa.length; i++) logs.push(logs[i] + (pH - pKa[i]) * LN10)
  const max = Math.max(...logs)
  const terms = logs.map((l) => Math.exp(l - max))
  const sum = terms.reduce((a, b) => a + b, 0)
  return terms.map((t) => t / sum)
}

/**
 * Net charge concentration (mol/L of charge) from solutes at a pH. A ligand's complexed share has
 * given up all its protons (the metal's own charge stays balanced by its counter-ions).
 */
function soluteCharge(systems: readonly AcidBaseSystem[], pH: number, complexes?: ComplexSystem, warm?: { z?: number[] }): number {
  const sp = complexes ? speciate(complexes, pH, warm) : undefined
  let q = 0
  for (const s of systems) {
    q += s.total * s.spectator
    const a = fractions(s.pKa, pH)
    let mean = 0
    for (let i = 0; i < a.length; i++) mean += a[i] * (s.charge - i)
    const b = boundShare(sp, s.substance)
    q += s.total * ((1 - b) * mean + b * (s.charge - s.pKa.length))
  }
  return q
}

/** The pH that closes the charge balance: [H⁺] + Σ solute charge − [OH⁻] = 0. */
export function solvePH(systems: readonly AcidBaseSystem[], temperatureK = 298.15, complexes?: ComplexSystem, warm: { z?: number[] } = {}): number {
  const rust = scientificNumerics()
  if (rust) return rust.solvePH(systems, temperatureK, complexes, warm)
  const kwLog = -pKw(temperatureK)
  const f = (pH: number) => Math.pow(10, -pH) + soluteCharge(systems, pH, complexes, warm) - Math.pow(10, kwLog + pH)
  let lo = -2
  let hi = 16
  // f decreases with pH; bisection is robust for any mixture. 60 halvings of 18 pH units reach
  // the resolution of a double.
  if (!complexes) {
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2
      if (f(mid) > 0) lo = mid
      else hi = mid
    }
    return (lo + hi) / 2
  }
  // With complexes every evaluation is a speciation solve, so take fewer: halve the bracket to
  // half a pH unit, then close it by false position (Illinois), which converges superlinearly.
  while (hi - lo > 0.5) {
    const mid = (lo + hi) / 2
    if (f(mid) > 0) lo = mid
    else hi = mid
  }
  let flo = f(lo)
  let fhi = f(hi)
  let side = 0
  for (let i = 0; i < 60 && hi - lo > 1e-10; i++) {
    const x = flo === fhi ? (lo + hi) / 2 : hi - (fhi * (hi - lo)) / (fhi - flo)
    const fx = f(x)
    if (fx === 0) return x
    if (fx > 0) {
      lo = x
      flo = fx
      if (side === -1) fhi /= 2
      side = -1
    } else {
      hi = x
      fhi = fx
      if (side === 1) flo /= 2
      side = 1
    }
    if (Math.abs(fx) < 1e-15) return x
  }
  return (lo + hi) / 2
}

/** pH of a liquid layer, or undefined if there is no liquid. */
export function layerPH(cat: Catalogue, layer: Layer, temperatureK: number): number | undefined {
  return layerSpeciation(cat, layer, temperatureK).pH
}

/** A layer at equilibrium: its pH, the solution's redox potential, the complexes, and its species after any redox. */
export interface LayerSpeciation {
  pH?: number
  /** Redox potential (V vs SHE), where the layer holds a redox couple. */
  potentialV?: number
  complexes?: Speciation
  /** The species as they are at equilibrium (the stored layer itself unless redox moved electrons). */
  layer: Layer
  /** For a liquid with ions (models/ionic.ts): every species, and the substances it accounts for. */
  ionic?: IonicResult & { handled: Set<string> }
}

/** Recent speciations by exact composition: a step asks about the same unchanged layer several times. */
const speciationCache = new WeakMap<Catalogue, { numerics: ReturnType<typeof scientificNumerics>; values: Map<string, LayerSpeciation> }>()
const SPECIATION_CACHE_SIZE = 256

/**
 * A layer's pH and, where they meet, its redox couples brought to one potential and its ligands
 * bound to metal ions. Redox is settled at the pH of what was added (its protons are assumed in
 * excess); the complexes and the final pH follow from the species redox leaves.
 */
export function layerSpeciation(cat: Catalogue, layer: Layer, temperatureK: number): LayerSpeciation {
  if (layer.volumeL <= 0) return { layer }
  const redox = Object.keys(layer.species).some((s) => layer.species[s] > 0 && cat.substances.get(s)?.redox)
  const ionic = isIonic(cat, layer)
  const plainCs = redox || ionic ? undefined : complexSystemIn(cat, layer)
  if (!redox && !plainCs && !ionic) return { pH: solvePH(systemsIn(cat, layer), temperatureK), layer }
  // A reference/production backend change must not reuse another solver's answers.
  const numerics = scientificNumerics()
  let cached = speciationCache.get(cat)
  if (!cached || cached.numerics !== numerics) {
    cached = { numerics, values: new Map() }
    speciationCache.set(cat, cached)
  }
  const cache = cached.values
  let key = `${layer.volumeL}|${temperatureK}`
  for (const [s, n] of Object.entries(layer.species)) if (n > 0) key += `|${s}=${n}`
  const hit = cache.get(key)
  if (hit) return hit
  let eff = layer
  let potentialV: number | undefined
  if (redox) {
    const rx = redoxEquilibrate(cat, layer, solvePH(systemsIn(cat, layer), temperatureK), temperatureK)
    if (rx) {
      eff = rx.layer
      potentialV = rx.potentialV
    }
  }
  if (ionic || isIonic(cat, eff)) {
    // The ionic model takes the whole liquid: acid–base, complexes, hydrolysis and saturation.
    const r = ionicEquilibrium(cat, layerTotals(eff), temperatureK)
    const handled = new Set(Object.keys(eff.species).filter((s) => eff.species[s] > 0 && handledByIonic(cat, s)))
    const out: LayerSpeciation = { pH: r.pH, layer: eff, ...(potentialV !== undefined ? { potentialV } : {}), ionic: { ...r, handled } }
    if (cache.size >= SPECIATION_CACHE_SIZE) cache.delete(cache.keys().next().value!)
    cache.set(key, out)
    return out
  }
  const cs = redox ? complexSystemIn(cat, eff) : plainCs
  const warm: { z?: number[] } = {}
  const pH = solvePH(systemsIn(cat, eff), temperatureK, cs, warm)
  const out: LayerSpeciation = { pH, layer: eff, ...(potentialV !== undefined ? { potentialV } : {}), ...(cs ? { complexes: speciate(cs, pH, warm) } : {}) }
  if (cache.size >= SPECIATION_CACHE_SIZE) cache.delete(cache.keys().next().value!)
  cache.set(key, out)
  return out
}

/**
 * Record what the ionic model just settled a layer to (ionicEquilibrate solves the liquid with its
 * solids; the dissolved state it leaves is that solution), so the next look at the layer (its pH,
 * heat, colour) needs no second solve. Only for a layer without redox couples. The water a solid
 * formed or released shifts concentrations by a fraction of a percent, which this ignores.
 */
export function primeSpeciation(cat: Catalogue, layer: Layer, temperatureK: number, r: IonicResult): void {
  if (!(layer.volumeL > 0) || Object.keys(layer.species).some((s) => layer.species[s] > 0 && cat.substances.get(s)?.redox)) return
  const numerics = scientificNumerics()
  let cached = speciationCache.get(cat)
  if (!cached || cached.numerics !== numerics) {
    cached = { numerics, values: new Map() }
    speciationCache.set(cat, cached)
  }
  let key = `${layer.volumeL}|${temperatureK}`
  for (const [s, n] of Object.entries(layer.species)) if (n > 0) key += `|${s}=${n}`
  const handled = new Set(Object.keys(layer.species).filter((s) => layer.species[s] > 0 && handledByIonic(cat, s)))
  const solids = Object.fromEntries(Object.keys(r.solids).map((s) => [s, 0]))
  if (cached.values.size >= SPECIATION_CACHE_SIZE) cached.values.delete(cached.values.keys().next().value!)
  cached.values.set(key, { pH: r.pH, layer, ionic: { ...r, solids, handled } })
}

/**
 * Molar absorption coefficient of a substance at a wavelength and pH, including indicator forms
 * and, for a ligand, the complexes it is in (`bound`: its share bound to each ion).
 */
export function formEpsilon(cat: Catalogue, substance: string, nm: number, pH: number | undefined, base: (s: string, nm: number) => number, bound?: Record<string, number>): number {
  const def = cat.substances.get(substance)
  const ab = def?.acidBase
  let complexed = 0
  let e = 0
  if (bound) {
    for (const c of def?.complexes ?? []) {
      const share = bound[c.ion] ?? 0
      complexed += share
      if (c.epsilon) e += share * interpolate(c.epsilon, nm)
    }
  }
  const free = Math.max(0, 1 - complexed)
  if (!ab?.forms || ab.forms.length === 0 || pH === undefined) return e + free * base(substance, nm)
  const a = fractions([...ab.pKa].sort((x, y) => x - y), pH)
  ab.forms.forEach((form, i) => {
    if (i < a.length && form.epsilon) e += free * a[i] * interpolate(form.epsilon, nm)
  })
  return e
}

export function interpolate(table: ReadonlyArray<readonly [number, number]>, nm: number): number {
  const pts = [...table].sort((a, b) => a[0] - b[0])
  if (pts.length === 0 || nm < pts[0][0] || nm > pts[pts.length - 1][0]) return 0
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i]
    const [x1, y1] = pts[i + 1]
    if (nm >= x0 && nm <= x1) return x1 === x0 ? y0 : y0 + ((y1 - y0) * (nm - x0)) / (x1 - x0)
  }
  return pts[pts.length - 1][1]
}

/** Whether the ionic model accounts for a substance's absorbance (it is, or dissolves to, ion carriers). */
function handledByIonic(cat: Catalogue, s: string): boolean {
  const def = cat.substances.get(s)
  return !!(def?.acidBase || def?.aqueous || def?.ions || def?.solid)
}

/**
 * Σ ε·c over a liquid's absorbing species at a wavelength (cm⁻¹): every species of the ionic model
 * (forms, complexes) where it is engaged, and the other substances by their forms and complexes.
 */
export function layerAbsorptivity(cat: Catalogue, sp: LayerSpeciation, volumeL: number, nm: number, base: (s: string, nm: number) => number): number {
  if (!(volumeL > 0)) return 0
  let a = 0
  if (sp.ionic) for (const x of sp.ionic.species) if (x.epsilon && x.conc > 0) a += interpolate(x.epsilon, nm) * x.conc
  for (const [s, n] of Object.entries(sp.layer.species)) {
    if (!(n > 0) || sp.ionic?.handled.has(s)) continue
    a += formEpsilon(cat, s, nm, sp.pH, base, sp.complexes?.bound[s]) * (n / volumeL)
  }
  return a
}

/**
 * The colour an eye sees (T1 from optics): the name of the strongest visible absorber, if the
 * visible absorbance over 1 cm exceeds a threshold; otherwise "colourless".
 */
export function visibleColour(cat: Catalogue, layer: Layer, temperatureK: number, base: (s: string, nm: number) => number): string {
  if (layer.volumeL <= 0) return 'empty'
  const sp = layerSpeciation(cat, layer, temperatureK)
  const { pH, complexes, layer: eq } = sp
  let best = { a: 0, colour: 'colourless' }
  let total = 0
  // Ionic species (forms, complexes) name their own colour, else their carrier's.
  for (const x of sp.ionic?.species ?? []) {
    if (!x.epsilon || !(x.conc > 0)) continue
    let peak = 0
    for (const nm of [420, 470, 520, 552, 600, 650]) peak = Math.max(peak, interpolate(x.epsilon, nm) * x.conc)
    total += peak
    if (peak > best.a) best = { a: peak, colour: x.colour ?? cat.substances.get(x.carrier)?.optics?.colour ?? 'coloured' }
  }
  for (const [s, n] of Object.entries(eq.species)) {
    if (sp.ionic?.handled.has(s)) continue
    if (!(n > 0)) continue
    const c = n / layer.volumeL
    const def = cat.substances.get(s)
    const bound = complexes?.bound[s]
    let peak = 0
    for (const nm of [420, 470, 520, 552, 600, 650]) peak = Math.max(peak, formEpsilon(cat, s, nm, pH, base, bound) * c)
    total += peak
    if (peak > best.a) {
      let colour = def?.optics?.colour ?? 'coloured'
      // The form (free, by protonation, or a complex) that absorbs most decides the colour seen.
      let strongest = 0
      const free = 1 - boundShare(complexes, s)
      if (def?.acidBase?.forms && pH !== undefined) {
        const a = fractions([...def.acidBase.pKa].sort((x, y) => x - y), pH)
        let i = 0
        for (let k = 1; k < a.length; k++) if (a[k] * maxEps(def.acidBase.forms[k]?.epsilon) > a[i] * maxEps(def.acidBase.forms[i]?.epsilon)) i = k
        colour = def.acidBase.forms[i]?.colour ?? colour
        strongest = free * a[i] * maxEps(def.acidBase.forms[i]?.epsilon)
      }
      for (const cx of def?.complexes ?? []) {
        const w = (bound?.[cx.ion] ?? 0) * maxEps(cx.epsilon)
        if (cx.colour && w > strongest) {
          strongest = w
          colour = cx.colour
        }
      }
      best = { a: peak, colour }
    }
  }
  return total < 0.05 ? 'colourless' : best.colour
}

function maxEps(table: ReadonlyArray<readonly [number, number]> | undefined): number {
  return table ? Math.max(0, ...table.map((p) => p[1])) : 0
}

/**
 * Ionic strength (mol/L), I = ½ Σ cᵢ zᵢ²: acid–base solutes by their forms at the layer's pH, each
 * with its spectator ions (taken as monovalent: Na⁺, K⁺, Cl⁻); other salts as their declared
 * cation (else a monovalent one) balanced by monovalent anions. Neutral molecules, proteins and H⁺
 * and OH⁻ themselves are left out (small beside a buffer's ions).
 */
export function ionicStrength(cat: Catalogue, layer: Layer, temperatureK: number): number {
  if (!(layer.volumeL > 0)) return 0
  let pH: number | undefined
  let sum = 0
  for (const [s, n] of Object.entries(layer.species)) {
    if (!(n > 0)) continue
    const c = n / layer.volumeL
    const def = cat.substances.get(s)
    const ab = def?.acidBase
    if (ab) {
      pH ??= layerPH(cat, layer, temperatureK) ?? 7
      const a = fractions([...ab.pKa].sort((x, y) => x - y), pH)
      let z2 = 0
      for (let i = 0; i < a.length; i++) z2 += a[i] * ((ab.charge ?? 0) - i) ** 2
      sum += c * (z2 + Math.abs(ab.spectator ?? 0))
    } else if (def?.identity.class === 'salt') {
      const m = def.cation?.ion.match(/(\d*)\+$/)
      const z = m ? Number(m[1] || 1) : 1
      const count = def.cation?.count ?? 1
      sum += c * count * (z * z + z)
    }
  }
  return sum / 2
}
