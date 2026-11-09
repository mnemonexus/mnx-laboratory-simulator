// Process models integrated over simulated time (scientific simulation §3; master-plan/04 §4).
// Each runs on one liquid layer at a time (a layer is a well-mixed sub-volume), so stratified
// containers react layer by layer and diffusion mixes them separately.
import type { Catalogue } from '../catalogue/catalogue.ts'
import type { ModelDecl, SubstanceDef } from '../catalogue/types.ts'
import { molarMass } from '../kernel/materials.ts'
import { activeAmount, type Container, type Contents, type Layer, liquidVolume, type Place, relaxLayers, type World } from '../kernel/state.ts'
import { equilibrate, hasLimited } from './solubility.ts'
import { growLayer, growSurface, moistureFactor, strainDna, strainProteins } from './growth.ts'
import { digest } from './digestion.ts'
import { layerPH, pKw } from './acidbase.ts'
import { bindingCapacity, surfaceStep } from './binding.ts'
import { blotStep } from './blot.ts'
import { releaseHeat, resyncEnthalpy, settledEnthalpyJ, substanceEnthalpyJ, WATER_DHF_J } from './thermochem.ts'
import { settle } from './contamination.ts'
import { lyseCells } from './pcr.ts'
import { updateGel } from './gelling.ts'
import { viscosityMPaS } from './viscosity.ts'
import { parseValue } from '../units/quantity.ts'
import { boilingK, molarVolume, vapourAfter, vleFor, WATER_MOLAR_L, waterMol } from './distillation.ts'
import { mainSolvent, twoPhase } from './phases.ts'
import { gasStep, OXYGEN, bubbleUptake, routeGas } from './gases.ts'
import { takeUpGas } from './ionic.ts'
import { hasSurfaceReactions, reactAtSurfaces } from './surface.ts'
import { tissueStep } from './tissue.ts'
import { canChangePhase, phaseChange } from './phasechange.ts'
import { transpire } from './transpiration.ts'
import { canCorrode, corrode } from './corrosion.ts'
import { respire } from './respiration.ts'
import { breed } from './genetics.ts'
import { wander } from './behaviour.ts'
import { functionalGroupReactions } from './organic.ts'
import { distilStep } from './stillhead.ts'

const K0 = 273.15
const LN2 = Math.LN2

/** Fixed internal step for integration (master-plan/03 §5). */
export const STEP_S = 5

/** Boiling point of water, taken for any liquid without other data; no boiling-point elevation. */
const BOILING_K = 373.15
/** Below this share of water (by volume) a liquid has no pH to speak of, so no hydroxide to react with. */
const MIN_WATER_FOR_HYDROXIDE = 0.2
/** Water itself as a reactant or product: the implicit solvent, counted from the layer's volume. */
const WATER = 'core:water'
/** Solvent boiled off per kelvin that the heater is above the boiling point (L/s/K). */
const BOIL_OFF_L_PER_S_PER_K = 0.5e-6
/** Time constant for solid to dissolve in a liquid that is not stirred (s). */
const UNSTIRRED_DISSOLVE_S = 120

/**
 * Remove solvent: solutes stay behind in less liquid; with no liquid left they are solid. The
 * solvent is implicit, so this is the one place where it leaves.
 */
export function evaporate(contents: Contents, volumeL: number): void {
  const v = liquidVolume(contents)
  if (volumeL <= 0 || v <= 0) return
  if (volumeL >= v) {
    for (const l of contents.layers) for (const [s, n] of Object.entries(l.species)) if (n > 0) contents.solid[s] = (contents.solid[s] ?? 0) + n
    contents.layers = []
    return
  }
  const keep = 1 - volumeL / v
  for (const l of contents.layers) l.volumeL *= keep
}

// ---- Parameters read from the catalogue, cached per catalogue ----

interface ColourModel {
  id: string
  trigger: string[]
  product: string
  /** The reagent species the coloured product forms from (Cu(II) for BCA, free dye for Bradford). */
  reagent: string
  assay: string
  /** Half-saturation, g/L of BSA-equivalent protein in the reaction mixture. */
  halfSaturationGPerL: number
  /** First-order rate at 37 °C, per second. */
  rate37: number
  q10: number
}

interface StabilityModel {
  /** Reference points: [1/T, ln k]. */
  points: Array<[number, number]>
  tmK?: number
  protein: boolean
}

interface EnzymeModel {
  substrates: string[]
  products: string[]
  yields: Record<string, number>
  /** Whether its reaction changes the enthalpy (a substrate or product with thermal data, or water formed). */
  thermal: boolean
  kcat: number
  km: Record<string, number>
  inhibitors: Array<{ substance: string; type: string; ki: number; alpha: number }>
  pHActivity?: { acidPKa: number; basePKa: number }
  alternatives: Array<{ substrates: string[]; products: string[]; yields: Record<string, number>; kcat: number; km: Record<string, number> }>
  /** Light-driven: half-saturating light and the action of each filter colour. */
  light?: { half: number; action: Record<string, number> }
  inactivators: Array<{ substance: string; kinact: number; ki: number }>
}

