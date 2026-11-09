// Separation operations (composition model §5.2): filtration and column elution. The funnel is
// a container that keeps solids; liquid passes into the filtrate except what the wet cake holds,
// which carries its dissolved impurities until it is washed out. A wash is a transfer onto the
// cake followed by another filtration, so washing with too little, too much or too warm solvent
// has its consequences without a special rule. A size-exclusion column takes in the sample put
// on its bed and releases each solute by size as buffer is pushed through, fraction by fraction.
import { equilibrateWithHeat, settleAll } from '../models/solubility.ts'
import { bandShare, columnSpec, elutionVolume } from '../models/sizeexclusion.ts'
import { epsilon } from '../models/measurement.ts'
import { exchangerOf, type IonExchanger, moveBand } from '../models/ionexchange.ts'
import { ionicStrength, layerPH } from '../models/acidbase.ts'
import { affinityPass, type AffinityResin, resinOf } from '../models/affinity.ts'
import { bandsFromLane, developBlot } from '../models/blot.ts'
import { boilingK, molarVolume, vapourAfter, vleFor, WATER_MOLAR_L, waterMol } from '../models/distillation.ts'
import { gelMatrix } from '../models/electrophoresis.ts'
import type { MeasurementRecord } from './state.ts'
import { eluentStrength, rf } from '../models/tlc.ts'
import { advance } from '../models/processes.ts'
import { meanLayer } from './state.ts'
import { type OpContext, type OpImpl, type OpResult } from './kernel.ts'
import { molarMass } from './materials.ts'
import { addOrigins, requireOpen } from './ops-bench.ts'
import { addInto, addOnTop, type Container, drawFromTop, drawProportional, type Layer, liquidVolume, relaxLayers, scaleLayer } from './state.ts'
import { isOrganic, samePhase } from '../models/phases.ts'
import { parseValue } from '../units/index.ts'

type Params = Record<string, unknown>

function solidGrams(ctx: OpContext, solid: Record<string, number>): number {
  return Object.entries(solid).reduce((a, [s, n]) => a + (n > 0 ? n * (molarMass(ctx.cat, s) ?? 0) : 0), 0)
}

function filter(ctx: OpContext, p: Params): OpResult {
  const funnel = ctx.container(p.filter, 'filter')
  if (ctx.cat.property(funnel.equipment, 'filter') !== true) ctx.refuse('NOT-A-FILTER', `${funnel.label} is not a filter funnel`)
  const filtrate = ctx.container(p.filtrate, 'filtrate')
  if (filtrate.id === funnel.id) ctx.refuse('SAME-CONTAINER', 'The filtrate needs its own flask')
  requireOpen(ctx, filtrate)

  // Pour everything from the source onto the filter.
  let poured = false
  if (p.source !== undefined && p.source !== null) {
    const src = ctx.container(p.source, 'source')
    if (src.id === funnel.id || src.id === filtrate.id) ctx.refuse('SAME-CONTAINER', 'Pour from another vessel')
    requireOpen(ctx, src)
    const v = liquidVolume(src.contents)
    const before = liquidVolume(funnel.contents)
    if (before + v > funnel.capacityL * (1 + 1e-9)) ctx.refuse('OVERFLOW', `${funnel.label} holds ${funnel.capacityL * 1000} mL: filter in portions`)
    const tSrc = src.contents.temperatureK
    const tF = funnel.contents.temperatureK
    if (v > 0) addOnTop(funnel.contents, drawProportional(src.contents, v), 1)
    for (const [s, n] of Object.entries(src.contents.solid)) {
      if (!(n > 0)) continue
      funnel.contents.solid[s] = (funnel.contents.solid[s] ?? 0) + n
      src.contents.solid[s] = 0
    }
    const after = liquidVolume(funnel.contents)
    funnel.contents.temperatureK = after > 0 ? (tF * before + tSrc * v) / after : tSrc
    addOrigins(funnel, src)
    ctx.world.provenance.push({ event: ctx.eventIndex, from: src.id, to: funnel.id, volumeL: v, kind: 'transfer' })
    poured = true
  }

  // The liquid on the filter is one pool with the cake; the paper keeps any fine particles.
  relaxLayers(funnel.contents, 1)
  equilibrateWithHeat(ctx.cat, funnel.contents, 1)
  settleAll(funnel.contents)
  const solidG = solidGrams(ctx, funnel.contents.solid)
  const liquid = liquidVolume(funnel.contents)
  const perGram = Number(ctx.cat.property(funnel.equipment, 'retainedLiquidPerGram') ?? 1)
  const retained = Math.min(liquid, perGram * solidG * 1e-3)
  const pass = liquid - retained
  const before = liquidVolume(filtrate.contents)
  if (before + pass > filtrate.capacityL * (1 + 1e-9)) ctx.refuse('OVERFLOW', `${filtrate.label} would overflow`, { capacity: filtrate.capacityL })
  if (pass > 0) {
    const tF = funnel.contents.temperatureK
    const tD = filtrate.contents.temperatureK
    addOnTop(filtrate.contents, drawProportional(funnel.contents, pass), 1)
    const after = liquidVolume(filtrate.contents)
    filtrate.contents.temperatureK = (tD * before + tF * pass) / after
    addOrigins(filtrate, funnel)
    ctx.world.provenance.push({ event: ctx.eventIndex, from: funnel.id, to: filtrate.id, volumeL: pass, kind: 'transfer' })
  }
  return { outputs: { filtrate: `${pass * 1000} mL` }, facts: { poured, passedL: pass, retainedL: retained, solidG } }
}

