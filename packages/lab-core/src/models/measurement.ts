// Measurement models: state → signal (master-plan/04 §5–§6; scientific simulation §3.2).
// Raw values stay raw: instruments never subtract blanks or correct anything automatically.
import type { Catalogue } from '../catalogue/catalogue.ts'
import type { SubstanceDef } from '../catalogue/types.ts'
import { contentsMassKg } from '../kernel/materials.ts'
import { type Container, liquidVolume, meanLayer } from '../kernel/state.ts'
import type { Rng } from '../rng/rng.ts'
import { parseValue } from '../units/quantity.ts'
import { layerAbsorptivity, layerSpeciation } from './acidbase.ts'
import { colourName, colourOfAbsorbance, srgbToLinear, WAVELENGTHS, withScattering } from './colour.ts'

/**
 * A protein's near-UV band relative to its ε280 (tryptophan and tyrosine): a peak at 280 nm,
 * nothing above about 310 nm. Below 240 nm the peptide bond takes over, which is not modelled.
 */
const PROTEIN_UV: ReadonlyArray<readonly [number, number]> = [[240, 0.4], [250, 0.35], [260, 0.55], [270, 0.85], [280, 1], [290, 0.6], [300, 0.1], [310, 0.02], [320, 0]]

/** Molar absorption coefficient (L mol⁻¹ cm⁻¹) at a wavelength, interpolated; 0 outside the table. */
export function epsilon(cat: Catalogue, substance: string, nm: number): number {
  const sub = cat.substances.get(substance)
  const table = sub?.optics?.epsilon ?? (sub?.protein?.epsilon280 ? PROTEIN_UV.map(([x, f]) => [x, f * sub.protein!.epsilon280!] as [number, number]) : undefined)
  if (!table || table.length === 0) return 0
  const pts = [...table].sort((a, b) => a[0] - b[0])
  if (nm < pts[0][0] || nm > pts[pts.length - 1][0]) return 0
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i]
    const [x1, y1] = pts[i + 1]
    if (nm >= x0 && nm <= x1) return x1 === x0 ? y0 : y0 + ((y1 - y0) * (nm - x0)) / (x1 - x0)
  }
  return pts[pts.length - 1][1]
}

/**
 * The vessel's own absorbance (plate bottom, cuvette walls) by material. Polystyrene is opaque
 * below about 300 nm (so UV work needs quartz or UV-transparent plastic).
 */
export function vesselAbsorbance(material: string | undefined, nm: number): number {
  switch (material) {
    case 'quartz':
      return 0.02
    case 'glass':
      return nm < 320 ? 3.5 : 0.03
    case 'polystyrene':
    default:
      if (nm < 300) return 3.5
      if (nm < 340) return 3.5 - ((nm - 300) / 40) * (3.5 - 0.06)
      return 0.045
  }
}

/** True absorbance of a container's liquid at `nm` along a beam of `pathCm` (cuvettes). */
export function sampleAbsorbance(cat: Catalogue, c: Container, nm: number, pathCm: number): number {
  const v = liquidVolume(c.contents)
  if (v <= 0) return 0
  const mean = meanLayer(c.contents)
  const sp = layerSpeciation(cat, mean, c.contents.temperatureK)
  const base = (s: string, w: number) => epsilon(cat, s, w)
  let a = layerAbsorptivity(cat, sp, v, nm, base) * pathCm
  // Cells scatter light: apparent absorbance from their number per mL (living or dead).
  for (const [key, p] of Object.entries(mean.populations ?? {})) a += odPerCell(cat, key, nm) * (p.count / (v * 1000)) * pathCm
  // So do colloids (milk's casein, colloidal sulfur).
  return a + colloidDepth(cat, mean.species, v, nm) * pathCm
}

/** Optical depth per cm of the colloids in a liquid (their `optics.turbidity` by mass), scattering as 1/λ. */
export function colloidDepth(cat: Catalogue, species: Record<string, number>, volumeL: number, nm: number): number {
  if (!(volumeL > 0)) return 0
  let tau = 0
  for (const [s, n] of Object.entries(species)) {
    const t = n > 0 ? cat.substances.get(s)?.optics?.turbidity : undefined
    if (t) tau += t * ((n * (molarMassOf(cat, s) ?? 0) * 1000) / (volumeL * 1000))
  }
  return tau * (600 / nm)
}