export interface Reaction {
  id: string
  reactants: Array<[string, number]>
  products: Array<[string, number]>
  orders: Array<[string, number]>
  /** Undissolved reactants in excess (a metal powder): suspended or settled amount per litre of liquid. */
  heterogeneous: string[]
  /** Order in hydroxide ion (from the pH), 0 if none. */
  hydroxide: number
  /** Order in hydrogen ion (from the pH), 0 if none: an acid-catalysed or acid-consuming reaction. */
  acid: number
  k: number
  atK: number
  eaJPerMol: number
}

export interface ProcessParams {
  colour: ColourModel[]
  reactions: Reaction[]
  stability: Map<string, StabilityModel>
  enzymes: Map<string, EnzymeModel>
  diffusionTimeAt1mL: number
  /** Substances that are leafy shoots, losing water to the air. */
  transpiring: Set<string>
  /** Substances that are respiring organisms (seeds, woodlice). */
  respiring: Set<string>
  /** No liquid boils below this: the lowest boiling point the catalogue knows (vapour–liquid tables included). */
  lowestBoilingK: number
}

const cache = new WeakMap<Catalogue, ProcessParams>()

export function processParams(cat: Catalogue): ProcessParams {
  const hit = cache.get(cat)
  if (hit) return hit
  const colour: ColourModel[] = []
  const reactions: Reaction[] = []
  let diffusionTimeAt1mL = 1800
  for (const m of cat.models.values()) {
    if (m.contract === 'colour-development' && m.kind === 'process') colour.push(colourModel(m))
    if (m.contract === 'kinetics.mass-action' && m.reaction) {
      const r = m.reaction
      reactions.push({
        id: m.id,
        reactants: Object.entries(r.reactants),
        products: Object.entries(r.products),
        orders: Object.entries(r.orders ?? r.reactants),
        heterogeneous: r.heterogeneous ?? [],
        hydroxide: r.hydroxide ?? 0,
        acid: r.acid ?? 0,
        k: r.k,
        atK: r.at ? parseValue(r.at).si : 298.15,
        eaJPerMol: r.ea ? parseValue(r.ea).si : 0,
      })
    }
    if (m.contract === 'mixing' && m.params?.diffusionTimeAt1mL) diffusionTimeAt1mL = parseValue(String(m.params.diffusionTimeAt1mL)).si
  }
  // Functional-group classes (esterification, oxidation, acylation …) for each compound they name.
  reactions.push(...functionalGroupReactions(cat))
  const stability = new Map<string, StabilityModel>()
  const enzymes = new Map<string, EnzymeModel>()
  let lowestBoilingK = BOILING_K
  for (const m of cat.models.values()) for (const t of m.vle?.T ?? []) lowestBoilingK = Math.min(lowestBoilingK, t + 273.15)
  for (const s of cat.substances.values()) {
    // Only a solvent that can stand as a layer of its own boils at its own boiling point here (layerBoilingK).
    if (s.physical?.boilingPoint && s.physical.immiscible) lowestBoilingK = Math.min(lowestBoilingK, parseValue(s.physical.boilingPoint).si)
    const st = stabilityModel(s)
    if (st) stability.set(s.id, st)
    if (s.enzyme) {
      enzymes.set(s.id, {
        substrates: s.enzyme.substrates,
        products: s.enzyme.products,
        yields: s.enzyme.yields ?? {},
        thermal: [...s.enzyme.substrates, ...s.enzyme.products].some((x) => x === WATER || !!cat.substances.get(x)?.thermo),
        kcat: parseValue(s.enzyme.kcat).si,
        km: Object.fromEntries(Object.entries(s.enzyme.km).map(([k, v]) => [k, parseValue(v).si / 1000])),
        inhibitors: Object.entries(s.enzyme.inhibitors ?? {}).map(([substance, i]) => ({
          substance,
          type: i.type,
          ki: parseValue(i.ki).si / 1000,
          alpha: i.alpha ?? 1,
        })),
        ...(s.enzyme.pHActivity ? { pHActivity: s.enzyme.pHActivity } : {}),
        alternatives: (s.enzyme.alternatives ?? []).map((a) => ({
          substrates: a.substrates,
          products: a.products,
          yields: a.yields ?? {},
          kcat: parseValue(a.kcat).si,
          km: Object.fromEntries(Object.entries(a.km).map(([k, v]) => [k, parseValue(v).si / 1000])),
        })),
        inactivators: Object.entries(s.enzyme.inactivators ?? {}).map(([substance, i]) => ({ substance, kinact: parseValue(i.kinact).si, ki: parseValue(i.ki).si / 1000 })),
        ...(s.enzyme.light ? { light: { half: s.enzyme.light.half, action: s.enzyme.light.action ?? {} } } : {}),
      })
    }
  }
  const transpiring = new Set([...cat.substances.values()].filter((s) => s.transpiration).map((s) => s.id))
  const respiring = new Set([...cat.substances.values()].filter((s) => s.respiration).map((s) => s.id))
  const out = { colour, reactions, stability, enzymes, diffusionTimeAt1mL, transpiring, respiring, lowestBoilingK }
  cache.set(cat, out)
  return out
}