/**
 * Collect one fraction from a size-exclusion column. Liquid on top of the bed runs in first as
 * the sample (its volume widens the bands; a sample applied once a whole bed volume has passed
 * since the last starts a new run, and whatever was left of the last is washed out with it). Then `volume` of buffer is pushed through, and the fraction receives that
 * buffer plus the share of each solute's band that leaves in it (models/sizeexclusion.ts).
 */
function elute(ctx: OpContext, p: Params): OpResult {
  const column = ctx.container(p.column, 'column')
  if (ctx.cat.property(column.equipment, 'column') !== true) ctx.refuse('NOT-A-COLUMN', `${column.label} is not a chromatography column`)
  const buffer = ctx.container(p.buffer, 'buffer')
  const into = ctx.container(p.into, 'fraction')
  if (into.id === column.id || buffer.id === column.id || into.id === buffer.id) ctx.refuse('SAME-CONTAINER', 'The column, the buffer and the fraction must be different vessels')
  requireOpen(ctx, into)
  const volumeL = ctx.quantity(p.volume, 'volume').si * 1000
  const resin = resinOf(ctx.cat, column.equipment)
  if (resin) return affinityElute(ctx, column, buffer, into, volumeL, resin)
  if (!(volumeL > 0)) ctx.refuse('BAD-VOLUME', 'Collect a positive volume')
  if (liquidVolume(buffer.contents) < volumeL * (1 - 1e-9)) ctx.refuse('NOT-ENOUGH', `${buffer.label} has too little left`)
  if (liquidVolume(into.contents) + volumeL > into.capacityL * (1 + 1e-9)) ctx.refuse('OVERFLOW', `${into.label} cannot take ${volumeL * 1000} mL more`)
  const spec = columnSpec(ctx.cat, column.equipment)
  const exchanger = exchangerOf(ctx.cat, column.equipment)
  if (exchanger) return ionExchangeElute(ctx, column, buffer, into, volumeL, spec, exchanger)
  let state = column.contents.column
  const applied = liquidVolume(column.contents)
  if (applied > 0) {
    if (!state || state.passedL >= spec.totalL) state = { loaded: {}, left: {}, sampleL: 0, passedL: 0 }
    for (const l of column.contents.layers) {
      for (const [s, n] of Object.entries(l.species)) {
        if (!(n > 0)) continue
        state.loaded[s] = (state.loaded[s] ?? 0) + n
        state.left[s] = (state.left[s] ?? 0) + n
      }
    }
    state.sampleL += applied
    column.contents.layers = []
    column.contents.column = state
  }
  const a = state?.passedL ?? 0
  const b = a + volumeL
  const out = drawProportional(buffer.contents, volumeL)
  if (state) {
    for (const [s, n] of Object.entries(state.loaded)) {
      const share = bandShare(spec, molarMass(ctx.cat, s) ?? 100, state.sampleL, a, b)
      const take = Math.min(state.left[s] ?? 0, n * share)
      if (!(take > 0)) continue
      out.species[s] = (out.species[s] ?? 0) + take
      state.left[s] -= take
    }
    state.passedL = b
  }
  addOnTop(into.contents, out, 1)
  addOrigins(into, buffer)
  addOrigins(into, column)
  ctx.world.provenance.push({ event: ctx.eventIndex, from: column.id, to: into.id, volumeL, kind: 'transfer' })
  return {
    outputs: { from: `${Math.round(a * 1e6) / 1000} mL`, to: `${Math.round(b * 1e6) / 1000} mL` },
    facts: { column: column.id, fromL: a, toL: b, sampleL: state?.sampleL ?? 0, applied: applied > 0 },
  }
}

/**
 * A fraction from a column whose matrix carries charges: each solute's band is moved through the
 * bed by the buffer around it (models/ionexchange.ts), so the buffer pushed through matters: a
 * weak one holds what the resin attracts and a stronger one, arriving as a front, releases it.
 */
function ionExchangeElute(ctx: OpContext, column: Container, buffer: Container, into: Container, volumeL: number, spec: ReturnType<typeof columnSpec>, ex: IonExchanger): OpResult {
  let state = column.contents.column
  const applied = liquidVolume(column.contents)
  if (applied > 0) {
    // A new run starts in whatever buffer the bed now holds.
    const holding = state?.segments?.at(-1)
    if (!state || state.passedL >= spec.totalL) state = { loaded: {}, left: {}, sampleL: 0, passedL: 0, positions: {}, segments: holding ? [{ ...holding, fromL: 0 }] : [] }
    for (const l of column.contents.layers) {
      for (const [s, n] of Object.entries(l.species)) {
        if (!(n > 0)) continue
        state.loaded[s] = (state.loaded[s] ?? 0) + n
        state.left[s] = (state.left[s] ?? 0) + n
        state.positions![s] = 0
      }
    }
    state.sampleL += applied
    column.contents.layers = []
    column.contents.column = state
  }
  const a = state?.passedL ?? 0
  const b = a + volumeL
  const bufferLayer = meanLayer(buffer.contents)
  const T = buffer.contents.temperatureK
  const segment = { fromL: a, ionicM: ionicStrength(ctx.cat, bufferLayer, T), pH: layerPH(ctx.cat, bufferLayer, T) ?? 7 }
  const out = drawProportional(buffer.contents, volumeL)
  if (state) {
    const segments = (state.segments ??= [])
    const last = segments[segments.length - 1]
    if (!last || Math.abs(last.ionicM - segment.ionicM) > 1e-6 || Math.abs(last.pH - segment.pH) > 1e-3) segments.push(segment)
    const positions = (state.positions ??= {})
    for (const [s, n] of Object.entries(state.loaded)) {
      const moved = moveBand(ctx.cat, spec, ex, segments, s, molarMass(ctx.cat, s) ?? 100, state.sampleL, positions[s] ?? 0, a, b)
      positions[s] = moved.x
      const take = Math.min(state.left[s] ?? 0, n * moved.share)
      if (!(take > 0)) continue
      out.species[s] = (out.species[s] ?? 0) + take
      state.left[s] -= take
    }
    state.passedL = b
  } else if (!column.contents.column) {
    // Buffer run through a bed with nothing on it yet: it settles the bed into that buffer.
    column.contents.column = { loaded: {}, left: {}, sampleL: 0, passedL: 0, positions: {}, segments: [segment] }
  }
  addOnTop(into.contents, out, 1)
  addOrigins(into, buffer)
  addOrigins(into, column)
  ctx.world.provenance.push({ event: ctx.eventIndex, from: column.id, to: into.id, volumeL, kind: 'transfer' })
  return {
    outputs: { from: `${Math.round(a * 1e6) / 1000} mL`, to: `${Math.round(b * 1e6) / 1000} mL` },
    facts: { column: column.id, fromL: a, toL: b, sampleL: state?.sampleL ?? 0, applied: applied > 0, ionicM: segment.ionicM },
  }
}

