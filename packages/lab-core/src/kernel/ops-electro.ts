// Electrochemistry operations (models/electrochem.ts, models/electrolysis.ts): a salt bridge
// joining two half-cells, a high-resistance voltmeter across two electrodes, a conductivity meter,
// and electrolysis from a power supply between two electrodes on clips.
import { type OpContext, type OpImpl, type OpResult } from './kernel.ts'
import { type Container, liquidVolume, type MeasurementRecord, meanLayer } from './state.ts'
import { conductivityUSPerCm, electrodePotentialV, electrodesIn } from '../models/electrochem.ts'
import { electrolyseStep, FARADAY } from '../models/electrolysis.ts'
import { ionicEquilibrate } from '../models/ionic.ts'
import { advance } from '../models/processes.ts'

type Params = Record<string, unknown>

/** Join two half-cells with a salt bridge (filter paper soaked in potassium nitrate), or (no `to`) take it out. */
function connectBridge(ctx: OpContext, p: Params): OpResult {
  const a = ctx.container(p.from, 'from')
  const unlink = (c: Container) => {
    const other = c.bridge ? ctx.world.containers[c.bridge] : undefined
    if (other?.bridge === c.id) delete other.bridge
    delete c.bridge
  }
  unlink(a)
  if (p.to === undefined || p.to === null) return {}
  const b = ctx.container(p.to, 'to')
  if (b.id === a.id) ctx.refuse('SAME-CONTAINER', 'A salt bridge joins two different vessels')
  for (const c of [a, b]) if (!(liquidVolume(c.contents) > 0)) ctx.refuse('NO-LIQUID', `${c.label} has no solution for the bridge to dip into`)
  unlink(b)
  a.bridge = b.id
  b.bridge = a.id
  return { facts: { from: a.id, to: b.id } }
}

/** The electrode named in a container, or its only metal. */
function electrode(ctx: OpContext, c: Container, named: unknown, param: string): string {
  const metals = electrodesIn(ctx.cat, c.contents)
  if (named !== undefined && named !== null) {
    const id = String(named)
    if (!metals.includes(id)) ctx.refuse('NO-ELECTRODE', `${c.label} has no ${ctx.cat.substances.get(id)?.identity.name ?? id} in it`)
    return id
  }
  if (metals.length === 0) ctx.refuse('NO-ELECTRODE', `${c.label} has no metal electrode in it`)
  if (metals.length > 1) ctx.refuse('WHICH-ELECTRODE', `${c.label} holds more than one metal: name the ${param}`)
  return metals[0]
}

/**
 * A voltmeter's positive lead on the electrode in `subject`, its negative lead on the one in
 * `negative` (the same vessel when not given): the difference of their potentials, read to 1 mV.
 * Two vessels need a salt bridge between them to complete the circuit.
 */
export function measureVoltage(ctx: OpContext, id: string, subject: Container, p: Params): OpResult {
  const other = p.negative === undefined || p.negative === null ? subject : ctx.container(p.negative, 'negative')
  const plus = electrode(ctx, subject, p.electrode, 'electrode')
  const minus = electrode(ctx, other, p.negativeElectrode, 'negativeElectrode')
  if (other === subject && plus === minus) ctx.refuse('SAME-ELECTRODE', 'The two leads need two different electrodes')
  const circuit = other === subject || subject.bridge === other.id
  const flags: MeasurementRecord['flags'][string] = []
  let volts = 0
  if (circuit) {
    const ePlus = electrodePotentialV(ctx.cat, subject.contents, plus)
    const eMinus = electrodePotentialV(ctx.cat, other.contents, minus)
    if (ePlus === undefined || eMinus === undefined) ctx.refuse('DRY-ELECTRODE', 'Both electrodes must dip into a solution')
    volts = ePlus - eMinus + ctx.rng('voltmeter').normal(0, 0.002 * ctx.options.noise)
  } else {
    // An open circuit: the meter wanders about zero.
    volts = ctx.rng('voltmeter').normal(0, 0.003)
    flags.push('unstable')
  }
  const shown = Math.round(volts * 1000) / 1000
  const record: MeasurementRecord = {
    id: ctx.newId('m'),
    event: ctx.eventIndex,
    timeS: ctx.world.timeS,
    instrument: id,
    settings: { positive: `${subject.id}:${plus}`, negative: `${other.id}:${minus}` },
    subject: subject.id,
    kind: 'scalar',
    quantity: 'potential',
    unit: 'V',
    value: shown,
    display: { [subject.id]: circuit ? `${shown.toFixed(3)} V` : `${shown.toFixed(3)} V (no circuit: the reading drifts about zero)` },
    flags: flags.length ? { [subject.id]: flags } : {},
    uncertainty: { random: 0.002, resolution: 0.001 },
  }
  ctx.world.measurements.push(record)
  // Volts, as a number (the units here have no electrical dimension).
  return { outputs: { record: record.id, value: shown }, facts: { record: record.id, volts: shown, circuit } }
}