function colourModel(m: ModelDecl): ColourModel {
  const p = m.params ?? {}
  return {
    id: m.id,
    trigger: m.trigger ?? [],
    product: String(p.product),
    reagent: String(p.reagent ?? p.copper),
    assay: String(p.assay ?? 'bca'),
    halfSaturationGPerL: parseValue(String(p.halfSaturation ?? '1.2 mg/mL')).si,
    rate37: parseValue(String(p.rate37 ?? '0.1 /min')).si,
    q10: Number(p.q10 ?? 2.5),
  }
}

function stabilityModel(s: SubstanceDef): StabilityModel | undefined {
  const st = s.stability
  if (!st) return undefined
  const points: Array<[number, number]> = []
  const add = (celsius: number, text?: string) => {
    if (!text) return
    const t = parseValue(text).si
    if (t > 0) points.push([1 / (celsius + K0), Math.log(LN2 / t)])
  }
  add(4, st.halfLife4)
  add(25, st.halfLife25)
  add(37, st.halfLife37)
  if (points.length === 0) return undefined
  points.sort((a, b) => a[0] - b[0])
  return {
    points,
    tmK: st.tm ? parseValue(st.tm).si : undefined,
    protein: s.identity.class === 'protein' || s.identity.class === 'enzyme',
  }
}

/** First-order loss rate (1/s) at temperature T: ln k linear in 1/T between the declared points. */
export function decayRate(model: StabilityModel, temperatureK: number): number {
  const x = 1 / temperatureK
  const pts = model.points
  let lnk: number
  if (pts.length === 1) {
    // One point: assume the rate doubles every 10 °C.
    lnk = pts[0][1] + LN2 * ((temperatureK - 1 / pts[0][0]) / 10)
  } else {
    let i = 0
    while (i < pts.length - 2 && x > pts[i + 1][0]) i++
    const [x0, y0] = pts[i]
    const [x1, y1] = pts[i + 1]
    lnk = y0 + ((y1 - y0) * (x - x0)) / (x1 - x0)
  }
  let k = Math.exp(lnk)
  if (model.tmK !== undefined && temperatureK > model.tmK - 5) {
    // Unfolding near and above the melting temperature: half-life of a minute at Tm, halving every 2 °C.
    k += (LN2 / 60) * 2 ** ((temperatureK - model.tmK) / 2)
  }
  return k
}

// ---- The integrator ----

/**
 * Boiling point of a layer at 1 atm: a solvent layer's main solvent; a mixture with a vapour–liquid
 * table (ethanol and water) from the table; anything else, water's.
 */
function layerBoilingK(cat: Catalogue, layer: Layer): number {
  const solvent = mainSolvent(cat, layer)
  if (solvent) {
    const bp = cat.substances.get(solvent)?.physical?.boilingPoint
    return bp ? parseValue(bp).si : BOILING_K
  }
  const vle = vleFor(cat, layer)
  if (!vle) return BOILING_K
  const nL = layer.species[vle.light] ?? 0
  const nW = waterMol(cat, layer)
  return boilingK(vle, nL + nW > 0 ? nL / (nL + nW) : 0)
}

function boilingPointK(cat: Catalogue, contents: Contents): number {
  let bp = Infinity
  for (const l of contents.layers) if (l.volumeL > 0) bp = Math.min(bp, layerBoilingK(cat, l))
  return Number.isFinite(bp) ? bp : BOILING_K
}

/**
 * Boil off a volume of liquid, from each layer by its share: a solvent layer loses its solvent, a
 * mixture with a vapour–liquid table loses vapour of the table's composition (richer in the more
 * volatile part), water loses water. Boiled dry, volatile liquids are gone and the rest is solid.
 */
function boilOff(cat: Catalogue, contents: Contents, volumeL: number): void {
  const total = liquidVolume(contents)
  if (!(volumeL > 0) || !(total > 0)) return
  if (volumeL >= total) {
    for (const l of contents.layers) for (const s of Object.keys(l.species)) if (cat.substances.get(s)?.physical?.boilingPoint) delete l.species[s]
    evaporate(contents, total)
    return
  }
  for (const l of contents.layers) {
    const dV = volumeL * (l.volumeL / total)
    const solvent = mainSolvent(cat, l)
    if (solvent) {
      const v = molarVolume(cat, solvent)
      const n = Math.min(l.species[solvent] ?? 0, dV / v)
      l.species[solvent] -= n
      l.volumeL -= n * v
      continue
    }
    const vle = vleFor(cat, l)
    if (vle) {
      const nL = l.species[vle.light] ?? 0
      const nW = waterMol(cat, l)
      const y = vapourAfter(vle, nL + nW > 0 ? nL / (nL + nW) : 0, 1)
      const n = dV / (y * molarVolume(cat, vle.light) + (1 - y) * WATER_MOLAR_L)
      l.species[vle.light] = Math.max(0, nL - n * y)
    }
    l.volumeL -= dV
  }
}

export interface AdvanceReport {
  steps: number
}

/** Advance every time-dependent process by `durationS` (the core:advance-time operation). */
export function advance(world: World, cat: Catalogue, durationS: number): AdvanceReport {
  const params = processParams(cat)
  let remaining = durationS
  let steps = 0
  while (remaining > 1e-9) {
    const dt = Math.min(STEP_S, remaining)
    for (const c of Object.values(world.containers)) {
      if (c.discarded || c.kind === 'plate') continue
      stepContainer(world, c, cat, params, dt)
    }
    world.timeS += dt
    remaining -= dt
    steps++
  }
  return { steps }
}