/**
 * An affinity column: the liquid on its bed (a sample, or buffer just added) runs through, then
 * `volume` more of `buffer` (zero to collect only what was applied). Everything that passes
 * equilibrates with the resin (models/affinity.ts) and leaves into the fraction.
 */
function affinityElute(ctx: OpContext, column: Container, buffer: Container, into: Container, volumeL: number, resin: AffinityResin): OpResult {
  if (!(volumeL >= 0)) ctx.refuse('BAD-VOLUME', 'Collect zero or more')
  if (volumeL > 0 && liquidVolume(buffer.contents) < volumeL * (1 - 1e-9)) ctx.refuse('NOT-ENOUGH', `${buffer.label} has too little left`)
  const applied = liquidVolume(column.contents)
  const passing = applied > 0 ? drawProportional(column.contents, applied) : { volumeL: 0, species: {} }
  if (volumeL > 0) addInto(passing, drawProportional(buffer.contents, volumeL), 1)
  if (!(passing.volumeL > 0)) ctx.refuse('NOTHING-TO-PASS', `Nothing is on ${column.label} and no buffer was asked for`)
  if (liquidVolume(into.contents) + passing.volumeL > into.capacityL * (1 + 1e-9)) ctx.refuse('OVERFLOW', `${into.label} cannot take ${(passing.volumeL * 1000).toFixed(1)} mL more`)
  const state = (column.contents.affinity ??= { bound: {} })
  state.bound = affinityPass(ctx.cat, resin, state.bound, passing)
  addOnTop(into.contents, passing, 1)
  addOrigins(into, column)
  if (volumeL > 0) addOrigins(into, buffer)
  ctx.world.provenance.push({ event: ctx.eventIndex, from: column.id, to: into.id, volumeL: passing.volumeL, kind: 'transfer' })
  return { outputs: { volume: `${Math.round(passing.volumeL * 1e6) / 1000} mL` }, facts: { column: column.id, passedL: passing.volumeL } }
}

/** Liquid a well keeps after it is emptied and tapped dry (L). */
const RESIDUAL_L = 2e-6

/**
 * Wash wells (or one tube): empty each, fill it with buffer and empty it again, `cycles` times.
 * What is on the wall stays (adsorbed proteins, bound antibodies); what is free is diluted away
 * by the residual each time, so too few washes leave unbound antibody behind.
 */
function wash(ctx: OpContext, p: Params): OpResult {
  const target = ctx.container(p.target, 'target')
  const buffer = ctx.container(p.buffer, 'buffer')
  const volumeL = ctx.quantity(p.volume ?? '300 uL', 'volume').si * 1000
  const cycles = Math.round(Number(p.cycles ?? 3))
  if (!(cycles >= 1 && cycles <= 10)) ctx.refuse('BAD-CYCLES', 'Wash 1 to 10 times')
  const wells: Container[] = target.kind === 'plate'
    ? (target.wells ?? []).map((id) => ctx.world.containers[id]).filter((w) => liquidVolume(w.contents) > 0 || Object.keys(w.contents.adsorbed ?? {}).length > 0)
    : [target]
  if (wells.length === 0) ctx.refuse('NOTHING-TO-WASH', `Nothing in ${target.label} to wash`)
  for (const w of wells) if (volumeL > w.capacityL * (1 + 1e-9)) ctx.refuse('OVERFLOW', `${w.label} holds ${w.capacityL * 1e6} µL`)
  const needL = volumeL * cycles * wells.length
  if (liquidVolume(buffer.contents) < needL * (1 - 1e-9)) ctx.refuse('NOT-ENOUGH', `${buffer.label} has too little for ${cycles} washes of ${wells.length} wells`)
  const empty = (w: Container) => {
    const v = liquidVolume(w.contents)
    if (v <= RESIDUAL_L) return
    const keep = RESIDUAL_L / v
    w.contents.layers = w.contents.layers.map((l) => scaleLayer(l, keep))
  }
  for (const w of wells) {
    empty(w)
    for (let i = 0; i < cycles; i++) {
      addOnTop(w.contents, drawProportional(buffer.contents, volumeL), 1)
      relaxLayers(w.contents, 1)
      empty(w)
    }
    addOrigins(w, buffer)
  }
  return { outputs: {}, facts: { wells: wells.length, cycles, volumeL } }
}

/**
 * Spot a TLC plate: a small volume of a solution onto one lane's origin. The solvent evaporates
 * and what was dissolved stays on the silica.
 */
