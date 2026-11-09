// Composition helpers: concentrations and amounts through substance facets (state model §11:
// conversions involving substance properties are done by the kernel, never by the UI).
import type { Catalogue } from '../catalogue/catalogue.ts'
import { parseValue, type Quantity } from '../units/quantity.ts'
import { DIMENSIONS, sameDim } from '../units/units.ts'
import { type Contents, type Layer, type LabelledComponent, meanLayer, liquidVolume } from './state.ts'

export class MaterialError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MaterialError'
  }
}

const molarMassCache = new WeakMap<Catalogue, Map<string, number | undefined>>()

/** Molar mass in g/mol (parsed once per catalogue). */
export function molarMass(cat: Catalogue, substance: string): number | undefined {
  let cache = molarMassCache.get(cat)
  if (!cache) molarMassCache.set(cat, (cache = new Map()))
  if (cache.has(substance)) return cache.get(substance)
  const text = cat.substances.get(substance)?.physical?.molarMass
  const g = text ? parseValue(text).si * 1000 : undefined
  cache.set(substance, g)
  return g
}

const AVOGADRO = 6.02214076e23

/** A concentration (molar, mass, or a count per volume such as {copies}/uL) as mol/L of `substance`. */
export function toMolPerL(cat: Catalogue, substance: string, conc: Quantity): number {
  if (sameDim(conc.dim, DIMENSIONS.molarConcentration)) return conc.si / 1000
  if (sameDim(conc.dim, DIMENSIONS.dimensionless)) {
    // A fraction of the pure liquid ("1 mol/mol" water). The solvent is implicit, so water adds nothing.
    if (cat.substances.get(substance)?.identity.class === 'solvent' && substance === 'core:water') return 0
    const density = cat.substances.get(substance)?.physical?.density
    const mm = molarMass(cat, substance)
    if (!density || !mm) throw new MaterialError(`"${substance}" needs a density and molar mass to be used as a pure liquid`)
    return (conc.si * parseValue(density).si) / mm
  }
  if (sameDim(conc.dim, DIMENSIONS.massConcentration)) {
    const mm = molarMass(cat, substance)
    if (!mm) throw new MaterialError(`"${substance}" has no molar mass, so a mass concentration cannot be converted`)
    return conc.si / mm
  }
  // Molecules per cubic metre: a thousand litres, then a mole of them.
  if (sameDim(conc.dim, DIMENSIONS.numberConcentration)) return conc.si / 1000 / AVOGADRO
  throw new MaterialError(`Not a concentration: ${JSON.stringify(conc)}`)
}

/** Mass concentration (g/L) from an amount in a volume. */
export function massConcentration(cat: Catalogue, substance: string, mol: number, volumeL: number): number {
  const mm = molarMass(cat, substance)
  if (!mm || volumeL <= 0) return 0
  return (mol * mm) / volumeL
}

/** A layer of `volumeL` with the given components. Components are { substance, conc }. */
export function layerFrom(cat: Catalogue, components: Array<{ substance: string; conc: Quantity }>, volumeL: number): Layer {
  const layer: Layer = { volumeL, species: {} }
  for (const c of components) {
    const mol = toMolPerL(cat, c.substance, c.conc) * volumeL
    if (mol > 0) layer.species[c.substance] = (layer.species[c.substance] ?? 0) + mol
  }
  return layer
}

/** The components of a catalogue preparation, as quantities. */
export function preparationComponents(cat: Catalogue, preparation: string): Array<{ substance: string; conc: Quantity; text: string }> {
  const prep = cat.preparations.get(preparation)
  if (!prep) throw new MaterialError(`Unknown preparation "${preparation}"`)
  return prep.components.map((c) => ({ substance: c.substance, conc: parseValue(c.conc), text: c.conc }))
}

export function labelledFrom(components: Array<{ substance: string; conc: Quantity; text: string }>): LabelledComponent[] {
  return components.map((c) => ({
    substance: c.substance,
    si: c.conc.si,
    basis: sameDim(c.conc.dim, DIMENSIONS.massConcentration) ? 'mass' : 'molar',
    text: c.text,
  }))
}

/** Mean molar concentration (mol/L) of a substance in a container's liquid. */
export function molarConc(contents: Contents, substance: string): number {
  const v = liquidVolume(contents)
  if (v <= 0) return 0
  return (meanLayer(contents).species[substance] ?? 0) / v
}

/** Total amount (mol) of a substance in liquid and solid. */
export function totalAmount(contents: Contents, substance: string): number {
  let n = contents.solid[substance] ?? 0
  for (const l of contents.layers) n += l.species[substance] ?? 0
  return n
}

/** Mass of the contents in kg: liquid at water's density plus dissolved and solid solutes. */
export function contentsMassKg(cat: Catalogue, contents: Contents): number {
  let g = liquidVolume(contents) * 1000 * WATER_G_PER_ML
  const add = (species: Record<string, number>, displaces: boolean) => {
    for (const [s, n] of Object.entries(species)) {
      const m = n * (molarMass(cat, s) ?? 0)
      // A solute takes up room in the solution, displacing water of its own volume.
      g += displaces ? m * (1 - (WATER_G_PER_ML * 1000) / soluteDensity(cat, s)) : m
    }
  }
  for (const l of contents.layers) {
    add(l.species, true)
    // Suspended solid counts its whole mass, like settled solid: the liquid's volume is its own.
    if (l.particles) add(l.particles, false)
  }
  add(contents.solid, false)
  if (contents.coating) add(contents.coating, false)
  return g / 1000
}

const WATER_G_PER_ML = 0.997

/** Density of a pure substance (g/L), for the volume it takes up in solution; 1500 g/L if unknown. */
export function soluteDensity(cat: Catalogue, s: string): number {
  const d = cat.substances.get(s)?.physical?.density
  return d ? parseValue(d).si : 1500
}
