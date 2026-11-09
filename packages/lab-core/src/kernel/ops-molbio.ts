// Molecular-biology operations (composition model §5.2): running a thermal-cycler program (read
// after every cycle on a real-time cycler), a melt curve, and running an agarose gel. Loading a gel
// well is an ordinary transfer (see core:transfer).
import { advance } from '../models/processes.ts'
import { gelMatrix, runLane } from '../models/electrophoresis.ts'
import { amplify, lyseCells, type PcrProgram, programDuration } from '../models/pcr.ts'
import { strainDna, strainProteins } from '../models/growth.ts'
import { amplificationReads, baselineCorrect, dyeFactor, meltCurve, quantificationCycle } from '../models/qpcr.ts'
import { type OpContext, type OpImpl, type OpResult } from './kernel.ts'
import { type Container, liquidVolume, type MeasurementRecord, relaxLayers } from './state.ts'

type Params = Record<string, unknown>

/** The reactions in a cycler: its tubes, and the wells of any plate in it. */
function reactionsIn(ctx: OpContext, cyclerId: string): Container[] {
  const ids = new Set<string>()
  for (const c of Object.values(ctx.world.containers)) {
    if (c.place !== cyclerId || c.discarded) continue
    if (c.wells?.length) for (const w of c.wells) ids.add(w)
    else ids.add(c.id)
  }
  return [...ids].map((id) => ctx.world.containers[id]).filter((c) => c && !c.discarded)
}

const isRealTime = (ctx: OpContext, equipment: string) =>
  ctx.cat.capabilitiesOf(equipment).some((c) => ctx.cat.purposeIsA(c.purpose, 'measure.fluorescence'))

/** Run a program on every tube in a thermal cycler; time passes for the whole program. */
function thermocycle(ctx: OpContext, p: Params): OpResult {
  const cycler = ctx.place(p.cycler, 'cycler')
  if (!ctx.cat.capabilitiesOf(cycler.equipment).some((c) => ctx.cat.purposeIsA(c.purpose, 'transform.amplify-dna'))) {
    ctx.refuse('NOT-A-CYCLER', `${cycler.label} cannot run a PCR program`)
  }
  const cycles = Number(p.cycles ?? 30)
  if (!Number.isInteger(cycles) || cycles < 1 || cycles > 60) ctx.refuse('BAD-CYCLES', 'Between 1 and 60 cycles')
  const t = (v: unknown, d: string, what: string) => ctx.quantity(v ?? d, 'temperature', what).si
  const s = (v: unknown, d: string, what: string) => ctx.quantity(v ?? d, 'time', what).si
  const program: PcrProgram = {
    cycles,
    denatureK: t(p.denatureTemperature, '95 Cel', 'denatureTemperature'),
    denatureS: s(p.denatureTime, '30 s', 'denatureTime'),
    annealK: t(p.annealTemperature, '55 Cel', 'annealTemperature'),
    annealS: s(p.annealTime, '30 s', 'annealTime'),
    extendK: t(p.extendTemperature, '72 Cel', 'extendTemperature'),
    extendS: s(p.extendTime, '60 s', 'extendTime'),
  }
  const initialS = s(p.initialTime, '2 min', 'initialTime')
  const finalS = s(p.finalTime, '5 min', 'finalTime')
  const holdK = t(p.hold, '4 Cel', 'hold')
  const tubes = reactionsIn(ctx, cycler.id)
  if (tubes.length === 0) ctx.refuse('EMPTY', `There are no tubes in ${cycler.label}`)
  const realTime = isRealTime(ctx, cycler.equipment)
  const threshold = Number(p.threshold ?? 0.2)
  if (realTime && !(threshold > 0)) ctx.refuse('BAD-THRESHOLD', 'The threshold is a positive ΔRn')
  const made: Record<string, Record<string, number>> = {}
  const copies = ctx.rng('copies')
  const optics = ctx.rng('optics')
  const series: Record<string, number[]> = {}
  const values: Record<string, number> = {}
  const display: Record<string, string> = {}
  const flags: MeasurementRecord['flags'] = {}
  for (const tube of tubes) {
    if (liquidVolume(tube.contents) <= 0) continue
    // The lid heats and the block cycles: the reaction is one well-mixed volume.
    relaxLayers(tube.contents, 1)
    const layer = tube.contents.layers[0]
    const dye = realTime ? dyeFactor(ctx.cat, layer) : 0
    // Colony PCR: any cells burst in the first denaturation.
    const inhibition = lyseCells(ctx.cat, layer, (key) => strainDna(ctx.cat, key), (key, pop) => strainProteins(ctx.cat, key, pop))
    const run = amplify(ctx.cat, layer, program, copies, inhibition)
    made[tube.id] = run.products
    if (!realTime) continue
    const delta = baselineCorrect(amplificationReads(run.dsBp, layer.volumeL, dye, optics))
    series[tube.id] = delta.map((d) => Number(d.toFixed(4)))
    const cq = quantificationCycle(delta, threshold)
    if (cq === undefined) {
      display[tube.id] = 'Undetermined'
      flags[tube.id] = ['below-detection']
    } else {
      values[tube.id] = Number(cq.toFixed(2))
      display[tube.id] = `Cq ${cq.toFixed(2)}`
    }
  }
  cycler.temperatureK = holdK
  for (const tube of tubes) tube.contents.temperatureK = holdK
  advance(ctx.world, ctx.cat, programDuration(program, initialS, finalS))
  if (!realTime) return { facts: { tubes: tubes.map((x) => x.id), cycles, annealK: program.annealK, made } }
  const record: MeasurementRecord = {
    id: ctx.newId('m'),
    event: ctx.eventIndex,
    timeS: ctx.world.timeS,
    instrument: cycler.id,
    settings: { cycles, threshold, dye: 'SYBR', signal: 'ΔRn' },
    subject: tubes.map((x) => x.id).join(','),
    kind: 'series',
    quantity: 'fluorescence',
    unit: '{cycles}',
    values,
    series,
    axis: { label: 'cycle', unit: '1', values: Array.from({ length: cycles }, (_, i) => i + 1) },
    display,
    flags,
    uncertainty: {},
  }
  ctx.world.measurements.push(record)
  return { outputs: { record: record.id }, facts: { tubes: tubes.map((x) => x.id), cycles, annealK: program.annealK, made, record: record.id, determined: Object.keys(values).length } }
}