/** Turbidity per (cell/mL) over 1 cm at a wavelength: the organism's own, or by kind; scattering falls as 1/λ. */
export function odPerCell(cat: Catalogue, strain: string, nm: number): number {
  const o = cat.substances.get(strain.split('+')[0])?.organism
  const at600 = o?.od600PerCell ?? (o?.morphology === 'yeast' ? 3.3e-8 : o ? 1.25e-9 : 0)
  return at600 * (600 / nm)
}

/**
 * Plate wells are read with a vertical beam: path = V / area, so A = Σ ε · n / area and the
 * well's volume cancels (but not its amount). Layering does not matter for a vertical beam.
 */
export function wellAbsorbance(cat: Catalogue, c: Container, nm: number): number {
  const areaCm2 = (c.areaM2 ?? 3.2e-5) * 1e4
  const mean = meanLayer(c.contents)
  const sp = layerSpeciation(cat, mean, c.contents.temperatureK)
  const base = (s: string, w: number) => epsilon(cat, s, w)
  let a = (layerAbsorptivity(cat, sp, mean.volumeL, nm, base) * mean.volumeL * 1000) / areaCm2
  // Cells per cm² of the beam's cross-section, whatever the volume.
  for (const [key, p] of Object.entries(mean.populations ?? {})) a += (odPerCell(cat, key, nm) * p.count) / areaCm2
  a += (colloidDepth(cat, mean.species, mean.volumeL, nm) * mean.volumeL * 1000) / areaCm2
  return a
}

export interface PhotometerSpec {
  strayLight: number
  maxReading: number
  noise: number
  noiseRelative: number
  readability: number
  wavelengthMin: number
  wavelengthMax: number
}

export function photometerSpec(cat: Catalogue, equipment: string): PhotometerSpec {
  const prop = (name: string) => cat.property(equipment, name)
  const q = (name: string, fallback: string) => parseValue(String(prop(name) ?? fallback))
  return {
    strayLight: Number(prop('strayLight') ?? 0.001),
    maxReading: q('maxReading', '3.0 AU').si,
    noise: q('noise', '0.003 AU').si,
    noiseRelative: Number(prop('noiseRelative') ?? 0.005),
    readability: q('readability', '0.001 AU').si,
    wavelengthMin: q('wavelengthMin', '325 nm').si * 1e9,
    wavelengthMax: q('wavelengthMax', '1000 nm').si * 1e9,
  }
}

export interface Reading {
  value: number
  display: string
  flags: Array<'saturated' | 'insufficient-volume'>
}

/** What a photometer reports for a true absorbance: stray light, noise, readability, over-range. */
export function observeAbsorbance(trueA: number, spec: PhotometerSpec, rng: Rng, noiseScale: number): Reading {
  const s = spec.strayLight
  const transmitted = Math.pow(10, -trueA)
  let a = -Math.log10((transmitted + s) / (1 + s))
  a += rng.normal(0, spec.noise * noiseScale) + rng.normal(0, spec.noiseRelative * noiseScale * Math.abs(a))
  const value = Math.round(a / spec.readability) * spec.readability
  const decimals = Math.max(0, Math.round(-Math.log10(spec.readability)))
  if (a > spec.maxReading) return { value: Number(value.toFixed(decimals)), display: 'OVER', flags: ['saturated'] }
  return { value: Number(value.toFixed(decimals)), display: value.toFixed(decimals), flags: [] }
}

export interface BalanceSpec {
  readability: number
  repeatability: number
  capacity: number
}

export function balanceSpec(cat: Catalogue, equipment: string): BalanceSpec {
  const q = (name: string, fallback: string) => parseValue(String(cat.property(equipment, name) ?? fallback)).si
  return { readability: q('readability', '0.01 g'), repeatability: q('repeatability', '0.01 g'), capacity: q('capacity', '600 g') }
}

/** Mass on a balance pan in kg: the containers' own mass plus their contents. */
export function loadKg(cat: Catalogue, containers: Container[]): number {
  let kg = 0
  for (const c of containers) {
    kg += c.tareMassKg
    kg += contentsMassKg(cat, c.contents)
  }
  return kg
}

