// Gas-law operations (models/gaslaws.ts): trap air in a sealed syringe, hold its plunger at a volume
// or let it go, and read its volume, its pressure (a pressure sensor), or the size of a film spread
// on water (a ruler over a ripple tray).
import { type OpContext, type OpImpl, type OpResult } from './kernel.ts'
import { type Container, liquidVolume, type MeasurementRecord } from './state.ts'
import { airMolIn, gasSampleState, monolayerAreaM2 } from '../models/gaslaws.ts'
import { parseValue } from '../units/index.ts'

type Params = Record<string, unknown>

function sealedSyringe(ctx: OpContext, ref: unknown): Container {
  const c = ctx.container(ref)
  if (ctx.cat.property(c.equipment, 'gasSample') !== true) ctx.refuse('NOT-A-GAS-SYRINGE', `${c.label} cannot hold a sealed sample of gas`)
  return c
}

/** Draw a volume of air into a syringe and seal its nozzle (with any liquid or solid already in it). */
function trapAir(ctx: OpContext, p: Params): OpResult {
  const c = sealedSyringe(ctx, p.container)
  const v = ctx.quantity(p.volume, 'volume', 'volume').si * 1000
  const room = c.capacityL - liquidVolume(c.contents)
  if (!(v > 0) || v > room + 1e-12) ctx.refuse('BAD-VOLUME', `Draw in more than 0 and at most ${(room * 1000).toFixed(0)} mL of air`)
  // At the syringe's own temperature (room air, or a tube's screw clip closed in a warm bath).
  c.gasSample = { airMol: airMolIn(v, c.contents.temperatureK) }
  // Its rubber cap: sealed, but a hypodermic needle can pass through it.
  c.open = false
  c.septum = true
  return { facts: { airMol: c.gasSample.airMol } }
}

/** Hold the plunger at a volume (squeezing or pulling the gas), or (no volume) let it go free at atmospheric pressure. */
function holdPlunger(ctx: OpContext, p: Params): OpResult {
  const c = sealedSyringe(ctx, p.container)
  if (!c.gasSample) ctx.refuse('NO-GAS', `Draw some air into ${c.label} and seal it first`)
  if (p.volume === undefined || p.volume === null) {
    delete c.gasSample.fixedL
    return {}
  }
  const v = ctx.quantity(p.volume, 'volume', 'volume').si * 1000
  const liquid = liquidVolume(c.contents)
  if (!(v > 0.05 * c.capacityL) || v + liquid > c.capacityL + 1e-12) ctx.refuse('BAD-VOLUME', `Hold the plunger between ${(0.05 * c.capacityL * 1000).toFixed(0)} and ${((c.capacityL - liquid) * 1000).toFixed(0)} mL`)
  c.gasSample.fixedL = v
  return { facts: { volumeL: v } }
}

/** The gas volume on a sealed syringe's scale. */
export function readGasSample(ctx: OpContext, c: Container): OpResult {
  const s = gasSampleState(ctx.cat, c)
  const resText = ctx.cat.property(c.equipment, 'resolution')
  const step = resText !== undefined ? parseValue(String(resText)).si * 1e6 : 1
  const read = s.volumeL * 1000 + ctx.options.handlingError * ctx.rng('gas-scale').normal(0, step / 4)
  const decimals = Math.max(0, Math.ceil(-Math.log10(step) - 1e-9))
  const mL = Number((Math.round(read / step) * step).toFixed(decimals))
  const record: MeasurementRecord = {
    id: ctx.newId('m'),
    event: ctx.eventIndex,
    timeS: ctx.world.timeS,
    instrument: c.id,
    settings: { scale: 'gas' },
    subject: c.id,
    kind: 'scalar',
    quantity: 'volume',
    unit: 'mL',
    value: mL,
    display: { [c.id]: s.atStop ? `${mL.toFixed(decimals)} mL (the plunger is at its stop)` : `${mL.toFixed(decimals)} mL` },
    flags: s.atStop ? { [c.id]: ['saturated'] } : {},
    uncertainty: { resolution: step },
  }
  ctx.world.measurements.push(record)
  return { outputs: { record: record.id, value: `${mL} mL` }, facts: { record: record.id, mL } }
}

/** A pressure sensor on a sealed syringe: kPa, to 0.1 kPa. */
export function measurePressure(ctx: OpContext, id: string, c: Container): OpResult {
  if (!c.gasSample) ctx.refuse('NO-GAS', `${c.label} holds no sealed gas for the sensor to read`)
  const s = gasSampleState(ctx.cat, c)
  const kPa = Math.round((s.pressureKPa + ctx.rng('pressure').normal(0, 0.1 * ctx.options.noise)) * 10) / 10
  const record: MeasurementRecord = {
    id: ctx.newId('m'),
    event: ctx.eventIndex,
    timeS: ctx.world.timeS,
    instrument: id,
    settings: {},
    subject: c.id,
    kind: 'scalar',
    quantity: 'pressure',
    unit: 'kPa',
    value: kPa,
    display: { [c.id]: `${kPa.toFixed(1)} kPa` },
    flags: {},
    uncertainty: { random: 0.1, resolution: 0.1 },
  }
  ctx.world.measurements.push(record)
  return { outputs: { record: record.id, value: `${kPa} kPa` }, facts: { record: record.id, kPa } }
}

/** A ruler over a tray of water: the diameter of a film spread on it, to the nearest 0.5 cm (its edge is a little ragged). */
export function measureFilm(ctx: OpContext, id: string, c: Container): OpResult {
  if (ctx.cat.property(c.equipment, 'trough') !== true) ctx.refuse('NOT-A-TRAY', `${ctx.world.equipment[id].label} measures films on a tray of water`)
  const area = monolayerAreaM2(ctx.cat, c.contents)
  const trayM2 = Number(ctx.cat.property(c.equipment, 'areaM2') ?? 0.12)
  const flags: MeasurementRecord['flags'][string] = []
  let cm = 0
  if (area > trayM2) flags.push('saturated')
  else if (area > 0) {
    const d = 2 * Math.sqrt(area / Math.PI) * 100
    cm = Math.round((d * (1 + ctx.rng('film').normal(0, 0.04 * ctx.options.noise))) * 2) / 2
  }
  const text = flags.length ? 'the film covers the whole tray' : cm > 0 ? `a roughly circular film ${cm.toFixed(1)} cm across` : 'no film'
  const record: MeasurementRecord = {
    id: ctx.newId('m'),
    event: ctx.eventIndex,
    timeS: ctx.world.timeS,
    instrument: id,
    settings: {},
    subject: c.id,
    kind: 'scalar',
    quantity: 'length',
    unit: 'cm',
    value: cm,
    display: { [c.id]: text },
    flags: flags.length ? { [c.id]: flags } : {},
    uncertainty: { resolution: 0.5 },
  }
  ctx.world.measurements.push(record)
  return { outputs: { record: record.id, value: `${cm} cm`, appearance: text }, facts: { record: record.id, cm } }
}

export const GASLAW_OPERATIONS: Record<string, OpImpl> = {
  'core:trap-air': trapAir,
  'core:hold-plunger': holdPlunger,
}