/** A conductivity meter dipped in a liquid: µS/cm at 25 °C, and the total dissolved solids it implies (0.64 mg/L per µS/cm). */
export function measureConductivity(ctx: OpContext, id: string, c: Container): OpResult {
  const v = liquidVolume(c.contents)
  const minL = Number(ctx.cat.property(ctx.world.equipment[id].equipment, 'minVolumeML') ?? 10) * 1e-3
  if (v < minL) ctx.refuse('TOO-LITTLE', `The cell needs at least ${minL * 1000} mL to dip into`)
  const trueUS = conductivityUSPerCm(ctx.cat, meanLayer(c.contents))
  // ±1 % of the reading, and the last digit of its range: 0.1 µS/cm below 200, 1 µS/cm below 2000, then 0.01 mS/cm.
  const noisy = Math.max(0, trueUS * (1 + ctx.rng('conductivity').normal(0, 0.01 * ctx.options.noise)))
  const step = noisy < 200 ? 0.1 : noisy < 2000 ? 1 : 10
  const uS = Math.round(noisy / step) * step
  const tds = Math.round(0.64 * uS)
  const text = uS < 2000 ? `${uS.toFixed(step < 1 ? 1 : 0)} µS/cm` : `${(uS / 1000).toFixed(2)} mS/cm`
  const record: MeasurementRecord = {
    id: ctx.newId('m'),
    event: ctx.eventIndex,
    timeS: ctx.world.timeS,
    instrument: id,
    settings: { reference: '25 Cel' },
    subject: c.id,
    kind: 'scalar',
    quantity: 'conductivity',
    unit: 'uS/cm',
    value: Number(uS.toFixed(1)),
    display: { [c.id]: `${text}; TDS ${tds} mg/L` },
    flags: {},
    uncertainty: { random: 0.01, resolution: step },
  }
  ctx.world.measurements.push(record)
  // µS/cm and mg/L, as numbers.
  return { outputs: { record: record.id, value: Number(uS.toFixed(1)), tds }, facts: { record: record.id, uSPerCm: uS, tdsMgL: tds } }
}

/** Electrolysis is stepped in pieces this long (s), the other processes advancing between them. */
const ELECTROLYSIS_STEP_S = 10
/** The electrodes' gap (m) and the voltage the electrode reactions themselves take (V). */
const GAP_M = 0.03
const BACK_EMF_V = 2

/** Whether a container holds an electrode: a metal strip or an electrode rod on its clip. */
function isElectrode(ctx: OpContext, c: Container): boolean {
  return Object.entries(c.contents.solid).some(([s, n]) => n > 0 && (!!ctx.cat.substances.get(s)?.metal || !!ctx.cat.substances.get(s)?.electrode))
}

/** Words for what happened at an electrode. */
function describe(ctx: OpContext, made: Record<string, number>): string {
  const seen: string[] = []
  for (const [s, n] of Object.entries(made)) {
    const def = ctx.cat.substances.get(s)
    if (n < -1e-6) seen.push('it wears away')
    else if (!(n > 1e-6)) continue
    else if (def?.physical?.phase === 'gas' || s === 'core:oxygen') seen.push(s === 'core:chlorine' ? 'bubbles of a pale green gas with a sharp smell' : 'bubbles of a colourless gas')
    else if (def?.metal) seen.push(`${def.look?.description ?? 'a deposit'} forms on it`)
    else if (def?.optics?.colour) seen.push(`the liquid round it turns ${def.optics.colour}`)
  }
  return seen.length ? [...new Set(seen)].join('; ') : 'nothing visible'
}

/**
 * Pass a current from a power supply through a cell between two electrodes (each a container
 * holding its strip or rod) for a time. The supply gives the set current unless the liquid conducts
 * too poorly for its voltage. Gas from each electrode can be collected in a tube held over it.
 */