export function observeMass(netKg: number, spec: BalanceSpec, rng: Rng, noiseScale: number): Reading {
  const m = netKg + rng.normal(0, spec.repeatability * noiseScale)
  const value = Math.round(m / spec.readability) * spec.readability
  const decimals = Math.max(0, Math.round(-Math.log10(spec.readability * 1000)))
  const grams = value * 1000
  if (netKg > spec.capacity) return { value: grams, display: 'OVER', flags: ['saturated'] }
  return { value: Number(grams.toFixed(decimals)), display: `${grams.toFixed(decimals)} g`, flags: [] }
}

/**
 * The colour a liquid shows through about a centimetre (a tube held to the light): its transmitted
 * light averaged over the blue (400–490 nm), green (490–580 nm) and red (580–700 nm) bands, named
 * by which bands get through and how much the darkest is cut; one that lets little of any band
 * through (two dyes of complementary colours together) looks brown. Undefined when it is colourless.
 */
export function perceivedColour(cat: Catalogue, c: Container, pathCm = 1): string | undefined {
  if (liquidVolume(c.contents) <= 0) return undefined
  const band = (lo: number, hi: number) => {
    let t = 0
    let n = 0
    // The liquid's own colour: a colloid's cloudiness is described apart, not seen as darkening.
    const v = liquidVolume(c.contents)
    const species = meanLayer(c.contents).species
    for (let nm = lo; nm <= hi; nm += 10, n++) t += Math.pow(10, -(sampleAbsorbance(cat, c, nm, pathCm) - colloidDepth(cat, species, v, nm) * pathCm))
    return t / n
  }
  const [r, g, b] = [band(580, 700), band(490, 580), band(400, 490)]
  const darkest = Math.min(r, g, b)
  if (darkest > 0.85) return undefined
  const top = Math.max(r, g, b)
  const [R, G, B] = [r / top, g / top, b / top]
  // Bands within a few per cent of the brightest count as brightest too.
  const TIE = 0.97
  // Red and blue through, green cut most but not below half (a faint pink, cobalt chloride turning
  // blue): too subtle for the bands, so the hue is the observer's, from the whole spectrum.
  const magenta = () => {
    const species = meanLayer(c.contents).species
    const v = liquidVolume(c.contents)
    const rgb = colourOfAbsorbance(WAVELENGTHS.map((nm) => sampleAbsorbance(cat, c, nm, pathCm) - colloidDepth(cat, species, v, nm) * pathCm))
    const name = colourName(rgb, 'liquid').replace(/^(very pale|pale|deep) /, '')
    return ['pink', 'purple', 'violet', 'red'].includes(name) ? name : 'pink'
  }
  let hue: string
  // Almost no light through: named by what little gets out, blue-black (starch–iodine), dark green
  // (chromium(III)), or else dark brown.
  if (top < 0.3) hue = B >= TIE && R < 0.5 ? 'blue-black' : G >= TIE && R < 0.7 ? 'dark green' : 'brown'
  else if (R >= TIE) hue = G >= TIE ? (B >= TIE ? 'grey' : 'yellow') : B >= 0.5 && G < 0.5 ? (B > 0.75 ? 'purple' : 'pink') : B > G ? magenta() : G >= 0.75 ? 'yellow' : G >= 0.4 ? 'orange' : 'red'
  else if (G >= TIE) hue = B >= 0.75 ? 'blue-green' : R >= 0.75 ? 'yellow-green' : 'green'
  else hue = G >= 0.75 ? 'blue-green' : R >= 0.6 ? 'violet' : 'blue'
  const shade = hue === 'brown' ? 'dark ' : hue === 'blue-black' || hue === 'dark green' ? '' : darkest > 0.5 ? 'pale ' : darkest < 0.1 ? 'deep ' : ''
  return shade + hue
}

/** A solid outside the ionic model that comes out of solution as a coloured precipitate (its solubility and look). */
export function isPrecipitate(def: SubstanceDef): boolean {
  return !def.solid && !!def.solubility?.precipitate && !!def.look?.rgb
}

