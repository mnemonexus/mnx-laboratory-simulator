// Heat of reaction (contract thermochemistry, T2) by Hess's law: a liquid's chemical enthalpy is a
// state function, and whatever changes it releases or takes up the difference as heat.
//
//   H = Σ n × (standard enthalpy of formation of what each substance is made of)    (absolute)
//     + Σ species × (formation enthalpy of the species from its components)          (speciation)
//
// Ion carriers count their ions' standard enthalpies of formation (NBS tables, H⁺ = 0); species,
// complexes and solids count the ΔH of their formation from the carriers (PHREEQC's data); free
// hydroxide counts water's ionisation. Water is the solvent and is not counted: carriers stand for
// their acid or base less water, so a substance's formula may hold water beyond its carriers (a
// hydroxide one, a pentahydrate five), and a solid's enthalpy is its own less that water's. A layer
// the ionic model does not engage keeps the proton-transfer form: each proton on an acid site
// counts −ΔH_ion of that site (core data aligned with PHREEQC's protonation enthalpies), free
// hydroxide water's ionisation; a carrier whose ion holds protons the acid–base form does not
// (NH₄⁺ for ammonia) counts their ionisation, so both paths share one reference.
//
// Layers carry their enthalpy as they move and merge, so mixing releases the difference between
// what they carried and what the mixture holds (strong acid and base −55.8 kJ per mole of water;
// silver chloride precipitating −65 kJ/mol). Undissolved solids, suspended or settled, are outside
// the liquid's state: processes that move matter between them and the liquid (precipitation,
// dissolving, solids reacting, gas leaving) pass the change in the solids and the gas given off as
// `extraJ`, so settling, stirring up and pouring a suspension move no heat. Water a reaction forms
// (2H₂O₂ → 2H₂O + O₂) is passed the same way.
import type { Catalogue } from '../catalogue/catalogue.ts'
import type { Contents, Layer } from '../kernel/state.ts'
import { fractions, layerPH, layerSpeciation, pKw } from './acidbase.ts'
import { carriersOf } from './ionic.ts'
import { scientificNumerics, type EnthalpySystem } from './numerics.ts'
import { waterMol } from './distillation.ts'
import { parseValue } from '../units/index.ts'

/** Enthalpy of water's ionisation, J/mol. */
const WATER_ION_J = 55800
/** Standard enthalpy of formation of liquid water, J/mol. */
export const WATER_DHF_J = -285830
/** Heat capacity of the (aqueous) liquid, J per litre per kelvin. */
const CP_J_PER_L_K = 4184
/** The vessel and any solid hold heat too: never less than half a millilitre of water's worth (about 2 J/K). */
const MIN_HEAT_CAPACITY_L = 5e-4

function carrierEnthalpyJ(cat: Catalogue, s: string): number {
  let h = 0
  for (const [carrier, k] of Object.entries(carriersOf(cat, s))) h += k * (cat.substances.get(carrier)?.aqueous?.dHf ?? 0)
  return h * 1000
}

/**
 * A substance's enthalpy (J/mol) on the solvent-free reference: dissolved, as a solid (crystals, a
 * precipitate) or as a gas given off. Without data a solid counts as dissolved and a gas as an
 * element, so nothing that lacks data releases heat by changing state.
 */
