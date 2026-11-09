// Working under an inert atmosphere (models/gases.ts): a flask sealed with a septum is flushed with
// nitrogen from a balloon (a vent needle letting the air out), and the balloon left on keeps it
// under nitrogen as liquid is drawn out; bubbled through the liquid, the gas also takes out the
// dissolved oxygen. Syringes are flushed from such a flask before use so no air rides in with the
// liquid. A dissolved-oxygen meter shows what all this achieved.
import { type OpContext, type OpImpl, type OpResult } from './kernel.ts'
import { gasParams, headspaceAir, headspaceL, OXYGEN, relaxOxygen } from '../models/gases.ts'
import { advance } from '../models/processes.ts'
import { liquidVolume, meanLayer, type MeasurementRecord, type ToolState } from './state.ts'

type Params = Record<string, unknown>

/** Flush a septum-sealed flask with an inert gas from a balloon, optionally bubbling it through the liquid; the balloon stays on. */
function purge(ctx: OpContext, p: Params): OpResult {
  const c = ctx.container(p.container, 'flask')
  const balloon = ctx.equipment(p.balloon, 'balloon')
  const gas = ctx.cat.property(balloon.equipment, 'inertGas')
  if (typeof gas !== 'string') ctx.refuse('NOT-A-GAS-SOURCE', `${balloon.label} holds no inert gas`)
  if (!c.septum) ctx.refuse('NO-SEPTUM', `Fit a septum to ${c.label} first: the gas goes in through one needle and the air out through another`)
  const duration = ctx.optionalQuantity(p.duration, 'time', 'duration')?.si ?? 120
  if (!(duration > 0)) ctx.refuse('BAD-DURATION', 'Purge for some time')
  const g = gasParams(ctx.cat)
  const tau = g.purgeTauSPer100mL * (headspaceL(c) / 0.1)
  c.headspaceAir = headspaceAir(c) * Math.exp(-duration / tau)
  const sparge = p.sparge === true
  if (sparge && liquidVolume(c.contents) > 0) {
    // Bubbles carry the dissolved oxygen out towards the (now nearly oxygen-free) gas.
    relaxOxygen(ctx.cat, c.contents, c.headspaceAir, 1 - Math.exp(-duration / g.spargeTauS))
  }
  c.balloon = gas
  advance(ctx.world, ctx.cat, duration)
  return { facts: { gas, headspaceAir: c.headspaceAir, sparged: sparge } }
}

/** Flush a syringe: draw gas from a flask's headspace and push it out, three times. */
function flushSyringe(ctx: OpContext, p: Params): OpResult {
  const id = String(p.syringe ?? '')
  const inst = ctx.equipment(p.syringe, 'syringe')
  if (ctx.cat.property(inst.equipment, 'syringe') !== true || inst.state.kind !== 'tool') ctx.refuse('NOT-A-SYRINGE', `${inst.label} is not a syringe`)
  const tool = inst.state as ToolState
  if (tool.discarded) ctx.refuse('DISCARDED', `${inst.label} has been thrown away`)
  const src = ctx.container(p.source, 'source')
  if (!src.septum) ctx.refuse('NO-SEPTUM', `${src.label} has no septum to draw gas through`)
  const air = headspaceAir(src)
  // Drawing gas from a flask without a balloon pulls air in after it.
  if (!src.balloon) src.headspaceAir = Math.min(1, air + (1 - air) * Math.min(1, (3 * Number(ctx.cat.property(inst.equipment, 'capacityML') ?? 10) * 1e-3) / headspaceL(src)))
  tool.flushed = air < 0.05 && src.balloon ? src.balloon : undefined
  return { facts: { syringe: id || inst.id, flushed: tool.flushed ?? 'air' } }
}

/** Dissolved oxygen (mg/L) of a liquid, by a probe dipped into it. */
export function measureDissolvedOxygen(ctx: OpContext, id: string, subjectRef: string): OpResult {
  const c = ctx.container(subjectRef, 'sample')
  if (c.septum || !c.open) ctx.refuse('SEALED', `Open ${c.label} (or transfer a sample) to put the probe in`)
  const v = liquidVolume(c.contents)
  const minL = Number(ctx.cat.property(ctx.world.equipment[id].equipment, 'minVolumeML') ?? 5) * 1e-3
  if (v < minL) ctx.refuse('TOO-LITTLE', `The probe needs at least ${minL * 1000} mL to dip into`)
  const mean = meanLayer(c.contents)
  if (!(OXYGEN in mean.species)) ctx.refuse('NOT-TRACKED', `${c.label} holds nothing whose oxygen is followed here`)
  const trueMgL = ((mean.species[OXYGEN] ?? 0) / mean.volumeL) * 32000
  const reading = Math.max(0, Math.round((trueMgL + ctx.rng('do').normal(0, 0.08 * ctx.options.noise)) * 100) / 100)
  const record: MeasurementRecord = {
    id: ctx.newId('m'),
    event: ctx.eventIndex,
    timeS: ctx.world.timeS,
    instrument: id,
    settings: {},
    subject: c.id,
    kind: 'scalar',
    quantity: 'concentration',
    unit: 'mg/L',
    value: reading,
    display: { [c.id]: `${reading.toFixed(2)} mg/L O₂` },
    flags: {},
    uncertainty: { random: 0.08, resolution: 0.01 },
  }
  ctx.world.measurements.push(record)
  return { outputs: { record: record.id, value: `${reading} mg/L` }, facts: { record: record.id, mgPerL: reading } }
}

export const ATMOSPHERE_OPERATIONS: Record<string, OpImpl> = {
  'core:purge': purge,
  'core:flush-syringe': flushSyringe,
}