/** The liquid's make-up to two figures (dissolved oxygen aside), its solids and its temperature to 1 K. */
function surfaceKey(c: Contents): string {
  let key = `${Math.round(c.temperatureK)}`
  for (const l of c.layers) for (const [s, n] of Object.entries(l.species)) if (n > 0 && s !== OXYGEN) key += `|${s}=${n.toPrecision(2)}`
  for (const [s, n] of Object.entries(c.solid)) if (n > 0) key += `|${s}:${n.toPrecision(2)}`
  return key
}

/** Above this, cells in a liquid burst (a boiled extract). */
const LYSIS_K = 363.15
function stepContainer(world: World, c: Container, cat: Catalogue, params: ProcessParams, dt: number): void {
  // What is uncovered on the bench collects what settles out of the air.
  if (c.uncovered) settle(cat, world, c, dt)
  const contents = c.contents
  const volume = liquidVolume(contents)
  // Heat: Newton cooling towards the place, slower for bigger volumes (wells follow their plate).
  const place = world.places[c.place] ?? world.places.bench
  const scale = c.kind === 'well' ? 1 : Math.min(5, Math.max(0.3, Math.cbrt(Math.max(volume, 1e-7) / 1e-3)))
  // An insulated vessel (a polystyrene-cup calorimeter) exchanges heat many times more slowly.
  const tau = place.tauS * scale * Number(cat.property(c.equipment, 'insulation') ?? 1)
  contents.temperatureK += (place.temperatureK - contents.temperatureK) * (1 - Math.exp(-dt / tau))
  // Melting and freezing hold the temperature at the melting point while both phases are there.
  if (canChangePhase(cat, contents)) phaseChange(cat, contents)
  // Seeds and small animals respire: oxygen from the air (a sealed respirometer's, or the room's), and heat.
  if (params.respiring.size) respire(cat, params.respiring, c, dt)
  // Flies in a vial breed; animals in a choice chamber wander between its sides.
  if (contents.flies) breed(cat, world.seed, c.id, contents, world.timeS + dt, dt)
  if (contents.chamber) wander(cat, world.seed, c.id, contents.chamber, world.timeS + dt, dt)
  // A leafy shoot standing in the water draws it up as its leaves lose vapour to the air.
  if (volume > 0 && params.transpiring.size) transpire(cat, params.transpiring, contents, place, dt)
  // Metal under oxygenated water rusts or, wrapped with a more reactive metal, sacrifices that.
  if (volume > 0 && canCorrode(cat, contents)) corrode(cat, contents, dt)
  // The headspace and the oxygen dissolved under it.
  gasStep(cat, c, dt)
  // Solids reacting at their surfaces (metals in acid, marble chips), then the gas given off goes
  // to a syringe, through a delivery tube into another liquid, or into the headspace.
  if (volume > 0 && hasSurfaceReactions(cat, contents)) {
    // Solids reacting too slowly to see (under 10⁻⁹ mol/s: a nail in neutral water, magnesium in
    // salt water) are reacted in one go once about 10 nmol is due, between a minute and an hour (the
    // surface model sub-steps within it), or at once if the liquid's make-up or temperature changes.
    const quiet = contents.surfaceQuiet
    const end = world.timeS + dt
    if (!(quiet && end < quiet.untilS && quiet.key === surfaceKey(contents))) {
      const span = quiet ? end - quiet.fromS : dt
      // Their heat (Hess's law): the liquid's enthalpy, the solids used up or deposited, the gas
      // given off, and any water a catalyst forms.
      const before = settledEnthalpyJ(cat, contents)
      const { used, waterMol } = reactAtSurfaces(cat, contents, contents.temperatureK, span)
      releaseHeat(cat, contents, before - settledEnthalpyJ(cat, contents) - waterMol * WATER_DHF_J)
      const reacted = Object.values(used).reduce((a, n) => a + Math.abs(n), 0)
      if (reacted < 1e-9 * span) contents.surfaceQuiet = { key: surfaceKey(contents), fromS: end, untilS: end + Math.min(3600, Math.max(60, (1e-8 * span) / Math.max(reacted, 1e-30))) }
      else delete contents.surfaceQuiet
    }
  }
  if (contents.evolved || c.gas || contents.layers.some((l) => (l.species[OXYGEN] ?? 0) > 0)) {
    // Bubbles through another liquid: it takes up its share, the rest escapes to its headspace.
    routeGas(cat, world, c, dt, (target, gas, mol) => {
      const kept = mol * bubbleUptake(cat, target)
      if (kept > 0) {
        // The gas brings its enthalpy; what it does there (limewater turning milky) gives the heat.
        const before = settledEnthalpyJ(cat, target.contents) + kept * substanceEnthalpyJ(cat, gas, 'gas')
        takeUpGas(cat, target.contents, gas, kept)
        releaseHeat(cat, target.contents, before - settledEnthalpyJ(cat, target.contents))
      }
      if (mol > kept) (target.contents.evolved ??= {})[gas] = (target.contents.evolved?.[gas] ?? 0) + mol - kept
    })
  }
  if (volume <= 0) return
  // Boiling: the liquid holds at its boiling point and the surplus heat boils it off, unless a
  // condenser above it sends the vapour back (reflux).
  // (In a sealed syringe the vapour stays in the gas: models/gaslaws.ts.)
  // Under a still head it boils at its bubble point and the vapour goes to the receiver.
  if (c.still && !c.gasSample) {
    if (distilStep(cat, world, c, place, dt) && liquidVolume(contents) <= 0) return
  } else if (contents.temperatureK > params.lowestBoilingK && !c.gasSample) {
    const bp = boilingPointK(cat, contents)
    if (contents.temperatureK > bp) {
      contents.temperatureK = bp
      if (cat.property(place.equipment, 'condenser') !== true) {
        boilOff(cat, contents, Math.max(0, place.temperatureK - bp) * BOIL_OFF_L_PER_S_PER_K * dt)
        if (liquidVolume(contents) <= 0) return
      }
    }
  }
  // Molten agar sets as it cools.
  updateGel(cat, c)
  // Solubility: excess comes out at once; solid redissolves slowly while standing.
  if (hasLimited(cat, contents)) {
    // What dissolves or comes out gives its heat of solution (only when something did).
    const before = settledEnthalpyJ(cat, contents)
    const changed = equilibrate(cat, contents, 1 - Math.exp(-dt / UNSTIRRED_DISSOLVE_S))
    if (Object.values(changed.change).some((x) => x !== 0)) releaseHeat(cat, contents, before - settledEnthalpyJ(cat, contents))
  }
  // Diffusion between layers (not across the boundary of two liquids that do not mix).
  if (contents.layers.length > 1 && !twoPhase(cat, contents)) {
    const tauD = Math.max(60, params.diffusionTimeAt1mL * Math.pow(volume / 1e-3, 2 / 3))
    relaxLayers(contents, 1 - Math.exp(-dt / tauD))
    // The heat of what diffusion brings together: carried enthalpy is conserved, so releasing it
    // once a minute (not every step) loses nothing and saves solving every layer's pH each step.
    if (Math.floor(world.timeS / 60) !== Math.floor((world.timeS + dt) / 60)) releaseHeat(cat, contents)
  }
  if (contents.layers.some((l) => l.particles)) settleGrains(cat, contents, volume, dt)
  // Boiling lysis: cells heated past 90 °C burst and their DNA goes into the liquid.
  if (contents.temperatureK > LYSIS_K) for (const l of contents.layers) if (l.populations) lyseCells(cat, l, (key) => strainDna(cat, key), (key, pop) => strainProteins(cat, key, pop))
  const T = contents.temperatureK
  if (contents.surface) growSurface(cat, world.seed, c, T, dt, world.timeS)
  // Plant tissue: water in or out by water potential; damaged membranes leak pigment.
  if (contents.tissue) tissueStep(cat, contents, dt)
  const capacity = bindingCapacity(cat, c)
  if (capacity !== undefined) surfaceStep(cat, c, capacity, T, dt)
  if (contents.blot) blotStep(cat, contents, dt)
  const bottom = contents.layers[contents.layers.length - 1]
  // Organisms in a soil grow as fast as its water lets them.
  const wet = contents.layers.some((l) => l.populations) ? moistureFactor(cat, contents, volume) : 1
  let heatMol = 0
  for (const layer of contents.layers) {
    if (layer.volumeL <= 0) continue
    if (layer.populations) growLayer(cat, layer, T, dt, wet)
    degrade(layer, params, T, dt)
    for (const m of params.colour) colourDevelopment(layer, m, cat, T, dt)
    // Enzymes on the wall act on the liquid touching it.
    if (params.enzymes.size > 0) heatMol += enzymeKinetics(cat, layer, params, T, dt, layer === bottom ? contents.adsorbed : undefined, place)
    for (const r of params.reactions) massAction(cat, layer, r, T, dt, layer === bottom ? contents.solid : undefined)
    digest(cat, layer, T, dt)
  }
  // The heat of enzyme reactions with thermal data (catalase on hydrogen peroxide): at once when
  // they turn over more than 1 µM a step, otherwise once a minute (the carried enthalpy keeps what
  // is not yet released, and plankton turning over nanomolar amounts need not solve the pH each step).
  if (heatMol > 1e-6 * volume || (heatMol > 0 && Math.floor(world.timeS / 60) !== Math.floor((world.timeS + dt) / 60))) releaseHeat(cat, contents)
}