export function substanceEnthalpyJ(cat: Catalogue, s: string, state: 'dissolved' | 'solid' | 'gas'): number {
  const def = cat.substances.get(s)
  if (!def) return 0
  const ionic = !!(def.aqueous || def.ions)
  if (state === 'gas') return def.solid?.phase === 'gas' && ionic ? carrierEnthalpyJ(cat, s) - (def.solid.dH ?? 0) * 1000 : 0
  if (state === 'solid') {
    if (def.thermo) return (def.thermo.dHf * 1000) - (def.thermo.water ?? 0) * WATER_DHF_J
    // A solid of the ionic model: its carriers less the enthalpy of dissolving into them.
    if (def.solid && ionic) return carrierEnthalpyJ(cat, s) - (def.solid.dH ?? 0) * 1000
  }
  if (ionic) return carrierEnthalpyJ(cat, s)
  if (!def.thermo) return 0
  let h = (def.thermo.dHf + (def.thermo.solution ?? 0)) * 1000 - (def.thermo.water ?? 0) * WATER_DHF_J
  // An acid–base solute's protons are reckoned from its fully deprotonated form: add back the
  // ionisation enthalpies of the sites the catalogued form holds (the highest pKa first).
  const ab = def.acidBase
  if (ab?.dH?.length) {
    const sites = ab.pKa.map((pKa, i) => ({ pKa, dH: ab.dH?.[i] ?? 0 })).sort((a, b) => b.pKa - a.pKa)
    const held = Math.max(0, Math.min(sites.length, sites.length - (ab.charge ?? 0) - (ab.spectator ?? 0)))
    for (let i = 0; i < held; i++) h += sites[i].dH * 1000
  }
  return h
}

/**
 * For an acid–base substance described by ion carriers: the ionisation enthalpy (J/mol) of the
 * protons its carriers' ions hold beyond the fully deprotonated form (NH₄⁺ holds ammonia's one),
 * which the ionic model counts from the ion and the proton-transfer form from the bare base.
 */
function carrierReferenceJ(cat: Catalogue, s: string): number {
  const def = cat.substances.get(s)
  const ab = def?.acidBase
  if (!ab?.dH?.length || !def?.ions) return 0
  let ionCharge = 0
  for (const [carrier, k] of Object.entries(def.ions)) ionCharge += k * (cat.substances.get(carrier)?.aqueous?.charge ?? 0)
  const n = ab.pKa.length
  const held = Math.round(ionCharge - ((ab.charge ?? 0) - n + (ab.spectator ?? 0)))
  if (!(held > 0)) return 0
  const sites = ab.pKa.map((pKa, i) => ({ pKa, dH: ab.dH?.[i] ?? 0 })).sort((a, b) => b.pKa - a.pKa)
  let h = 0
  for (let i = 0; i < Math.min(held, n); i++) h += sites[i].dH * 1000
  return h
}

/** The proton-transfer enthalpy of a layer without ion carriers (relative to every site deprotonated), J. */
function protonEnthalpy(cat: Catalogue, layer: Layer, temperatureK: number): number {
  const pH = layerPH(cat, layer, temperatureK)
  if (pH === undefined) return 0
  const rust = scientificNumerics()
  if (rust) {
    const systems: EnthalpySystem[] = []
    for (const [substance, moles] of Object.entries(layer.species)) {
      const ab = cat.substances.get(substance)?.acidBase
      if (!ab?.dH?.length || !(moles > 0)) continue
      systems.push({ moles, pKa: ab.pKa, ionisationJ: ab.pKa.map((_, index) => (ab.dH?.[index] ?? 0) * 1000) })
    }
    return rust.chemicalEnthalpy(systems, layer.volumeL, temperatureK, pH)
  }
  let h = WATER_ION_J * Math.pow(10, pH - pKw(temperatureK)) * layer.volumeL
  for (const [s, n] of Object.entries(layer.species)) {
    const ab = cat.substances.get(s)?.acidBase
    if (!ab?.dH?.length || !(n > 0)) continue
    const order = ab.pKa.map((pKa, i) => ({ pKa, dH: (ab.dH?.[i] ?? 0) * 1000 })).sort((a, b) => a.pKa - b.pKa)
    const a = fractions(order.map((x) => x.pKa), pH)
    // Site i (in order of pKa) holds its proton in every form that has lost fewer than i + 1.
    let held = 0
    order.forEach((site, i) => {
      held = 0
      for (let j = 0; j <= i; j++) held += a[j]
      h += n * held * -site.dH
    })
  }
  return h
}

