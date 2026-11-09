// Surface reactions (contract kinetics.surface, T2): solids that react where the liquid touches
// them, at a rate set by their surface. A metal gives up its electrons to hydrogen ions (hydrogen
// is given off) or to the ions of a less reactive metal, which deposits as the metal; a carbonate
// (marble chips, powder) dissolves in acid and the ionic model lets its CO₂ bubble out; a solid
// catalyst (manganese(IV) oxide) turns a dissolved substrate into products without being used up.
//
//   rate (mol/s) = k(T) × area × [H⁺]^order   (acid)      k(T) = k₂₉₈ exp(−Ea/R (1/T − 1/298.15))
//   rate (mol/s) = k(T) × area × [M^z+]        (displacement, only towards a higher E°)
//   rate (mol/s) = k(T) × area × [substrate]   (a solid catalyst)
//   area (m²)    = specific surface × m₀ × (m/m₀)^p, so powder outpaces ribbon or chips of the same
//                  mass; p is 0 for a sheet (ribbon thins at constant area), ½ for a rod, ⅔ for a particle
//
// Products join the liquid as ion carriers with protons implicit: a metal's ion stands for its
// hydroxide less water, which is exactly the acid it used up, so the pH follows by itself. The
// liquid's volume follows the solute added so that its mass is exact (a flask on a balance loses
// only the gas). Ideal: no passivating oxide layers; pieces of one solid shrink together.
import type { Catalogue } from '../catalogue/catalogue.ts'
import type { Contents, Layer } from '../kernel/state.ts'
import { liquidVolume } from '../kernel/state.ts'
import { parseValue } from '../units/index.ts'
import { layerSpeciation } from './acidbase.ts'
import { carriersOf, hiddenWater, ionicEquilibrate } from './ionic.ts'
import { isOrganic } from './phases.ts'

const R = 8.314462618
/** How a solid's area falls as it is used up: area ∝ (mass)^p. */
const SHAPE_EXPONENT = { sheet: 0, rod: 0.5, particle: 2 / 3 } as const
/** The volume a dissolved solute takes up (as in contentsMassKg): 1500 g/L. */
const SOLUTE_G_PER_L = 1500
export const HYDROGEN = 'aq:hydrogen'
const WATER = 'core:water'
/** Water's volume per mol (18.015 g/mol at 0.997 g/mL). */
const WATER_L_PER_MOL = 0.018069

function molarMassG(cat: Catalogue, s: string): number {
  const t = cat.substances.get(s)?.physical?.molarMass
  return t ? parseValue(t).si * 1000 : 0
}

/** Whether the contents hold a solid that reacts at its surface. */
export function hasSurfaceReactions(cat: Catalogue, c: Contents): boolean {
  const reactive = (s: string) => {
    const d = cat.substances.get(s)
    return !!(d?.surface && (d.metal || d.dissolution || d.catalyst))
  }
  for (const [s, n] of Object.entries(c.solid)) if (n > 0 && reactive(s)) return true
  for (const l of c.layers) for (const [s, n] of Object.entries(l.particles ?? {})) if (n > 0 && reactive(s)) return true
  return false
}

interface Reactive {
  substance: string
  /** Where it is: settled (contents.solid) and suspended in each layer. */
  settled: number
  suspended: number
}

/** Take mol of a reactive solid, from the suspension first. */
function takeSolid(c: Contents, s: string, mol: number): void {
  let left = mol
  for (const l of c.layers) {
    const n = l.particles?.[s] ?? 0
    if (!(n > 0) || left <= 0) continue
    const take = Math.min(n, left)
    l.particles![s] = n - take
    left -= take
  }
  if (left > 0) c.solid[s] = Math.max(0, (c.solid[s] ?? 0) - left)
}

/** Add dissolved substance to the aqueous layers by volume, the volume growing by what it takes up. */
function addDissolved(cat: Catalogue, layers: Layer[], volumeL: number, s: string, mol: number): void {
  const dV = (mol * molarMassG(cat, s)) / SOLUTE_G_PER_L
  for (const l of layers) {
    const share = l.volumeL / volumeL
    l.species[s] = Math.max(0, (l.species[s] ?? 0) + mol * share)
    l.volumeL = Math.max(0, l.volumeL + dV * share)
  }
}

/**
 * Let the solids react at their surfaces for dt seconds at temperature T. Returns the mol of each
 * solid (or catalysed substrate) used and the water formed. Runs the ionic model afterwards, so gas
 * given off and solids formed are settled.
 */