function spotPlate(ctx: OpContext, p: Params): OpResult {
  const plate = ctx.container(p.plate, 'plate')
  if (ctx.cat.property(plate.equipment, 'tlc') !== true) ctx.refuse('NOT-A-TLC-PLATE', `${plate.label} is not a TLC plate`)
  const source = ctx.container(p.source, 'source')
  const lanes = Number(ctx.cat.property(plate.equipment, 'lanes') ?? 5)
  const lane = Math.round(Number(p.lane))
  if (!(lane >= 1 && lane <= lanes)) ctx.refuse('BAD-LANE', `${plate.label} has lanes 1 to ${lanes}`)
  if (plate.contents.tlc?.developed) ctx.refuse('ALREADY-DEVELOPED', `${plate.label} has already been run`)
  const volumeL = ctx.quantity(p.volume ?? '2 uL', 'volume').si * 1000
  if (!(volumeL > 0 && volumeL <= 20e-6)) ctx.refuse('BAD-VOLUME', 'Spot between 0.5 and 20 µL')
  if (liquidVolume(source.contents) < volumeL) ctx.refuse('NOT-ENOUGH', `${source.label} has too little left`)
  const drop = drawProportional(source.contents, volumeL)
  const tlc = (plate.contents.tlc ??= { lanes: {} })
  const spot = (tlc.lanes[String(lane)] ??= {})
  for (const [s, n] of Object.entries(drop.species)) if (n > 0) spot[s] = (spot[s] ?? 0) + n
  addOrigins(plate, source)
  return { outputs: {}, facts: { lane, volumeL } }
}

/**
 * Develop a TLC plate in a chamber of eluent until the solvent front has run `front` from the
 * origin. If the eluent stands higher than the origin, the spots dissolve into it instead.
 */
function develop(ctx: OpContext, p: Params): OpResult {
  const plate = ctx.container(p.plate, 'plate')
  if (ctx.cat.property(plate.equipment, 'tlc') !== true) ctx.refuse('NOT-A-TLC-PLATE', `${plate.label} is not a TLC plate`)
  const chamber = ctx.container(p.chamber, 'chamber')
  const tlc = (plate.contents.tlc ??= { lanes: {} })
  if (tlc.developed) ctx.refuse('ALREADY-DEVELOPED', `${plate.label} has already been run`)
  const eluent = meanLayer(chamber.contents)
  const strength = eluentStrength(ctx.cat, eluent.species)
  if (strength === undefined) ctx.refuse('NOT-AN-ELUENT', `${chamber.label} holds no eluent`)
  const length = Number(ctx.cat.property(plate.equipment, 'lengthMm') ?? 70)
  const origin = Number(ctx.cat.property(plate.equipment, 'originMm') ?? 10)
  const front = ctx.quantity(p.front ?? '50 mm', 'length').si * 1000
  if (!(front > 5 && front <= length - origin - 2)) ctx.refuse('BAD-FRONT', `Let the front run 5 to ${length - origin - 2} mm on this plate`)
  const areaCm2 = Number(ctx.cat.property(chamber.equipment, 'areaCm2') ?? 20)
  const depthMm = (liquidVolume(chamber.contents) * 1e6) / areaCm2 / 100
  let washed = false
  if (depthMm >= origin) {
    // The spots sit below the solvent: they dissolve into it.
    washed = true
    const top = chamber.contents.layers[0]
    for (const spot of Object.values(tlc.lanes)) for (const [s, n] of Object.entries(spot)) top.species[s] = (top.species[s] ?? 0) + n
    tlc.lanes = {}
  }
  const rng = ctx.rng('tlc')
  const positions: Record<string, Record<string, number>> = {}
  for (const [lane, spot] of Object.entries(tlc.lanes)) {
    positions[lane] = {}
    for (const s of Object.keys(spot)) {
      const r = rf(ctx.cat, s, strength!)
      if (r === undefined) continue
      positions[lane][s] = Math.max(0, Math.min(front, r * front + rng.normal(0, 0.6 * ctx.options.noise)))
    }
  }
  tlc.developed = { frontMm: front, positions }
  // About a minute per centimetre.
  advance(ctx.world, ctx.cat, (front / 10) * 60)
  return { outputs: { front: `${front} mm` }, facts: { strength: strength!, washed, depthMm } }
}

/** Blot an SDS gel onto a membrane: every lane's protein bands, at their positions. */
function blot(ctx: OpContext, p: Params): OpResult {
  const gel = ctx.container(p.gel, 'gel')
  if (gel.kind !== 'plate' || ctx.cat.property(gel.equipment, 'gel') !== true) ctx.refuse('NOT-A-GEL', `${gel.label} is not a gel`)
  const membrane = ctx.container(p.membrane, 'membrane')
  if (ctx.cat.property(membrane.equipment, 'membrane') !== true) ctx.refuse('NOT-A-MEMBRANE', `${membrane.label} is not a blotting membrane`)
  if (membrane.contents.blot) ctx.refuse('ALREADY-BLOTTED', `${membrane.label} already carries a blot`)
  const matrix = gelMatrix(ctx.cat, gel.equipment)
  if (matrix.kind !== 'acrylamide') ctx.refuse('NOT-A-PROTEIN-GEL', 'Only protein (SDS-polyacrylamide) gels are blotted here')
  const lengthMm = Number(ctx.cat.property(gel.equipment, 'lengthMm') ?? 65)
  const bands: NonNullable<Container['contents']['blot']>['bands'] = []
  for (const w of gel.wells ?? []) {
    const lane = Number(ctx.world.containers[w].position?.replace(/^[A-Z]/, '') ?? 0)
    for (const b of bandsFromLane(ctx.cat, ctx.world.containers[w].contents, matrix, lengthMm)) {
      bands.push({ lane, positionMm: b.positionMm, species: b.species, bound: {}, ...(b.prestained ? { prestained: true } : {}) })
    }
  }
  membrane.contents.blot = { bands }
  // About an hour in the tank.
  advance(ctx.world, ctx.cat, 3600)
  return { outputs: {}, facts: { bands: bands.length } }
}