/** A layer's chemical enthalpy at equilibrium, J. */
export function equilibriumEnthalpy(cat: Catalogue, layer: Layer, temperatureK: number): number {
  if (layer.volumeL <= 0) return 0
  let absolute = 0
  for (const [s, n] of Object.entries(layer.species)) if (n > 0) absolute += n * substanceEnthalpyJ(cat, s, 'dissolved')
  const ionic = layerSpeciation(cat, layer, temperatureK).ionic
  if (ionic) {
    let speciation = 0
    for (const sp of ionic.species) speciation += sp.conc * (sp.dH ?? 0)
    return absolute + speciation * 1000 * layer.volumeL
  }
  let reference = 0
  for (const [s, n] of Object.entries(layer.species)) if (n > 0) reference += n * carrierReferenceJ(cat, s)
  return absolute + reference + protonEnthalpy(cat, layer, temperatureK)
}

/** The enthalpy of the undissolved solids (settled and suspended) and of gas given off but not yet gone, J. */
export function settledEnthalpyJ(cat: Catalogue, c: Contents): number {
  let h = 0
  for (const [s, n] of Object.entries(c.solid)) if (n > 0) h += n * substanceEnthalpyJ(cat, s, 'solid')
  for (const l of c.layers) for (const [s, n] of Object.entries(l.particles ?? {})) if (n > 0) h += n * substanceEnthalpyJ(cat, s, 'solid')
  for (const [s, n] of Object.entries(c.evolved ?? {})) if (n > 0) h += n * substanceEnthalpyJ(cat, s, 'gas')
  return h
}

/**
 * What the contents hold per kelvin (J/K): an aqueous liquid as water (4.184 J per mL per K); a
 * liquid that is mostly something else (molten stearic acid) by its own specific heat; and solids
 * that declare one (a metal block, ice). Never less than half a millilitre of water's worth.
 */
export function heatCapacityJK(cat: Catalogue, c: Contents): number {
  let j = 0
  for (const l of c.layers) {
    if (!(l.volumeL > 0)) continue
    const waterL = waterMol(cat, l) * 0.018015
    const declared = Object.entries(l.species).filter(([s, n]) => n > 0 && cat.substances.get(s)?.physical?.specificHeat)
    // Mostly water, or nothing in it declares its own: counted as water, as before.
    if (waterL >= 0.5 * l.volumeL || !declared.length) j += CP_J_PER_L_K * l.volumeL
    else {
      j += CP_J_PER_L_K * waterL
      for (const [s, n] of declared) j += n * grams(cat, s) * cat.substances.get(s)!.physical!.specificHeat!
    }
  }
  for (const [s, n] of Object.entries(c.solid)) {
    const cp = cat.substances.get(s)?.physical?.specificHeat
    if (cp && n > 0) j += n * grams(cat, s) * cp
  }
  return Math.max(j, CP_J_PER_L_K * MIN_HEAT_CAPACITY_L)
}

/** Grams per mole. */
function grams(cat: Catalogue, s: string): number {
  const mm = cat.substances.get(s)?.physical?.molarMass
  return mm ? parseValue(mm).si * 1000 : 0
}

/**
 * Release the heat of whatever happened since the liquid was last at equilibrium: each layer's
 * carried enthalpy is compared with what it holds now, plus `extraJ` from outside the liquid
 * (solids used up or formed, gas given off, water formed), and the difference warms the contents.
 */
export function releaseHeat(cat: Catalogue, c: Contents, extraJ = 0): number {
  let q = extraJ
  let volume = 0
  for (const l of c.layers) {
    if (l.volumeL <= 0) continue
    volume += l.volumeL
    const eq = equilibriumEnthalpy(cat, l, c.temperatureK)
    if (l.enthalpyJ !== undefined) q += l.enthalpyJ - eq
    l.enthalpyJ = eq
  }
  if (volume > 0 && q !== 0) c.temperatureK += q / heatCapacityJK(cat, c)
  return q
}

/** Take a layer's present state as its equilibrium without releasing heat (after other chemistry changed it). */
export function resyncEnthalpy(cat: Catalogue, layer: Layer, temperatureK: number): void {
  layer.enthalpyJ = equilibriumEnthalpy(cat, layer, temperatureK)
}