/** Scattering by suspended solid: optical depth per (mg/mL × cm). A precipitate of 1 mg/mL is milky over a test tube. */
const SCATTER_PER_MG_ML_CM = 2.0

export interface Appearance {
  /** What the eye sees through the vessel: display sRGB, 0–1. */
  rgb: [number, number, number]
  /** The liquid's own colour without suspended matter, and its name. */
  liquid: [number, number, number]
  liquidName: string
  /** How much suspended matter hides the light (0 clear – 1 opaque). */
  opacity: number
  /** Suspended and settled ionic solid: its body colour, name, look and amount. */
  precipitate?: { rgb: [number, number, number]; name: string; look?: string; suspendedMg: number; settledMg: number }
  /** Everything lying on the bottom (precipitate, a deposit, ribbon, chips): its colour and bulk volume. */
  sediment?: { rgb: [number, number, number]; volumeMl: number }
  /** How much a colloid (milk's casein, colloidal sulfur) clouds the liquid (0 clear – 1 opaque), and its colour. */
  colloidOpacity?: number
  colloidName?: string
}

/**
 * What a container looks like (appearance contract, T2 from optics): daylight through the liquid
 * along `pathCm` (its full absorption spectrum, by CIE colour matching), clouded by suspended
 * precipitate and cells, which scatter their own body colour back. For the 3D bench and for
 * observations.
 */
export function appearance(cat: Catalogue, c: Container, pathCm = 1.5): Appearance | undefined {
  const v = liquidVolume(c.contents)
  if (!(v > 0)) return undefined
  const mean = meanLayer(c.contents)
  const sp = layerSpeciation(cat, mean, c.contents.temperatureK)
  const base = (s: string, w: number) => epsilon(cat, s, w)
  const absorbance = WAVELENGTHS.map((nm) => layerAbsorptivity(cat, sp, v, nm, base) * pathCm)
  const liquid = colourOfAbsorbance(absorbance)
  // Suspended and settled ionic solid, by mass, its colour mixed as pigments mix (Kubelka–Munk).
  let suspendedMg = 0
  let settledMg = 0
  const body = [0, 0, 0]
  let look: string | undefined
  let biggest = 0
  const addSolid = (s: string, mol: number, suspended: boolean) => {
    const def = cat.substances.get(s)
    if (!def || !(mol > 0)) return
    // An ionic solid, or one a reaction throws out of solution (copper(I) oxide from Benedict's).
    const shown = def.solid ?? (isPrecipitate(def) ? { rgb: def.look!.rgb, look: def.look!.description } : undefined)
    if (!shown) return
    const mg = mol * (molarMassOf(cat, s) ?? 100) * 1000
    if (suspended) suspendedMg += mg
    else settledMg += mg
    const lin = srgbToLinear(shown.rgb ?? [0.95, 0.95, 0.95])
    for (let i = 0; i < 3; i++) body[i] += kubelkaMunk(lin[i]) * mg
    if (mg > biggest) {
      biggest = mg
      look = shown.look
    }
  }
  for (const l of c.contents.layers) for (const [s, n] of Object.entries(l.particles ?? {})) addSolid(s, n, true)
  for (const [s, n] of Object.entries(c.contents.solid)) addSolid(s, n, false)
  // Cells scatter too (an OD600 of 1 is about as cloudy as 0.4 mg/mL of precipitate), whitish.
  let cellOD = 0
  for (const [key, p] of Object.entries(mean.populations ?? {})) cellOD += odPerCell(cat, key, 600) * (p.count / (v * 1000))
  const totalMg = suspendedMg + settledMg
  const precipitate = totalMg > 0 ? (() => {
    const lin = body.map((x) => reflectanceOf(x / totalMg)) as [number, number, number]
    const rgb = xyzToSrgbFromLinear(lin)
    return { rgb, name: colourName(rgb, 'solid'), ...(look ? { look } : {}), suspendedMg, settledMg }
  })() : undefined
  // Colloids scatter their own body colour (white casein, pale yellow sulfur).
  const colloidTau = colloidDepth(cat, mean.species, v, 550) * pathCm
  let colloidBody: [number, number, number] | undefined
  if (colloidTau > 0) {
    let w = 0
    const sum = [0, 0, 0]
    for (const [s, n] of Object.entries(mean.species)) {
      const def = n > 0 ? cat.substances.get(s) : undefined
      if (!def?.optics?.turbidity) continue
      const weight = def.optics.turbidity * n * (molarMassOf(cat, s) ?? 0)
      const lin = srgbToLinear(def.look?.rgb ?? [0.95, 0.95, 0.93])
      for (let i = 0; i < 3; i++) sum[i] += lin[i] * weight
      w += weight
    }
    colloidBody = xyzToSrgbFromLinear(sum.map((x) => x / w) as [number, number, number])
  }
  const tau = SCATTER_PER_MG_ML_CM * (suspendedMg / (v * 1000)) * pathCm + 0.8 * cellOD * pathCm + colloidTau
  const opacity = 1 - Math.exp(-tau)
  const scatterBody = precipitate && suspendedMg > 0 ? precipitate.rgb : (colloidBody ?? ([0.93, 0.92, 0.88] as [number, number, number]))
  const rgb = opacity > 0.001 ? withScattering(liquid, scatterBody, opacity) : liquid
  const sediment = sedimentOf(cat, c)
  return { rgb, liquid, liquidName: colourName(liquid, 'liquid'), opacity, ...(precipitate ? { precipitate } : {}), ...(sediment ? { sediment } : {}), ...(colloidTau > 0 && colloidBody ? { colloidOpacity: 1 - Math.exp(-colloidTau), colloidName: colourName(colloidBody, 'solid') } : {}) }
}

