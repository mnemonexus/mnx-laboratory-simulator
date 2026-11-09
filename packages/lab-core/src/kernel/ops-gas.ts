// Gas operations (models/gases.ts, models/ionic.ts): where a reaction's gas goes, and the classic
// tests for what it is. A bung with a gas syringe collects it to be measured; a delivery tube
// bubbles it through another liquid (limewater); open, it fills the headspace and airs out, where a
// lighted or glowing splint, or damp litmus paper, meets it.
import { type OpContext, type OpImpl, type OpResult } from './kernel.ts'
import { type Container, liquidVolume, type MeasurementRecord, meanLayer } from './state.ts'
import { gasVolumeL, headspaceFractions } from '../models/gases.ts'
import { ionicEquilibrium, layerTotals } from '../models/ionic.ts'
import { HYDROGEN } from '../models/surface.ts'

type Params = Record<string, unknown>
const CO2 = 'aq:carbon-dioxide'
const R = 8.314462618

/** Send a vessel's gas to a gas syringe, through a delivery tube into another liquid, or (neither) back to the room. */
function connectGas(ctx: OpContext, p: Params): OpResult {
  const c = ctx.container(p.container)
  const g = (c.gas ??= {})
  if (p.syringe !== undefined && p.syringe !== null) {
    const syringe = ctx.equipment(p.syringe, 'syringe')
    if (!ctx.cat.isA(syringe.equipment, 'core:gas-syringe')) ctx.refuse('NOT-A-GAS-SYRINGE', `${syringe.label} is not a gas syringe`)
    g.to = { kind: 'syringe', instrument: syringe.id }
    g.collectedMol = {}
    c.open = false
    return { facts: { to: syringe.id } }
  }
  if (p.into !== undefined && p.into !== null) {
    const target = ctx.container(p.into, 'into')
    if (target.id === c.id) ctx.refuse('SAME-CONTAINER', 'The delivery tube must lead into another vessel')
    if (!(liquidVolume(target.contents) > 0)) ctx.refuse('NOTHING-TO-BUBBLE-THROUGH', `${target.label} holds no liquid for the gas to bubble through`)
    g.to = { kind: 'liquid', container: target.id }
    c.open = false
    return { facts: { to: target.id } }
  }
  delete g.to
  delete g.collectedMol
  c.open = true
  return { facts: { to: 'room' } }
}

/** Partial pressure (atm) of a gas over the liquid from its Henry's law constant and the free aqueous species. */
function vapourPressure(ctx: OpContext, c: Container, gas: string): number {
  const def = ctx.cat.substances.get(gas)?.gas
  if (!def?.species || !(liquidVolume(c.contents) > 0)) return 0
  const T = c.contents.temperatureK
  const layer = meanLayer(c.contents)
  let free = 0
  try {
    const r = ionicEquilibrium(ctx.cat, layerTotals(layer), T)
    free = r.species.filter((x) => x.name === def.species).reduce((a, x) => a + x.conc, 0)
  } catch {
    return 0
  }
  // Henry's constant falls as the liquid warms (exothermic solution): the gas comes off.
  const kH = def.henry * Math.exp(((-(def.dH ?? 0) * 1000) / R) * (1 / T - 1 / 298.15)) / 1
  return kH > 0 ? free / kH : 0
}

/**
 * A gas test at the mouth of a vessel: a lighted splint (hydrogen pops; carbon dioxide puts it
 * out), a glowing splint (oxygen relights it), damp red litmus (ammonia turns it blue), damp blue
 * litmus (acid gases turn it red). What is seen, never what it is.
 */
function testGas(ctx: OpContext, p: Params): OpResult {
  const c = ctx.container(p.container)
  const test = String(p.test ?? '')
  const x = headspaceFractions(ctx.cat, c)
  const h2 = x[HYDROGEN] ?? 0
  const co2 = x[CO2] ?? 0
  const o2 = x['core:oxygen'] ?? 0
  // Chlorine turns damp litmus red, then bleaches it.
  const cl2 = x['core:chlorine'] ?? 0
  let seen: string
  switch (test) {
    case 'lighted-splint':
      // At the mouth the gas meets the room's air: any hydrogen above its lower flammable limit pops.
      seen = h2 >= 0.04 ? 'a squeaky pop' : co2 >= 0.3 ? 'the flame goes out' : 'the splint burns on, no pop'
      break
    case 'glowing-splint':
      seen = o2 >= 0.4 ? 'the splint relights' : co2 >= 0.3 ? 'the glow goes out' : 'the splint keeps glowing, but does not relight'
      break
    case 'damp-red-litmus': {
      const nh3 = vapourPressure(ctx, c, 'aq:ammonia-gas')
      seen = cl2 >= 0.01 ? 'the paper is bleached white' : nh3 >= 2e-4 ? 'the paper turns blue' : 'the paper stays red'
      break
    }
    case 'damp-blue-litmus': {
      const hcl = vapourPressure(ctx, c, 'aq:hydrogen-chloride-gas')
      seen = cl2 >= 0.01 ? 'the paper turns red, then is bleached white' : hcl >= 1e-4 || co2 >= 0.5 ? 'the paper turns red' : 'the paper stays blue'
      break
    }
    default:
      ctx.refuse('UNKNOWN-TEST', `No gas test called "${test}": use lighted-splint, glowing-splint, damp-red-litmus or damp-blue-litmus`)
  }
  const record: MeasurementRecord = {
    id: ctx.newId('m'),
    event: ctx.eventIndex,
    timeS: ctx.world.timeS,
    instrument: test,
    settings: {},
    subject: c.id,
    kind: 'observation',
    quantity: 'appearance',
    unit: '',
    display: { [c.id]: seen! },
    flags: {},
    uncertainty: {},
  }
  ctx.world.measurements.push(record)
  return { outputs: { record: record.id, appearance: seen! }, facts: { record: record.id } }
}