/** The first substrate's share of the site (each reaction's lead substrate over its Km). */
function siteLoad(layer: Layer, model: EnzymeModel): number {
  const v = layer.volumeL
  let load = 0
  for (const r of [model, ...model.alternatives]) {
    const lead = r.substrates[0]
    load += (layer.species[lead] ?? 0) / v / (r.km[lead] ?? 1e-4)
  }
  return load
}

/** Mechanism-based inactivation: the active enzyme decays at kobs, slowed by substrate occupying the site. */
function inactivate(layer: Layer, enzyme: string, model: EnzymeModel, dt: number): void {
  const load = siteLoad(layer, model)
  let kobs = 0
  for (const i of model.inactivators) {
    const c = (layer.species[i.substance] ?? 0) / layer.volumeL
    if (c > 0) kobs += (i.kinact * c) / (i.ki * (1 + load) + c)
  }
  if (!(kobs > 0)) return
  layer.active ??= {}
  layer.active[enzyme] = activeAmount(layer, enzyme) * Math.exp(-kobs * dt)
}

/**
 * An enzyme with alternative substrates: every reaction's lead substrate competes for the one
 * site, vᵢ = kcatᵢ E ([Sᵢ]/Kmᵢ) / (1 + Σ [Sⱼ]/Kmⱼ + Σ [I]/Ki), times any second substrate's saturation.
 */