export function reactAtSurfaces(cat: Catalogue, c: Contents, T: number, dt: number): { used: Record<string, number>; waterMol: number } {
  const used: Record<string, number> = {}
  const out = { used, waterMol: 0 }
  const v = liquidVolume(c)
  if (!(v > 0)) return out
  const aqueous = c.layers.filter((l) => !isOrganic(cat, l))
  let volumeL = aqueous.reduce((a, l) => a + l.volumeL, 0)
  if (!(volumeL > 0)) return out
  const reactive: Reactive[] = []
  const seen = new Set<string>()
  const consider = (s: string) => {
    if (seen.has(s)) return
    seen.add(s)
    const d = cat.substances.get(s)
    if (!d?.surface || !(d.metal || d.dissolution || d.catalyst)) return
    const settled = c.solid[s] ?? 0
    const suspended = c.layers.reduce((a, l) => a + (l.particles?.[s] ?? 0), 0)
    if (settled + suspended > 0) reactive.push({ substance: s, settled, suspended })
  }
  for (const s of Object.keys(c.solid)) consider(s)
  for (const l of c.layers) for (const s of Object.keys(l.particles ?? {})) consider(s)
  if (reactive.length === 0) return out
  // Salts are taken apart into their ions before anything changes (displacement takes the other
  // metal's ions by carrier); rates read the liquid as it is, so nothing that cannot react costs a solve.
  let canonical = false

  let t = 0
  for (let guard = 0; guard < 400 && t < dt - 1e-9; guard++) {
    // The liquid as it is now: free H⁺ from its pH, and each ion carrier's total concentration.
    // The liquid as each sub-step left it (its volume follows the solute and water added).
    volumeL = aqueous.reduce((a, l) => a + l.volumeL, 0)
    const merged: Layer = { volumeL, species: {} }
    for (const l of aqueous) for (const [s, n] of Object.entries(l.species)) merged.species[s] = (merged.species[s] ?? 0) + n
    const pH = layerSpeciation(cat, merged, T).pH ?? 7
    const h = Math.pow(10, -pH)
    const carriers: Record<string, number> = {}
    for (const [s, n] of Object.entries(merged.species)) {
      if (!(n > 0)) continue
      const d = cat.substances.get(s)
      if (!(d?.aqueous || d?.ions)) continue
      for (const [carrier, k] of Object.entries(carriersOf(cat, s))) carriers[carrier] = (carriers[carrier] ?? 0) + (n * k) / volumeL
    }
    // Rates now (mol/s) for every reaction of every solid.
    // limit: the most the step can use; bound: how much can go before its rate changes much.
    const steps: Array<{ solid: string; rate: number; apply: (mol: number) => void; limit: number; bound: number; acid?: boolean }> = []
    for (const r of reactive) {
      const d = cat.substances.get(r.substance)!
      const mol = (c.solid[r.substance] ?? 0) + c.layers.reduce((a, l) => a + (l.particles?.[r.substance] ?? 0), 0)
      if (!(mol > 1e-15)) continue
      const ref = Math.max(c.surfaceRef?.[r.substance] ?? 0, mol)
      ;(c.surfaceRef ??= {})[r.substance] = ref
      const p = SHAPE_EXPONENT[d.surface!.shape ?? 'particle']
      const area = d.surface!.m2PerG * ref * molarMassG(cat, r.substance) * Math.pow(mol / ref, p)
      // The area changes by p × the fraction used: a sheet's rate holds until it is gone.
      const solidBound = p > 0 ? mol / p : Infinity
      const metal = d.metal
      if (metal) {
        const arr = Math.exp(-((metal.ea ?? 40) * 1000 / R) * (1 / T - 1 / 298.15))
        if (metal.acidK && metal.e0 < 0) {
          steps.push({
            solid: r.substance,
            rate: metal.acidK * arr * area * h,
            acid: true,
            // Each mol of metal: its ion into the liquid, charge/2 mol of hydrogen off.
            apply: (n) => {
              takeSolid(c, r.substance, n)
              addDissolved(cat, aqueous, volumeL, metal.ion, n)
              ;(c.evolved ??= {})[HYDROGEN] = (c.evolved[HYDROGEN] ?? 0) + (n * metal.charge) / 2
            },
            limit: mol,
            bound: solidBound,
          })
        }
        if (metal.displaceK) {
          for (const [ion, conc] of Object.entries(carriers)) {
            const target = cat.substances.get(ion)?.aqueous
            if (!target?.metal || ion === metal.ion || !(target.metal.e0 > metal.e0 + 0.05) || !(conc > 0)) continue
            const zIon = target.charge
            const ionMol = conc * volumeL
            steps.push({
              solid: r.substance,
              rate: metal.displaceK * arr * area * conc,
              // n mol of metal gives up n·z electrons: n·z/zIon mol of the other ion deposits as its metal.
              apply: (n) => {
                const deposited = Math.min(ionMol, (n * metal.charge) / zIon)
                const metalUsed = (deposited * zIon) / metal.charge
                takeSolid(c, r.substance, metalUsed)
                addDissolved(cat, aqueous, volumeL, metal.ion, metalUsed)
                removeCarrier(cat, aqueous, volumeL, ion, deposited)
                c.solid[target.metal!.deposit] = (c.solid[target.metal!.deposit] ?? 0) + deposited
              },
              limit: Math.min(mol, (ionMol * zIon) / metal.charge),
              bound: Math.min(solidBound, (ionMol * zIon) / metal.charge),
            })
          }
        }
      }
      const dis = d.dissolution
      if (dis) {
        const arr = Math.exp(-((dis.ea ?? 40) * 1000 / R) * (1 / T - 1 / 298.15))
        steps.push({
          solid: r.substance,
          rate: dis.k * arr * area * Math.pow(h, dis.order ?? 1),
          acid: true,
          apply: (n) => {
            takeSolid(c, r.substance, n)
            for (const [carrier, k] of Object.entries(d.ions ?? {})) addDissolved(cat, aqueous, volumeL, carrier, n * k)
            // An oxide's water joins the liquid (CuO + 2H⁺ → Cu²⁺ + H₂O); a carbonate holds none.
            const water = hiddenWater(cat, r.substance)
            if (water > 0) for (const l of aqueous) l.volumeL += (n * water * WATER_L_PER_MOL * l.volumeL) / volumeL
          },
          limit: mol,
          bound: solidBound,
        })
      }
    }
    for (const r of reactive) {
      const d = cat.substances.get(r.substance)!
      const cat_ = d.catalyst
      if (!cat_) continue
      const mol = (c.solid[r.substance] ?? 0) + c.layers.reduce((a, l) => a + (l.particles?.[r.substance] ?? 0), 0)
      const substrateMol = merged.species[cat_.substrate] ?? 0
      if (!(mol > 1e-15) || !(substrateMol > 1e-15)) continue
      const area = d.surface!.m2PerG * mol * molarMassG(cat, r.substance)
      const arr = Math.exp(-((cat_.ea ?? 50) * 1000 / R) * (1 / T - 1 / 298.15))
      steps.push({
        solid: cat_.substrate,
        rate: cat_.k * arr * area * (substrateMol / volumeL),
        // The substrate goes; its products join the liquid (water as volume), the catalyst stays.
        apply: (n) => {
          removeCarrier(cat, aqueous, volumeL, cat_.substrate, n)
          for (const [product, k] of Object.entries(cat_.products)) {
            if (product === WATER) {
              for (const l of aqueous) l.volumeL += (n * k * WATER_L_PER_MOL * l.volumeL) / volumeL
              out.waterMol += n * k
            }
            else addDissolved(cat, aqueous, volumeL, product, n * k)
          }
        },
        limit: substrateMol,
        bound: substrateMol,
      })
    }
    const total = steps.reduce((a, x) => a + x.rate, 0)
    // Nothing measurable left to happen in this step (copper among more reactive metals' ions).
    if (!(total * (dt - t) > 1e-12)) break
    if (!canonical) {
      ionicEquilibrate(cat, c, 1)
      canonical = true
    }
    // A sub-step changes no rate by more than about 5 %, and a step that finishes a solid ends there;
    // a reaction that can use under a nanomole in all (a trace of another metal's ion) just runs out.
    let span = dt - t
    for (const x of steps) if (x.limit > 1e-9) span = Math.min(span, Math.min(0.05 * x.bound, x.limit) / x.rate)
    // Reactions that use acid take no more than a tenth of the free H⁺ before the pH is re-solved,
    // or 0.1 µmol in a near-neutral liquid, whose hydrolysis holds far more than its free H⁺ (an
    // overshoot there corrects itself at the next solve, as the pH it reaches slows the reaction).
    const acidRate = steps.reduce((a, x) => a + (x.acid ? x.rate : 0), 0)
    if (acidRate > 0) span = Math.min(span, Math.max(1e-3, Math.max(0.1 * h * volumeL, 1e-7) / acidRate))
    span = Math.max(span, Math.min(dt - t, 1e-3))
    for (const x of steps) {
      const n = Math.min(x.limit, x.rate * span)
      if (n > 0) {
        x.apply(n)
        used[x.solid] = (used[x.solid] ?? 0) + n
      }
    }
    // The ionic model settles what the products did: pH, any solid formed, CO₂ bubbling out.
    ionicEquilibrate(cat, c, 1)
    t += span
  }
  for (const s of Object.keys(c.surfaceRef ?? {})) {
    const left = (c.solid[s] ?? 0) + c.layers.reduce((a, l) => a + (l.particles?.[s] ?? 0), 0)
    if (!(left > 1e-15)) delete c.surfaceRef![s]
  }
  return out
}

/** Remove a dissolved substance (a carrier whose ions deposited as metal, a catalyst's substrate), the volume shrinking by what it took up. */
function removeCarrier(cat: Catalogue, layers: Layer[], volumeL: number, carrier: string, mol: number): void {
  // Salts were taken apart into carriers when the ionic model engaged; take from the carrier itself.
  const dV = -(mol * molarMassG(cat, carrier)) / SOLUTE_G_PER_L
  for (const l of layers) {
    const share = l.volumeL / volumeL
    l.species[carrier] = Math.max(0, (l.species[carrier] ?? 0) - mol * share)
    l.volumeL = Math.max(0, l.volumeL + dV * share)
  }
}

/** Specific surface (m²/g) of spheres or flakes of a given size and density: what the catalogue's values come from. */
export function specificSurface(shape: 'sphere' | 'sheet', sizeM: number, densityGPerM3: number): number {
  return shape === 'sphere' ? 6 / (densityGPerM3 * sizeM) : 2 / (densityGPerM3 * sizeM)
}