/** Colour deposited per band (mol) that shows faintly, clearly and darkly. */
const BLOT_FAINT = 1e-10
const BLOT_CLEAR = 1e-9
const BLOT_DARK = 1e-8
/** A band is about 0.05 cm2 of membrane; it must stand out against the background there. */
const BAND_AREA_CM2 = 0.05

/**
 * Develop a blot that lies in a chromogenic substrate for `duration`, then photograph it: bands
 * where bound enzyme deposited colour (and the prestained marker), against the background.
 */
function detect(ctx: OpContext, p: Params): OpResult {
  const membrane = ctx.container(p.membrane, 'membrane')
  if (!membrane.contents.blot) ctx.refuse('NOT-BLOTTED', `${membrane.label} has nothing blotted on it`)
  const seconds = ctx.quantity(p.duration ?? '5 min', 'time', 'duration').si
  const liquid = meanLayer(membrane.contents)
  // Colour forms only where an enzyme's substrates are in the liquid.
  const substrateIn = Object.keys(liquid.species).some((s) => (liquid.species[s] ?? 0) > 0 && [...ctx.cat.substances.values()].some((d) => d.enzyme?.substrates.includes(s)))
  advance(ctx.world, ctx.cat, seconds)
  const area = Number(ctx.cat.property(membrane.equipment, 'surfaceAreaCm2') ?? 48)
  const blotState = membrane.contents.blot!
  const developed = substrateIn ? developBlot(ctx.cat, membrane.contents, seconds, area) : { signals: blotState.bands.map(() => 0), backgroundPerCm2: blotState.background ?? 0 }
  const floor = 3 * developed.backgroundPerCm2 * BAND_AREA_CM2
  const bands: NonNullable<MeasurementRecord['bands']> = []
  const rng = ctx.rng('blot')
  blotState.bands.forEach((b, i) => {
    const s = developed.signals[i] ?? 0
    const shows = b.prestained || (s >= BLOT_FAINT && s > floor)
    if (!shows) return
    const intensity = b.prestained ? 'clear' : s >= BLOT_DARK ? 'saturated' : s >= BLOT_CLEAR ? 'bright' : 'faint'
    bands.push({ lane: `${membrane.id}#${b.lane}`, positionMm: Math.round((b.positionMm + rng.normal(0, 0.2 * ctx.options.noise)) * 10) / 10, intensity })
  })
  const lanes = [...new Set(blotState.bands.map((b) => b.lane))].sort((a, b) => a - b)
  const parts = lanes.map((l) => {
    const mine = bands.filter((b) => b.lane === `${membrane.id}#${l}`).sort((a, b) => a.positionMm - b.positionMm)
    return `lane ${l}: ${mine.length ? mine.map((b) => `${b.intensity} band at ${b.positionMm.toFixed(1)} mm`).join(', ') : 'no bands'}`
  })
  const bg = developed.backgroundPerCm2 * BAND_AREA_CM2
  // Against the faintest band one could see: five times that over a band's area is a dark membrane.
  const background = bg >= 5 * BLOT_FAINT ? 'a dark background over the whole membrane' : bg >= 0.5 * BLOT_FAINT ? 'a grey background' : 'a clean background'
  const record: MeasurementRecord = {
    id: ctx.newId('m'),
    event: ctx.eventIndex,
    timeS: ctx.world.timeS,
    instrument: membrane.id,
    settings: { blot: 1, background: bg >= 5 * BLOT_FAINT ? 2 : bg >= 0.5 * BLOT_FAINT ? 1 : 0 },
    subject: membrane.id,
    kind: 'observation',
    quantity: 'appearance',
    unit: 'mm',
    display: { [membrane.id]: `${parts.join('; ')}; ${background}` },
    flags: {},
    uncertainty: { random: 0.2, resolution: 0.1 },
    bands,
  }
  ctx.world.measurements.push(record)
  return { outputs: { record: record.id }, facts: { record: record.id, bands: bands.length, substrate: substrateIn } }
}

/** Distillate collected per step (L), and how fast it comes over (L/s). */
const DISTIL_STEP_L = 0.5e-3
const DISTIL_RATE_L_PER_S = 2e-3 / 60
/** What must stay in the pot: never distil to dryness. */
const POT_RESIDUE_L = 5e-3

/**
 * Distil from a flask into a receiver until `volume` has been collected. The vapour's make-up
 * follows the catalogue's vapour-liquid equilibrium for the pot's light component, enriched
 * further by a fractionating column's theoretical plates; the pot is depleted step by step, so
 * later distillate is poorer and the still head hotter. The head temperatures are recorded.
 */