/** Heat every reaction in a real-time cycler slowly, reading as it goes: a melt curve per well. */
function meltCurveOp(ctx: OpContext, p: Params): OpResult {
  const cycler = ctx.place(p.cycler, 'cycler')
  if (!isRealTime(ctx, cycler.equipment)) ctx.refuse('NOT-REAL-TIME', `${cycler.label} cannot read fluorescence`)
  const fromK = ctx.quantity(p.from ?? '65 Cel', 'temperature', 'from').si
  const toK = ctx.quantity(p.to ?? '95 Cel', 'temperature', 'to').si
  if (!(toK > fromK + 5) || toK > 99 + 273.15) ctx.refuse('BAD-RANGE', 'Melt upwards over at least 5 °C, to no more than 99 °C')
  const tubes = reactionsIn(ctx, cycler.id).filter((t) => liquidVolume(t.contents) > 0)
  if (tubes.length === 0) ctx.refuse('EMPTY', `There are no reactions in ${cycler.label}`)
  const optics = ctx.rng('optics')
  const series: Record<string, number[]> = {}
  const values: Record<string, number> = {}
  const peaks: Record<string, number[]> = {}
  const display: Record<string, string> = {}
  let axis: number[] = []
  for (const tube of tubes) {
    relaxLayers(tube.contents, 1)
    const layer = tube.contents.layers[0]
    const curve = meltCurve(ctx.cat, layer, dyeFactor(ctx.cat, layer), fromK, toK, optics)
    axis = curve.temperaturesC.map((t) => Number(t.toFixed(2)))
    series[tube.id] = curve.derivative.map((d) => Number(d.toFixed(4)))
    peaks[tube.id] = curve.peaksC.map((t) => Number(t.toFixed(1)))
    if (curve.peaksC.length) values[tube.id] = Number(curve.peaksC[0].toFixed(1))
    display[tube.id] = curve.peaksC.length ? curve.peaksC.map((t) => `${t.toFixed(1)} °C`).join(', ') : 'no peak'
  }
  // A ramp of 0.05 K/s, then back to the hold.
  advance(ctx.world, ctx.cat, (toK - fromK) / 0.05)
  const record: MeasurementRecord = {
    id: ctx.newId('m'),
    event: ctx.eventIndex,
    timeS: ctx.world.timeS,
    instrument: cycler.id,
    settings: { from: Number((fromK - 273.15).toFixed(1)), to: Number((toK - 273.15).toFixed(1)), signal: '−dF/dT' },
    subject: tubes.map((x) => x.id).join(','),
    kind: 'series',
    quantity: 'fluorescence',
    unit: 'Cel',
    values,
    series,
    axis: { label: 'temperature', unit: 'Cel', values: axis },
    peaks,
    display,
    flags: {},
    uncertainty: { resolution: 0.5 },
  }
  ctx.world.measurements.push(record)
  return { outputs: { record: record.id }, facts: { record: record.id, peaks } }
}

/**
 * Run a gel (agarose for DNA, SDS-polyacrylamide for proteins): every loaded lane moves towards
 * the anode. A negative voltage (leads swapped) runs it backwards, out of the wells and into the buffer.
 */
function runGel(ctx: OpContext, p: Params): OpResult {
  const gel = ctx.container(p.gel, 'gel')
  if (gel.kind !== 'plate' || ctx.cat.property(gel.equipment, 'gel') !== true) ctx.refuse('NOT-A-GEL', `${gel.label} is not a gel`)
  const volts = Number(p.voltage ?? 100)
  if (!Number.isFinite(volts) || Math.abs(volts) > 200) ctx.refuse('BAD-VOLTAGE', 'Use up to 200 V for a mini gel')
  const minutes = ctx.quantity(p.duration, 'time', 'duration').si / 60
  const matrix = gelMatrix(ctx.cat, gel.equipment)
  for (const w of gel.wells ?? []) runLane(ctx.cat, ctx.world.containers[w].contents, matrix, volts, minutes)
  advance(ctx.world, ctx.cat, minutes * 60)
  return { facts: { volts, minutes, reversed: volts < 0 } }
}

export const MOLBIO_OPERATIONS: Record<string, OpImpl> = {
  'core:thermocycle': thermocycle,
  'core:melt-curve': meltCurveOp,
  'core:run-gel': runGel,
}