function competingReactions(cat: Catalogue, layer: Layer, model: EnzymeModel, e: number, T: number, dt: number): void {
  const v = layer.volumeL
  let fpH = 1
  if (model.pHActivity) {
    const pH = layerPH(cat, layer, T) ?? 7
    fpH = 1 / (1 + Math.pow(10, model.pHActivity.acidPKa - pH) + Math.pow(10, pH - model.pHActivity.basePKa))
  }
  const scale = e * Math.pow(2, (T - 298.15) / 10) * fpH
  const reactions = [model, ...model.alternatives].filter((r) => r.substrates.every((s) => (layer.species[s] ?? 0) > 0))
  if (!reactions.length) return
  const conc = (s: string) => Math.max(0, layer.species[s] ?? 0) / v
  const competitive = model.inhibitors.filter((i) => i.type === 'competitive' || i.type === 'mixed').reduce((a, i) => a + conc(i.substance) / i.ki, 0)
  const general = model.inhibitors.filter((i) => i.type !== 'competitive').reduce((a, i) => a * (1 + conc(i.substance) / (i.type === 'mixed' ? i.ki * i.alpha : i.ki)), 1)
  let t = 0
  while (t < dt - 1e-12) {
    const load = 1 + competitive + reactions.reduce((a, r) => a + conc(r.substrates[0]) / (r.km[r.substrates[0]] ?? 1e-4), 0)
    const rates = reactions.map((r) => {
      let rate = (r.kcat * scale * conc(r.substrates[0])) / (r.km[r.substrates[0]] ?? 1e-4) / load / general
      for (const s of r.substrates.slice(1)) rate *= conc(s) / ((r.km[s] ?? 1e-4) + conc(s))
      return rate
    })
    const fastest = Math.max(...rates.map((r, i) => r / Math.max(1e-30, Math.min(...reactions[i].substrates.map(conc)))))
    if (!(fastest > 0)) break
    const h = Math.min(dt - t, Math.max(1e-3, 0.02 / fastest))
    reactions.forEach((r, i) => {
      const step = Math.min(rates[i] * h, ...r.substrates.map(conc))
      if (!(step > 0)) return
      for (const s of r.substrates) layer.species[s] = Math.max(0, (layer.species[s] ?? 0) - step * v)
      for (const pr of r.products) layer.species[pr] = (layer.species[pr] ?? 0) + step * v * (r.yields[pr] ?? 1)
    })
    t += h
  }
}

/**
 * Grains with a declared size settle out of a liquid (Stokes): v = (ρp − ρ) g d² / 18η. They fall
 * behind a clearing front: the liquid above it is clear, below it as cloudy as when stirred, so the
 * column (about 1.5 × the cube root of its volume) is clear after h / v. Zinc powder (20 µm) clears
 * 5 mL of water in about 20 seconds; grains without a size (a fine protein precipitate) stay
 * suspended until spun down. Stirring or pouring in liquid starts the clock again.
 */
function settleGrains(cat: Catalogue, contents: Contents, volumeL: number, dt: number): void {
  const heightM = Math.max(0.005, 1.5 * Math.cbrt(volumeL / 1000))
  const clock = (contents.grainClock ??= {})
  for (const layer of contents.layers) {
    for (const [s, n] of Object.entries(layer.particles ?? {})) {
      if (!(n > 0)) continue
      const phys = cat.substances.get(s)?.physical
      if (!phys?.particleSize || !phys.density) continue
      const d = parseValue(phys.particleSize).si
      const rho = parseValue(phys.density).si
      const eta = viscosityMPaS(cat, layer) / 1000
      const v = (Math.max(0, rho - 1000) * 9.81 * d * d) / (18 * eta)
      const t = clock[s] ?? 0
      const left = 1 - (v * t) / heightM
      const f = left <= 0 ? 1 : Math.min(1, (v * dt) / heightM / left)
      layer.particles![s] = n * (1 - f)
      contents.solid[s] = (contents.solid[s] ?? 0) + n * f
    }
  }
  for (const s of Object.keys(clock)) clock[s] += dt
  for (const layer of contents.layers) for (const s of Object.keys(layer.particles ?? {})) if (!(s in clock)) clock[s] = dt
}

function degrade(layer: Layer, params: ProcessParams, T: number, dt: number): void {
  for (const [s, n] of Object.entries(layer.species)) {
    if (n <= 0) continue
    const model = params.stability.get(s)
    if (!model) continue
    const f = Math.exp(-decayRate(model, T) * dt)
    if (model.protein) {
      layer.active ??= {}
      layer.active[s] = activeAmount(layer, s) * f
    } else {
      layer.species[s] = n * f
    }
  }
}

/**
 * Colour development (contract colour-development, T2): the product approaches
 * c_eq = R_total × P / (P + K) with first-order kinetics, k = k37 × Q10^((T − 37 °C)/10).
 * P is the assay-weighted protein mass concentration; R is the reagent the product forms from
 * (Cu(II) for BCA, free Coomassie dye for Bradford), consumed as the product forms.
 */