function distil(ctx: OpContext, p: Params): OpResult {
  const flask = ctx.container(p.flask, 'flask')
  const receiver = ctx.container(p.receiver, 'receiver')
  if (flask.id === receiver.id) ctx.refuse('SAME-CONTAINER', 'Collect the distillate in another vessel')
  requireOpen(ctx, receiver)
  const volumeL = ctx.quantity(p.volume, 'volume').si * 1000
  if (!(volumeL > 0)) ctx.refuse('BAD-VOLUME', 'Collect a positive volume')
  if (liquidVolume(flask.contents) - volumeL < POT_RESIDUE_L) ctx.refuse('TO-DRYNESS', `Leave at least ${POT_RESIDUE_L * 1000} mL in ${flask.label}: never distil to dryness`)
  if (liquidVolume(receiver.contents) + volumeL > receiver.capacityL * (1 + 1e-9)) ctx.refuse('OVERFLOW', `${receiver.label} cannot take ${volumeL * 1000} mL more`)
  const column = p.column === undefined || p.column === null ? undefined : ctx.equipment(p.column, 'column')
  const stages = 1 + (column ? Number(ctx.cat.property(column.equipment, 'theoreticalPlates') ?? 0) : 0)
  relaxLayers(flask.contents, 1)
  const pot = flask.contents.layers[0]
  const vle = vleFor(ctx.cat, pot)
  let collected = 0
  let light = 0
  const heads: number[] = []
  while (collected < volumeL - 1e-12) {
    const dV = Math.min(DISTIL_STEP_L, volumeL - collected)
    const nL = vle ? (pot.species[vle.light] ?? 0) : 0
    const nW = waterMol(ctx.cat, pot)
    const x = vle && nL + nW > 0 ? nL / (nL + nW) : 0
    const y = vle ? vapourAfter(vle, x, stages) : 0
    heads.push(vle ? boilingK(vle, y) : 373.15)
    // Moles in dV of condensate of composition y (volumes additive).
    const vl = vle ? molarVolume(ctx.cat, vle.light) : WATER_MOLAR_L
    const n = dV / (y * vl + (1 - y) * WATER_MOLAR_L)
    const takeLight = Math.min(nL, n * y)
    if (vle) pot.species[vle.light] = nL - takeLight
    pot.volumeL -= dV
    light += takeLight
    collected += dV
  }
  const condensate: Layer = { volumeL: collected, species: vle && light > 0 ? { [vle.light]: light } : {} }
  const t0 = receiver.contents.temperatureK
  const before = liquidVolume(receiver.contents)
  addOnTop(receiver.contents, condensate, 1)
  // The condensate arrives cooled to the room.
  const room = (ctx.world.places[receiver.place] ?? ctx.world.places.bench).temperatureK
  receiver.contents.temperatureK = (t0 * before + room * collected) / (before + collected)
  addOrigins(receiver, flask)
  ctx.world.provenance.push({ event: ctx.eventIndex, from: flask.id, to: receiver.id, volumeL: collected, kind: 'transfer' })
  advance(ctx.world, ctx.cat, collected / DISTIL_RATE_L_PER_S)
  const potX = vle ? (pot.species[vle.light] ?? 0) / ((pot.species[vle.light] ?? 0) + waterMol(ctx.cat, pot)) : 0
  flask.contents.temperatureK = vle ? boilingK(vle, potX) : 373.15
  const start = Math.round((heads[0] - 273.15) * 10) / 10
  const end = Math.round((heads[heads.length - 1] - 273.15) * 10) / 10
  const record: MeasurementRecord = {
    id: ctx.newId('m'),
    event: ctx.eventIndex,
    timeS: ctx.world.timeS,
    instrument: flask.id,
    settings: { stages },
    subject: receiver.id,
    kind: 'scalar',
    quantity: 'temperature',
    unit: 'Cel',
    value: end,
    range: [start, end],
    display: { [receiver.id]: `still head ${start.toFixed(1)}–${end.toFixed(1)} °C while ${(collected * 1000).toFixed(1)} mL came over` },
    flags: {},
    uncertainty: { resolution: 0.1 },
  }
  ctx.world.measurements.push(record)
  return { outputs: { record: record.id, headStart: `${start} Cel`, headEnd: `${end} Cel` }, facts: { record: record.id, stages, collectedL: collected } }
}

/** Less liquid than this (a microlitre) left in an evaporating flask counts as none. */
const RESIDUE_L = 1e-6

/** Of the lower layer, what is left above the tap when it is closed at the interface. */
const TAP_HOLDUP_L = 0.3e-3

/**
 * Run liquid out of the bottom of a separating funnel through its tap: by default the lower layer,
 * the tap closed as the interface reaches it (a little of that layer stays behind); with a volume,
 * that much from the bottom, through the interface if it comes to that. Air must get in at the
 * top, so the stopper has to be out.
 */
function drain(ctx: OpContext, p: Params): OpResult {
  const funnel = ctx.container(p.funnel, 'funnel')
  if (ctx.cat.property(funnel.equipment, 'tap') !== true) ctx.refuse('NO-TAP', `${funnel.label} has no tap: pour from it instead`)
  const receiver = ctx.container(p.receiver, 'receiver')
  if (receiver.id === funnel.id) ctx.refuse('SAME-CONTAINER', 'Run it into another vessel')
  requireOpen(ctx, receiver)
  if (!funnel.open) ctx.refuse('STOPPERED', `Take the stopper out of ${funnel.label} first: with no air getting in at the top, nothing runs out`)
  const total = liquidVolume(funnel.contents)
  if (!(total > 0)) ctx.refuse('EMPTY', `${funnel.label} is empty`)
  const layers = funnel.contents.layers
  let volumeL: number
  if (p.volume !== undefined && p.volume !== null) volumeL = Math.min(total, ctx.quantity(p.volume, 'volume', 'volume').si * 1000)
  else {
    const lower = layers[layers.length - 1].volumeL
    const holdup = Number(ctx.cat.property(funnel.equipment, 'tapHoldupML') ?? TAP_HOLDUP_L * 1000) * 1e-3
    // Where the tap is closed is a judgement: a little more or less of the lower layer stays.
    const left = holdup * Math.max(0.2, 1 + ctx.options.handlingError * ctx.rng('interface').normal(0, 0.4))
    volumeL = layers.length > 1 ? Math.max(0, lower - left) : total
  }
  if (!(volumeL > 0)) ctx.refuse('BAD-VOLUME', 'Nothing to run off')
  const before = liquidVolume(receiver.contents)
  if (before + volumeL > receiver.capacityL * (1 + 1e-9)) ctx.refuse('OVERFLOW', `${receiver.label} cannot take ${(volumeL * 1000).toFixed(1)} mL more`, { capacity: receiver.capacityL })
  // From the bottom: the layers turned over, drawn from the top, turned back.
  funnel.contents.layers.reverse()
  const out = drawFromTop(funnel.contents, volumeL)
  funnel.contents.layers.reverse()
  const tF = funnel.contents.temperatureK
  const tR = receiver.contents.temperatureK
  addOnTop(receiver.contents, out, samePhase(ctx.cat, out, receiver.contents.layers[0]) ? 0.6 : 0)
  receiver.contents.temperatureK = (tR * before + tF * out.volumeL) / (before + out.volumeL)
  addOrigins(receiver, funnel)
  ctx.world.provenance.push({ event: ctx.eventIndex, from: funnel.id, to: receiver.id, volumeL: out.volumeL, kind: 'transfer' })
  return { outputs: { drained: `${out.volumeL * 1000} mL` }, facts: { drainedL: out.volumeL, layersBefore: layers.length, organic: isOrganic(ctx.cat, out) } }
}