/**
 * The share of a settled solid's bulk that is solid: gelatinous hydroxide flocs hold most of their
 * volume as water (about 2 % solid), curdy silver halides about a quarter, grains and pieces
 * about half or more.
 */
function packing(look: string | undefined): number {
  return /gelatinous/.test(look ?? '') ? 0.02 : /curdy/.test(look ?? '') ? 0.25 : 0.55
}

/** What lies on the bottom, by mass-weighted colour (in linear light) and bulk volume. */
function sedimentOf(cat: Catalogue, c: Container): Appearance['sediment'] {
  let volumeMl = 0
  let mass = 0
  const body = [0, 0, 0]
  for (const [s, n] of Object.entries(c.contents.solid)) {
    const def = cat.substances.get(s)
    const colour = def?.solid?.rgb ?? def?.look?.rgb
    if (!(n > 0) || !colour) continue
    const g = n * (molarMassOf(cat, s) ?? 100)
    const density = def?.physical?.density ? parseValue(def.physical.density).si / 1000 : 2.5
    volumeMl += g / density / packing(def?.solid?.look ?? def?.look?.description)
    mass += g
    const lin = srgbToLinear(colour)
    for (let i = 0; i < 3; i++) body[i] += lin[i] * g
  }
  if (!(mass > 0)) return undefined
  return { rgb: xyzToSrgbFromLinear(body.map((x) => x / mass) as [number, number, number]), volumeMl }
}

/**
 * Kubelka–Munk: a solid's absorption-to-scattering ratio K/S from its reflectance (linear, one
 * channel), and back. Mixtures of solids that scatter alike add their K/S by amount, so a little of
 * a strongly coloured solid (silver chromate) tints a white one (silver chloride) as a drop of red
 * paint tints white paint, which mixing reflectances by mass would hide.
 */
function kubelkaMunk(reflectance: number): number {
  const r = Math.min(0.999, Math.max(0.001, reflectance))
  return (1 - r) ** 2 / (2 * r)
}
function reflectanceOf(ks: number): number {
  return 1 + ks - Math.sqrt(ks * ks + 2 * ks)
}

function molarMassOf(cat: Catalogue, s: string): number | undefined {
  const mm = cat.substances.get(s)?.physical?.molarMass
  return mm ? parseValue(mm).si * 1000 : undefined
}

/** Display sRGB of a linear-light colour. */
function xyzToSrgbFromLinear(lin: readonly [number, number, number]): [number, number, number] {
  const e = (v: number) => {
    const x = Math.max(0, Math.min(1, v))
    return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055
  }
  return [e(lin[0]), e(lin[1]), e(lin[2])]
}