/** Read the gas syringe on a vessel: the volume of gas collected at the room's temperature and 1 atm. */
export function readGasSyringe(ctx: OpContext, instrument: string, c: Container): OpResult {
  const g = c.gas
  if (g?.to?.kind !== 'syringe' || g.to.instrument !== instrument) ctx.refuse('NOT-CONNECTED', `${c.label} is not connected to that syringe`)
  const inst = ctx.equipment(instrument, 'instrument')
  const capacityL = Number(ctx.cat.property(inst.equipment, 'capacityL') ?? 0.1)
  const readL = Number(ctx.cat.property(inst.equipment, 'readabilityL') ?? 0.001)
  let mol = 0
  for (const n of Object.values(g.collectedMol ?? {})) mol += n
  // The syringe sits on the bench, out of any bath: the gas in it is at room temperature.
  const trueL = gasVolumeL(mol, ctx.world.places.bench?.temperatureK ?? 293.15)
  const rng = ctx.rng('gas-syringe')
  const noisy = trueL + rng.normal(0, 0.3 * readL * ctx.options.noise)
  const full = trueL >= capacityL
  const value = full ? capacityL : Math.max(0, Math.round(noisy / readL) * readL)
  // Shown to the syringe's graduations: whole millilitres, or hundredths on a photosynthometer's capillary.
  const places = Math.max(0, Math.ceil(-Math.log10(readL * 1000) - 1e-9))
  const mL = Number((value * 1000).toFixed(places))
  const record: MeasurementRecord = {
    id: ctx.newId('m'),
    event: ctx.eventIndex,
    timeS: ctx.world.timeS,
    instrument,
    settings: {},
    subject: c.id,
    kind: 'scalar',
    quantity: 'volume',
    unit: 'mL',
    value: mL,
    display: { [c.id]: full ? `${mL.toFixed(places)} mL (the plunger is at its stop)` : `${mL.toFixed(places)} mL` },
    flags: full ? { [c.id]: ['saturated'] } : {},
    uncertainty: { resolution: readL * 1000 },
  }
  ctx.world.measurements.push(record)
  return { outputs: { record: record.id, value: `${mL.toFixed(places)} mL` }, facts: { record: record.id, mL } }
}

/**
 * Fit a still head and condenser to a flask, leading into a receiver: while the flask boils, what
 * comes off is condensed into it (models/stillhead.ts). Without a receiver, take it off again and
 * report what came over: the still head's temperatures and the volume collected.
 */
function connectCondenser(ctx: OpContext, p: Params): OpResult {
  const c = ctx.container(p.flask, 'flask')
  if (p.receiver !== undefined && p.receiver !== null) {
    const receiver = ctx.container(p.receiver, 'receiver')
    if (receiver.id === c.id) ctx.refuse('SAME-CONTAINER', 'Collect the distillate in another vessel')
    if (!receiver.open) ctx.refuse('CLOSED', `${receiver.label} is closed: the distillate cannot run in`)
    if (c.gasSample) ctx.refuse('SEALED', `${c.label} is a sealed syringe`)
    c.still = { receiver: receiver.id, collectedL: 0 }
    return { facts: { receiver: receiver.id } }
  }
  const s = c.still
  if (!s) ctx.refuse('NOT-CONNECTED', `${c.label} has no still head on it`)
  delete c.still
  const mL = Math.round((s.collectedL ?? 0) * 1e5) / 100
  const rng = ctx.rng('still-head')
  const read = (k: number | undefined) => (k === undefined ? undefined : Math.round((k - 273.15 + rng.normal(0, 0.3 * ctx.options.noise)) * 10) / 10)
  const start = read(s.headStartK)
  const end = read(s.headEndK)
  const lo = read(s.headMinK)
  const hi = read(s.headMaxK)
  const record: MeasurementRecord = {
    id: ctx.newId('m'),
    event: ctx.eventIndex,
    timeS: ctx.world.timeS,
    instrument: c.id,
    settings: {},
    subject: s.receiver,
    kind: 'scalar',
    quantity: 'temperature',
    unit: 'Cel',
    ...(end !== undefined ? { value: end } : {}),
    ...(lo !== undefined && hi !== undefined ? { range: [lo, hi] as [number, number] } : {}),
    display: { [s.receiver]: lo === undefined ? 'nothing came over' : `still head ${lo.toFixed(1)}–${hi!.toFixed(1)} °C while ${mL.toFixed(1)} mL came over` },
    flags: {},
    uncertainty: { resolution: 0.1 },
  }
  ctx.world.measurements.push(record)
  return {
    outputs: { record: record.id, collected: `${mL} mL`, ...(lo !== undefined ? { headStart: `${start} Cel`, headEnd: `${end} Cel`, headMin: `${lo} Cel`, headMax: `${hi} Cel` } : {}) },
    facts: { record: record.id, collectedL: s.collectedL ?? 0 },
  }
}

export const GAS_OPERATIONS: Record<string, OpImpl> = {
  'core:connect-condenser': connectCondenser,
  'core:connect-gas': connectGas,
  'core:test-gas': testGas,
}