/**
 * Rotary evaporation: the flask turns in a warm bath under reduced pressure. Solvents boiling below
 * the evaporator's limit (at 1 atm) distil off at its solvent rate, a solvent layer taking the water
 * it holds with it; water standing as a layer of its own evaporates only at the slower water rate.
 * What does not evaporate is left behind, as a solid once no liquid holds it.
 */
function concentrate(ctx: OpContext, p: Params): OpResult {
  const flask = ctx.container(p.flask, 'flask')
  const ev = ctx.equipment(p.evaporator, 'evaporator')
  if (ctx.cat.property(ev.equipment, 'evaporator') !== true) ctx.refuse('NOT-AN-EVAPORATOR', `${ev.label} cannot evaporate a solvent`)
  const duration = ctx.optionalQuantity(p.duration, 'time', 'duration')?.si ?? 600
  if (!(duration > 0)) ctx.refuse('BAD-DURATION', 'Run it for some time')
  const limitK = parseValue(String(ctx.cat.property(ev.equipment, 'boilsBelow') ?? '90 Cel')).si
  let solventBudget = Number(ctx.cat.property(ev.equipment, 'solventRateMLPerMin') ?? 10) * 1e-3 * (duration / 60)
  let waterBudget = Number(ctx.cat.property(ev.equipment, 'waterRateMLPerMin') ?? 0.3) * 1e-3 * (duration / 60)
  const volatile = (s: string): boolean => {
    const bp = ctx.cat.substances.get(s)?.physical?.boilingPoint
    return !!bp && parseValue(bp).si <= limitK
  }
  const start = liquidVolume(flask.contents)
  const kept: Layer[] = []
  // Solvent layers first (the evaporator takes the lighter, more volatile liquid first).
  const order = [...flask.contents.layers].sort((a, b) => Number(isOrganic(ctx.cat, b)) - Number(isOrganic(ctx.cat, a)))
  for (const l of order) {
    const organic = isOrganic(ctx.cat, l)
    for (const [s, n] of Object.entries(l.species)) {
      if (!(n > 0) || !volatile(s)) continue
      const v = molarVolume(ctx.cat, s)
      const take = Math.min(n, solventBudget / v)
      l.species[s] = n - take
      l.volumeL -= take * v
      solventBudget -= take * v
    }
    const stillVolatile = Object.entries(l.species).some(([s, n]) => n > 1e-12 && volatile(s))
    const water = waterMol(ctx.cat, l) * WATER_MOLAR_L
    if (organic && !stillVolatile) l.volumeL -= water
    else if (!stillVolatile) {
      const w = Math.min(water, waterBudget)
      l.volumeL -= w
      waterBudget -= w
    }
    if (l.volumeL <= RESIDUE_L) {
      // No more than a smear of liquid left: what it held is left on the glass.
      for (const [s, n] of Object.entries(l.species)) if (n > 1e-15 && !volatile(s)) flask.contents.solid[s] = (flask.contents.solid[s] ?? 0) + n
      continue
    }
    kept.push(l)
  }
  flask.contents.layers = flask.contents.layers.filter((l) => kept.includes(l))
  equilibrateWithHeat(ctx.cat, flask.contents, 1)
  advance(ctx.world, ctx.cat, duration)
  const left = liquidVolume(flask.contents)
  return { outputs: { remaining: `${left * 1000} mL` }, facts: { removedL: start - left, remainingL: left, dry: left <= 1e-9 } }
}

/** The chromatogram's resolution (L of eluate per point). */
const TRACE_STEP_L = 0.02e-3

/** Local maxima of a trace above a share of its highest point, refined by a parabola through each and its neighbours. */
function tracePeaks(xs: number[], ys: number[], share = 0.03): number[] {
  const top = Math.max(...ys)
  if (!(top > 0)) return []
  const out: number[] = []
  for (let i = 1; i < ys.length - 1; i++) {
    if (!(ys[i] > ys[i - 1] && ys[i] >= ys[i + 1]) || ys[i] < share * top) continue
    const d = ys[i - 1] - 2 * ys[i] + ys[i + 1]
    const shift = d !== 0 ? (0.5 * (ys[i - 1] - ys[i + 1])) / d : 0
    out.push(Number((xs[i] + shift * (xs[i + 1] - xs[i])).toFixed(3)))
  }
  return out
}