function electrolyse(ctx: OpContext, p: Params): OpResult {
  const supply = ctx.equipment(p.supply, 'supply')
  if (!ctx.cat.isA(supply.equipment, 'core:dc-power-supply')) ctx.refuse('NOT-A-SUPPLY', `${supply.label} is not a power supply`)
  const cell = ctx.container(p.cell, 'cell')
  const anode = ctx.container(p.anode, 'anode')
  const cathode = ctx.container(p.cathode, 'cathode')
  if (anode.id === cathode.id || anode.id === cell.id || cathode.id === cell.id) ctx.refuse('SAME-CONTAINER', 'The cell, the anode and the cathode must be three different things')
  for (const e of [anode, cathode]) if (!isElectrode(ctx, e)) ctx.refuse('NOT-AN-ELECTRODE', `${e.label} holds no electrode: clip a metal strip or a graphite rod into it`)
  if (!(liquidVolume(cell.contents) > 0)) ctx.refuse('NO-ELECTROLYTE', `${cell.label} has no liquid for the electrodes to dip into`)
  const set = ctx.quantity(p.current, 'current', 'current').si
  const duration = ctx.quantity(p.duration, 'time', 'duration').si
  const maxA = Number(ctx.cat.property(supply.equipment, 'maxCurrentA') ?? 3)
  const maxV = Number(ctx.cat.property(supply.equipment, 'maxVoltage') ?? 12)
  if (!(set > 0) || set > maxA) ctx.refuse('BAD-CURRENT', `Set a current above 0 and up to ${maxA} A`)
  if (!(duration > 0) || duration > 86400) ctx.refuse('BAD-DURATION', 'Run it for more than 0 s and at most a day')
  const collector = (ref: unknown, role: string) => (ref === undefined || ref === null ? undefined : ctx.container(ref, role))
  const tubes = { anode: collector(p.anodeGas, 'anodeGas'), cathode: collector(p.cathodeGas, 'cathodeGas') }
  if (tubes.anode && tubes.anode === tubes.cathode) ctx.refuse('SAME-TUBE', 'Each electrode needs its own collecting tube')
  for (const tube of [tubes.anode, tubes.cathode]) {
    if (!tube || tube.gas?.to?.kind === 'syringe') continue
    // Filled with the liquid and upturned over the electrode: no air in it, and the liquid seals it.
    if (!tube.gas?.headspaceMol) tube.headspaceAir = 0
    tube.open = false
  }
  const gasOut = (side: 'anode' | 'cathode', gas: string, mol: number) => {
    const tube = tubes[side]
    if (!tube) {
      ;(cell.contents.evolved ??= {})[gas] = (cell.contents.evolved?.[gas] ?? 0) + mol
      return
    }
    // A tube full of the liquid, upturned over the electrode: the gas collects in it (or, bunged, in its gas syringe).
    const g = (tube.gas ??= {})
    if (g.to?.kind === 'syringe') (g.collectedMol ??= {})[gas] = (g.collectedMol?.[gas] ?? 0) + mol
    else (g.headspaceMol ??= {})[gas] = (g.headspaceMol?.[gas] ?? 0) + mol
  }
  const made = { anode: {} as Record<string, number>, cathode: {} as Record<string, number> }
  let charge = 0
  let lowest = set
  for (let t = 0; t < duration - 1e-9; ) {
    const dt = Math.min(ELECTROLYSIS_STEP_S, duration - t)
    // Ohm's law through the liquid, R = gap / (kappa x area), with what is left of the supply's voltage after the electrode reactions.
    const kappaSPerM = conductivityUSPerCm(ctx.cat, meanLayer(cell.contents)) * 1e-4
    const resistance = GAP_M / Math.max(1e-12, kappaSPerM * 1e-3)
    const current = Math.min(set, (maxV - BACK_EMF_V) / resistance)
    lowest = Math.min(lowest, current)
    const r = electrolyseStep(ctx.cat, cell.contents, anode.contents, cathode.contents, current, dt, gasOut)
    for (const side of ['anode', 'cathode'] as const) for (const [s, n] of Object.entries(r[side].made)) made[side][s] = (made[side][s] ?? 0) + n
    charge += current * dt
    advance(ctx.world, ctx.cat, dt)
    t += dt
  }
  ionicEquilibrate(ctx.cat, cell.contents, 0)
  const short = lowest < 0.98 * set ? 'the current fell short of the setting: the liquid conducts too poorly' : ''
  const amps = charge / duration
  return {
    outputs: { charge: `${charge.toPrecision(4)} C`, current: `${amps.toFixed(3)} A`, anode: describe(ctx, made.anode), cathode: describe(ctx, made.cathode), notes: short },
    facts: { chargeC: charge, electronsMol: charge / FARADAY, anode: made.anode, cathode: made.cathode },
  }
}

export const ELECTRO_OPERATIONS: Record<string, OpImpl> = {
  'core:connect-bridge': connectBridge,
  'core:electrolyse': electrolyse,
}