function colourDevelopment(layer: Layer, m: ColourModel, cat: Catalogue, T: number, dt: number): void {
  for (const t of m.trigger) if (!((layer.species[t] ?? 0) > 0)) return
  const v = layer.volumeL
  let proteinGPerL = 0
  for (const [s, n] of Object.entries(layer.species)) {
    if (n <= 0) continue
    const def = cat.substances.get(s)
    const response = def?.protein?.assayResponse?.[m.assay]
    if (!response) continue
    const mm = molarMass(cat, s) ?? 0
    proteinGPerL += ((n * mm) / v) * response
  }
  const cu = (layer.species[m.reagent] ?? 0) / v
  const product = (layer.species[m.product] ?? 0) / v
  const cuTotal = cu + product
  const ceq = proteinGPerL > 0 ? (cuTotal * proteinGPerL) / (proteinGPerL + m.halfSaturationGPerL) : 0
  if (ceq <= product) return
  const k = m.rate37 * Math.pow(m.q10, (T - 310.15) / 10)
  const next = ceq + (product - ceq) * Math.exp(-k * dt)
  const formed = (next - product) * v
  layer.species[m.product] = (layer.species[m.product] ?? 0) + formed
  layer.species[m.reagent] = Math.max(0, (layer.species[m.reagent] ?? 0) - formed)
}

/**
 * Mass-action kinetics (contract kinetics.mass-action, T2): rate = k(T) Π [A]^order (× [OH⁻]ⁿ for a
 * base-catalysed reaction), with
 * k(T) = k_ref exp(−Ea/R (1/T − 1/T_ref)); each species changes by its coefficient × rate.
 * An order may name a catalyst (in the orders, not the reactants: unchanged by the reaction), and
 * water may be a reactant or product: the solvent itself, so the liquid's volume changes with it.
 * Integrated in sub-steps that change no reactant by more than 2 %.
 */
function massAction(cat: Catalogue, layer: Layer, r: Reaction, T: number, dt: number, settled?: Contents['solid']): void {
  const v = layer.volumeL
  for (const [s] of r.reactants) if (!((s === WATER ? waterMol(cat, layer) : (layer.species[s] ?? 0)) > 0)) return
  let k = r.k * Math.exp((-r.eaJPerMol / 8.314) * (1 / T - 1 / r.atK))
  // A base-catalysed reaction goes as [OH⁻]ⁿ at the liquid's pH (held through the step: the
  // catalyst is in excess, or the products' acidity is settled by the next equilibrium).
  if (r.hydroxide > 0) {
    // Hydroxide is in water: none in a solvent layer or a liquid that is mostly organic (dry THF).
    if (waterMol(cat, layer) * WATER_MOLAR_L < MIN_WATER_FOR_HYDROXIDE * v) return
    k *= Math.pow(Math.pow(10, (layerPH(cat, layer, T) ?? 7) - pKw(T)), r.hydroxide)
  }
  // An acid-catalysed reaction (or one that uses up H⁺, the ionic model settling the pH afterwards)
  // goes as [H⁺]ⁿ at the liquid's pH: acidified dichromate oxidising an alcohol.
  if (r.acid > 0) {
    if (waterMol(cat, layer) * WATER_MOLAR_L < MIN_WATER_FOR_HYDROXIDE * v) return
    k *= Math.pow(Math.pow(10, -(layerPH(cat, layer, T) ?? 7)), r.acid)
  }
  const conc: Record<string, number> = {}
  for (const [s] of [...r.reactants, ...r.products, ...r.orders]) conc[s] = (s === WATER ? waterMol(cat, layer) : (layer.species[s] ?? 0)) / v
  const conc0 = { ...conc }
  // A powder reacts where the liquid touches it: grains still suspended in this layer, and (for the
  // bottom layer) those settled under it.
  for (const s of r.heterogeneous) {
    conc[s] = ((layer.particles?.[s] ?? 0) + (settled?.[s] ?? 0)) / v
    if (!(conc[s] > 0)) return
  }
  let t = 0
  while (t < dt - 1e-12) {
    let rate = k
    for (const [s, order] of r.orders) rate *= Math.pow(Math.max(0, conc[s] ?? 0), order)
    if (!(rate > 0)) break
    let h = dt - t
    for (const [s, nu] of r.reactants) h = Math.min(h, (0.02 * conc[s]) / (nu * rate))
    h = Math.max(h, 1e-6)
    for (const [s, nu] of r.reactants) conc[s] = Math.max(0, conc[s] - nu * rate * h)
    for (const [s, nu] of r.products) conc[s] = (conc[s] ?? 0) + nu * rate * h
    t += h
  }
  for (const [s, c] of Object.entries(conc)) if (s !== WATER && !r.heterogeneous.includes(s) && (c > 0 || s in layer.species)) layer.species[s] = c * v
  // The liquid's volume follows what was made and used: water, and the liquids with a density (a
  // consumed solvent's volume must not turn into water).
  let dV = 0
  for (const [s, c] of Object.entries(conc)) {
    if (r.heterogeneous.includes(s) || c === conc0[s]) continue
    if (s === WATER) dV += (c - conc0[s]) * v * WATER_MOLAR_L
    else if (cat.substances.get(s)?.physical?.density) dV += (c - conc0[s]) * v * molarVolume(cat, s)
  }
  if (dV !== 0) layer.volumeL = Math.max(0, v + dV)
  // Reaction heats are not modelled yet: what the reaction did to the acid–base state is not heat.
  resyncEnthalpy(cat, layer, T)
}