/**
 * An analytical size-exclusion run: a sample injected on a column and eluted with buffer past a UV
 * monitor, which records absorbance (mAU) against the volume passed at each of its wavelengths.
 * Each solute comes off as a Gaussian band centred on its elution volume (size-exclusion model)
 * and shows in proportion to its molar absorption coefficient at that wavelength. The sample goes
 * to waste; the column is ready for the next run.
 */
function chromatograph(ctx: OpContext, p: Params): OpResult {
  const column = ctx.container(p.column, 'column')
  if (!ctx.cat.isA(column.equipment, 'core:sec-column')) ctx.refuse('NOT-A-SEC-COLUMN', `${column.label} is not a size-exclusion column`)
  const sample = ctx.container(p.sample, 'sample')
  requireOpen(ctx, sample)
  const monitor = ctx.equipment(p.detector, 'detector')
  if (ctx.cat.property(monitor.equipment, 'uvMonitor') !== true) ctx.refuse('NOT-A-MONITOR', `${monitor.label} does not monitor absorbance`)
  const offered = String(ctx.cat.property(monitor.equipment, 'wavelengths') ?? '280').split(/\s+/).map(Number)
  const wavelengths = (Array.isArray(p.wavelengths) ? p.wavelengths : [p.wavelengths ?? 280]).map((w) => Number(String(w).replace(/\s*nm$/, '')))
  for (const nm of wavelengths) if (!offered.includes(nm)) ctx.refuse('WAVELENGTH', `${monitor.label} reads at ${offered.join(', ')} nm only`)
  const spec = columnSpec(ctx.cat, column.equipment)
  const sampleL = ctx.quantity(p.volume, 'volume', 'volume').si * 1000
  const loopL = Number(ctx.cat.property(monitor.equipment, 'maxInjectionML') ?? 0.5) * 1e-3
  if (!(sampleL > 0) || sampleL > loopL * (1 + 1e-9)) ctx.refuse('INJECTION', `Inject between 0 and ${loopL * 1000} mL`)
  if (liquidVolume(sample.contents) - sample.deadVolumeL < sampleL - 1e-12) ctx.refuse('NOT-ENOUGH', `${sample.label} has too little to inject`)
  const runVolumeL = (ctx.optionalQuantity(p.runVolume, 'volume', 'runVolume')?.si ?? (spec.totalL + 2e-3) / 1000) * 1000
  const injected = drawProportional(sample.contents, sampleL)
  addOrigins(column, sample)
  const pathCm = Number(ctx.cat.property(monitor.equipment, 'pathCm') ?? 0.2)
  const bands = Object.entries(injected.species)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => {
      const ve = elutionVolume(spec, molarMass(ctx.cat, s) ?? 100)
      return { s, n, ve, sigma: Math.sqrt((ve / Math.sqrt(spec.plates)) ** 2 + (sampleL * sampleL) / 12) }
    })
  const rng = ctx.rng('uv-monitor')
  const volumes: number[] = []
  for (let v = 0; v <= runVolumeL + 1e-12; v += TRACE_STEP_L) volumes.push(v)
  const series: Record<string, number[]> = {}
  const peaks: Record<string, number[]> = {}
  const apex: Record<string, number> = {}
  const xs = volumes.map((v) => Number((v * 1000).toFixed(3)))
  for (const nm of wavelengths) {
    const key = `A${nm}`
    const trace = volumes.map((v) => {
      let a = 0
      for (const b of bands) {
        const eps = epsilon(ctx.cat, b.s, nm)
        if (!(eps > 0)) continue
        const z = (v - b.ve) / b.sigma
        if (Math.abs(z) > 8) continue
        a += eps * pathCm * ((b.n * Math.exp(-0.5 * z * z)) / (b.sigma * Math.sqrt(2 * Math.PI)))
      }
      return Number((1000 * a + rng.normal(0, 0.15 * ctx.options.noise)).toFixed(2))
    })
    series[key] = trace
    peaks[key] = tracePeaks(xs, trace)
    apex[key] = xs[trace.indexOf(Math.max(...trace))]
  }
  const record: MeasurementRecord = {
    id: ctx.newId('m'),
    event: ctx.eventIndex,
    timeS: ctx.world.timeS,
    instrument: monitor.id,
    settings: { injectedML: sampleL * 1000, pathCm, column: column.equipment },
    subject: column.id,
    kind: 'series',
    quantity: 'absorbance',
    unit: 'mAU',
    axis: { label: 'elution volume', unit: 'mL', values: xs },
    series,
    peaks,
    display: Object.fromEntries(wavelengths.map((nm) => [`A${nm}`, `peaks at ${peaks[`A${nm}`].map((v) => v.toFixed(2)).join(', ') || 'none'} mL`])),
    flags: {},
    uncertainty: { resolution: TRACE_STEP_L * 1000 },
  }
  ctx.world.measurements.push(record)
  ctx.world.provenance.push({ event: ctx.eventIndex, from: sample.id, to: column.id, volumeL: sampleL, kind: 'transfer' })
  advance(ctx.world, ctx.cat, (runVolumeL * 1000) / Number(ctx.cat.property(monitor.equipment, 'flowMLPerMin') ?? 0.5) * 60)
  return { outputs: { record: record.id, peaks, apex }, facts: { record: record.id, bands: bands.length } }
}

export const SEPARATION_OPERATIONS: Record<string, OpImpl> = {
  'core:chromatograph': chromatograph,
  'core:drain': drain,
  'core:concentrate': concentrate,
  'core:distil': distil,
  'core:blot': blot,
  'core:detect': detect,
  'core:spot': spotPlate,
  'core:develop': develop,
  'core:wash': wash,
  'core:filter': filter,
  'core:elute': elute,
}