/**
 * Enzyme kinetics (contract kinetics.enzymatic, T3): independent Michaelis–Menten terms for
 * each substrate; inhibitors act on the first substrate. kcat is taken at 25 °C with Q10 = 2.
 * An enzyme with a pH profile works at kcat / (1 + 10^(acidPKa − pH) + 10^(pH − basePKa)): the
 * bell-shaped curve of two ionising groups, from the layer's own pH. Integrated with RK4 in
 * sub-steps small enough that no substrate goes negative.
 */
/** Share of the light a filter of each colour passes (of white light's photosynthetically active photons). */
const FILTER_PASS = 0.3

/** How much a light-driven enzyme works under the light where its vessel stands (0 in the dark). */
function lightFactor(model: EnzymeModel, place: Place | undefined): number {
  if (!model.light) return 1
  const white = place?.light ?? 0
  const usable = place?.filter ? white * FILTER_PASS * (model.light.action[place.filter] ?? 0.3) : white
  return usable / (usable + model.light.half)
}

/** Run each enzyme for `dt`; returns the mol turned over by enzymes whose reaction gives heat. */
function enzymeKinetics(cat: Catalogue, layer: Layer, params: ProcessParams, T: number, dt: number, wall?: Record<string, number>, place?: Place): number {
  let thermalMol = 0
  const v = layer.volumeL
  let pH: number | undefined
  for (const [enzyme, model] of params.enzymes) {
    const onWall = wall ? (wall[enzyme] ?? 0) + (wall[`${enzyme}@bound`] ?? 0) : 0
    if (model.inactivators.length && activeAmount(layer, enzyme) > 0) inactivate(layer, enzyme, model, dt)
    const e = ((activeAmount(layer, enzyme) + onWall) / v) * lightFactor(model, place)
    if (!(e > 0)) continue
    if (model.alternatives.length) {
      competingReactions(cat, layer, model, e, T, dt)
      continue
    }
    if (!model.substrates.every((s) => (layer.species[s] ?? 0) > 0)) continue
    let fpH = 1
    if (model.pHActivity) {
      pH ??= layerPH(cat, layer, T) ?? 7
      fpH = 1 / (1 + Math.pow(10, model.pHActivity.acidPKa - pH) + Math.pow(10, pH - model.pHActivity.basePKa))
    }
    const vmax = model.kcat * e * Math.pow(2, (T - 298.15) / 10) * fpH
    const conc = (s: string) => (layer.species[s] ?? 0) / v
    const inhib = model.inhibitors.map((i) => ({ ...i, c: conc(i.substance) })).filter((i) => i.c > 0)
    const rate = (sub: number[]): number => {
      let r = vmax
      sub.forEach((s, idx) => {
        let km = model.km[model.substrates[idx]] ?? 1e-4
        if (idx === 0) {
          for (const i of inhib) {
            const ratio = i.c / i.ki
            if (i.type === 'competitive') km *= 1 + ratio
            else if (i.type === 'noncompetitive') r /= 1 + ratio
            else if (i.type === 'uncompetitive') {
              km /= 1 + ratio
              r /= 1 + ratio
            } else if (i.type === 'mixed') {
              km *= (1 + ratio) / (1 + ratio / i.alpha)
              r /= 1 + ratio / i.alpha
            }
          }
        }
        r *= Math.max(0, s) / (km + Math.max(0, s))
      })
      return r
    }
    let s = model.substrates.map(conc)
    let t = 0
    let produced = 0
    while (t < dt - 1e-12) {
      const r0 = rate(s)
      if (r0 <= 0) break
      const minS = Math.min(...s)
      const h = Math.min(dt - t, Math.max(1e-3, (0.05 * minS) / r0))
      const k1 = r0
      const k2 = rate(s.map((x) => x - (h / 2) * k1))
      const k3 = rate(s.map((x) => x - (h / 2) * k2))
      const k4 = rate(s.map((x) => x - h * k3))
      const d = (h / 6) * (k1 + 2 * k2 + 2 * k3 + k4)
      const step = Math.min(d, minS)
      s = s.map((x) => x - step)
      produced += step
      t += h
    }
    if (produced <= 0) continue
    model.substrates.forEach((sub) => (layer.species[sub] = Math.max(0, (layer.species[sub] ?? 0) - produced * v)))
    for (const p of model.products) {
      const n = produced * (model.yields[p] ?? 1) * v
      if (p !== WATER) {
        layer.species[p] = (layer.species[p] ?? 0) + n
        continue
      }
      // Water joins the solvent: its volume, and the heat of forming it (the solvent is not in the state).
      layer.volumeL += n * WATER_MOLAR_L
      if (layer.enthalpyJ !== undefined) layer.enthalpyJ -= n * WATER_DHF_J
    }
    if (model.thermal) thermalMol += produced * v
  }
  return thermalMol
}
